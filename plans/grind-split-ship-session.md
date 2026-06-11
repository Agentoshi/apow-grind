# Grind Split Ship Session — Runbook

One sitting, AKLO at keyboard. Outcome: grind.apow.io runs the hardened worker (May economics + June split gate), revenue settles to a fresh cold treasury, the facilitator is a gas-only hot key, and the old dual-role wallet is retired.

Preconditions (already done 2026-06-11): `main` @ `bd515a9`+ merged and pushed; worker tests pass (16). Production currently runs the OLD March worker — this session replaces it. Deploying does NOT enable paid traffic by itself: RunPod `workersMax` stays 0 until the cloud-mining relaunch, and `safe_to_serve` stays false.

Secret-handling rules for every step: terminal output is livestreamed — no private keys, passwords, or keyed RPC URLs on screen, ever. `umask 077` before writing any key file. Record every new wallet in the registry BEFORE first on-chain use (`/Users/aklo/.claude/projects/-Users-aklo-projects-apow/memory/MEMORY.md`).

## 1. Generate the treasury (cold keystore)

    cd /Users/aklo/projects/apow/apow-cli
    node dist/index.js wallet new        # interactive password prompt; prints ADDRESS only

- Password goes in AKLO's password manager, nowhere else.
- Keystore lands in `~/.apow/keystores/` (0600). Optionally copy the keystore JSON to offline storage.
- Record in wallet registry: address, keystore path, purpose "Grind treasury + sweep payout (cold)".

## 2. Generate the new facilitator (hot, gas-only)

    umask 077
    cast wallet new --json > ~/mining/facilitator-20260611.json   # never cat this file
    jq -r '.[0].address' ~/mining/facilitator-20260611.json        # address only — safe to show

- Record in registry: address, key file path, purpose "x402 settlement signer (hot, gas-only)".

## 3. Set Worker secrets (key goes process-to-process, never on screen)

    cd /Users/aklo/projects/apow/apow-grind/worker
    jq -r '.[0].private_key' ~/mining/facilitator-20260611.json | npx wrangler secret put FACILITATOR_PRIVATE_KEY
    npx wrangler secret put SERVICE_WALLET        # paste TREASURY address (public — fine)

RPC note: the Worker needs `RPC_URL` for settlement/verification. The old QuickNode endpoint was exposed on-stream 2026-06-11 (and is unreachable) — provision a NEW keyed RPC and set it as a secret too: `npx wrangler secret put RPC_URL`. Never echo it.

## 4. Enable the split gate

Add to `worker/wrangler.toml` `[vars]`: `REQUIRE_SPLIT_WALLETS = "true"` (commit this). The gate blocks serving if SERVICE_WALLET and the facilitator address ever match again.

## 5. D1 ledger

    npx wrangler d1 list                                          # expect apow-grind-economics
    npx wrangler d1 migrations apply apow-grind-economics --remote

## 6. Deploy + verify

    npx wrangler deploy
    curl -s https://grind.apow.io/health | jq '.wallet_split'
    curl -s https://grind.apow.io/ops/economics | jq '{safe_to_serve, reasons, wallet_split}'

Expect: `wallet_split.ok == true`, `safe_to_serve == false` with reasons about `workersMax=0` (paused capacity — correct until relaunch).

## 7. Fund facilitator + retire old wallet

Old dual-role wallet: `0x85ed004AFF50FaD46bC353171B0573b7a8F93642` (key: `~/mining/wallet-grindproxy-service.txt`). One-time import into a cast keystore so sends never expose the key:

    cast wallet import grind-old --interactive    # paste key at HIDDEN prompt, choose password

Then (password prompts each time):

    cast send <NEW_FACILITATOR_ADDR> --value 0.004ether --account grind-old --rpc-url <RPC>
    # sweep remaining USDC to treasury:
    cast send 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "transfer(address,uint256)" <TREASURY> <USDC_UNITS> --account grind-old --rpc-url <RPC>
    # sweep remaining ETH minus gas to treasury, then mark wallet RETIRED in registry.

## 8. Close out

- Registry rows updated: treasury (cold), facilitator (hot), old wallet → RETIRED + sweep tx hashes.
- apow-grind CHANGELOG entry; commit wrangler.toml change; push via `~/.claude/tools/git-push-as.sh Agentoshi origin main`.
- Rollback: snapshot branch `snapshot/wallet-protocol-v2-pre-20260610`; old worker re-deployable from `0311d73`; old wallet key retained (retired, not destroyed).
