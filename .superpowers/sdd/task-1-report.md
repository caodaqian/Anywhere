# Task 1 Report — Phase 0 依赖升级与 finishAuth 核验

## 1. Resolved versions

- `backend/package.json`: `@langchain/mcp-adapters` 已改为 `^1.1.3`。
- pnpm 安装后 resolved:
  - `@langchain/mcp-adapters@1.1.3`
  - `@modelcontextprotocol/sdk@1.29.0`（transitive，由 adapters `^1.29.0` 带动；同 1.x 大版本，兼容升级；之前为 1.20.2）
- 物理位置（pnpm virtual store）：
  - adapters: `backend/node_modules/.pnpm/@langchain+mcp-adapters@1.1.3_@cfworker+json-schema@4.1.1_@langchain+core@1.0.2_openai@_90e6fafd0cf29b1a27990a8470b5d1ed/node_modules/@langchain/mcp-adapters`
  - sdk: `backend/node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_@cfworker+json-schema@4.1.1_zod@4.1.12/node_modules/@modelcontextprotocol/sdk`
- SDK `package.json`: `type: "module"`，但 exports 同时提供 `import`（esm）与 `require`（cjs）条件；adapters 在 CJS 入口 `dist/index.cjs` 通过 `require` 条件加载 SDK 的 `dist/cjs/*`。运行时 CJS 互操作正常。

## 2. v1 OAuthClientProvider 接口导出路径与符号

- 导出子路径 `@modelcontextprotocol/sdk/client` → `dist/cjs/client/index.js`，运行时导出 `Client`、`getSupportedElicitationModes`（无 OAuth 符号）。
- OAuth 全部符号在 `@modelcontextprotocol/sdk/client/auth.js`（即 exports 子路径 `./client/auth`，运行时 `dist/cjs/client/auth.js`）：
  - 运行时导出（已确认）：`UnauthorizedError`、`auth`、`buildDiscoveryUrls`、`discoverAuthorizationServerMetadata`、`discoverOAuthMetadata`、`discoverOAuthProtectedResourceMetadata`、`discoverOAuthServerInfo`、`exchangeAuthorization`、`extractResourceMetadataUrl`、`extractWWWAuthenticateParams`、`fetchToken`、`isHttpsUrl`、`parseErrorResponse`、`prepareAuthorizationCodeRequest`、`refreshAuthorization`、`registerClient`、`selectClientAuthMethod`、`selectResourceURL`、`startAuthorization`。
  - 类型（`auth.d.ts`，type-only）：`OAuthClientProvider`、`OAuthClientMetadata`、`OAuthClientInformation`/`OAuthClientInformationMixed`、`OAuthTokens`、`AuthProvider`、`OAuthProtectedResourceMetadata`、`OAuthAuthorizationServerMetadata`、`AuthResult` 等。
- v1 `OAuthClientProvider` 接口（auth.d.ts:15）必需成员（与方案一致）：
  - `redirectUrl` (get)
  - `clientMetadata` (get, `OAuthClientMetadata`)
  - `clientInformation()` → `OAuthClientInformationMixed | undefined`
  - `saveClientInformation?(clientInformation)` (optional)
  - `tokens()` → `OAuthTokens | undefined`
  - `saveTokens(tokens)`
  - `redirectToAuthorization(authorizationUrl: URL)`
  - `codeVerifier()` / `saveCodeVerifier(codeVerifier)`
  - 可选：`state?()`、`clientMetadataUrl?`、`invalidateCredentials?(scope)`（前瞻字段）
- **关键**：v1 接口方法**无 `ctx` 参数**（`tokens()`、`clientInformation()`、`saveTokens()` 等都不带 ctx）。这与 v2 beta 的 `ctx` 参数不同 → Task 2 实现按 v1 形态即可，未来迁移 v2 只需在各方法补 `ctx`。
- 典型 import 形式（CJS）：
  ```js
  const { UnauthorizedError, auth } = require("@modelcontextprotocol/sdk/client/auth.js");
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  ```
  （Task 2/3 走 adapters 透传，多数情况下不直接 require 这些；仅 `UnauthorizedError` 用于 catch。）

## 3. finishAuth 在 v1 SDK 的具体调用形式（Task 3 编排关键）

### 3.1 transport.finishAuth
- `StreamableHTTPClientTransport.finishAuth(authorizationCode: string): Promise<void>`（streamableHttp.d.ts:139；实现 streamableHttp.js:269）。
- `SSEClientTransport.finishAuth(authorizationCode: string): Promise<void>`（sse.d.ts:76；实现 sse.js:143）。
- **两者签名均为单一字符串参数 `authorizationCode`，无 `iss` 参数**（v1 形态；v2 beta 才有 `iss`）。
- 实现：内部调用 `auth(this._authProvider, { serverUrl, authorizationCode, resourceMetadataUrl, scope, fetchFn })`；若返回值非 `'AUTHORIZED'` 则抛 `UnauthorizedError('Failed to authorize')`。

### 3.2 顶层 `auth(provider, options)` helper
- 签名（auth.d.ts:214）：
  ```ts
  function auth(provider: OAuthClientProvider, options: {
    serverUrl: string | URL;
    authorizationCode?: string;
    scope?: string;
    resourceMetadataUrl?: URL;
    fetchFn?: FetchLike;
  }): Promise<AuthResult>
  ```
- `auth()` 是统一入口：当 `authorizationCode` 缺省时，它会跑 discovery（`discoverOAuthProtectedResourceMetadata`/`discoverAuthorizationServerMetadata`）→ DCR（`registerClient`，若 `clientInformation()` 为空）→ 构造授权 URL → 调 `provider.redirectToAuthorization(url)` 并抛 `UnauthorizedError`（流程未完成）；当传入 `authorizationCode` 时，它跑 `exchangeAuthorization`（PKCE）+ `saveTokens`，成功返回 `'AUTHORIZED'`。

### 3.3 最小编排伪代码（X = `transport.finishAuth(code)`）
```
try {
  await multiClient.getTools()        // 或 connectAndFetchTools()
} catch (e) {
  if (e instanceof UnauthorizedError) {
    // SDK 已自动跑完 discovery + DCR + provider.redirectToAuthorization(url)
    // → 我们的 provider.redirectToAuthorization 打开浏览器/弹窗登录
    const code = await waitForCallback()      // loopback / BrowserWindow 回调拿 code
    const sdkClient = await multiClient.getClient(serverName)
    await sdkClient.transport.finishAuth(code) // ← X：用 transport.finishAuth
    // 重新 connect（重建 wrapper 或对该 client 重新 getTools）
  }
}
```
> Task 3 实现 `ensureMcpAuthenticated` 时优先用 `getClient(name).transport.finishAuth(code)`；transport 为 SDK `Protocol.get transport()`（protocol.d.ts:283 公开 getter），类型为 `Transport | undefined`。若 transport 不存在（未 connect 过），退化为直接调 `auth(provider, { serverUrl, authorizationCode: code })` helper（Task 2 的 `finishAuthFlow` 兜底）。

## 4. 多服务器场景是否需要绕过 langchain wrapper

- `MultiServerMCPClient` **公开** `getClient(serverName, options?): Promise<Client | undefined>`（client.d.ts 已确认）→ 返回底层 SDK `Client`。
- SDK `Client extends Protocol`，`Protocol` 暴露 `get transport(): Transport | undefined`（protocol.d.ts:283，public getter）。
- 因此 **Task 3 不必绕过 wrapper**：路径 `multiClient.getClient(name).transport.finishAuth(code)` 可达。这是推荐方案（方案 A）。
- 方案 B（兜底，仅当 transport 为空或 finishAuth 不可达时）：Task 2 的 `finishAuthFlow` 直接 `require('@modelcontextprotocol/sdk/client/auth.js').auth(provider, { serverUrl, authorizationCode: code })`，独立完成 token 交换后让 wrapper 重新 connect 时 `provider.tokens()` 即返回新 token。两个方案均可在 Task 3 保留。
- `connection.cjs` 内部 `getTransport(opts)`（L161）是连接池管理器方法（私有 `#clientConnections`），但 `MultiServerMCPClient` 类本身未公开 `getTransport`，故**对外用 `getClient().transport`**，不要依赖 wrapper 内部 pool 方法。

## 5. langchain wrapper 在哪一层抛 UnauthorizedError / 触发 auth 流

- adapters `connection.cjs`：
  - `#createStreamableHTTPTransport`/`#createSSETransport` 把 `authProvider` 透传给底层 transport 构造选项（L79、L176、L208、L318、L533）。
  - wrapper 在 `_initializeStreamableHTTPConnection`/`_initializeSSEConnection` 里 `new StreamableHTTPClientTransport({ url, headers, authProvider })` 并 `new Client(...).connect(transport)`。
  - **auth 流由底层 transport 驱动**：transport 在 `send()` 遇 401/403 时调 `auth(provider, {...})`（streamableHttp.js:41、100、318、326、356；sse.js:38、93、180、184），discovery+DCR+`redirectToAuthorization` 全部在 transport 内完成，随后抛 `UnauthorizedError`。
- 时序结论：
  - **构造 wrapper 时不触发 auth**（`connect()` 会 `start()` + 发 initialize 请求；若服务器首次 401，则 initialize 请求的 send 抛 UnauthorizedError → wrapper 的 `connect` reject）。
  - `getTools()`/`listResources()` 等 send 操作遇 401 也会抛 UnauthorizedError。
  - 因此 **Task 3 应在 `initializeMcpClient` / `connectAndFetchTools` / `connectAndInvokeTool` 三处都 catch `UnauthorizedError`**，统一交给 `ensureMcpAuthenticated(name)` 编排（拿 code → `getClient(name).transport.finishAuth(code)` → 重连）。这与现有 `connectAndFetchTools` 已有 try/catch 结构一致，改动最小。

## 回归结果

- `pnpm install` 成功（经 `npx -y pnpm@latest install`，因系统未装 pnpm）。
- import-ok 校验（按 brief 要求的静态校验）：
  - `cd backend && node -e "require('@langchain/mcp-adapters'); console.log('adapters-import-ok')"` → 打印 `adapters-import-ok`。
  - SDK 为 transitive，从 backend 根 `require('@modelcontextprotocol/sdk')` 失败是 pnpm 标准行为（非本项目 direct dep）；adapters 内部 require 链正常加载 CJS dist，adapters-import-ok 即为回归门。
- `backend/src/*.js` 未修改，无业务代码回归面。
- Breaking：无（同 1.x 大版本；adapters 1.0→1.1.3 minor 升级，authProvider 透传为新增能力，现有 builtin/stdio/bearer 路径未触及）。

## Delivery

- 修改文件：`backend/package.json`（`@langchain/mcp-adapters` → `^1.1.3`）、`backend/pnpm-lock.yaml`（pnpm 自动）。
- 未修改任何 `backend/src/*.js`、前端、locales、docs。
- 本 report：`.superpowers/sdd/task-1-report.md`。
- 待提交 commit：`chore(deps): bump @langchain/mcp-adapters to ^1.1.3 (drives @modelcontextprotocol/sdk to 1.29.x) for MCP OAuth authProvider support`。