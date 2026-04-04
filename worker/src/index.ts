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
  SERVICE_WALLET: string;
  FACILITATOR_PRIVATE_KEY: string;
  RPC_URL?: string;
  RUNPOD_GPU_COST_PER_HOUR_USD?: string;
  RUNPOD_HASHRATE_HPS?: string;
  RUNPOD_STARTUP_OVERHEAD_SECS?: string;
  RUNPOD_MIN_BILLABLE_SECS?: string;
  RUNPOD_TIME_BUFFER_MULTIPLIER?: string;
  SETTLEMENT_GAS_USD?: string;
  PRICE_MARKUP?: string;
  PRICE_FLOOR_USD?: string;
  PRICE_ROUNDING_USD?: string;
  PRICE_REFERENCE_COMPUTE_SECS?: string;
}

// Free Base RPCs — fallback chain if RPC_URL not set
// NOTE: base.llamarpc.com returns Cloudflare challenges from Workers — keep it last
const BASE_RPC_URLS = [
  "https://mainnet.base.org",
  "https://1rpc.io/base",
  "https://base-mainnet.public.blastapi.io",
  "https://base.llamarpc.com",
];

const app = new Hono<{ Bindings: Env }>();

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

type PricingConfig = {
  gpuCostPerHourUsd: number;
  hashrateHps: number;
  startupOverheadSecs: number;
  minBillableSecs: number;
  timeBufferMultiplier: number;
  settlementGasUsd: number;
  markup: number;
  priceFloorUsd: number;
  priceRoundingUsd: number;
  referenceComputeSecs: number;
};

type PriceQuote = {
  priceUsd: number;
  price: string;
  expectedHashes: bigint;
  estimatedComputeSecs: number;
  billableSecs: number;
  gpuCostUsd: number;
  gasCostUsd: number;
  rawCostUsd: number;
};

type GrindRequestBody = {
  challenge?: string;
  target?: string;
  address?: string;
};

function parseEnvNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getPricingConfig(env: Env): PricingConfig {
  return {
    gpuCostPerHourUsd: parseEnvNumber(env.RUNPOD_GPU_COST_PER_HOUR_USD, 0.59),
    hashrateHps: parseEnvNumber(env.RUNPOD_HASHRATE_HPS, 20_000_000_000),
    startupOverheadSecs: parseEnvNumber(env.RUNPOD_STARTUP_OVERHEAD_SECS, 8),
    minBillableSecs: parseEnvNumber(env.RUNPOD_MIN_BILLABLE_SECS, 1),
    timeBufferMultiplier: parseEnvNumber(env.RUNPOD_TIME_BUFFER_MULTIPLIER, 1.25),
    settlementGasUsd: parseEnvNumber(env.SETTLEMENT_GAS_USD, 0.001),
    markup: parseEnvNumber(env.PRICE_MARKUP, 1.5),
    priceFloorUsd: parseEnvNumber(env.PRICE_FLOOR_USD, 0.004),
    priceRoundingUsd: parseEnvNumber(env.PRICE_ROUNDING_USD, 0.001),
    referenceComputeSecs: parseEnvNumber(env.PRICE_REFERENCE_COMPUTE_SECS, 15),
  };
}

function roundUpPrice(priceUsd: number, incrementUsd: number): number {
  const increment = incrementUsd > 0 ? incrementUsd : 0.001;
  return Math.ceil(priceUsd / increment) * increment;
}

function formatUsd(priceUsd: number): string {
  return `$${priceUsd.toFixed(3)}`;
}

function quotePriceFromTarget(target: bigint, pricing: PricingConfig): PriceQuote {
  const expectedHashes = target > 0n ? TWO_POW_256 / target : 0n;
  const estimatedComputeSecs = target > 0n ? Number(expectedHashes) / pricing.hashrateHps : pricing.referenceComputeSecs;
  const safeEstimatedSecs = Number.isFinite(estimatedComputeSecs) && estimatedComputeSecs > 0
    ? estimatedComputeSecs
    : pricing.referenceComputeSecs;
  const billableSecs = Math.max(
    pricing.minBillableSecs,
    safeEstimatedSecs * pricing.timeBufferMultiplier + pricing.startupOverheadSecs,
  );
  const gpuCostUsd = billableSecs * (pricing.gpuCostPerHourUsd / 3600);
  const gasCostUsd = pricing.settlementGasUsd;
  const rawCostUsd = (gpuCostUsd + gasCostUsd) * pricing.markup;
  const priceUsd = Math.max(
    pricing.priceFloorUsd,
    roundUpPrice(rawCostUsd, pricing.priceRoundingUsd),
  );
  return {
    priceUsd,
    price: formatUsd(priceUsd),
    expectedHashes,
    estimatedComputeSecs: safeEstimatedSecs,
    billableSecs,
    gpuCostUsd,
    gasCostUsd,
    rawCostUsd,
  };
}

function quoteReferencePrice(pricing: PricingConfig): PriceQuote {
  const billableSecs = Math.max(
    pricing.minBillableSecs,
    pricing.referenceComputeSecs * pricing.timeBufferMultiplier + pricing.startupOverheadSecs,
  );
  const gpuCostUsd = billableSecs * (pricing.gpuCostPerHourUsd / 3600);
  const gasCostUsd = pricing.settlementGasUsd;
  const rawCostUsd = (gpuCostUsd + gasCostUsd) * pricing.markup;
  const priceUsd = Math.max(
    pricing.priceFloorUsd,
    roundUpPrice(rawCostUsd, pricing.priceRoundingUsd),
  );
  return {
    priceUsd,
    price: formatUsd(priceUsd),
    expectedHashes: 0n,
    estimatedComputeSecs: pricing.referenceComputeSecs,
    billableSecs,
    gpuCostUsd,
    gasCostUsd,
    rawCostUsd,
  };
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

// ── Health check — no payment required ───────────────────────────────

app.get("/health", (c) => {
  const pricing = getPricingConfig(c.env);
  const referenceQuote = quoteReferencePrice(pricing);
  const avgGrindTime = totalGrinds > 0 ? totalGrindTimeMs / totalGrinds / 1000 : 0;
  const avgQueueTime = totalGrinds > 0 ? totalQueueTimeMs / totalGrinds / 1000 : 0;
  return c.json({
    ok: true,
    service: "grind-proxy",
    version: BACKEND_VERSION,
    timeout_ms: RUNPOD_TIMEOUT_MS,
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
      runpod_gpu_cost_per_hour_usd: pricing.gpuCostPerHourUsd,
      runpod_hashrate_hps: pricing.hashrateHps,
      runpod_startup_overhead_secs: pricing.startupOverheadSecs,
      runpod_min_billable_secs: pricing.minBillableSecs,
      runpod_time_buffer_multiplier: pricing.timeBufferMultiplier,
      settlement_gas_usd: pricing.settlementGasUsd,
      markup: pricing.markup,
      price_floor_usd: pricing.priceFloorUsd,
      price_rounding_usd: pricing.priceRoundingUsd,
      reference_billable_secs: Number(referenceQuote.billableSecs.toFixed(3)),
      reference_gpu_cost_usd: Number(referenceQuote.gpuCostUsd.toFixed(6)),
      reference_raw_cost_usd: Number(referenceQuote.rawCostUsd.toFixed(6)),
      reference_price_usd: Number(referenceQuote.priceUsd.toFixed(3)),
    },
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
    estimated_compute_secs: Number(quote.estimatedComputeSecs.toFixed(3)),
    billable_secs: Number(quote.billableSecs.toFixed(3)),
    gpu_cost_usd: Number(quote.gpuCostUsd.toFixed(6)),
    gas_cost_usd: Number(quote.gasCostUsd.toFixed(6)),
    raw_cost_usd: Number(quote.rawCostUsd.toFixed(6)),
    expected_hashes: quote.expectedHashes.toString(),
  });
});

// ── Debug — test RPC connectivity from Worker ────────────────────────

app.get("/debug/rpc", async (c) => {
  const results: Record<string, unknown> = {};
  try {
    const rpcUrl = c.env.RPC_URL ?? BASE_RPC_URLS[0];
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
  const currentPrice = quotePriceFromTarget(validated.target, pricing).price;
  let cachedMw = middlewareCache.get(currentPrice);

  if (!cachedMw) {
    const account = privateKeyToAccount(c.env.FACILITATOR_PRIVATE_KEY as `0x${string}`);
    const rpcUrl = c.env.RPC_URL ?? BASE_RPC_URLS[0];
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

const RUNPOD_TIMEOUT_MS = 120_000;

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
  totalPaidRequests++;
  totalQuotedRevenueUsd += quote.priceUsd;

  // Normalize target to 0x-prefixed 64-char hex
  const targetHex = "0x" + targetBigInt.toString(16).padStart(64, "0");

  // Dispatch to RunPod serverless (sync — blocks until nonce found or timeout)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RUNPOD_TIMEOUT_MS);

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
    if (err instanceof DOMException && err.name === "AbortError") {
      return c.json({ error: "Grind timed out (120s)" }, 504);
    }
    return c.json({ error: "RunPod backend unreachable" }, 502);
  }
  clearTimeout(timeout);

  const computeTimeMs = Date.now() - computeStart;
  const queueTimeMs = computeStart - queueStart;

  if (!resp.ok) {
    totalFailures++;
    const errBody = await resp.text().catch(() => "");
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
  let data: {
    status?: string;
    output?: { nonce?: string; elapsed?: number; error?: string };
    error?: string;
  };
  try {
    data = JSON.parse(rawText);
  } catch {
    totalFailures++;
    return c.json({ error: "RunPod returned invalid JSON", detail: rawText.slice(0, 500) }, 502);
  }

  if (data.status === "COMPLETED" && data.output?.nonce) {
    // Update metrics
    totalGrinds++;
    totalGrindTimeMs += computeTimeMs;
    totalQueueTimeMs += queueTimeMs;

    return c.json(
      {
        nonce: data.output.nonce,
        elapsed: data.output.elapsed ?? 0,
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
});

export default app;
