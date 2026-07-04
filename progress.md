---
task: 實價登錄分析系統 — 台北+新北全歷史 ETL→DuckDB→Next.js→React(表格+價量圖)
contract: marathon-contract.md
status: COMPLETED
started_at: 2026-07-03
completed_at: 2026-07-04
dev_server: localhost:3000
---

## 進度

| # | Criterion | Status | Attempts | Commit |
|---|-----------|--------|----------|--------|
| C1 | ETL 產乾淨 parquet（車位扣、四單價） | VERIFIED | 手算誤差0% | 5d321e1 |
| C2 | 網站啟動 + 篩選表單完整 | VERIFIED | console 0錯 | — |
| C3 | 查大安區→表格報表 | VERIFIED | 真資料+排序 | — |
| C4 | 價量折線圖渲染 | VERIFIED | 雙軸價量 | — |
| C5 | filter 交互（outlier/低實用/地段聚合） | VERIFIED | 三項皆驗 | — |

## 熔斷狀態
- consecutive_failures: 0
- total_iterations: ~12
- last_passing_commit: (更新中)

## 驗證證據
- evidence/C2-form.png — 完整介面（表單+KPI+價量圖）
- C3 表格：snapshot 確認真實 巷級 資料（忠孝東路四段166巷 住宅大樓 主61.4坪 133.6萬/坪）
- C5 outlier：UI 實點 25,361→26,232 件（DOM 變化）
- C5 聚合：仁愛路四段25巷(7筆<8) → aggregatedToSeg=true，趨勢聚合到段

## Codex 修正（C1）
車位面積欄名跨期容錯 / 租賃白名單放寬(4萬→12.6萬筆) / 地址正則重寫(0髒) / net_price<=0濾除 / IQR最小樣本門檻

## 資料規模
1,166,149 筆（台北買賣276k+租賃126k / 新北買賣637k+租賃127k），2012Q1~2025Q4
