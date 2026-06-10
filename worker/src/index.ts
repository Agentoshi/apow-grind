/**
 * GrindProxy — x402 payment-gated GPU nonce grinding service.
 *
 * Accepts POST /grind with { challenge, target, address },
 * requires x402 USDC payment (dynamic pricing), dispatches to RunPod
 * serverless GPU backend, returns the nonce.
 *
 * Pricing tracks actual RunPod GPU cost + settlement gas with a small
 * markup. Price adjusts automatically as network difficulty changes.
 *
 * Self-hosted x402 facilitator — no external facilitator dependency.
 * Uses @x402/core + @x402/evm for in-process payment verification
 * and settlement on Base mainnet.
 */

import { Hono } from "hono";
import {
  paymentMiddleware,
  x402ResourceServer,
} from "@x402/hono";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  registerExactEvmScheme,
} from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { publicActions } from "viem";
import type { MiddlewareHandler } from "hono";

interface Env {
  RUNPOD_ENDPOINT: string;
  RUNPOD_API_KEY: string;
  RUNPOD_AUTOPAUSE_ENABLED?: string;
  RUNPOD_GPU_IDS?: string;
  RUNPOD_TEMPLATE_ID?: string;
  RUNPOD_GPU_COUNT?: string;
  SERVICE_WALLET: string;
  FACILITATOR_PRIVATE_KEY: string;
  ECONOMICS_DB?: D1Database;
  RPC_URL?: string;
  REQUIRE_ECONOMICS_DB?: string;
  RUNPOD_WORKER_COST_PER_HOUR_USD?: string;
  RUNPOD_GPU_COST_PER_HOUR_USD?: string;
  RUNPOD_HASHRATE_HPS?: string;
  RUNPOD_STARTUP_OVERHEAD_SECS?: string;
  RUNPOD_POST_JOB_IDLE_SECS?: string;
  RUNPOD_MIN_BILLABLE_SECS?: string;
  RUNPOD_TIME_BUFFER_MULTIPLIER?: string;
  RUNPOD_CONTAINER_DISK_GB?: string;
  RUNPOD_STORAGE_COST_PER_GB_MONTH_USD?: string;
  RUNPOD_FAILURE_ALLOWANCE_RATE?: string;
  RUNPOD_FAILURE_TIMEOUT_SECS?: string;
  RUNPOD_MAX_WORKERS_SAFE?: string;
  SETTLEMENT_GAS_USD?: string;
  CLOUDFLARE_OVERHEAD_USD?: string;
  OBSERVABILITY_OVERHEAD_USD?: string;
  PRICE_MARKUP?: string;
  PRICE_FLOOR_USD?: string;
  PRICE_ROUNDING_USD?: string;
  PRICE_REFERENCE_COMPUTE_SECS?: string;
  MIN_GROSS_MARGIN_USD?: string;
  MIN_GROSS_MARGIN_PCT?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store, max-age=0");
  c.header("Pragma", "no-cache");
  await next();
});

// ── Global error handler — catch unhandled exceptions ────────────────

app.onError((err, c) => {
  console.error("Worker error:", err.message, err.stack);
  return c.json({ error: err.message, stack: err.stack?.split("\n").slice(0, 5) }, 500);
});

// ── Metrics (in-memory, resets on worker restart) ────────────────────

let totalGrinds = 0;
let totalPaidRequests = 0;
let totalFailures = 0;
let totalGrindTimeMs = 0;
let totalQueueTimeMs = 0;
let totalQuotedRevenueUsd = 0;

const BACKEND_VERSION = "daemon-v2";
const TWO_POW_256 = 2n ** 256n;
const SECONDS_PER_30_DAY_MONTH = 30 * 24 * 60 * 60;
const RUNPOD_4090_PRO_FLEX_COST_PER_HOUR_USD = 0.00031 * 3600;

const KNOWN_GPU_FLEX_COST_PER_HOUR_USD: Array<{ pattern: RegExp; cost: number }> = [
  { pattern: /4090/i, cost: RUNPOD_4090_PRO_FLEX_COST_PER_HOUR_USD },
  { pattern: /A4000|A4500|RTX 4000/i, cost: 0.00016 * 3600 },
  { pattern: /L4|A5000|3090/i, cost: 0.00019 * 3600 },
  { pattern: /L40|L40S|6000 Ada/i, cost: 0.00053 * 3600 },
  { pattern: /A6000|A40/i, cost: 0.00034 * 3600 },
  { pattern: /H100/i, cost: 0.00116 * 3600 },
  { pattern: /A100/i, cost: 0.00076 * 3600 },
  { pattern: /H200/i, cost: 0.00155 * 3600 },
  { pattern: /B200/i, cost: 0.00240 * 3600 },
];

type PricingConfig = {
  workerCostPerHourUsd: number;
  hashrateHps: number;
  startupOverheadSecs: number;
  postJobIdleSecs: number;
  minBillableSecs: number;
  timeBufferMultiplier: number;
  containerDiskGb: number;
  storageCostPerGbMonthUsd: number;
  failureAllowanceRate: number;
  failureTimeoutSecs: number;
  maxWorkersSafe: number;
  settlementGasUsd: number;
  cloudflareOverheadUsd: number;
  observabilityOverheadUsd: number;
  markup: number;
  configuredPriceFloorUsd: number;
  priceRoundingUsd: number;
  referenceComputeSecs: number;
  minGrossMarginUsd: number;
  minGrossMarginPct: number;
};

type PriceQuote = {
  priceUsd: number;
  price: string;
  expectedHashes: bigint;
  estimatedComputeSecs: number;
  billableSecs: number;
  workerCostUsd: number;
  storageCostUsd: number;
  settlementGasUsd: number;
  cloudflareOverheadUsd: number;
  observabilityOverheadUsd: number;
  failureAllowanceUsd: number;
  costBeforeMarginUsd: number;
  minimumGrossMarginUsd: number;
  grossMarginUsd: number;
  rawCostUsd: number;
  minimumPriceUsd: number;
  effectiveFloorUsd: number;
};

type GrindRequestBody = {
  challenge?: string;
  target?: string;
  address?: string;
};

type RunpodEndpointConfig = {
  id: string;
  name: string;
  workersMin: number;
  workersMax: number;
  workersStandby?: number;
  idleTimeout?: number;
  scalerType?: string;
  scalerValue?: number;
  templateId?: string;
  gpuCount?: number;
  gpuTypeIds?: string[];
  flashboot?: boolean;
  executionTimeoutMs?: number;
  workers?: RunpodWorkerSnapshot[];
};

type RunpodEndpointHealth = {
  jobs?: {
    completed?: number;
    failed?: number;
    inProgress?: number;
    inQueue?: number;
    retried?: number;
  };
  workers?: {
    idle?: number;
    initializing?: number;
    ready?: number;
    running?: number;
    throttled?: number;
    unhealthy?: number;
  };
};

type RunpodWorkerSnapshot = {
  id?: string;
  desiredStatus?: string;
  costPerHr?: number | string;
  adjustedCostPerHr?: number | string;
  machine?: {
    costPerHr?: number | string;
    currentPricePerGpu?: number | string;
    gpuDisplayName?: string;
    gpuTypeId?: string;
  };
};

type RunpodTelemetry = {
  endpointId: string;
  config: RunpodEndpointConfig;
  health: RunpodEndpointHealth;
};

type RunpodJobResponse = {
  id?: string;
  status?: string;
  output?: { nonce?: string; elapsed?: number; error?: string };
  error?: string;
};

type RunpodSafetyAssessment = {
  safe: boolean;
  reasons: string[];
  maxObservedWorkerCostPerHourUsd: number | null;
};

type RunpodSafetyOptions = {
  allowPausedAutostart?: boolean;
};

type RunpodCapacityLease = {
  resumed: boolean;
  config: RunpodEndpointConfig;
};

type RunpodLeakCleanupResult = {
  action: "noop" | "cleanup";
  reason: string;
  activePaidRows: number;
  stalePaidRows: number;
  activeJobs: number;
  warmWorkers: number;
  capacityEnabled: boolean;
  purgedQueue?: boolean;
  pausedCapacity?: boolean;
};

type LedgerStatus = "paid_started" | "success" | "error";

type GrindEconomicsLedgerRow = {
  requestId: string;
  createdAt: string;
  updatedAt: string;
  status: LedgerStatus;
  minerAddress: string;
  challengePrefix: string;
  targetHex: string;
  expectedHashes: string;
  price: string;
  priceUsd: number;
  estimatedComputeSecs: number;
  billableSecs: number;
  workerCostUsd: number;
  storageCostUsd: number;
  settlementGasUsd: number;
  cloudflareOverheadUsd: number;
  observabilityOverheadUsd: number;
  failureAllowanceUsd: number;
  costBeforeMarginUsd: number;
  grossMarginUsd: number;
  endpointId: string;
};

type GrindEconomicsLedgerUpdate = {
  status: LedgerStatus;
  responseStatus: number;
  runpodHttpStatus?: number | null;
  runpodStatus?: string | null;
  queueTimeMs?: number | null;
  computeTimeMs?: number | null;
  elapsedSecs?: number | null;
  nonce?: string | null;
  error?: string | null;
};

type EconomicsLedgerStatus = {
  required: boolean;
  configured: boolean;
  healthy: boolean;
  error?: string;
};

let cachedRunpodTelemetry: { expiresAt: number; value: RunpodTelemetry } | null = null;
const RUNPOD_TELEMETRY_CACHE_MS = 5_000;
const RUNPOD_POLL_INTERVAL_MS = 10_000;

function parseEnvNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseMaybeNumber(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function parseEnvBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

function runpodAutopauseEnabled(env: Partial<Env>): boolean {
  return parseEnvBoolean(env.RUNPOD_AUTOPAUSE_ENABLED, true);
}

function getRunpodCapacityGpuIds(env: Partial<Env>, config: RunpodEndpointConfig): string | null {
  if (env.RUNPOD_GPU_IDS) return env.RUNPOD_GPU_IDS;
  if (config.gpuTypeIds?.some((gpuTypeId) => /4090/i.test(gpuTypeId))) {
    return "ADA_24";
  }
  return null;
}

function canAutostartRunpod(env: Partial<Env>, config: RunpodEndpointConfig): boolean {
  return runpodAutopauseEnabled(env)
    && Boolean(env.RUNPOD_TEMPLATE_ID ?? config.templateId)
    && Boolean(getRunpodCapacityGpuIds(env, config));
}

function getMaxKnownGpuFlexCostPerHourUsd(gpuTypeIds: string[] | undefined): number | null {
  if (!gpuTypeIds || gpuTypeIds.length === 0) return null;
  let maxCost: number | null = null;
  for (const gpuTypeId of gpuTypeIds) {
    const match = KNOWN_GPU_FLEX_COST_PER_HOUR_USD.find(({ pattern }) => pattern.test(gpuTypeId));
    if (!match) return null;
    maxCost = maxCost === null ? match.cost : Math.max(maxCost, match.cost);
  }
  return maxCost;
}

function getRpcUrl(env: Env): string {
  if (!env.RPC_URL) {
    throw new Error("RPC_URL is required; refusing to fall back to public Base RPC endpoints");
  }
  return env.RPC_URL;
}

function getPricingConfig(env: Partial<Env>): PricingConfig {
  return {
    workerCostPerHourUsd: parseEnvNumber(
      env.RUNPOD_WORKER_COST_PER_HOUR_USD ?? env.RUNPOD_GPU_COST_PER_HOUR_USD,
      1.25,
    ),
    hashrateHps: parseEnvNumber(env.RUNPOD_HASHRATE_HPS, 20_000_000_000),
    startupOverheadSecs: parseEnvNumber(env.RUNPOD_STARTUP_OVERHEAD_SECS, 120),
    postJobIdleSecs: parseEnvNumber(env.RUNPOD_POST_JOB_IDLE_SECS, 5),
    minBillableSecs: parseEnvNumber(env.RUNPOD_MIN_BILLABLE_SECS, 1),
    timeBufferMultiplier: parseEnvNumber(env.RUNPOD_TIME_BUFFER_MULTIPLIER, 1.25),
    containerDiskGb: parseEnvNumber(env.RUNPOD_CONTAINER_DISK_GB, 20),
    storageCostPerGbMonthUsd: parseEnvNumber(env.RUNPOD_STORAGE_COST_PER_GB_MONTH_USD, 0.10),
    failureAllowanceRate: parseEnvNumber(env.RUNPOD_FAILURE_ALLOWANCE_RATE, 1.0),
    failureTimeoutSecs: parseEnvNumber(env.RUNPOD_FAILURE_TIMEOUT_SECS, 300),
    maxWorkersSafe: parseEnvNumber(env.RUNPOD_MAX_WORKERS_SAFE, 1),
    settlementGasUsd: parseEnvNumber(env.SETTLEMENT_GAS_USD, 0.001),
    cloudflareOverheadUsd: parseEnvNumber(env.CLOUDFLARE_OVERHEAD_USD, 0.0001),
    observabilityOverheadUsd: parseEnvNumber(env.OBSERVABILITY_OVERHEAD_USD, 0.0001),
    markup: parseEnvNumber(env.PRICE_MARKUP, 1.5),
    configuredPriceFloorUsd: parseEnvNumber(env.PRICE_FLOOR_USD, 0.301),
    priceRoundingUsd: parseEnvNumber(env.PRICE_ROUNDING_USD, 0.001),
    referenceComputeSecs: parseEnvNumber(env.PRICE_REFERENCE_COMPUTE_SECS, 15),
    minGrossMarginUsd: parseEnvNumber(env.MIN_GROSS_MARGIN_USD, 0.002),
    minGrossMarginPct: parseEnvNumber(env.MIN_GROSS_MARGIN_PCT, 0.20),
  };
}

function roundUpPrice(priceUsd: number, incrementUsd: number): number {
  const increment = incrementUsd > 0 ? incrementUsd : 0.001;
  return Math.ceil(priceUsd / increment) * increment;
}

function formatUsd(priceUsd: number): string {
  return `$${priceUsd.toFixed(3)}`;
}

function computeMinimumPriceUsd(pricing: PricingConfig): number {
  return quotePriceFromEstimatedComputeSecs(pricing.referenceComputeSecs, 0n, pricing, true).priceUsd;
}

function quotePriceFromEstimatedComputeSecs(
  estimatedComputeSecs: number,
  expectedHashes: bigint,
  pricing: PricingConfig,
  minimumOnly = false,
): PriceQuote {
  const safeEstimatedSecs = Number.isFinite(estimatedComputeSecs) && estimatedComputeSecs > 0
    ? estimatedComputeSecs
    : (minimumOnly ? 0 : pricing.referenceComputeSecs);
  const billableSecs = Math.max(
    pricing.minBillableSecs,
    safeEstimatedSecs * pricing.timeBufferMultiplier
      + pricing.startupOverheadSecs
      + pricing.postJobIdleSecs,
  );
  const workerCostUsd = billableSecs * (pricing.workerCostPerHourUsd / 3600);
  const storageCostUsd = billableSecs
    * pricing.containerDiskGb
    * (pricing.storageCostPerGbMonthUsd / SECONDS_PER_30_DAY_MONTH);
  const failureBillableSecs = Math.max(
    billableSecs,
    pricing.startupOverheadSecs + pricing.failureTimeoutSecs + pricing.postJobIdleSecs,
  );
  const failureWorkerCostUsd = failureBillableSecs * (pricing.workerCostPerHourUsd / 3600);
  const failureStorageCostUsd = failureBillableSecs
    * pricing.containerDiskGb
    * (pricing.storageCostPerGbMonthUsd / SECONDS_PER_30_DAY_MONTH);
  const preFailureCostUsd = workerCostUsd
    + storageCostUsd
    + pricing.settlementGasUsd
    + pricing.cloudflareOverheadUsd
    + pricing.observabilityOverheadUsd;
  const failureAllowanceUsd = (
    failureWorkerCostUsd
    + failureStorageCostUsd
    + pricing.settlementGasUsd
    + pricing.cloudflareOverheadUsd
    + pricing.observabilityOverheadUsd
  ) * pricing.failureAllowanceRate;
  const costBeforeMarginUsd = preFailureCostUsd + failureAllowanceUsd;
  const minimumGrossMarginUsd = Math.max(
    pricing.minGrossMarginUsd,
    costBeforeMarginUsd * pricing.minGrossMarginPct,
  );
  const markedUpUsd = costBeforeMarginUsd * pricing.markup;
  const rawCostUsd = Math.max(markedUpUsd, costBeforeMarginUsd + minimumGrossMarginUsd);
  const minimumPriceUsd = minimumOnly
    ? roundUpPrice(rawCostUsd, pricing.priceRoundingUsd)
    : computeMinimumPriceUsd(pricing);
  const effectiveFloorUsd = Math.max(pricing.configuredPriceFloorUsd, minimumPriceUsd);
  const priceUsd = Math.max(
    effectiveFloorUsd,
    roundUpPrice(rawCostUsd, pricing.priceRoundingUsd),
  );
  const grossMarginUsd = priceUsd - costBeforeMarginUsd;
  return {
    priceUsd,
    price: formatUsd(priceUsd),
    expectedHashes,
    estimatedComputeSecs: safeEstimatedSecs,
    billableSecs,
    workerCostUsd,
    storageCostUsd,
    settlementGasUsd: pricing.settlementGasUsd,
    cloudflareOverheadUsd: pricing.cloudflareOverheadUsd,
    observabilityOverheadUsd: pricing.observabilityOverheadUsd,
    failureAllowanceUsd,
    costBeforeMarginUsd,
    minimumGrossMarginUsd,
    grossMarginUsd,
    rawCostUsd,
    minimumPriceUsd,
    effectiveFloorUsd,
  };
}

function quotePriceFromTarget(target: bigint, pricing: PricingConfig): PriceQuote {
  const expectedHashes = target > 0n ? TWO_POW_256 / target : 0n;
  const estimatedComputeSecs = target > 0n ? Number(expectedHashes) / pricing.hashrateHps : pricing.referenceComputeSecs;
  return quotePriceFromEstimatedComputeSecs(estimatedComputeSecs, expectedHashes, pricing);
}

function quoteReferencePrice(pricing: PricingConfig): PriceQuote {
  return quotePriceFromEstimatedComputeSecs(pricing.referenceComputeSecs, 0n, pricing);
}

function validateAndNormalizeRequest(body: GrindRequestBody): { challenge: `0x${string}`; target: bigint; address: `0x${string}` } | { error: string } {
  const { challenge, target, address } = body;
  if (!challenge || !/^0x[0-9a-fA-F]{64}$/.test(challenge)) {
    return { error: "Invalid challenge: must be 0x-prefixed 32-byte hex (66 chars)" };
  }
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { error: "Invalid address: must be 0x-prefixed 20-byte hex (42 chars)" };
  }
  if (!target) {
    return { error: "Missing target" };
  }
  let targetBigInt: bigint;
  try {
    targetBigInt = BigInt(target);
  } catch {
    return { error: "Invalid target: must be a decimal or 0x hex number" };
  }
  if (targetBigInt <= 0n) {
    return { error: "Invalid target: must be greater than zero" };
  }
  return {
    challenge: challenge as `0x${string}`,
    target: targetBigInt,
    address: address as `0x${string}`,
  };
}

function extractRunpodEndpointId(endpointUrl: string): string | null {
  const match = endpointUrl.match(/\/v2\/([^/]+)/);
  return match?.[1] ?? null;
}

async function fetchJsonWithTimeout<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return await response.json<T>();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRunpodTelemetry(env: Env): Promise<RunpodTelemetry> {
  const endpointId = extractRunpodEndpointId(env.RUNPOD_ENDPOINT);
  if (!endpointId) {
    throw new Error("Could not parse RunPod endpoint ID from RUNPOD_ENDPOINT");
  }
  const authHeader = { Authorization: `Bearer ${env.RUNPOD_API_KEY}` };
  const [config, health] = await Promise.all([
    fetchJsonWithTimeout<RunpodEndpointConfig>(
      `https://rest.runpod.io/v1/endpoints/${endpointId}`,
      { headers: authHeader },
      4_000,
    ),
    fetchJsonWithTimeout<RunpodEndpointHealth>(
      `${env.RUNPOD_ENDPOINT}/health`,
      { headers: authHeader },
      4_000,
    ),
  ]);
  return { endpointId, config, health };
}

async function fetchRunpodTelemetryCached(env: Env, force = false): Promise<RunpodTelemetry> {
  const now = Date.now();
  if (!force && cachedRunpodTelemetry && cachedRunpodTelemetry.expiresAt > now) {
    return cachedRunpodTelemetry.value;
  }
  const telemetry = await fetchRunpodTelemetry(env);
  cachedRunpodTelemetry = {
    value: telemetry,
    expiresAt: now + RUNPOD_TELEMETRY_CACHE_MS,
  };
  return telemetry;
}

async function fetchRunpodJobStatus(env: Env, jobId: string, signal: AbortSignal): Promise<RunpodJobResponse> {
  return fetchJsonWithTimeout<RunpodJobResponse>(
    `${env.RUNPOD_ENDPOINT}/status/${jobId}`,
    {
      headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}` },
      signal,
    },
    10_000,
  );
}

async function setRunpodWorkerCapacity(
  env: Env,
  config: RunpodEndpointConfig,
  workersMax: number,
): Promise<RunpodEndpointConfig> {
  const endpointId = extractRunpodEndpointId(env.RUNPOD_ENDPOINT);
  if (!endpointId) {
    throw new Error("Could not parse RunPod endpoint ID from RUNPOD_ENDPOINT");
  }
  const templateId = env.RUNPOD_TEMPLATE_ID ?? config.templateId;
  const gpuIds = getRunpodCapacityGpuIds(env, config);
  if (!templateId) {
    throw new Error("RUNPOD_TEMPLATE_ID is required to change RunPod capacity");
  }
  if (!gpuIds) {
    throw new Error("RUNPOD_GPU_IDS is required to change RunPod capacity for this GPU type");
  }

  const input = {
    id: endpointId,
    name: config.name ?? "apow-grind",
    templateId,
    gpuIds,
    workersMin: 0,
    workersMax,
    idleTimeout: config.idleTimeout ?? 5,
    scalerType: config.scalerType ?? "QUEUE_DELAY",
    scalerValue: config.scalerValue ?? 4,
    gpuCount: parseEnvNumber(env.RUNPOD_GPU_COUNT, config.gpuCount ?? 1),
    executionTimeoutMs: Math.round(getPricingConfig(env).failureTimeoutSecs * 1000),
  };
  const response = await fetchJsonWithTimeout<{
    data?: { saveEndpoint?: RunpodEndpointConfig };
    errors?: Array<{ message?: string }>;
  }>(
    "https://api.runpod.io/graphql",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.RUNPOD_API_KEY}`,
      },
      body: JSON.stringify({
        query: `mutation SaveEndpoint($input: EndpointInput!) {
          saveEndpoint(input: $input) {
            id
            name
            workersMin
            workersMax
            workersStandby
            idleTimeout
            scalerType
            scalerValue
            templateId
            gpuCount
          }
        }`,
        variables: { input },
      }),
    },
    10_000,
  );
  if (response.errors?.length) {
    throw new Error(response.errors.map((error) => error.message ?? "RunPod GraphQL error").join("; "));
  }
  if (!response.data?.saveEndpoint) {
    throw new Error("RunPod capacity update returned no endpoint");
  }
  cachedRunpodTelemetry = null;
  return response.data.saveEndpoint;
}

async function acquireRunpodCapacityLease(env: Env): Promise<RunpodCapacityLease> {
  const runpod = await fetchRunpodTelemetryCached(env, true);
  if (!runpodAutopauseEnabled(env)) {
    return { resumed: false, config: runpod.config };
  }
  if ((runpod.config.workersMax ?? 0) >= 1) {
    return { resumed: false, config: runpod.config };
  }
  const resumedConfig = await setRunpodWorkerCapacity(env, runpod.config, 1);
  logGrindEvent({
    event: "runpod_capacity_resume",
    endpointId: runpod.endpointId,
    workersMax: resumedConfig.workersMax,
    workersStandby: resumedConfig.workersStandby,
  });
  return { resumed: true, config: resumedConfig };
}

async function releaseRunpodCapacityLease(env: Env, lease: RunpodCapacityLease | null): Promise<void> {
  if (!lease?.resumed || !runpodAutopauseEnabled(env)) return;
  try {
    const pausedConfig = await setRunpodWorkerCapacity(env, lease.config, 0);
    logGrindEvent({
      event: "runpod_capacity_pause",
      workersMax: pausedConfig.workersMax,
      workersStandby: pausedConfig.workersStandby,
    });
  } catch (err) {
    logGrindEvent({
      event: "runpod_capacity_pause_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function purgeRunpodQueue(env: Env): Promise<void> {
  const endpointId = extractRunpodEndpointId(env.RUNPOD_ENDPOINT);
  if (!endpointId) {
    throw new Error("Could not parse RunPod endpoint ID from RUNPOD_ENDPOINT");
  }
  await fetchJsonWithTimeout<{ removed?: number; status?: string }>(
    `${env.RUNPOD_ENDPOINT.replace(/\/$/, "")}/purge-queue`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}` },
    },
    10_000,
  );
}

async function cancelRunpodJob(env: Env, jobId: string): Promise<void> {
  await fetchJsonWithTimeout<RunpodJobResponse>(
    `${env.RUNPOD_ENDPOINT}/cancel/${jobId}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}` },
    },
    10_000,
  );
}

async function waitForRunpodTerminalJob(
  env: Env,
  initial: RunpodJobResponse,
  deadlineMs: number,
  signal: AbortSignal,
): Promise<RunpodJobResponse> {
  let current = initial;
  while (isRunpodPendingStatus(current.status) && current.id && Date.now() < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, RUNPOD_POLL_INTERVAL_MS));
    current = await fetchRunpodJobStatus(env, current.id, signal);
  }
  return current;
}

function getMaxObservedWorkerCostPerHourUsd(workers: RunpodWorkerSnapshot[] | undefined): number | null {
  if (!workers || workers.length === 0) return null;
  let maxObserved: number | null = null;
  for (const worker of workers) {
    const observed = [
      parseMaybeNumber(worker.adjustedCostPerHr),
      parseMaybeNumber(worker.costPerHr),
      parseMaybeNumber(worker.machine?.costPerHr),
      parseMaybeNumber(worker.machine?.currentPricePerGpu),
    ].find((value): value is number => value !== null);
    if (observed !== undefined) {
      maxObserved = maxObserved === null ? observed : Math.max(maxObserved, observed);
    }
  }
  return maxObserved;
}

function getObservedFailureRate(jobs: RunpodEndpointHealth["jobs"] | undefined): number | null {
  const completed = jobs?.completed ?? 0;
  const failed = jobs?.failed ?? 0;
  const total = completed + failed;
  if (total <= 0) return null;
  return failed / total;
}

function isRunpodPendingStatus(status: string | undefined): boolean {
  return status === "IN_QUEUE" || status === "IN_PROGRESS";
}

function assessRunpodSafety(
  runpod: { config: RunpodEndpointConfig; health: RunpodEndpointHealth },
  pricing: PricingConfig,
  options: RunpodSafetyOptions = {},
): RunpodSafetyAssessment {
  const reasons: string[] = [];
  const jobs = runpod.health.jobs ?? {};
  const workers = runpod.health.workers ?? {};
  const activeJobs = (jobs.inQueue ?? 0) + (jobs.inProgress ?? 0);
  if (activeJobs > 0) {
    reasons.push(`RunPod already has ${activeJobs} queued/in-progress job(s); refusing new paid requests until capacity is clear`);
  }
  const billableWorkersWithoutPaidJob = (workers.initializing ?? 0) + (workers.ready ?? 0) + (workers.running ?? 0);
  if (activeJobs === 0 && billableWorkersWithoutPaidJob > 0) {
    reasons.push(`RunPod has ${billableWorkersWithoutPaidJob} initializing/ready/running worker(s) without an active paid job`);
  }
  if ((runpod.config.workersMin ?? 0) > 0) {
    reasons.push(`workersMin=${runpod.config.workersMin} keeps workers alive when no paid request is running`);
  }
  if ((runpod.config.workersStandby ?? 0) > 0) {
    reasons.push(`workersStandby=${runpod.config.workersStandby} starts RunPod flex capacity before payment`);
  }
  if ((runpod.config.idleTimeout ?? 0) > pricing.postJobIdleSecs) {
    reasons.push(
      `idleTimeout=${runpod.config.idleTimeout}s exceeds priced post-job idle tail ${pricing.postJobIdleSecs}s`,
    );
  }
  if (runpod.config.idleTimeout === undefined) {
    reasons.push("idleTimeout is missing from RunPod telemetry; refusing to price unknown idle burn");
  }
  if ((runpod.config.workersMax ?? 0) < 1 && !options.allowPausedAutostart) {
    reasons.push(`workersMax=${runpod.config.workersMax ?? "missing"} disables backend capacity; refusing to accept paid requests`);
  } else if ((runpod.config.workersMax ?? 0) > pricing.maxWorkersSafe) {
    reasons.push(
      `workersMax=${runpod.config.workersMax} exceeds configured safety cap ${pricing.maxWorkersSafe}`,
    );
  }
  const knownGpuFlexCostPerHourUsd = getMaxKnownGpuFlexCostPerHourUsd(runpod.config.gpuTypeIds);
  if (knownGpuFlexCostPerHourUsd === null) {
    reasons.push(`unknown or missing GPU pricing for ${runpod.config.gpuTypeIds?.join(", ") || "no GPU type"}; refusing to serve without a known cost floor`);
  } else if (pricing.workerCostPerHourUsd + 1e-6 < knownGpuFlexCostPerHourUsd) {
    reasons.push(
      `priced worker cost ${pricing.workerCostPerHourUsd.toFixed(3)}/hr is below official flex GPU floor ${knownGpuFlexCostPerHourUsd.toFixed(3)}/hr`,
    );
  }
  const maxObservedWorkerCostPerHourUsd = getMaxObservedWorkerCostPerHourUsd(runpod.config.workers);
  if (
    maxObservedWorkerCostPerHourUsd !== null
    && maxObservedWorkerCostPerHourUsd > pricing.workerCostPerHourUsd + 1e-6
  ) {
    reasons.push(
      `observed worker cost ${maxObservedWorkerCostPerHourUsd.toFixed(2)}/hr exceeds priced worker cost ${pricing.workerCostPerHourUsd.toFixed(2)}/hr`,
    );
  }
  const observedFailureRate = getObservedFailureRate(runpod.health.jobs);
  if (observedFailureRate !== null && observedFailureRate > pricing.failureAllowanceRate + 1e-6) {
    reasons.push(
      `observed RunPod failure rate ${(observedFailureRate * 100).toFixed(2)}% exceeds priced failure allowance ${(pricing.failureAllowanceRate * 100).toFixed(2)}%`,
    );
  }
  return {
    safe: reasons.length === 0,
    reasons,
    maxObservedWorkerCostPerHourUsd,
  };
}

function buildEconomicsWarnings(
  runpod: { config: RunpodEndpointConfig; health: RunpodEndpointHealth },
  pricing: PricingConfig,
  safety: RunpodSafetyAssessment,
  referenceQuote: PriceQuote,
): string[] {
  const warnings: string[] = [];
  const jobs = runpod.health.jobs ?? {};
  const workers = runpod.health.workers ?? {};
  warnings.push(...safety.reasons);
  if ((workers.running ?? 0) > 0 && (jobs.inQueue ?? 0) === 0 && (jobs.inProgress ?? 0) === 0) {
    warnings.push(`workers are still running with no queue backlog; confirm the endpoint drains after idleTimeout=${runpod.config.idleTimeout ?? "?"}s`);
  }
  if (runpod.config.gpuTypeIds && runpod.config.gpuTypeIds.length > 1) {
    warnings.push(`multiple GPU types are allowed (${runpod.config.gpuTypeIds.join(", ")}); pricing must assume the most expensive worker`);
  }
  if (pricing.configuredPriceFloorUsd < referenceQuote.minimumPriceUsd) {
    warnings.push(
      `PRICE_FLOOR_USD=${pricing.configuredPriceFloorUsd} is below the computed cold-start floor ${referenceQuote.minimumPriceUsd.toFixed(3)}; the effective floor is being raised automatically`,
    );
  }
  if (pricing.workerCostPerHourUsd < RUNPOD_4090_PRO_FLEX_COST_PER_HOUR_USD) {
    warnings.push(`RUNPOD_WORKER_COST_PER_HOUR_USD=${pricing.workerCostPerHourUsd} is below current 4090 PRO flex pricing ${RUNPOD_4090_PRO_FLEX_COST_PER_HOUR_USD.toFixed(3)}/hr`);
  }
  return warnings;
}

function logGrindEvent(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({
    service: "grind-proxy",
    version: BACKEND_VERSION,
    ...fields,
  }));
}

function roundLedgerNumber(value: number, decimals = 6): number {
  return Number(value.toFixed(decimals));
}

function economicsLedgerRequired(env: Partial<Env>): boolean {
  return env.REQUIRE_ECONOMICS_DB !== "false";
}

function trimLedgerError(error: string | null | undefined): string | null {
  if (!error) return null;
  return error.slice(0, 500);
}

function buildInitialGrindLedgerRow(args: {
  requestId: string;
  now: string;
  address: `0x${string}`;
  challenge: `0x${string}`;
  targetHex: string;
  quote: PriceQuote;
  endpointId: string;
}): GrindEconomicsLedgerRow {
  return {
    requestId: args.requestId,
    createdAt: args.now,
    updatedAt: args.now,
    status: "paid_started",
    minerAddress: args.address.toLowerCase(),
    challengePrefix: args.challenge.slice(0, 10),
    targetHex: args.targetHex,
    expectedHashes: args.quote.expectedHashes.toString(),
    price: args.quote.price,
    priceUsd: roundLedgerNumber(args.quote.priceUsd),
    estimatedComputeSecs: roundLedgerNumber(args.quote.estimatedComputeSecs),
    billableSecs: roundLedgerNumber(args.quote.billableSecs),
    workerCostUsd: roundLedgerNumber(args.quote.workerCostUsd),
    storageCostUsd: roundLedgerNumber(args.quote.storageCostUsd),
    settlementGasUsd: roundLedgerNumber(args.quote.settlementGasUsd),
    cloudflareOverheadUsd: roundLedgerNumber(args.quote.cloudflareOverheadUsd),
    observabilityOverheadUsd: roundLedgerNumber(args.quote.observabilityOverheadUsd),
    failureAllowanceUsd: roundLedgerNumber(args.quote.failureAllowanceUsd),
    costBeforeMarginUsd: roundLedgerNumber(args.quote.costBeforeMarginUsd),
    grossMarginUsd: roundLedgerNumber(args.quote.grossMarginUsd),
    endpointId: args.endpointId,
  };
}

async function getEconomicsLedgerStatus(env: Env): Promise<EconomicsLedgerStatus> {
  const required = economicsLedgerRequired(env);
  if (!env.ECONOMICS_DB) {
    return {
      required,
      configured: false,
      healthy: !required,
      error: required ? "ECONOMICS_DB D1 binding is missing" : undefined,
    };
  }

  try {
    await env.ECONOMICS_DB.prepare("SELECT 1 AS ok").first();
    return { required, configured: true, healthy: true };
  } catch (err) {
    return {
      required,
      configured: true,
      healthy: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function insertGrindLedgerRow(env: Env, row: GrindEconomicsLedgerRow): Promise<void> {
  if (!env.ECONOMICS_DB) return;
  await env.ECONOMICS_DB.prepare(`
    INSERT INTO grind_economics (
      request_id, created_at, updated_at, status, miner_address, challenge_prefix, target_hex,
      expected_hashes, price, price_usd, estimated_compute_secs, billable_secs,
      worker_cost_usd, storage_cost_usd, settlement_gas_usd, cloudflare_overhead_usd,
      observability_overhead_usd, failure_allowance_usd, cost_before_margin_usd,
      gross_margin_usd, endpoint_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    row.requestId,
    row.createdAt,
    row.updatedAt,
    row.status,
    row.minerAddress,
    row.challengePrefix,
    row.targetHex,
    row.expectedHashes,
    row.price,
    row.priceUsd,
    row.estimatedComputeSecs,
    row.billableSecs,
    row.workerCostUsd,
    row.storageCostUsd,
    row.settlementGasUsd,
    row.cloudflareOverheadUsd,
    row.observabilityOverheadUsd,
    row.failureAllowanceUsd,
    row.costBeforeMarginUsd,
    row.grossMarginUsd,
    row.endpointId,
  ).run();
}

async function updateGrindLedgerRow(
  env: Env,
  requestId: string,
  update: GrindEconomicsLedgerUpdate,
): Promise<void> {
  if (!env.ECONOMICS_DB) return;
  await env.ECONOMICS_DB.prepare(`
    UPDATE grind_economics
    SET updated_at = ?,
        status = ?,
        response_status = ?,
        runpod_http_status = ?,
        runpod_status = ?,
        queue_time_ms = ?,
        compute_time_ms = ?,
        elapsed_secs = ?,
        nonce = ?,
        error = ?
    WHERE request_id = ?
  `).bind(
    new Date().toISOString(),
    update.status,
    update.responseStatus,
    update.runpodHttpStatus ?? null,
    update.runpodStatus ?? null,
    update.queueTimeMs ?? null,
    update.computeTimeMs ?? null,
    update.elapsedSecs ?? null,
    update.nonce ?? null,
    trimLedgerError(update.error),
    requestId,
  ).run();
}

async function countActivePaidRows(env: Env, cutoffIso: string): Promise<number> {
  if (!env.ECONOMICS_DB) return 0;
  const row = await env.ECONOMICS_DB.prepare(`
    SELECT COUNT(*) AS count
    FROM grind_economics
    WHERE status = 'paid_started'
      AND created_at >= ?
  `).bind(cutoffIso).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function countStalePaidRows(env: Env, cutoffIso: string): Promise<number> {
  if (!env.ECONOMICS_DB) return 0;
  const row = await env.ECONOMICS_DB.prepare(`
    SELECT COUNT(*) AS count
    FROM grind_economics
    WHERE status = 'paid_started'
      AND created_at < ?
  `).bind(cutoffIso).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function markStalePaidRowsErrored(env: Env, cutoffIso: string, reason: string): Promise<void> {
  if (!env.ECONOMICS_DB) return;
  await env.ECONOMICS_DB.prepare(`
    UPDATE grind_economics
    SET
      updated_at = ?,
      status = 'error',
      response_status = 504,
      error = ?
    WHERE status = 'paid_started'
      AND created_at < ?
  `).bind(
    new Date().toISOString(),
    trimLedgerError(reason),
    cutoffIso,
  ).run();
}

async function writeLedgerSafely(label: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (err) {
    logGrindEvent({
      event: "economics_ledger_error",
      operation: label,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runRunpodLeakCleanup(env: Env, reason = "scheduled"): Promise<RunpodLeakCleanupResult> {
  const pricing = getPricingConfig(env);
  const staleAfterMs = (pricing.failureTimeoutSecs + pricing.postJobIdleSecs + 60) * 1000;
  const cutoffIso = new Date(Date.now() - staleAfterMs).toISOString();
  const [runpod, activePaidRows, stalePaidRows] = await Promise.all([
    fetchRunpodTelemetry(env),
    countActivePaidRows(env, cutoffIso),
    countStalePaidRows(env, cutoffIso),
  ]);

  const jobs = runpod.health.jobs ?? {};
  const workers = runpod.health.workers ?? {};
  const activeJobs = (jobs.inQueue ?? 0) + (jobs.inProgress ?? 0);
  const warmWorkers = (workers.initializing ?? 0)
    + (workers.ready ?? 0)
    + (workers.running ?? 0)
    + (workers.idle ?? 0);
  const capacityEnabled = (runpod.config.workersMin ?? 0) > 0
    || (runpod.config.workersMax ?? 0) > 0
    || (runpod.config.workersStandby ?? 0) > 0;

  if (stalePaidRows > 0) {
    await markStalePaidRowsErrored(env, cutoffIso, "runpod_leak_cleanup_stale_paid_started");
  }

  const shouldCleanup = stalePaidRows > 0
    || (activePaidRows === 0 && (activeJobs > 0 || warmWorkers > 0 || capacityEnabled));

  if (!shouldCleanup) {
    return {
      action: "noop",
      reason,
      activePaidRows,
      stalePaidRows,
      activeJobs,
      warmWorkers,
      capacityEnabled,
    };
  }

  let purgedQueue = false;
  let pausedCapacity = false;
  if (activeJobs > 0) {
    try {
      await purgeRunpodQueue(env);
      purgedQueue = true;
    } catch (err) {
      logGrindEvent({
        event: "runpod_leak_cleanup_purge_failed",
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    await setRunpodWorkerCapacity(env, runpod.config, 0);
    pausedCapacity = true;
  } catch (err) {
    logGrindEvent({
      event: "runpod_leak_cleanup_pause_failed",
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const result: RunpodLeakCleanupResult = {
    action: "cleanup",
    reason,
    activePaidRows,
    stalePaidRows,
    activeJobs,
    warmWorkers,
    capacityEnabled,
    purgedQueue,
    pausedCapacity,
  };
  logGrindEvent({ event: "runpod_leak_cleanup", ...result });
  return result;
}

// ── Health check — no payment required ───────────────────────────────

app.get("/health", (c) => {
  const pricing = getPricingConfig(c.env);
  const runpodTimeoutMs = Math.round(pricing.failureTimeoutSecs * 1000);
  const referenceQuote = quoteReferencePrice(pricing);
  const avgGrindTime = totalGrinds > 0 ? totalGrindTimeMs / totalGrinds / 1000 : 0;
  const avgQueueTime = totalGrinds > 0 ? totalQueueTimeMs / totalGrinds / 1000 : 0;
  return c.json({
    ok: true,
    service: "grind-proxy",
    version: BACKEND_VERSION,
    timeout_ms: runpodTimeoutMs,
    total_grinds: totalGrinds,
    paid_requests: totalPaidRequests,
    failed_grinds: totalFailures,
    avg_grind_time: Math.round(avgGrindTime * 1000) / 1000,
    avg_queue_time: Math.round(avgQueueTime * 1000) / 1000,
    quoted_revenue_usd: Number(totalQuotedRevenueUsd.toFixed(3)),
    price: referenceQuote.price,
    pricing: {
      mode: "deterministic-per-request",
      reference_compute_secs: pricing.referenceComputeSecs,
      runpod_worker_cost_per_hour_usd: pricing.workerCostPerHourUsd,
      runpod_hashrate_hps: pricing.hashrateHps,
      runpod_startup_overhead_secs: pricing.startupOverheadSecs,
      runpod_post_job_idle_secs: pricing.postJobIdleSecs,
      runpod_min_billable_secs: pricing.minBillableSecs,
      runpod_time_buffer_multiplier: pricing.timeBufferMultiplier,
      runpod_container_disk_gb: pricing.containerDiskGb,
      runpod_storage_cost_per_gb_month_usd: pricing.storageCostPerGbMonthUsd,
      runpod_failure_allowance_rate: pricing.failureAllowanceRate,
      runpod_failure_timeout_secs: pricing.failureTimeoutSecs,
      runpod_max_workers_safe: pricing.maxWorkersSafe,
      settlement_gas_usd: pricing.settlementGasUsd,
      cloudflare_overhead_usd: pricing.cloudflareOverheadUsd,
      observability_overhead_usd: pricing.observabilityOverheadUsd,
      markup: pricing.markup,
      price_floor_usd: pricing.configuredPriceFloorUsd,
      min_gross_margin_usd: pricing.minGrossMarginUsd,
      min_gross_margin_pct: pricing.minGrossMarginPct,
      effective_price_floor_usd: Number(referenceQuote.effectiveFloorUsd.toFixed(3)),
      minimum_safe_price_usd: Number(referenceQuote.minimumPriceUsd.toFixed(3)),
      price_rounding_usd: pricing.priceRoundingUsd,
      reference_billable_secs: Number(referenceQuote.billableSecs.toFixed(3)),
      reference_worker_cost_usd: Number(referenceQuote.workerCostUsd.toFixed(6)),
      reference_storage_cost_usd: Number(referenceQuote.storageCostUsd.toFixed(6)),
      reference_failure_allowance_usd: Number(referenceQuote.failureAllowanceUsd.toFixed(6)),
      reference_cost_before_margin_usd: Number(referenceQuote.costBeforeMarginUsd.toFixed(6)),
      reference_gross_margin_usd: Number(referenceQuote.grossMarginUsd.toFixed(6)),
      reference_raw_cost_usd: Number(referenceQuote.rawCostUsd.toFixed(6)),
      reference_price_usd: Number(referenceQuote.priceUsd.toFixed(3)),
    },
  });
});

app.get("/ops/economics", async (c) => {
  const pricing = getPricingConfig(c.env);
  const referenceQuote = quoteReferencePrice(pricing);
  try {
    const runpod = await fetchRunpodTelemetryCached(c.env, true);
    const allowPausedAutostart = canAutostartRunpod(c.env, runpod.config);
    const safety = assessRunpodSafety(runpod, pricing, { allowPausedAutostart });
    const warnings = buildEconomicsWarnings(runpod, pricing, safety, referenceQuote);
    const ledger = await getEconomicsLedgerStatus(c.env);
    return c.json({
      ok: true,
      service: "grind-proxy",
      version: BACKEND_VERSION,
      endpoint_id: runpod.endpointId,
      pricing: {
        mode: "deterministic-per-request",
        runpod_worker_cost_per_hour_usd: pricing.workerCostPerHourUsd,
        runpod_hashrate_hps: pricing.hashrateHps,
        runpod_startup_overhead_secs: pricing.startupOverheadSecs,
        runpod_post_job_idle_secs: pricing.postJobIdleSecs,
        runpod_min_billable_secs: pricing.minBillableSecs,
        runpod_time_buffer_multiplier: pricing.timeBufferMultiplier,
        runpod_container_disk_gb: pricing.containerDiskGb,
        runpod_storage_cost_per_gb_month_usd: pricing.storageCostPerGbMonthUsd,
        runpod_failure_allowance_rate: pricing.failureAllowanceRate,
        runpod_failure_timeout_secs: pricing.failureTimeoutSecs,
        runpod_max_workers_safe: pricing.maxWorkersSafe,
        settlement_gas_usd: pricing.settlementGasUsd,
        cloudflare_overhead_usd: pricing.cloudflareOverheadUsd,
        observability_overhead_usd: pricing.observabilityOverheadUsd,
        markup: pricing.markup,
        price_floor_usd: pricing.configuredPriceFloorUsd,
        min_gross_margin_usd: pricing.minGrossMarginUsd,
        min_gross_margin_pct: pricing.minGrossMarginPct,
        effective_price_floor_usd: Number(referenceQuote.effectiveFloorUsd.toFixed(3)),
        minimum_safe_price_usd: Number(referenceQuote.minimumPriceUsd.toFixed(3)),
        price_rounding_usd: pricing.priceRoundingUsd,
        reference_compute_secs: pricing.referenceComputeSecs,
        reference_price_usd: Number(referenceQuote.priceUsd.toFixed(3)),
        reference_billable_secs: Number(referenceQuote.billableSecs.toFixed(3)),
        reference_cost_before_margin_usd: Number(referenceQuote.costBeforeMarginUsd.toFixed(6)),
        reference_gross_margin_usd: Number(referenceQuote.grossMarginUsd.toFixed(6)),
      },
      safe_to_serve: safety.safe,
      runpod_autopause_enabled: runpodAutopauseEnabled(c.env),
      paused_autostart_ready: allowPausedAutostart && (runpod.config.workersMax ?? 0) < 1,
      blocking_reasons: safety.reasons,
      runpod: {
        config: {
          workersMin: runpod.config.workersMin,
          workersMax: runpod.config.workersMax,
          workersStandby: runpod.config.workersStandby,
          idleTimeout: runpod.config.idleTimeout,
          scalerType: runpod.config.scalerType,
          scalerValue: runpod.config.scalerValue,
          gpuTypeIds: runpod.config.gpuTypeIds,
          flashboot: runpod.config.flashboot,
          executionTimeoutMs: runpod.config.executionTimeoutMs,
          observedMaxWorkerCostPerHourUsd: safety.maxObservedWorkerCostPerHourUsd === null
            ? null
            : Number(safety.maxObservedWorkerCostPerHourUsd.toFixed(3)),
        },
        health: runpod.health,
      },
      local_metrics: {
        total_grinds: totalGrinds,
        paid_requests: totalPaidRequests,
        failed_grinds: totalFailures,
        quoted_revenue_usd: Number(totalQuotedRevenueUsd.toFixed(3)),
      },
      ledger,
      warnings,
    });
  } catch (err) {
    return c.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      pricing: {
        mode: "deterministic-per-request",
        reference_price_usd: Number(referenceQuote.priceUsd.toFixed(3)),
      },
    }, 502);
  }
});

app.get("/ops/ledger", async (c) => {
  const ledger = await getEconomicsLedgerStatus(c.env);
  if (!ledger.configured || !ledger.healthy || !c.env.ECONOMICS_DB) {
    return c.json({ ok: false, ledger }, 503);
  }

  const limitRaw = Number(c.req.query("limit") ?? 20);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 20;
  const from = c.req.query("from");
  const to = c.req.query("to");
  const filters: string[] = [];
  const params: string[] = [];
  if (from) {
    filters.push("created_at >= ?");
    params.push(from);
  }
  if (to) {
    filters.push("created_at <= ?");
    params.push(to);
  }
  const whereSql = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const [totals, byStatus, recent] = await Promise.all([
    c.env.ECONOMICS_DB.prepare(`
      SELECT
        COUNT(*) AS attempts,
        COALESCE(SUM(price_usd), 0) AS quoted_revenue_usd,
        COALESCE(SUM(cost_before_margin_usd), 0) AS estimated_cost_before_margin_usd,
        COALESCE(SUM(gross_margin_usd), 0) AS estimated_gross_margin_usd
      FROM grind_economics
      ${whereSql}
    `).bind(...params).first(),
    c.env.ECONOMICS_DB.prepare(`
      SELECT
        status,
        COUNT(*) AS attempts,
        COALESCE(SUM(price_usd), 0) AS quoted_revenue_usd,
        COALESCE(SUM(cost_before_margin_usd), 0) AS estimated_cost_before_margin_usd,
        COALESCE(SUM(gross_margin_usd), 0) AS estimated_gross_margin_usd
      FROM grind_economics
      ${whereSql}
      GROUP BY status
      ORDER BY status
    `).bind(...params).all(),
    c.env.ECONOMICS_DB.prepare(`
      SELECT
        request_id,
        created_at,
        updated_at,
        status,
        price,
        price_usd,
        cost_before_margin_usd,
        gross_margin_usd,
        billable_secs,
        queue_time_ms,
        compute_time_ms,
        elapsed_secs,
        response_status,
        runpod_http_status,
        runpod_status,
        error
      FROM grind_economics
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(...params, limit).all(),
  ]);

  return c.json({
    ok: true,
    ledger,
    range: {
      from: from ?? null,
      to: to ?? null,
    },
    totals,
    by_status: byStatus.results ?? [],
    recent: recent.results ?? [],
  });
});

app.get("/price", (c) => {
  const pricing = getPricingConfig(c.env);
  const target = c.req.query("target");
  const quote = target ? (() => {
    try {
      const targetBigInt = BigInt(target);
      if (targetBigInt <= 0n) throw new Error("invalid");
      return quotePriceFromTarget(targetBigInt, pricing);
    } catch {
      return null;
    }
  })() : quoteReferencePrice(pricing);

  if (!quote) {
    return c.json({ error: "Invalid target query param" }, 400);
  }

  return c.json({
    ok: true,
    price: quote.price,
    price_usd: Number(quote.priceUsd.toFixed(3)),
    minimum_safe_price_usd: Number(quote.minimumPriceUsd.toFixed(3)),
    effective_price_floor_usd: Number(quote.effectiveFloorUsd.toFixed(3)),
    estimated_compute_secs: Number(quote.estimatedComputeSecs.toFixed(3)),
    billable_secs: Number(quote.billableSecs.toFixed(3)),
    worker_cost_usd: Number(quote.workerCostUsd.toFixed(6)),
    storage_cost_usd: Number(quote.storageCostUsd.toFixed(6)),
    settlement_gas_usd: Number(quote.settlementGasUsd.toFixed(6)),
    cloudflare_overhead_usd: Number(quote.cloudflareOverheadUsd.toFixed(6)),
    observability_overhead_usd: Number(quote.observabilityOverheadUsd.toFixed(6)),
    failure_allowance_usd: Number(quote.failureAllowanceUsd.toFixed(6)),
    cost_before_margin_usd: Number(quote.costBeforeMarginUsd.toFixed(6)),
    minimum_gross_margin_usd: Number(quote.minimumGrossMarginUsd.toFixed(6)),
    gross_margin_usd: Number(quote.grossMarginUsd.toFixed(6)),
    raw_cost_usd: Number(quote.rawCostUsd.toFixed(6)),
    expected_hashes: quote.expectedHashes.toString(),
  });
});

// ── Debug — test RPC connectivity from Worker ────────────────────────

app.get("/debug/rpc", async (c) => {
  const results: Record<string, unknown> = {};
  try {
    const rpcUrl = getRpcUrl(c.env);
    results.rpcUrl = rpcUrl;
    const pub = createPublicClient({ chain: base, transport: http(rpcUrl) });
    const blockNumber = await pub.getBlockNumber();
    results.blockNumber = blockNumber.toString();

    // Check USDC contract name + version (used in EIP-712 domain)
    const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`;
    const name = await pub.readContract({
      address: usdc,
      abi: [{ name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }],
      functionName: "name",
    });
    results.usdcName = name;

    const version = await pub.readContract({
      address: usdc,
      abi: [{ name: "version", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }],
      functionName: "version",
    });
    results.usdcVersion = version;

    // Check if facilitator wallet is configured
    const account = privateKeyToAccount(c.env.FACILITATOR_PRIVATE_KEY as `0x${string}`);
    results.facilitatorAddress = account.address;
    const ethBal = await pub.getBalance({ address: account.address });
    results.facilitatorEth = (Number(ethBal) / 1e18).toFixed(6);

    results.ok = true;
  } catch (err) {
    results.ok = false;
    results.error = err instanceof Error ? err.message : String(err);
  }
  return c.json(results);
});

// ── x402 payment gate — dynamic pricing ─────────────────────────────
// Price must be deterministic across Cloudflare isolates because x402 is a
// 2-step flow (402 -> paid retry). Price is therefore derived only from the
// request body and env-configured cost assumptions.

const middlewareCache = new Map<string, MiddlewareHandler>();

app.use("/grind", async (c, next) => {
  let body: GrindRequestBody;
  try {
    body = await c.req.raw.clone().json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const validated = validateAndNormalizeRequest(body);
  if ("error" in validated) {
    return c.json({ error: validated.error }, 400);
  }

  const pricing = getPricingConfig(c.env);
  let runpod: RunpodTelemetry;
  try {
    runpod = await fetchRunpodTelemetryCached(c.env);
  } catch (err) {
    return c.json({
      error: "RunPod safety check failed",
      detail: err instanceof Error ? err.message : String(err),
    }, 502);
  }
  const safety = assessRunpodSafety(runpod, pricing, {
    allowPausedAutostart: canAutostartRunpod(c.env, runpod.config),
  });
  if (!safety.safe) {
    logGrindEvent({
      event: "billing_safety_block",
      endpointId: runpod.endpointId,
      reasons: safety.reasons,
    });
    return c.json({
      error: "RunPod backend is in unsafe billing configuration",
      endpoint_id: runpod.endpointId,
      reasons: safety.reasons,
    }, 503);
  }

  const ledger = await getEconomicsLedgerStatus(c.env);
  if (!ledger.healthy) {
    logGrindEvent({
      event: "billing_safety_block",
      endpointId: runpod.endpointId,
      reasons: [ledger.error ?? "economics ledger is unavailable"],
    });
    return c.json({
      error: "Economics ledger is unavailable",
      endpoint_id: runpod.endpointId,
      ledger,
    }, 503);
  }

  const currentPrice = quotePriceFromTarget(validated.target, pricing).price;
  let cachedMw = middlewareCache.get(currentPrice);

  if (!cachedMw) {
    const account = privateKeyToAccount(c.env.FACILITATOR_PRIVATE_KEY as `0x${string}`);
    const rpcUrl = getRpcUrl(c.env);
    const client = createWalletClient({
      account,
      chain: base,
      transport: http(rpcUrl),
    }).extend(publicActions);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signer = toFacilitatorEvmSigner(client as any);
    const facilitator = new x402Facilitator();
    registerExactEvmScheme(facilitator, {
      signer,
      networks: "eip155:8453",
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const facilitatorClient: any = {
      verify: facilitator.verify.bind(facilitator),
      settle: facilitator.settle.bind(facilitator),
      getSupported: async () => facilitator.getSupported(),
    };

    const resourceServer = new x402ResourceServer(
      [facilitatorClient],
    ).register("eip155:8453", new (await import("@x402/evm/exact/server")).ExactEvmScheme());

    cachedMw = paymentMiddleware(
      {
        "POST /grind": {
          accepts: {
            scheme: "exact",
            price: currentPrice,
            network: "eip155:8453",
            payTo: c.env.SERVICE_WALLET as `0x${string}`,
          },
          description: "GPU nonce grinding for APoW mining",
        },
      },
      resourceServer,
    );
    middlewareCache.set(currentPrice, cachedMw);
    if (middlewareCache.size > 16) {
      const firstKey = middlewareCache.keys().next().value;
      if (firstKey) middlewareCache.delete(firstKey);
    }
  }

  return cachedMw(c, next);
});

// ── Grind handler ────────────────────────────────────────────────────

app.post("/grind", async (c) => {
  const requestId = crypto.randomUUID();
  const queueStart = Date.now();

  const body = await c.req.json<GrindRequestBody>();
  const validated = validateAndNormalizeRequest(body);
  if ("error" in validated) {
    return c.json({ error: validated.error }, 400);
  }
  const { challenge, target: targetBigInt, address } = validated;
  const pricing = getPricingConfig(c.env);
  const quote = quotePriceFromTarget(targetBigInt, pricing);
  const runpodTimeoutMs = Math.round(pricing.failureTimeoutSecs * 1000);
  totalPaidRequests++;
  totalQuotedRevenueUsd += quote.priceUsd;

  // Normalize target to 0x-prefixed 64-char hex
  const targetHex = "0x" + targetBigInt.toString(16).padStart(64, "0");
  const endpointId = extractRunpodEndpointId(c.env.RUNPOD_ENDPOINT) ?? "unknown";
  const ledgerRow = buildInitialGrindLedgerRow({
    requestId,
    now: new Date().toISOString(),
    address,
    challenge,
    targetHex,
    quote,
    endpointId,
  });
  await writeLedgerSafely("insert_paid_started", () => insertGrindLedgerRow(c.env, ledgerRow));

  let capacityLease: RunpodCapacityLease | null = null;
  try {
  try {
    capacityLease = await acquireRunpodCapacityLease(c.env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    totalFailures++;
    await writeLedgerSafely("update_capacity_resume_error", () => updateGrindLedgerRow(c.env, requestId, {
      status: "error",
      responseStatus: 503,
      queueTimeMs: Date.now() - queueStart,
      computeTimeMs: 0,
      error: `runpod_capacity_resume_failed: ${message}`,
    }));
    return c.json({
      error: "RunPod capacity resume failed",
      detail: message,
    }, 503);
  }

  // Dispatch to RunPod serverless (sync — blocks until nonce found or timeout)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), runpodTimeoutMs);

  const computeStart = Date.now();
  let resp: Response;
  try {
    resp = await fetch(`${c.env.RUNPOD_ENDPOINT}/runsync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${c.env.RUNPOD_API_KEY}`,
      },
      body: JSON.stringify({
        input: { challenge, target: targetHex, address },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const computeTimeMs = Date.now() - computeStart;
    const queueTimeMs = computeStart - queueStart;
    const result = err instanceof DOMException && err.name === "AbortError" ? "timeout" : "backend_unreachable";
    const responseStatus = result === "timeout" ? 504 : 502;
    logGrindEvent({
      event: "grind_error",
      requestId,
      result,
      priceUsd: Number(quote.priceUsd.toFixed(3)),
      billableSecs: Number(quote.billableSecs.toFixed(3)),
      queueTimeMs,
      computeTimeMs,
    });
    await writeLedgerSafely("update_backend_fetch_error", () => updateGrindLedgerRow(c.env, requestId, {
      status: "error",
      responseStatus,
      queueTimeMs,
      computeTimeMs,
      error: result,
    }));
    if (result === "timeout") {
      return c.json({ error: `Grind timed out (${pricing.failureTimeoutSecs}s)` }, 504);
    }
    return c.json({ error: "RunPod backend unreachable" }, 502);
  }
  clearTimeout(timeout);

  let computeTimeMs = Date.now() - computeStart;
  const queueTimeMs = computeStart - queueStart;

  if (!resp.ok) {
    totalFailures++;
    const errBody = await resp.text().catch(() => "");
    logGrindEvent({
      event: "grind_error",
      requestId,
      result: "runpod_http_error",
      runpodStatus: resp.status,
      priceUsd: Number(quote.priceUsd.toFixed(3)),
      billableSecs: Number(quote.billableSecs.toFixed(3)),
      queueTimeMs,
      computeTimeMs,
    });
    await writeLedgerSafely("update_runpod_http_error", () => updateGrindLedgerRow(c.env, requestId, {
      status: "error",
      responseStatus: 502,
      runpodHttpStatus: resp.status,
      queueTimeMs,
      computeTimeMs,
      error: `RunPod HTTP ${resp.status}: ${errBody.slice(0, 200)}`,
    }));
    return c.json(
      { error: `RunPod error: HTTP ${resp.status}`, detail: errBody.slice(0, 500) },
      502,
      {
        "X-Grind-Request-Id": requestId,
        "X-Grind-Queue-Time": `${queueTimeMs}ms`,
        "X-Grind-Compute-Time": `${computeTimeMs}ms`,
        "X-Grind-Price": quote.price,
        "X-Grind-Billable-Secs": quote.billableSecs.toFixed(3),
      },
    );
  }

  const rawText = await resp.text();
  let data: RunpodJobResponse;
  try {
    data = JSON.parse(rawText);
  } catch {
    totalFailures++;
    logGrindEvent({
      event: "grind_error",
      requestId,
      result: "invalid_runpod_json",
      priceUsd: Number(quote.priceUsd.toFixed(3)),
      billableSecs: Number(quote.billableSecs.toFixed(3)),
      queueTimeMs,
      computeTimeMs,
    });
    await writeLedgerSafely("update_invalid_runpod_json", () => updateGrindLedgerRow(c.env, requestId, {
      status: "error",
      responseStatus: 502,
      queueTimeMs,
      computeTimeMs,
      error: `RunPod returned invalid JSON: ${rawText.slice(0, 200)}`,
    }));
    return c.json({ error: "RunPod returned invalid JSON", detail: rawText.slice(0, 500) }, 502);
  }

  if (isRunpodPendingStatus(data.status) && data.id) {
    try {
      data = await waitForRunpodTerminalJob(
        c.env,
        data,
        computeStart + runpodTimeoutMs,
        controller.signal,
      );
      computeTimeMs = Date.now() - computeStart;
    } catch (err) {
      totalFailures++;
      computeTimeMs = Date.now() - computeStart;
      logGrindEvent({
        event: "grind_error",
        requestId,
        result: "runpod_status_error",
        runpodJobId: data.id,
        status: data.status,
        priceUsd: Number(quote.priceUsd.toFixed(3)),
        billableSecs: Number(quote.billableSecs.toFixed(3)),
        queueTimeMs,
        computeTimeMs,
      });
      await writeLedgerSafely("update_runpod_status_error", () => updateGrindLedgerRow(c.env, requestId, {
        status: "error",
        responseStatus: 502,
        runpodStatus: data.status ?? null,
        queueTimeMs,
        computeTimeMs,
        error: err instanceof Error ? err.message : String(err),
      }));
      return c.json({ error: "RunPod status polling failed" }, 502);
    }
  }

  if (isRunpodPendingStatus(data.status)) {
    totalFailures++;
    computeTimeMs = Date.now() - computeStart;
    if (data.id) {
      await writeLedgerSafely("cancel_runpod_timeout", () => cancelRunpodJob(c.env, data.id as string));
    }
    logGrindEvent({
      event: "grind_error",
      requestId,
      result: "runpod_timeout_pending",
      runpodJobId: data.id,
      status: data.status,
      priceUsd: Number(quote.priceUsd.toFixed(3)),
      billableSecs: Number(quote.billableSecs.toFixed(3)),
      queueTimeMs,
      computeTimeMs,
    });
    await writeLedgerSafely("update_runpod_timeout_pending", () => updateGrindLedgerRow(c.env, requestId, {
      status: "error",
      responseStatus: 504,
      runpodStatus: data.status ?? null,
      queueTimeMs,
      computeTimeMs,
      error: "runpod_timeout_pending",
    }));
    return c.json(
      { error: "RunPod job did not complete before timeout", status: data.status },
      504,
      {
        "X-Grind-Request-Id": requestId,
        "X-Grind-Queue-Time": `${queueTimeMs}ms`,
        "X-Grind-Compute-Time": `${computeTimeMs}ms`,
        "X-Grind-Price": quote.price,
        "X-Grind-Billable-Secs": quote.billableSecs.toFixed(3),
      },
    );
  }

  if (data.status === "COMPLETED" && data.output?.nonce) {
    const nonce = data.output.nonce;
    const elapsedSecs = data.output.elapsed ?? 0;
    // Update metrics
    totalGrinds++;
    totalGrindTimeMs += computeTimeMs;
    totalQueueTimeMs += queueTimeMs;
    logGrindEvent({
      event: "grind_success",
      requestId,
      priceUsd: Number(quote.priceUsd.toFixed(3)),
      billableSecs: Number(quote.billableSecs.toFixed(3)),
      queueTimeMs,
      computeTimeMs,
      elapsedSecs,
    });
    await writeLedgerSafely("update_grind_success", () => updateGrindLedgerRow(c.env, requestId, {
      status: "success",
      responseStatus: 200,
      runpodStatus: data.status ?? null,
      queueTimeMs,
      computeTimeMs,
      elapsedSecs,
      nonce,
    }));

    return c.json(
      {
        nonce,
        elapsed: elapsedSecs,
      },
      200,
      {
        "X-Grind-Request-Id": requestId,
        "X-Grind-Queue-Time": `${queueTimeMs}ms`,
        "X-Grind-Compute-Time": `${computeTimeMs}ms`,
        "X-Grind-Price": quote.price,
        "X-Grind-Billable-Secs": quote.billableSecs.toFixed(3),
      },
    );
  }

  totalFailures++;
  logGrindEvent({
    event: "grind_error",
    requestId,
    result: data.output?.error ?? data.error ?? "grind_failed",
    status: data.status,
    priceUsd: Number(quote.priceUsd.toFixed(3)),
    billableSecs: Number(quote.billableSecs.toFixed(3)),
    queueTimeMs,
    computeTimeMs,
  });
  await writeLedgerSafely("update_grind_failed", () => updateGrindLedgerRow(c.env, requestId, {
    status: "error",
    responseStatus: 502,
    runpodStatus: data.status ?? null,
    queueTimeMs,
    computeTimeMs,
    error: data.output?.error ?? data.error ?? "grind_failed",
  }));
  return c.json(
    {
      error: data.output?.error ?? data.error ?? "Grind failed",
      status: data.status,
      raw: rawText.slice(0, 500),
    },
    502,
    {
      "X-Grind-Request-Id": requestId,
      "X-Grind-Queue-Time": `${queueTimeMs}ms`,
      "X-Grind-Compute-Time": `${computeTimeMs}ms`,
      "X-Grind-Price": quote.price,
      "X-Grind-Billable-Secs": quote.billableSecs.toFixed(3),
    },
  );
  } finally {
    await releaseRunpodCapacityLease(c.env, capacityLease);
  }
});

export {
  RUNPOD_4090_PRO_FLEX_COST_PER_HOUR_USD,
  assessRunpodSafety,
  buildInitialGrindLedgerRow,
  buildEconomicsWarnings,
  economicsLedgerRequired,
  getPricingConfig,
  isRunpodPendingStatus,
  quotePriceFromEstimatedComputeSecs,
  quotePriceFromTarget,
  quoteReferencePrice,
  runRunpodLeakCleanup,
};
export type {
  PriceQuote,
  PricingConfig,
  GrindEconomicsLedgerRow,
  RunpodEndpointConfig,
  RunpodEndpointHealth,
  RunpodSafetyAssessment,
  RunpodTelemetry,
};

const worker: ExportedHandler<Env> = {
  fetch: app.fetch,
  scheduled(_event, env, ctx) {
    ctx.waitUntil(runRunpodLeakCleanup(env, "scheduled"));
  },
};

export default worker;
