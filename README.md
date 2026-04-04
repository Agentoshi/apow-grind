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
  │
  ▼
RunPod Serverless (GPU backend)     ← Docker: grinder-cuda binary
  │  POST /runsync  {input: {challenge, target, address}}
  │  Returns: {nonce, elapsed}
  │  Scale-to-zero is strongly recommended (`workersMin=0`)
```

## Pricing

Pricing is deterministic per request so x402 remains stable across Cloudflare isolates, but it is still difficulty-aware. The Worker computes price from the submitted `target` plus conservative cost assumptions:

`price = max(floor, ceil(((billable_gpu_time × gpu_cost_per_sec) + settlement_gas) × markup, rounding))`

Where:
- `billable_gpu_time = max(min_billable_secs, estimated_compute_secs × time_buffer_multiplier + startup_overhead_secs)`
- `estimated_compute_secs` is derived from the submitted target and the configured effective hashrate
- pricing inputs are configured via Worker vars, not in-memory metrics, so the initial 402 and paid retry always agree

Default conservative assumptions:
- GPU cost: `$0.59/hr`
- Effective hashrate: `20 GH/s`
- Startup overhead: `8s`
- Time buffer: `1.25x`
- Settlement gas: `$0.001`
- Markup: `1.5x`
- Floor: `$0.004`

Operational rule:
- Keep RunPod `workersMin=0` unless you intentionally want to subsidize idle warm workers

Useful endpoints:
- `GET /health` — current pricing inputs, reference quote, and in-memory revenue counters
- `GET /price?target=0x...` — request-specific quote for a given mining target
- `GET /ops/economics` — live RunPod config/health plus pricing warnings for burn-risk auditing

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

# Set secrets
wrangler secret put RUNPOD_ENDPOINT   # https://api.runpod.ai/v2/YOUR_ENDPOINT_ID
wrangler secret put RUNPOD_API_KEY    # Your RunPod API key
wrangler secret put SERVICE_WALLET    # 0x address to receive USDC payments
wrangler secret put FACILITATOR_PRIVATE_KEY

# Optional: override pricing assumptions if your fleet differs
# wrangler.toml [vars]:
#   RUNPOD_GPU_COST_PER_HOUR_USD = "0.59"
#   RUNPOD_HASHRATE_HPS = "20000000000"
#   RUNPOD_STARTUP_OVERHEAD_SECS = "8"
#   RUNPOD_MIN_BILLABLE_SECS = "1"
#   RUNPOD_TIME_BUFFER_MULTIPLIER = "1.25"
#   SETTLEMENT_GAS_USD = "0.001"
#   PRICE_MARKUP = "1.5"
#   PRICE_FLOOR_USD = "0.004"
#   PRICE_ROUNDING_USD = "0.001"
#   PRICE_REFERENCE_COMPUTE_SECS = "15"

# Deploy
wrangler deploy
```

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
  "price": "$0.006",
  "pricing": {
    "mode": "deterministic-per-request",
    "runpod_gpu_cost_per_hour_usd": 0.59,
    "runpod_hashrate_hps": 20000000000,
    "reference_price_usd": 0.006
  }
}
```

No payment required.

### GET /ops/economics

Returns the current pricing model plus live RunPod endpoint config/health and warnings for common burn risks:
- `workersMin > 0`
- `idleTimeout` set too high
- `workersStandby > 0` still configured on the endpoint
- workers still running with no queue backlog

This is the endpoint to watch when you want to verify the service is not quietly drifting back into a cost-bleeding configuration.

## Operations

For a quick operator report from a terminal:

```bash
cd worker
npm run economics
```

Optional env vars:
- `GRIND_BASE_URL` — defaults to `https://grind.apow.io`
- `RPC_URL` — defaults to `https://mainnet.base.org`
- `SERVICE_WALLET` — include current ETH/USDC balances for the fee wallet

Recommended guardrails:
- keep `workersMin = 0`
- keep `idleTimeout <= 5`
- treat any `workersStandby > 0` warning as something to audit in the RunPod console/billing UI
- re-check `RUNPOD_GPU_COST_PER_HOUR_USD` whenever you change GPU classes or endpoint pricing

## License

MIT
