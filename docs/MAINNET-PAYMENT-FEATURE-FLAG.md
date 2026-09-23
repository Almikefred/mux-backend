# Mainnet Payment Feature Flag & Kill-Switch

This runbook documents the feature flag and kill-switch that gate all
mainnet-affecting payment behavior in `mux-backend`, including the
**payment dry-run mode** described in [`PAYMENT-DRY-RUN.md`](./PAYMENT-DRY-RUN.md).

> Scope: money-path and mainnet-affecting changes only. Testnet behavior is
> unaffected unless explicitly noted.

## Why this exists

Payment dry-run lets clients simulate and validate a payment without
submitting it to Stellar/Horizon. Because dry-run shares the same authz,
idempotency, and validation code paths as live payments, it must be gated so
that a misconfiguration cannot accidentally promote a dry-run into a live
spend, and so operators can disable the money path quickly during an incident.

## Flags

| Flag | Env var | Default | Effect |
| --- | --- | --- | --- |
| Payment dry-run | `PAYMENT_DRY_RUN_ENABLED` | `false` | Enables the dry-run entrypoint. When `false`, dry-run requests are rejected with `PAYMENT_DRY_RUN_DISABLED`. |
| Mainnet payments | `PAYMENT_MAINNET_ENABLED` | `false` | Master switch for live mainnet submission. When `false`, live writes fail closed with `PAYMENT_MAINNET_DISABLED`. |
| Payment kill-switch | `PAYMENT_KILL_SWITCH` | `false` | When `true`, all payment writes (live and dry-run) are rejected immediately with `PAYMENT_KILL_SWITCH_ENGAGED`. |

All flags are **deny-by-default**: unset or unparseable values are treated as
`false`.

## Invariants

1. Dry-run **never** submits to Stellar/Horizon. It only validates and returns
   a simulated result.
2. Dry-run and live payments share the same authz checks (owner / delegate /
   guardian / API-key / JWT). Dry-run cannot be used to bypass payment policy.
3. Every dry-run request carries a correlation id and is idempotent on
   `(account, idempotencyKey)`; replays return the original result.
4. On RPC/DB/Horizon outage, writes fail closed. Dry-run may return a
   validation error but must not mutate state.
5. No secrets (keys, JWTs, webhook secrets) are logged; only redacted
   identifiers and correlation ids.
6. The mainnet flag is evaluated **server-side only** and is never trusted from
   client input; a client cannot enable mainnet payments by sending a header,
   query param, or body field.

## Kill-switch procedure

1. Set `PAYMENT_KILL_SWITCH=true` and roll the deployment.
2. Confirm rejection metrics: `payments_rejected_total{reason="kill_switch"}`
   increases and `payments_submitted_total` drops to zero.
3. Investigate using correlation ids from structured logs.
4. To restore, set `PAYMENT_KILL_SWITCH=false` and roll back.

## Rollback

- Disable dry-run: `PAYMENT_DRY_RUN_ENABLED=false`.
- Disable live mainnet: `PAYMENT_MAINNET_ENABLED=false`.
- Full stop: `PAYMENT_KILL_SWITCH=true`.

Each flag is independently reversible without a schema migration.

## Observability

- `payments_dry_run_total{result}` — dry-run outcomes.
- `payments_rejected_total{reason}` — authz/flag/idempotency rejections.
- `payments_submitted_total` — live submissions (must be 0 when gated).
- `payments_mainnet_flag_state{enabled}` — current mainnet flag state, emitted
  on startup and on every flag re-read so operators can alert on drift.
- Structured logs include `correlationId` and redacted account refs only.

## References

- [`PAYMENT-DRY-RUN.md`](./PAYMENT-DRY-RUN.md)
- [`SECURITY.md`](../SECURITY.md)
