#!/usr/bin/env node

import { createPublicClient, http, formatEther, formatUnits } from "viem";
import { base } from "viem/chains";

const GRIND_BASE_URL = process.env.GRIND_BASE_URL ?? "https://grind.apow.io";
const RPC_URL = process.env.RPC_URL ?? "https://mainnet.base.org";
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

async function getJson(path) {
  const res = await fetch(`${GRIND_BASE_URL}${path}`);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

async function getWalletBalances() {
  if (!SERVICE_WALLET) return null;
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

const [health, ops, balances] = await Promise.all([
  getJson("/health"),
  getJson("/ops/economics"),
  getWalletBalances(),
]);

printSection("Service");
console.log(`base_url: ${GRIND_BASE_URL}`);
console.log(`version: ${health.version}`);
console.log(`reference_price: ${health.price}`);

printSection("Pricing");
console.log(`gpu_cost_per_hour: ${money(ops.pricing?.runpod_gpu_cost_per_hour_usd)}`);
console.log(`hashrate_hps: ${ops.pricing?.runpod_hashrate_hps ?? "n/a"}`);
console.log(`idle_overhead_secs: ${ops.pricing?.runpod_startup_overhead_secs ?? "n/a"}`);
console.log(`reference_billable_secs: ${ops.pricing?.reference_billable_secs ?? "n/a"}`);
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

printSection("Revenue");
console.log(`quoted_revenue_usd_since_worker_boot: ${money(health.quoted_revenue_usd)}`);
console.log(`paid_requests_since_worker_boot: ${health.paid_requests ?? "n/a"}`);
if (balances) {
  console.log(`service_wallet_eth: ${balances.eth}`);
  console.log(`service_wallet_usdc: ${balances.usdc}`);
} else {
  console.log("service_wallet: omitted (set SERVICE_WALLET to include on-chain balances)");
}

printSection("Warnings");
if (Array.isArray(ops.warnings) && ops.warnings.length > 0) {
  for (const warning of ops.warnings) {
    console.log(`- ${warning}`);
  }
} else {
  console.log("- none");
}
