#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GRIND_BASE_URL = process.env.GRIND_BASE_URL ?? "https://grind.apow.io";
const START = process.env.START_TIME ?? process.argv[2];
const END = process.env.END_TIME ?? process.argv[3];

if (!START || !END) {
  console.error("Usage: npm run reconcile -- <start-iso> <end-iso>");
  console.error("Example: npm run reconcile -- 2026-05-16T00:00:00Z 2026-05-16T23:59:59Z");
  process.exit(1);
}

function money(n) {
  return typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(6)}` : "n/a";
}

async function getJson(path) {
  const res = await fetch(`${GRIND_BASE_URL}${path}`, {
    headers: { "cache-control": "no-cache" },
  });
  if (!res.ok) {
    throw new Error(`${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

async function runpodBilling(start, end) {
  const { stdout } = await execFileAsync("runpodctl", [
    "billing",
    "serverless",
    "--start-time",
    start,
    "--end-time",
    end,
    "--bucket-size",
    "day",
  ], { maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout || "[]");
}

const [ops, ledger, billingRows] = await Promise.all([
  getJson("/ops/economics"),
  getJson(`/ops/ledger?from=${encodeURIComponent(START)}&to=${encodeURIComponent(END)}&limit=20`),
  runpodBilling(START, END),
]);

const endpointId = ops.endpoint_id;
const endpointRows = billingRows.filter((row) => row.endpointId === endpointId);
const runpodSpendUsd = endpointRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
const runpodBilledMs = endpointRows.reduce((sum, row) => sum + Number(row.timeBilledMs ?? 0), 0);
const ledgerRevenueUsd = Number(ledger.totals?.quoted_revenue_usd ?? 0);
const ledgerEstimatedCostUsd = Number(ledger.totals?.estimated_cost_before_margin_usd ?? 0);
const ledgerEstimatedMarginUsd = Number(ledger.totals?.estimated_gross_margin_usd ?? 0);
const grossAfterRunpodUsd = ledgerRevenueUsd - runpodSpendUsd;

console.log("Reconciliation");
console.log(`range: ${START} -> ${END}`);
console.log(`base_url: ${GRIND_BASE_URL}`);
console.log(`endpoint_id: ${endpointId}`);
console.log(`safe_to_serve: ${ops.safe_to_serve}`);

console.log("\nRunPod billing");
console.log(`rows: ${endpointRows.length}`);
console.log(`spend_usd: ${money(runpodSpendUsd)}`);
console.log(`billed_seconds: ${(runpodBilledMs / 1000).toFixed(3)}`);

console.log("\nD1 ledger");
console.log(`attempts: ${ledger.totals?.attempts ?? 0}`);
console.log(`quoted_revenue_usd: ${money(ledgerRevenueUsd)}`);
console.log(`estimated_cost_before_margin_usd: ${money(ledgerEstimatedCostUsd)}`);
console.log(`estimated_gross_margin_usd: ${money(ledgerEstimatedMarginUsd)}`);
console.log(`gross_after_runpod_usd: ${money(grossAfterRunpodUsd)}`);

console.log("\nStatus");
if ((ledger.totals?.attempts ?? 0) === 0 && runpodSpendUsd > 0) {
  console.log("UNEXPLAINED_SPEND: RunPod billed this endpoint but D1 has no paid attempts in the same window.");
  process.exitCode = 2;
} else if (grossAfterRunpodUsd < 0) {
  console.log("LOSS: D1 quoted revenue is lower than RunPod spend in this window.");
  process.exitCode = 2;
} else {
  console.log("OK: no unreconciled loss detected from RunPod billing vs D1 quoted revenue.");
}

if (Array.isArray(ledger.recent) && ledger.recent.length > 0) {
  console.log("\nRecent D1 rows");
  for (const row of ledger.recent) {
    console.log(`- ${row.created_at} ${row.status} ${row.price} request=${row.request_id} response=${row.response_status ?? "n/a"} error=${row.error ?? "none"}`);
  }
}
