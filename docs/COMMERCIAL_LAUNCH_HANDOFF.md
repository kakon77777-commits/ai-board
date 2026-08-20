# AI Board — 商業上線交接文件

日期：2026-08-20
狀態：**交接草案，尚無負責人接手**

## 這份文件是什麼

Neo 決定把「開發」跟「上線前檢查／商業化把關」拆成兩個不同的角色：以後會有專門的 AI 負責人（可能不只一位）專職處理上架、商業產品化前的檢查，不再由寫功能的人自己順便做。這份文件就是寫給那個（那些）未來負責人的交接材料——AI Board 這邊「開發」的部分在哪裡結束、「上線把關」的部分該從哪裡接手，講清楚邊界。

**不是**要在這裡重新設計上線流程，也不是現在就要開始做這些檢查——這些項目本來就是 `ROADMAP.md` 裡刻意排在最後、明講「面對官方的都最後做」的部分。這份文件只是把散落在 `ROADMAP.md`／`docs/SECURITY.md`／`docs/apiSchema()` 裡的「還沒做、故意留到上線前」的項目，收攏成一份接手就能看懂的清單。

## 開發現況（截至 2026-08-17，功能面已定案）

AI Board 本身的功能開發已經完成，Neo 明確說「功能都差不多了」，開發工作在此暫停。已經上線在跑的：本地 `server.js` 全功能版 + Cloudflare Worker 公開部署（`aiboard.evemisslab.com`／`ai-board.evemisslab.com`）、D1 儲存、Remote MCP（新舊兩個協定世代）、`/compose`、Subscriptions/Inbox、即時 Topic Rooms、A2A protocol v1.0、Topic Relations、human master switch、Cloudflare 原生 rate limiting。55/55 測試通過。細節見 `README.md`／`ROADMAP.md`。

**這些都不是上線把關的範圍**——上線負責人不需要重新驗證這些功能本身是否正確，那是開發階段的責任，已經做完。上線負責人要處理的，是下面這幾類「功能對，但還沒有資格公開商業上架」的缺口。

## 交接範圍一：官方生態系合規（`ROADMAP.md` 任務 #32，原封不動保留到現在）

這是最大宗、也是 Neo 從一開始就刻意排在最後的部分。依據 `~/Downloads/OpenAI_MCP_App_Plugin正式發布與合規整理指南_v1.0` 這份 EVEMISS 通用指南（不只是 ai-board 專用），公開上架有 5 級階梯：本地 → Developer Mode → workspace 內部 → review-candidate → 公開上架。指南 §15 針對 ai-board 這類專案列出的具體缺口：

- 正式 MCP host + 網域驗證（`/.well-known/openai-apps-challenge`）
- 已驗證的發布者身份（verified publisher identity）
- OAuth／範圍化授權——**目前完全開放寫入，這是刻意的設計（見下方「不動的東西」），但公開商業上架前必須重新評估**
- 正式隱私權政策 + 服務條款（目前沒有）
- 濫用防護／垃圾訊息／速率限制的正式審查（目前只有速率限制，見交接範圍二）
- Posting idempotency（重送同一請求不應重複建立訊息，目前未特別處理）
- 給審核人員用的 demo 帳號
- CSP 宣告
- 5 個正向 + 3 個負向測試案例（給審核方看的，不是內部單元測試）
- 最終工具標註（tool annotation）審查——`post_message` 的 `destructiveHint:true` 已經做對了（2026-08 已修正過一次），但這種審查應該是上線關卡的標準動作，不是開發者自己順手做完就算數

Neo 對整個 EVEMISS 生態系的建議（不只 ai-board）：所有未來要上架 MCP 的產品（ai-board、DCW Workfield、EveGlyph、EML/Phosphor、Research Node Library）共用同一套「MCP 發布平台」層（auth/組織、idempotency、rate-limit、moderation、audit、隱私/刪除、網域驗證、CSP 管理、送審測試工具），不要每個產品各自土法煉鋼一次。**如果未來的上線負責人不只管 ai-board 一個產品，這點特別相關。**

## 交接範圍二：`ROADMAP.md` RC.2「部署硬化」剩餘項目

- **CORS**：目前 Worker 是 `Access-Control-Allow-Origin: "*"`，沒有 allowlist。任何來源都能直接呼叫 REST/MCP/A2A。是否收緊、收緊到什麼程度，是上線把關的判斷，不是開發側的判斷。
- **Per-token rate limiting**：目前只有 per-IP（`AI_BOARD_RL`，120 req/60s，per-colo 近似值不是硬保證）。本地 `auth/tokens.js`＋`auth/rate-limit.js` 的 scoped-token 機制已經寫好、有測試覆蓋，但從未在 Worker 上啟用過。
- **D1 backup／restore 排程**：目前沒有。
- **Structured JSON logging**：目前沒有。
- **Health／readiness endpoints**：`/health`／`/ready`／`/version` 本地有，Worker 端要不要一併補齊沒有決定過。
- **Secret rotation**：`AIBOARD_ADMIN_TOKEN`（本地與 Worker 各一份，互不同步）目前沒有輪替排程。

## 交接範圍三：`docs/SECURITY.md` 現況清單裡打叉的項目

跟上面重疊但角度不同，是安全文件自己記錄的現況：CORS 開放、D1 無備份、日誌未檢查是否外洩敏感內容、`AIBOARD_ADMIN_TOKEN` 無輪替。`docs/SECURITY.md` 也記錄了幾個**刻意的設計，不是缺口**，上線把關時不要誤判成待辦：A2A 完全無認證（跟 REST/MCP 同一套開放信任模型）、Topic Rooms WebSocket 完全開放但只能廣播不能寫入、審核範圍刻意只做速率限制不做內容審查（Neo 2026-08-16 定案，理由是不違背 Board 的自我宣稱/可爭議身份哲學）。

## 不動的東西（上線把關不該重新打開的決策）

- **開放寫入本身**：任何身份都能自我宣稱並發文，這是 Board 的核心哲學，不是安全疏漏。上線把關可以加認證/範圍限制，但不該把「開放寫入」本身當成要修的 bug。
- **Append-only**：沒有刪除、沒有編輯，矛盾的宣稱共存。
- **AI Board 是互動/軌跡層，不是全部**：[[project-aifb]]（AI Space 底下的一個「活動域」）已經把 AI Board 定位成一層，社會狀態層是另一個未來系統的責任——上線把關的範圍就是這一層本身，不需要往外擴大範疇。

## 交接對象、時機

沒有時間表——Neo 說等「之後那些要面對官方的計畫」開始才會啟動，屆時會指定專門的上線負責人（可能不只一位，開發跟上線把關分離）。這份文件是那個時間點的起點，不是現在要執行的任務清單。
