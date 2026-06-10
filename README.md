# GrindProxy — x402 GPU Grinding Service

Open-source, x402 payment-gated GPU nonce grinding for APoW mining. Any agent sends `{challenge, target, address}` and gets back a valid nonce, paying with USDC via [x402](https://x402.org). No accounts, no SSH, no API keys.

## Architecture

```
Agent (apow-cli)
  │
  │  POST /grind  {challenge, target, address}
  │  x402 auto-payment: dynamic USDC pricing
  │
  ▼
CF Worker (grind.apow.io)           ← @x402/hono middleware
  │  1. First request → 402 with payment requirements
  │  2. Client signs USDC authorization
  │  3. Retry with payment → verify → dispatch to GPU
  │  4. Return nonce + timing headers
  │  5. Settle payment on-chain
  │  6. Persist request economics to D1 (no payment headers or signatures)
  │  7. Cron kill-switch purges/pauses leaked RunPod capacity every minute
  │
  ▼
RunPod Serverless (GPU backend)     ← Docker: grinder-cuda binary
  │  POST /runsync  {input: {challenge, target, address}}
  │  Returns: {nonce, elapsed}
  │  Target live: `workersMin=0`, `workersMax=1`, `workersStandby=0`, `idleTimeout=5`
  │  Paused: `workersMax=0` and Worker returns 503 before x402
```

## Pricing

Pricing is deterministic per request so x402 remains stable across Cloudflare isolates, but it is still difficulty-aware. The Worker computes price from the submitted `target` plus conservative cost assumptions:

`price = max(effective_floor, ceil(max(cost_before_margin × markup, cost_before_margin + required_margin), rounding))`

Where:
- `billable_worker_time = max(min_billable_secs, estimated_compute_secs × time_buffer_multiplier + startup_overhead_secs + post_job_idle_secs)`
- `estimated_compute_secs` is derived from the submitted target and the configured effective hashrate
- `cost_before_margin = worker runtime + container disk allocation + settlement gas + Cloudflare/observability overhead + failed-job allowance`
- `required_margin = max(min_gross_margin_usd, cost_before_margin × min_gross_margin_pct)`
- `effective_floor = max(configured_floor, computed_cold_start_floor)`
- pricing inputs are configured via Worker vars, not in-memory metrics, so the initial 402 and paid retry always agree

Default conservative assumptions:
- Worker cost: `$1.25/hr` (above current official 4090 PRO flex pricing)
- Effective hashrate: `20 GH/s`
- Startup overhead: `120s`
- Post-job idle tail: `5s`
- Time buffer: `1.25x`
- Container disk: `20 GB` at `$0.10/GB/month`
- Failed-job allowance: `100%` of the timeout path
- Failure timeout priced at: `300s`
- Settlement gas: `$0.001`
- Cloudflare + observability overhead: `$0.0002`
- Markup: `1.5x`
- Minimum gross margin: `$0.002` or `20%`, whichever is higher
- Configured floor: `$0.301`

Hard cost-safety rules:
- `workersMin` must be `0`
- at rest, `workersMax` and `workersStandby` must be `0`; the Worker resumes one paid worker only after x402 payment
- `workersStandby` must be `0` before payment, and is allowed only during an in-flight paid request
- actual `idleTimeout` must not exceed the priced `post_job_idle_secs`
- `workersMax` may be `0` at rest only when `RUNPOD_AUTOPAUSE_ENABLED=true` and the Worker has enough RunPod metadata to resume paid capacity
- `workersMax` must not exceed the configured paid-concurrency cap
- the D1 economics ledger must be configured and healthy before x402 payment is requested
- configured worker cost must be at or above the official flex rate for the allowed GPU class
- the Worker refuses to serve `/grind` if the RunPod endpoint drifts into an unsafe billing configuration
- a Cloudflare scheduled event runs every minute and force-pauses RunPod if a request crashes before normal cleanup

Useful endpoints:
- `GET /health` — current pricing inputs, reference quote, and in-memory revenue counters
- `GET /price?target=0x...` — request-specific quote for a given mining target
- `GET /ops/economics` — live RunPod config/health plus explicit `safe_to_serve` / blocking reasons
- `GET /ops/ledger?limit=20` — D1 economics totals and recent non-sensitive request rows

## Self-Hosting

### 1. RunPod GPU Endpoint

```bash
# Copy the CUDA source into the build context
cp ../apow-cli/local/gpu/grinder-cuda.cu gpu/grinder-cuda.cu

# Build the Docker image
cd gpu
docker build --platform linux/amd64 -t grind-proxy-gpu .

# Push to your registry
docker tag grind-proxy-gpu your-registry/grind-proxy-gpu:latest
docker push your-registry/grind-proxy-gpu:latest
```

Then create a RunPod serverless endpoint using the image. Note the endpoint URL.

### 2. Cloudflare Worker

```bash
cd worker
npm install

# Create and migrate the durable economics ledger
wrangler d1 create apow-grind-economics
# Add the returned database_id to wrangler.toml under [[d1_databases]]
wrangler d1 migrations apply apow-grind-economics --remote

# Set secrets
wrangler secret put RUNPOD_ENDPOINT   # https://api.runpod.ai/v2/YOUR_ENDPOINT_ID
wrangler secret put RUNPOD_API_KEY    # Your RunPod API key
wrangler secret put SERVICE_WALLET    # 0x address to receive USDC payments
wrangler secret put FACILITATOR_PRIVATE_KEY
wrangler secret put RPC_URL           # Private Base RPC for settlement + audits

# Optional: override pricing assumptions if your fleet differs
# wrangler.toml [vars]:
#   RUNPOD_AUTOPAUSE_ENABLED = "true"
#   RUNPOD_GPU_IDS = "ADA_24"
#   RUNPOD_TEMPLATE_ID = "jk913bmprs"
#   RUNPOD_GPU_COUNT = "1"
#   RUNPOD_WORKER_COST_PER_HOUR_USD = "1.25"
#   RUNPOD_HASHRATE_HPS = "20000000000"
#   RUNPOD_STARTUP_OVERHEAD_SECS = "120"
#   RUNPOD_POST_JOB_IDLE_SECS = "5"
#   RUNPOD_MIN_BILLABLE_SECS = "1"
#   RUNPOD_TIME_BUFFER_MULTIPLIER = "1.25"
#   RUNPOD_CONTAINER_DISK_GB = "20"
#   RUNPOD_STORAGE_COST_PER_GB_MONTH_USD = "0.10"
#   RUNPOD_FAILURE_ALLOWANCE_RATE = "1.0"
#   RUNPOD_FAILURE_TIMEOUT_SECS = "300"
#   RUNPOD_MAX_WORKERS_SAFE = "1"
#   SETTLEMENT_GAS_USD = "0.001"
#   CLOUDFLARE_OVERHEAD_USD = "0.0001"
#   OBSERVABILITY_OVERHEAD_USD = "0.0001"
#   PRICE_MARKUP = "1.5"
#   PRICE_FLOOR_USD = "0.301"
#   PRICE_ROUNDING_USD = "0.001"
#   PRICE_REFERENCE_COMPUTE_SECS = "15"
#   MIN_GROSS_MARGIN_USD = "0.002"
#   MIN_GROSS_MARGIN_PCT = "0.20"
#   REQUIRE_ECONOMICS_DB = "true"
#   REQUIRE_SPLIT_WALLETS = "true"

# Deploy
wrangler deploy
```

`SERVICE_WALLET` should be a cold treasury/payment destination. `FACILITATOR_PRIVATE_KEY`
should be a separate hot settlement signer with only gas dust. Set
`REQUIRE_SPLIT_WALLETS=true` only after rotation is complete; when enabled, `/grind`
stays blocked if the facilitator address equals `SERVICE_WALLET`.

### 3. Client Configuration (apow-cli)

```bash
# In your .env
GRIND_URL=https://your-worker.workers.dev/grind
USE_X402_GRIND=true
```

The CLI automatically handles x402 payments — when the server returns 402, the client signs a USDC authorization and retries.

## API

### POST /grind

**Request:**
```json
{
  "challenge": "0x...",   // 32-byte hex challenge from AgentCoin contract
  "target": "0x...",      // 32-byte hex target (or decimal string)
  "address": "0x..."      // 20-byte hex miner address
}
```

**Response (200):**
```json
{
  "nonce": "12345678",    // Decimal nonce string
  "elapsed": 1.234        // Seconds to find nonce
}
```

**Response Headers:**
- `X-Grind-Request-Id` — unique request ID
- `X-Grind-Queue-Time` — time spent in queue (ms)
- `X-Grind-Compute-Time` — GPU compute time (ms)
- `X-Grind-Price` — quoted x402 price charged for this request
- `X-Grind-Billable-Secs` — billable seconds assumed by the pricing model

**Response (402):** x402 payment requirements (handled automatically by `@x402/fetch`)

### GET /health

```json
{
  "ok": true,
  "service": "grind-proxy",
  "total_grinds": 42,
  "paid_requests": 43,
  "failed_grinds": 1,
  "avg_grind_time": 12.345,
  "avg_queue_time": 0.05,
  "quoted_revenue_usd": 0.217,
  "price": "$0.301",
  "pricing": {
    "mode": "deterministic-per-request",
    "runpod_worker_cost_per_hour_usd": 1.25,
    "runpod_hashrate_hps": 20000000000,
    "minimum_safe_price_usd": 0.301,
    "reference_price_usd": 0.301
  }
}
```

No payment required.

### GET /ops/economics

Returns the current pricing model plus live RunPod config/health and explicit serve/no-serve safety status:
- `workersMin > 0`
- `idleTimeout` exceeds the priced idle tail
- `workersStandby > 0` still configured on the endpoint
- `workersMax < 1`, which means the backend is intentionally paused
- `workersMax` exceeds the configured paid-concurrency cap
- D1 economics ledger missing or unhealthy
- configured worker cost is below the official flex rate for the allowed GPU class
- observed worker cost exceeds the priced worker cost assumption
- split-wallet requirement enabled while settlement signer equals revenue payTo

If `safe_to_serve` is `false`, the Worker blocks `/grind` until the billing configuration is safe again.

### GET /ops/ledger

Returns D1-backed accounting totals plus recent non-sensitive rows. It omits private keys, payment headers, x402 signatures, raw authorization material, and full request bodies. Use direct D1 queries for deeper operator reconciliation.

## Operations

For a quick operator report from a terminal:

```bash
cd worker
npm run economics
npm run reconcile -- 2026-05-16T00:00:00Z 2026-05-16T23:59:59Z
```

Optional env vars:
- `GRIND_BASE_URL` — defaults to `https://grind.apow.io`
- `START_TIME` / `END_TIME` — optional env var form for `npm run reconcile`
- `RPC_URL` — required if you want on-chain wallet balances in the report
- `SERVICE_WALLET` — include current ETH/USDC balances for the fee wallet

Recommended guardrails:
- keep `workersMin = 0`
- live capacity: set `workersMax = 1`; pause capacity: set `workersMax = 0`
- keep `workersStandby = 0`
- keep `idleTimeout <= RUNPOD_POST_JOB_IDLE_SECS`
- keep `REQUIRE_ECONOMICS_DB = true`
- use `RUNPOD_WORKER_COST_PER_HOUR_USD` for the worst worker you are willing to rent, not the average one
- never rely on public Base RPC defaults for settlement or audit paths
- if re-enabling to `workersMax = 1` recreates standby workers, pause back to `workersMax = 0` before accepting paid traffic
- keep the cron trigger enabled; it is the backstop that prevents a failed Worker invocation from leaving RunPod capacity on

## License

MIT
