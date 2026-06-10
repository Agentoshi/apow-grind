CREATE TABLE IF NOT EXISTS grind_economics (
  request_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('paid_started', 'success', 'error')),
  miner_address TEXT NOT NULL,
  challenge_prefix TEXT NOT NULL,
  target_hex TEXT NOT NULL,
  expected_hashes TEXT NOT NULL,
  price TEXT NOT NULL,
  price_usd REAL NOT NULL,
  estimated_compute_secs REAL NOT NULL,
  billable_secs REAL NOT NULL,
  worker_cost_usd REAL NOT NULL,
  storage_cost_usd REAL NOT NULL,
  settlement_gas_usd REAL NOT NULL,
  cloudflare_overhead_usd REAL NOT NULL,
  observability_overhead_usd REAL NOT NULL,
  failure_allowance_usd REAL NOT NULL,
  cost_before_margin_usd REAL NOT NULL,
  gross_margin_usd REAL NOT NULL,
  endpoint_id TEXT NOT NULL,
  response_status INTEGER,
  runpod_http_status INTEGER,
  runpod_status TEXT,
  queue_time_ms INTEGER,
  compute_time_ms INTEGER,
  elapsed_secs REAL,
  nonce TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_grind_economics_created_at
  ON grind_economics(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_grind_economics_status_created_at
  ON grind_economics(status, created_at DESC);
