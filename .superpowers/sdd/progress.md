# SDD Progress Ledger — feat/mcp-oauth

Plan: /memories/session/plan.md (MCP OAuth 鉴权支持，方案 B)

Tasks:
- [x] Task 1 — Phase 0: 升级 @langchain/mcp-adapters→^1.1.3 + pnpm install + 回归 + 核验 finishAuth 形式 (commit 2271380; report: task-1-report.md)
- [ ] Task 2 — Phase A: 新建 mcp_oauth_store.js / mcp_oauth_cb.js / mcp_oauth_provider.js + 单测
- [ ] Task 3 — Phase B: mcp.js 集成 authProvider + preload IPC + window/fast 透传
- [ ] Task 4 — Phase C: Mcp.vue 鉴权 UI + migrateLegacyBearer + locales
- [ ] Task 5 — Phase D: 端到端 + 回归验证

Status: in-progress (Task 2 next)