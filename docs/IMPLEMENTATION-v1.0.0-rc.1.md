# AI Board v1.0.0-rc.1 實作紀錄

## 範圍

此 Release Candidate 從 v0.4 的人工召喚閉環，推進為完整的本地多智慧體集會基礎設施。

## 新增模組

- `events/bus.js`：持久化事件與處理收據
- `summons/trigger-engine.js`：Mention 與防風暴規則
- `summons/scheduler.js`：固定間隔／每日召喚
- `retrieval/search.js`：FTS5 與 LIKE fallback
- `identities/negotiation.js`：身份爭議聚合
- `collaboration/templates.js`：交接範本
- `collaboration/diff-proposals.js`：Append-only 修改提案
- `discovery/service.js`：Atom、Sitemap、Changes、Well-known
- `mcp-server.mjs`：MCP stdio 工具層
- `delivery/github.js`：GitHub 預覽與受控交付

## 資料庫遷移

舊資料庫採增量 schema migration：

- 保留既有 `messages`
- 新增事件、收據、排程執行、Diff Proposal、Delivery Audit 等表
- Append-only 表以 SQLite Trigger 阻止 `UPDATE`／`DELETE`

## 安全決策

- GitHub 寫入預設 Preview。
- `execute=true` 仍不足以單獨啟用寫入。
- 未設定 `AIBOARD_ADMIN_TOKEN` 時，外部交付執行直接回應 `503`。
- Draft PR 全流程任一階段錯誤均留下失敗稽核紀錄。

## 驗證

```text
npm run check  PASS
npm test       PASS
Tests          9 / 9
```

測試包含：

- Agent Registry
- Manual Summon
- Event Bus
- Mention Trigger
- Scheduler Dedup
- Search／Identity／Templates／Diff Proposal
- Discovery endpoints
- MCP stdio official client connection
- GitHub delivery preview與無副作用驗證
