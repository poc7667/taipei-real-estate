# Marathon Contract
# 任務: 實價登錄分析系統 — 台北+新北全歷史，Python ETL 清洗 → clean.parquet → Next.js(DuckDB) → React(TanStack Table + Recharts 價量折線)
# 建立時間: 2026-07-03

## 已定決策（前置對談結論，實作不得偏離）

| 決策 | 定案 |
|---|---|
| 資料範圍 | 臺北市(a) + 新北市(f)，買賣(a) + 租賃(c)，全歷史 101S4~114S4 |
| 後端 | Next.js 15 API Route（全 TypeScript，單一 process，port 3000） |
| 查詢引擎 | DuckDB (node binding) 直讀 clean.parquet |
| ETL | Python + polars → clean.parquet |
| 車位 | 房屋淨價 = 總價 − 車位總價；純車位/純土地交易整列排除 |
| 四種單價 | ①權狀 ②主建物淨坪★ ③含附屬 ④主建物佔比%；單位=萬元/坪 |
| 圖表預設單價 | ② 主建物淨坪；前端下拉可切 ①②③ |
| outlier | 標記不刪（is_outlier）；前端「排除 outlier」filter 預設 ON |
| 低實用率 | 主建物佔比 <50% 標 is_low_ratio，前端可篩 |
| 地段粒度 | 三級全存（路 / 路+段 / 路+段+巷）；折線圖樣本 <8 自動聚合到「段」並標註 |
| 表格 | TanStack Table（排序+分頁） |
| 圖表 | Recharts：單價折線 + 成交量柱，雙軸價量同圖 |

## 驗收標準

### C1: ETL 產出乾淨 parquet（車位已扣、四單價齊全）
- playwright_action: 無（純資料層，用 CLI 驗證）
- cli_assertion:
  - 執行 `python etl/clean.py` 成功產生 `clean.parquet`
  - DuckDB 查詢：欄位含 西元年月, 縣市, 行政區, 路, 路段, 路段巷, 建物型別, 權狀總坪, 主建物坪, 車位坪, 房屋淨價, 單價_權狀, 單價_主建物, 單價_含附屬, 主建物佔比, is_車位交易, is_outlier, is_low_ratio, 交易類型(買賣/租賃), 來源期
  - 資料完整性：台北+新北 買賣+租賃 皆有列；純車位/純土地已排除；單價_主建物 對有主建物列皆 >0
  - 抽驗一筆手算：房屋淨價=總價−車位總價，單價_主建物=房屋淨價/(主建物m²/3.3058)/10000 誤差<1%
- console_check: N/A
- screenshot: N/A
- max_attempts: 10

### C2: 網站啟動，篩選表單完整可用
- playwright_action: goto localhost:3000 → snapshot
- dom_assertion: 頁面有篩選控制項：縣市下拉(台北/新北)、行政區下拉、建物型別下拉、交易類型(買賣/租賃)、期間、單價種類下拉(①②③)、「排除outlier」checkbox(預設勾選)、查詢按鈕
- console_check: zero errors
- network_check: N/A
- screenshot: evidence/C2-form.png
- max_attempts: 10

### C3: 查詢大安區→回表格報表
- playwright_action: 選 台北市→大安區→交易類型買賣→按查詢
- dom_assertion: 表格出現，欄位含 日期/地段/坪數/單價_主建物/總價；列數>0；可點欄位標題排序
- network_check: /api/query 回 200，JSON 含 rows 陣列
- console_check: zero errors
- screenshot: evidence/C3-table.png
- max_attempts: 10

### C4: 價量折線圖正確渲染
- playwright_action: 同 C3 查詢後
- dom_assertion: Recharts SVG 出現；單價折線 + 成交量柱兩組 series；X 軸為期別(西元季)；切換單價下拉①②③圖會更新
- console_check: zero errors（含 React key warning 也算失敗）
- screenshot: evidence/C4-chart.png
- max_attempts: 10

### C5: filter 交互 — 排除outlier + 低實用率 + 地段聚合
- playwright_action: 取消勾「排除outlier」→列數變多；勾「低實用率」篩選→列數變少；地段選到巷且樣本<8→圖標註「已聚合至段」
- dom_assertion: 上述三種互動 DOM 對應變化
- console_check: zero errors
- screenshot: evidence/C5-filters.png
- max_attempts: 10

## Circuit Breaker 設定
- consecutive_failures_limit: 3
- total_iteration_limit: 100
- per_criterion_limit: 10
- stuck_heuristic: 同一錯誤 3 次 → revert + 問 user
- dev_server: localhost:3000  (Next.js 預設，非 skill 預設 8181)

## Codex 角色
- 每個 criterion 通過後，codex 做 adversarial review（清洗邏輯正確性、單價公式、SQL 注入風險、React 效能）
- codex 指出的問題若成立 → 加為額外 criterion 或當場修

## 上下文
- 相關檔案: data/raw/*.zip(已下載53期), extract_all.py(既有臺北抽取), data/daan/*(既有大安樣本)
- 縣市前綴: a=台北 f=新北；類型: a=買賣 c=租賃
- 主檔欄位29=主建物面積 30=附屬建物面積 31=陽台面積（已驗證100%有值）
- 已知限制: 部分預售/透天無主建物分項→②③留空但保留列；坪換算 m²/3.3058
