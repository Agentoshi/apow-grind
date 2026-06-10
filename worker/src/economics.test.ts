import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNPOD_4090_PRO_FLEX_COST_PER_HOUR_USD,
  assessRunpodSafety,
  assessWalletSplit,
  buildInitialGrindLedgerRow,
  economicsLedgerRequired,
  getPricingConfig,
  isRunpodPendingStatus,
  quotePriceFromTarget,
  quoteReferencePrice,
} from "./index.js";
import type { RunpodTelemetry } from "./index.js";

const safeRunpod: RunpodTelemetry = {
  endpointId: "endpoint-test",
  config: {
    id: "endpoint-test",
    name: "apow-grind-test",
    workersMin: 0,
    workersMax: 1,
    workersStandby: 0,
    idleTimeout: 5,
    scalerType: "QUEUE_DELAY",
    scalerValue: 4,
    templateId: "template-test",
    gpuCount: 1,
    gpuTypeIds: ["NVIDIA GeForce RTX 4090"],
    flashboot: false,
    executionTimeoutMs: 120_000,
  },
  health: {
    jobs: { completed: 0, failed: 0, inProgress: 0, inQueue: 0, retried: 0 },
    workers: { idle: 0, initializing: 0, ready: 0, running: 0, throttled: 0, unhealthy: 0 },
  },
};

test("default pricing is above current official 4090 flex cost and has positive margin", () => {
  const pricing = getPricingConfig({});
  assert.equal(pricing.workerCostPerHourUsd, 1.25);
  assert.ok(pricing.workerCostPerHourUsd > RUNPOD_4090_PRO_FLEX_COST_PER_HOUR_USD);
  assert.equal(pricing.maxWorkersSafe, 1);
  assert.equal(pricing.failureAllowanceRate, 1.0);
  assert.equal(pricing.startupOverheadSecs, 120);
  assert.equal(pricing.failureTimeoutSecs, 300);

  const quote = quoteReferencePrice(pricing);
  assert.equal(quote.billableSecs, 143.75);
  assert.ok(quote.priceUsd > quote.costBeforeMarginUsd);
  assert.ok(quote.grossMarginUsd >= pricing.minGrossMarginUsd);
  assert.ok(quote.storageCostUsd > 0);
  assert.ok(quote.failureAllowanceUsd > 0);
  assert.ok(quote.priceUsd >= 0.301);
});

test("RunPod standby capacity blocks paid serving before x402 payment", () => {
  const pricing = getPricingConfig({});
  const runpod = {
    ...safeRunpod,
    config: { ...safeRunpod.config, workersStandby: 5 },
  };
  const safety = assessRunpodSafety(runpod, pricing);
  assert.equal(safety.safe, false);
  assert.ok(safety.reasons.some((reason) => reason.includes("workersStandby=5")));
});

test("worker cost below official flex GPU floor blocks serving", () => {
  const pricing = getPricingConfig({ RUNPOD_WORKER_COST_PER_HOUR_USD: "0.80" });
  const safety = assessRunpodSafety(safeRunpod, pricing);
  assert.equal(safety.safe, false);
  assert.ok(safety.reasons.some((reason) => reason.includes("official flex GPU floor")));
});

test("workersMax above configured safety cap blocks serving", () => {
  const pricing = getPricingConfig({ RUNPOD_MAX_WORKERS_SAFE: "1" });
  const runpod = {
    ...safeRunpod,
    config: { ...safeRunpod.config, workersMax: 5 },
  };
  const safety = assessRunpodSafety(runpod, pricing);
  assert.equal(safety.safe, false);
  assert.ok(safety.reasons.some((reason) => reason.includes("workersMax=5")));
});

test("workersMax zero blocks serving because the backend is paused", () => {
  const pricing = getPricingConfig({});
  const runpod = {
    ...safeRunpod,
    config: { ...safeRunpod.config, workersMax: 0 },
  };
  const safety = assessRunpodSafety(runpod, pricing);
  assert.equal(safety.safe, false);
  assert.ok(safety.reasons.some((reason) => reason.includes("workersMax=0")));
});

test("workersMax zero can accept payment when paid autostart is explicitly allowed", () => {
  const pricing = getPricingConfig({});
  const runpod = {
    ...safeRunpod,
    config: { ...safeRunpod.config, workersMax: 0 },
  };
  const safety = assessRunpodSafety(runpod, pricing, { allowPausedAutostart: true });
  assert.equal(safety.safe, true);
  assert.deepEqual(safety.reasons, []);
});

test("zero-idle single-worker 4090 config is safe under conservative pricing", () => {
  const pricing = getPricingConfig({});
  const safety = assessRunpodSafety(safeRunpod, pricing);
  assert.equal(safety.safe, true);
  assert.deepEqual(safety.reasons, []);
});

test("very easy targets still pay at least the reference cold-start floor", () => {
  const pricing = getPricingConfig({});
  const reference = quoteReferencePrice(pricing);
  const easy = quotePriceFromTarget((2n ** 256n) - 1n, pricing);
  assert.equal(easy.priceUsd, reference.priceUsd);
  assert.equal(easy.effectiveFloorUsd, reference.priceUsd);
});

test("observed RunPod failure rate above allowance blocks serving", () => {
  const pricing = getPricingConfig({ RUNPOD_FAILURE_ALLOWANCE_RATE: "0.05" });
  const runpod = {
    ...safeRunpod,
    health: {
      ...safeRunpod.health,
      jobs: { completed: 90, failed: 10, inProgress: 0, inQueue: 0, retried: 0 },
    },
  };
  const safety = assessRunpodSafety(runpod, pricing);
  assert.equal(safety.safe, false);
  assert.ok(safety.reasons.some((reason) => reason.includes("failure rate")));
});

test("existing RunPod queue or in-progress work blocks new paid requests", () => {
  const pricing = getPricingConfig({});
  const runpod = {
    ...safeRunpod,
    health: {
      ...safeRunpod.health,
      jobs: { completed: 0, failed: 0, inProgress: 0, inQueue: 1, retried: 0 },
    },
  };
  const safety = assessRunpodSafety(runpod, pricing);
  assert.equal(safety.safe, false);
  assert.ok(safety.reasons.some((reason) => reason.includes("queued/in-progress")));
});

test("initializing worker without an active paid job blocks before x402 payment", () => {
  const pricing = getPricingConfig({});
  const runpod = {
    ...safeRunpod,
    health: {
      ...safeRunpod.health,
      workers: { idle: 0, initializing: 1, ready: 0, running: 0, throttled: 0, unhealthy: 0 },
    },
  };
  const safety = assessRunpodSafety(runpod, pricing);
  assert.equal(safety.safe, false);
  assert.ok(safety.reasons.some((reason) => reason.includes("initializing/ready/running")));
});

test("RunPod pending status detection covers queue and running states only", () => {
  assert.equal(isRunpodPendingStatus("IN_QUEUE"), true);
  assert.equal(isRunpodPendingStatus("IN_PROGRESS"), true);
  assert.equal(isRunpodPendingStatus("COMPLETED"), false);
  assert.equal(isRunpodPendingStatus("FAILED"), false);
  assert.equal(isRunpodPendingStatus(undefined), false);
});

test("economics ledger is required by default and can be explicitly disabled", () => {
  assert.equal(economicsLedgerRequired({}), true);
  assert.equal(economicsLedgerRequired({ REQUIRE_ECONOMICS_DB: "true" }), true);
  assert.equal(economicsLedgerRequired({ REQUIRE_ECONOMICS_DB: "false" }), false);
});

test("wallet split warns but does not block until required", async () => {
  const split = await assessWalletSplit({
    SERVICE_WALLET: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
    FACILITATOR_PRIVATE_KEY: "0x1111111111111111111111111111111111111111111111111111111111111111",
  });
  assert.equal(split.safe, true);
  assert.ok(split.warnings.some((warning) => warning.includes("dual-role wallet")));
});

test("wallet split blocks dual-role wallet when REQUIRE_SPLIT_WALLETS is true", async () => {
  const split = await assessWalletSplit({
    SERVICE_WALLET: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
    FACILITATOR_PRIVATE_KEY: "0x1111111111111111111111111111111111111111111111111111111111111111",
    REQUIRE_SPLIT_WALLETS: "true",
  });
  assert.equal(split.safe, false);
  assert.ok(split.blockingReasons.some((reason) => reason.includes("dual-role wallet")));
});

test("ledger row captures economics without storing raw payment material", () => {
  const pricing = getPricingConfig({});
  const quote = quoteReferencePrice(pricing);
  const row = buildInitialGrindLedgerRow({
    requestId: "req-test",
    now: "2026-05-16T05:00:00.000Z",
    address: "0x0000000000000000000000000000000000000001",
    challenge: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    targetHex: "0x" + "f".repeat(64),
    quote,
    endpointId: "endpoint-test",
  });

  assert.equal(row.status, "paid_started");
  assert.equal(row.challengePrefix, "0x12345678");
  assert.equal(row.minerAddress, "0x0000000000000000000000000000000000000001");
  assert.equal(row.priceUsd, quote.priceUsd);
  assert.equal(row.billableSecs, quote.billableSecs);
  assert.equal(row.endpointId, "endpoint-test");
  assert.equal("payment" in row, false);
  assert.equal("signature" in row, false);
  assert.equal("authorization" in row, false);
});
