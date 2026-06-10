#!/usr/bin/env node

import { createPublicClient, http, formatEther, formatUnits } from "viem";
import { base } from "viem/chains";

const GRIND_BASE_URL = process.env.GRIND_BASE_URL ?? "https://grind.apow.io";
const RPC_URL = process.env.RPC_URL;
const SERVICE_WALLET = process.env.SERVICE_WALLET;

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

function money(n) {
  return typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(3)}` : "n/a";
}

function printSection(title) {
  process.stdout.write(`\n${title}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(path) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${GRIND_BASE_URL}${path}`, {
        headers: { "cache-control": "no-cache" },
      });
      if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
      return res.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(500 * attempt);
    }
  }
  throw lastError;
}

async function getWalletBalances() {
  if (!SERVICE_WALLET || !RPC_URL) return null;
  const client = createPublicClient({ chain: base, transport: http(RPC_URL) });
  const [eth, usdc] = await Promise.all([
    client.getBalance({ address: SERVICE_WALLET }),
    client.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [SERVICE_WALLET],
    }),
  ]);
  return {
    eth: formatEther(eth),
    usdc: formatUnits(usdc, 6),
  };
}

const [health, ops, ledger, balances] = await Promise.all([
  getJson("/health"),
  getJson("/ops/economics"),
  getJson("/ops/ledger?limit=5").catch((error) => ({ ok: false, error: error.message })),
  getWalletBalances(),
]);

printSection("Service");
console.log(`base_url: ${GRIND_BASE_URL}`);
console.log(`version: ${health.version}`);
console.log(`reference_price: ${health.price}`);

printSection("Pricing");
console.log(`worker_cost_per_hour: ${money(ops.pricing?.runpod_worker_cost_per_hour_usd)}`);
console.log(`hashrate_hps: ${ops.pricing?.runpod_hashrate_hps ?? "n/a"}`);
console.log(`startup_overhead_secs: ${ops.pricing?.runpod_startup_overhead_secs ?? "n/a"}`);
console.log(`post_job_idle_secs: ${ops.pricing?.runpod_post_job_idle_secs ?? "n/a"}`);
console.log(`container_disk_gb: ${ops.pricing?.runpod_container_disk_gb ?? "n/a"}`);
console.log(`storage_cost_per_gb_month: ${money(ops.pricing?.runpod_storage_cost_per_gb_month_usd)}`);
console.log(`failure_allowance_rate: ${ops.pricing?.runpod_failure_allowance_rate ?? "n/a"}`);
console.log(`failure_timeout_secs: ${ops.pricing?.runpod_failure_timeout_secs ?? "n/a"}`);
console.log(`max_workers_safe: ${ops.pricing?.runpod_max_workers_safe ?? "n/a"}`);
console.log(`minimum_safe_price_usd: ${money(ops.pricing?.minimum_safe_price_usd)}`);
console.log(`effective_price_floor_usd: ${money(ops.pricing?.effective_price_floor_usd)}`);
console.log(`min_gross_margin_usd: ${money(ops.pricing?.min_gross_margin_usd)}`);
console.log(`min_gross_margin_pct: ${ops.pricing?.min_gross_margin_pct ?? "n/a"}`);
console.log(`reference_billable_secs: ${ops.pricing?.reference_billable_secs ?? "n/a"}`);
console.log(`reference_cost_before_margin_usd: ${money(ops.pricing?.reference_cost_before_margin_usd)}`);
console.log(`reference_gross_margin_usd: ${money(ops.pricing?.reference_gross_margin_usd)}`);
console.log(`reference_price_usd: ${money(ops.pricing?.reference_price_usd)}`);

printSection("RunPod");
console.log(`endpoint_id: ${ops.endpoint_id ?? "n/a"}`);
console.log(`workers_min: ${ops.runpod?.config?.workersMin ?? "n/a"}`);
console.log(`workers_max: ${ops.runpod?.config?.workersMax ?? "n/a"}`);
console.log(`workers_standby: ${ops.runpod?.config?.workersStandby ?? "n/a"}`);
console.log(`idle_timeout: ${ops.runpod?.config?.idleTimeout ?? "n/a"}s`);
console.log(`queue: ${ops.runpod?.health?.jobs?.inQueue ?? "n/a"}`);
console.log(`in_progress: ${ops.runpod?.health?.jobs?.inProgress ?? "n/a"}`);
console.log(`running_workers: ${ops.runpod?.health?.workers?.running ?? "n/a"}`);
console.log(`ready_workers: ${ops.runpod?.health?.workers?.ready ?? "n/a"}`);
console.log(`idle_workers: ${ops.runpod?.health?.workers?.idle ?? "n/a"}`);
console.log(`safe_to_serve: ${ops.safe_to_serve ?? "n/a"}`);

printSection("Revenue");
console.log(`quoted_revenue_usd_since_worker_boot: ${money(health.quoted_revenue_usd)}`);
console.log(`paid_requests_since_worker_boot: ${health.paid_requests ?? "n/a"}`);
if (ledger.ok) {
  console.log(`ledger_attempts: ${ledger.totals?.attempts ?? 0}`);
  console.log(`ledger_quoted_revenue_usd: ${money(Number(ledger.totals?.quoted_revenue_usd ?? 0))}`);
  console.log(`ledger_estimated_cost_before_margin_usd: ${money(Number(ledger.totals?.estimated_cost_before_margin_usd ?? 0))}`);
  console.log(`ledger_estimated_gross_margin_usd: ${money(Number(ledger.totals?.estimated_gross_margin_usd ?? 0))}`);
} else {
  console.log(`ledger: unavailable (${ledger.error ?? "unknown error"})`);
}
if (balances) {
  console.log(`service_wallet_eth: ${balances.eth}`);
  console.log(`service_wallet_usdc: ${balances.usdc}`);
} else {
  console.log("service_wallet: omitted (set both SERVICE_WALLET and RPC_URL to include on-chain balances)");
}

printSection("Blocking");
if (Array.isArray(ops.blocking_reasons) && ops.blocking_reasons.length > 0) {
  for (const reason of ops.blocking_reasons) {
    console.log(`- ${reason}`);
  }
} else {
  console.log("- none");
}

printSection("Recent ledger rows");
if (ledger.ok && Array.isArray(ledger.recent) && ledger.recent.length > 0) {
  for (const row of ledger.recent) {
    console.log(`- ${row.created_at} ${row.status} ${row.price ?? ""} request=${row.request_id} response=${row.response_status ?? "n/a"} error=${row.error ?? "none"}`);
  }
} else {
  console.log("- none");
}

printSection("Warnings");
if (Array.isArray(ops.warnings) && ops.warnings.length > 0) {
  for (const warning of ops.warnings) {
    console.log(`- ${warning}`);
  }
} else {
  console.log("- none");
}
