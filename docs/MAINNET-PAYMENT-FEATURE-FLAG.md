# Mainnet Payment Submit Feature Flag

- `FEATURE_MAINNET_PAYMENT_SUBMIT` (boolean, default: false)
  - When `true`, `POST /transactions/fee-bump` requests with `network: "MAINNET"` are submitted to Horizon mainnet as normal.
  - When `false` or unset, MAINNET submissions are rejected with HTTP 403 (Forbidden) and message: "Mainnet payment submission is not available at this time. (Flag: mainnet_payment_submit)". `TESTNET` submissions are unaffected — the flag is only consulted when `network === "MAINNET"`.

Notes:
- Implemented as a kill-switch check inside `FeeBumpService.submitFeeBump` (not the route-level `FeatureFlagGuard`), because the decision depends on the `network` field in the request body rather than being fixed per-route.
- Reuses the existing `FeatureFlagService.isEnabled()` helper and the `FEATURE_<FLAG_NAME>` env var convention (e.g. `FEATURE_MAINNET_PAYMENT_SUBMIT=true`).
- Rejections happen before any wallet key material is decrypted or any call to Horizon is made.

Operational guidance:
- Keep this flag off in production until mainnet payment submission has been reviewed and approved for general availability; flip it on per-environment via env/secret config.

## Invisible Wallet Orchestration

This flag also gates the invisible-wallet orchestration money path. When the flag is off, orchestration entrypoints that would submit a mainnet spend (fee-bump submit, sponsored create, recovery submit) fail closed with HTTP 403 and the stable error code `MAINNET_PAYMENT_SUBMIT_DISABLED`; no wallet key material is decrypted and no Horizon/RPC call is made. Testnet orchestration is unaffected.

- Behavior and request/response contracts for orchestration are documented in `docs/WALLET-API.md`; this flag is the kill-switch for the mainnet-affecting subset of those flows.
- Authz for orchestration entrypoints is deny-by-default: owner/delegate/guardian/API-key/JWT must be present and valid, and revoked delegates are rejected before any spend is attempted.
- Replayed or concurrent orchestration requests are idempotent via the caller-supplied idempotency key; a duplicate key returns the original result rather than re-submitting.
- Errors carry a correlation id (request id) and the stable error codes above so ops can trace a failed orchestration without exposing secrets or raw key material.

Rollback:
- Set `FEATURE_MAINNET_PAYMENT_SUBMIT=false` (or unset) to immediately stop all mainnet orchestration spends; testnet flows continue to work. No migration or redeploy of wallet state is required.
