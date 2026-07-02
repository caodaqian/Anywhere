# Task 5 / Phase D — Verification Report

Plan ref: `/memories/session/plan.md` §Verification (9 items).

## Automated (run via `node tests/test_oauth_verify.js`)

| # | Item | Result |
|---|------|--------|
| 1 | SDK version regression | ✅ adapters=1.1.3, sdk=1.29.0 (`V1_OK true`) |
| 2 | OAuthClientProvider shape (duck-type: 5 required members + metadata native/secret_post/refresh grant) | ✅ all members present; redirectUrl loopback; empty-config build ok |
| 3 | loopback callback + state/iss validation | ✅ state mismatch rejected; matching state resolves code+iss; error callback rejected |
| 4 | encryption-at-rest (read shards → ciphertext not plaintext; decrypt round-trip) | ✅ tokens & client_secret NOT in plaintext; decrypt recovers originals |
| 7 | batch JSON migration regression | ✅ legacy Bearer→auth.bearer (header removed); Basic preserved; existing oauth not overridden; no-header noop |
| 8 | loopback port-occupied → BrowserWindow fallback route | ✅ loopback fails on occupied port; `runAuthFlowWithFallback` routes to BrowserWindow path |

Total automated: **26 passed, 0 failed**.

Supporting suites:
- `tests/test_oauth.js`: 43 passed, 0 failed (Phase A modules).
- `tests/test_migrate_bearer.js`: 9 passed, 0 failed (migrateLegacyBearer parity).
- `tests/test_load_sdk_auth.js`: ✅ `loadSdkAuth` resolves SDK `auth` + `UnauthorizedError` exports (finishAuthFlow Path B dependency).

Builds:
- `cd backend && npm run build` (esbuild) — ✅ ok.
- `cd Anywhere_main && npx vite build` — ✅ ok (1454 modules).

## Bug found & fixed during verification

**`loadSdkAuth` (mcp_oauth_provider.js)**: original root-extraction took the
first `node_modules` segment, yielding the top-level `node_modules` — but under
pnpm isolation the SDK is NOT hoisted there; it lives in the adapter's own
scoped `.pnpm/@modelcontextprotocol+sdk@.../node_modules/...`. The constructed
candidate path did not exist, so `finishAuthFlow` Path B (token exchange when no
transport reference is available) would throw `Cannot find module
'@modelcontextprotocol/sdk/client/auth.js'` at runtime.

Fix: resolve via `require.resolve(subpath, { paths: [adapterDir] })` so Node
follows the adapter's dependency tree to the scoped SDK, with a fallback from
this module's own directory. Verified by `test_load_sdk_auth.js`.

## Manual / live-environment (deferred — require running MCP OAuth server or second device)

These items cannot be exercised offline and are left for in-product QA:

- **Item 5 — E2E HTTP/SSE OAuth**: configure a remote MCP server requiring
  OAuth; in Mcp.vue run prepare→DCR→login→callback→finishAuth→status "已登录"→
  connect test shows tools→trial run returns; shorten `expires_at` 60s → SDK
  auto-refresh + reconnect; force `invalid_grant` → "重新登录" prompt.
- **Item 6 — E2E stdio OAuth**: stdio + oauth + `envMapping=['MY_TOKEN']`;
  child process prints env confirming `MY_TOKEN=<access_token>`; token expiry
  triggers refresh then re-injection of env.
- **Item 9 — cross-device**: load the same utools.db on another machine →
  decrypt fails (device-bound AES-256-GCM) → re-login prompt.

## Regression confirmation (static, offline-able parts of Item 7)

- Static bearer (`auth.type='bearer'`): `buildMcpClientServerConfig` injects
  `headers.Authorization` — unchanged path; not exercised by an OAuth provider.
- stdio: `prepareStdioAuthEnv` only acts when `auth.type==='oauth'`; non-oauth
  stdio unaffected.
- builtin services: `auth.type` defaults to `'none'` → no `authProvider`, no
  OAuth overhead.
- Batch JSON edit entry: `saveJson` runs `migrateLegacyBearer` per server for
  parity with single-server `saveServer` (both call the same helper).
- Non-Bearer (e.g. Basic) preserved; existing bearer/oauth config not overridden.

## Conclusion

Phase D offline verification is complete (Items 1,2,3,4,7,8 automated + build
regression). A real bug in `loadSdkAuth` (pnpm-isolated SDK resolution) was
found and fixed. Items 5, 6, 9 require a live OAuth-capable MCP server or a
second physical device and are documented as manual E2E for in-product QA.
