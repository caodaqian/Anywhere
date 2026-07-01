# Task 1: Phase 0 — 依赖升级与 finishAuth 核验

## 来源
Plan: /memories/session/plan.md (方案 B：升级官方 SDK)

## Task 全文

### Phase 0 — 依赖升级（独立验证）
0. **升级 backend/package.json**：`@langchain/mcp-adapters` `^1.0.0`→`^1.1.3`；`pnpm install` 让 sdk 自由解析到 1.29.x。运行现有 MCP 连接/调用做最小回归（确认 builtin、static headers bearer、stdio 三种现有服务仍可连通且工具可调用），无 breaking 再往下走。**此步同时实地核验 v1 SDK 的 `finishAuth` 调用形式**（公开方法 vs 走 `auth()` helper），敲定 Phase B 编排细节。

## 关键背景（决策依据 / 来自方案核实）
- `@langchain/mcp-adapters@1.1.3`（npm 最新，自 v0.4.6 起支持）在 `connection.ts` 的 `#createStreamableHTTPTransport` / `#createSSETransport` 把配置里的 `authProvider` 字段直接透传给底层 transport 构造选项。验证 schema `oAuthClientProviderSchema` 在 `types.ts` 强制要求 `redirectUrl`/`clientMetadata`/`clientInformation`/`tokens`/`saveTokens`，正好是 v1 `OAuthClientProvider` 必需集。
- 1.1.3 的依赖是 `@modelcontextprotocol/sdk ^1.29.0`，1.20.2 < 1.29.0 → 升级 mcp-adapters 会同步带动 sdk 升到 1.29.x（同 1.x 大版本，兼容升级）。
- stdio：`StdioClientTransport({ command, args, env, stderr, cwd })` 无 `authProvider`/auth 槽位；stdio 必须在我们注入 env。
- 官方 v2 接口在 `@modelcontextprotocol/client@2.0.0-beta.1`（beta，本方案不采用）。

## 必须产出的事实（供 Task 3 / Phase B 编排决策）

完成 install 后，读 `backend/node_modules/@modelcontextprotocol/sdk/` 实地确认并把结果写入 report：

1. **`package.json` 中的实际版本**：`@langchain/mcp-adapters` 与 `@modelcontextprotocol/sdk` 的 resolved version 字符串。
2. **v1 `OAuthClientProvider` 接口导出路径**：确认 `@modelcontextprotocol/sdk/client/auth.js` 是否导出 `OAuthClientProvider`（type-only 还是 runtime？）、`UnauthorizedError`、`auth` helper、`OAuthClientMetadata`、`OAuthClientInformation`、`OAuthTokens` 等类型/符号。把导出的列表与典型 import 形式记入 report。
3. **`finishAuth` 在 v1 SDK 的具体调用形式**（这是 Task 3 编排关键）：
   - 读 `node_modules/@modelcontextprotocol/sdk/dist/client/streamableHttp.js` 与 `.../sse.js`：`StreamableHTTPClientTransport` / `SSEClientTransport` 是否有公开的 `finishAuth(code | URLSearchParams, iss?: string)` 方法？
   - 是否导出顶层 `auth(provider, options)` helper？签名是什么？
   - 给出最小调用样例代码（伪代码即可），说明"401 → SDK 自动跑 discovery+DCR+redirectToAuthorization → 抛 UnauthorizedError → 我们的代码捕获 → 浏览器登录 → 拿回调 → 调 X 换 token → 重新 connect"中 X 的具体形式。
4. **多服务器持久连接场景下 finishAuth 是否需要绕过 langchain `MultiServerMCPClient`**：因为 langchain wrapper 内部持有 transport 实例。若 wrapper 不暴露底层 transport 引用，Task 3 需要决定"直接用底层 `Client` + transport"还是"等 wrapper 抛 UnauthorizedError 后无法 finishAuth 只能手工跑 auth()"。给出可行方案 A/B 与代码位置。
5. **langchain `MultiServerMCPClient` **是否** 在 connect 时遇到 401 会自动跑 discovery+DCR 并抛 `UnauthorizedError`**：读 `node_modules/@langchain/mcp-adapters/dist/...` 的 connection 实现，确认 wrapper 把 `authProvider` 直接透传给底层 transport 后，连接构造时序是否会触发底层 transport 的 auth 流程，还是只在 send/listTools 时才触发。这关系到 Task 3 在哪一层 catch UnauthorizedError。

## 回归要求（无 breaking 才能继续）
- 必须运行 `pnpm install` 成功。
- 因为 node 端需要起 utools runtime 才能跑真连接，**回归改用静态校验**：
  - `pnpm install` 后 `cd backend && node -e "require('@langchain/mcp-adapters'); require('@modelcontextprotocol/sdk'); console.log('import-ok')"` 必须打印 `import-ok`。
  - 跑一遍 `node -e` 加载 `src/mcp.js` / `src/preload.js` 看是否还能 require 成功（注意它们 require 了 `electron`、`utools` 这些全局；若 sandbox 缺失允许失败但要把错误记入 report，并非本任务 regression 目标——以 import-ok 为准）。
- 不要尝试启动整个 utools 插件（超出本任务范围，且无运行环境）。
- 不要修改任何 `backend/src/*.js` 业务代码——本任务只动 `package.json`、`pnpm-lock.yaml`，外加读 `node_modules`。

## 范围限制（YAGNI）
- 只升级 `@langchain/mcp-adapters` 到 `^1.1.3`，**不要** 升级到任何 alpha/beta（不要带 `@modelcontextprotocol/client`）。
- 不要预写任何 OAuth 模块代码——那是 Task 2 的职责。
- 不要改前端、locales、docs。

## Delivery
- 修改：`backend/package.json`（pin 范围）、`backend/pnpm-lock.yaml`（由 pnpm 自动更新）。
- 提交一个 commit：`chore(deps): bump @langchain/mcp-adapters to ^1.1.3 (drives @modelcontextprotocol/sdk to 1.29.x) for MCP OAuth authProvider support`。
- Report 文件 / 报告：见 implementer 契约。