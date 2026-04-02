# GrindProxy — x402 GPU Grinding Service

Open-source, at-cost GPU nonce grinding for APoW mining. Any agent sends `{challenge, target, address}` and gets back a valid nonce, paying with USDC via [x402](https://x402.org). No accounts, no SSH, no API keys.

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
RunPod Serverless (RTX 4090)        ← Docker: grinder-cuda binary
  │  POST /runsync  {input: {challenge, target, address}}
  │  Returns: {nonce, elapsed}
  │  Scale-to-zero, per-second billing (~$0.34/hr)
```

**Pricing:** Dynamic, tracks actual cost. `(avg_grind_time × $0.0000944/sec + $0.001 gas) × 1.5`
**At current difficulty (~30s):** ~$0.006 | **Floor:** $0.002 | Check `/health` for live price

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

**Response (402):** x402 payment requirements (handled automatically by `@x402/fetch`)

### GET /health

```json
{
  "ok": true,
  "service": "grind-proxy",
  "total_grinds": 42,
  "avg_grind_time": 12.345,
  "avg_queue_time": 0.05
}
```

No payment required.

## License

MIT
