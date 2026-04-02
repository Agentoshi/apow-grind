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
  ExactEvmScheme,
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
}

// Free Base RPCs — fallback chain if RPC_URL not set
const BASE_RPC_URLS = [
  "https://base.llamarpc.com",
  "https://base-mainnet.public.blastapi.io",
  "https://1rpc.io/base",
  "https://mainnet.base.org",
];

const app = new Hono<{ Bindings: Env }>();

// ── Global error handler — catch unhandled exceptions ────────────────

app.onError((err, c) => {
  console.error("Worker error:", err.message, err.stack);
  return c.json({ error: err.message, stack: err.stack?.split("\n").slice(0, 5) }, 500);
});

// ── Metrics (in-memory, resets on worker restart) ────────────────────

let totalGrinds = 0;
let totalGrindTimeMs = 0;
let totalQueueTimeMs = 0;

// ── Dynamic pricing ─────────────────────────────────────────────────
// Tracks actual RunPod cost + settlement gas with a small markup.
// Never at a loss: floor covers gas even for instant grinds.

const RUNPOD_PER_SEC = 0.34 / 3600; // $0.0000944/sec (RunPod serverless billing)
const GAS_COST_EST = 0.001;          // ~$0.001 Base L2 settlement gas
const MARKUP = 1.5;                   // 50% buffer for time variance
const PRICE_FLOOR = 0.002;           // minimum price (covers gas)
const DEFAULT_GRIND_SECS = 15;       // daemon mode avg (~12-17s)

function computePrice(): string {
  const avgSecs = totalGrinds > 0
    ? totalGrindTimeMs / totalGrinds / 1000
    : DEFAULT_GRIND_SECS;
  const gpuCost = avgSecs * RUNPOD_PER_SEC;
  const raw = (gpuCost + GAS_COST_EST) * MARKUP;
  const price = Math.max(PRICE_FLOOR, raw);
  // Round up to nearest $0.001 — never rounds down
  const rounded = Math.ceil(price * 1000) / 1000;
  return `$${rounded.toFixed(3)}`;
}

// ── Health check — no payment required ───────────────────────────────

app.get("/health", (c) => {
  const avgGrindTime = totalGrinds > 0 ? totalGrindTimeMs / totalGrinds / 1000 : 0;
  const avgQueueTime = totalGrinds > 0 ? totalQueueTimeMs / totalGrinds / 1000 : 0;
  const currentPrice = computePrice();
  return c.json({
    ok: true,
    service: "grind-proxy",
    total_grinds: totalGrinds,
    avg_grind_time: Math.round(avgGrindTime * 1000) / 1000,
    avg_queue_time: Math.round(avgQueueTime * 1000) / 1000,
    price: currentPrice,
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
// Price tracks actual GPU cost. Middleware is recreated when price changes.

let cachedMw: MiddlewareHandler | null = null;
let cachedPrice: string | null = null;

app.use("/grind", async (c, next) => {
  const currentPrice = computePrice();

  if (!cachedMw || cachedPrice !== currentPrice) {
    cachedPrice = currentPrice;

    // Create viem signer for the facilitator (verifies + settles payments)
    const account = privateKeyToAccount(c.env.FACILITATOR_PRIVATE_KEY as `0x${string}`);
    const rpcUrl = c.env.RPC_URL ?? BASE_RPC_URLS[0];
    const client = createWalletClient({
      account,
      chain: base,
      transport: http(rpcUrl),
    }).extend(publicActions);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signer = toFacilitatorEvmSigner(client as any);

    // Create in-process facilitator with Base mainnet support
    const facilitator = new x402Facilitator();
    registerExactEvmScheme(facilitator, {
      signer,
      networks: "eip155:8453",
    });

    // Wrap facilitator — x402Facilitator.getSupported() is sync but FacilitatorClient expects async
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
  }

  return cachedMw(c, next);
});

// ── Grind handler ────────────────────────────────────────────────────

const RUNPOD_TIMEOUT_MS = 60_000;

app.post("/grind", async (c) => {
  const requestId = crypto.randomUUID();
  const queueStart = Date.now();

  const body = await c.req.json<{
    challenge?: string;
    target?: string;
    address?: string;
  }>();

  const { challenge, target, address } = body;

  // Validate challenge: 0x-prefixed 66-char hex (32 bytes)
  if (!challenge || !/^0x[0-9a-fA-F]{64}$/.test(challenge)) {
    return c.json(
      { error: "Invalid challenge: must be 0x-prefixed 32-byte hex (66 chars)" },
      400,
    );
  }

  // Validate address: 0x-prefixed 42-char hex (20 bytes)
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return c.json(
      { error: "Invalid address: must be 0x-prefixed 20-byte hex (42 chars)" },
      400,
    );
  }

  // Validate target: must be a valid number (decimal or 0x hex)
  if (!target) {
    return c.json({ error: "Missing target" }, 400);
  }
  let targetBigInt: bigint;
  try {
    targetBigInt = BigInt(target);
  } catch {
    return c.json({ error: "Invalid target: must be a decimal or 0x hex number" }, 400);
  }

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
      return c.json({ error: "Grind timed out (60s)" }, 504);
    }
    return c.json({ error: "RunPod backend unreachable" }, 502);
  }
  clearTimeout(timeout);

  const computeTimeMs = Date.now() - computeStart;
  const queueTimeMs = computeStart - queueStart;

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    return c.json({ error: `RunPod error: HTTP ${resp.status}`, detail: errBody.slice(0, 500) }, 502);
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
      },
    );
  }

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
    },
  );
});

export default app;
