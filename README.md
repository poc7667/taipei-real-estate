# 實價登錄分析系統

台北 + 新北市 實價登錄全歷史（2012Q1–2025Q4）分析工具。
Python ETL 清洗 → `clean.parquet` → Next.js（DuckDB 直讀）→ React 查詢介面（表格 + 價量折線圖）。

## 快速啟動

```bash
# 1. 產生清洗後資料（一次性；讀 data/raw/*.zip → clean.parquet）
python3 etl/clean.py

# 2. 啟動網站
cd web && npm install && npm run dev
# 開 http://localhost:3000
```

## 資料清洗重點（etl/clean.py）

| 處理 | 說明 |
|------|------|
| 扣車位 | 房屋淨價 = 總價 − 車位總價；純車位/土地交易排除 |
| 四種單價 | ①權狀 ②主建物淨坪★ ③含附屬（萬元/坪） |
| 主建物佔比 | 主建物 ÷ 建物總面積；<50% 標 is_low_ratio |
| 民國→西元 | 交易年月日 +1911 |
| m²→坪 | ÷ 3.3058 |
| 地段三級 | 路 / 路+段 / 路+段+巷（正則抽，去縣市區里前綴） |
| outlier | 同(縣市,區,型別,類型)群組 IQR 1.5；樣本<30 不標 |
| 車位欄名容錯 | 跨期欄名差異（含括號）自動比對 |

## 架構

```
data/raw/*.zip → etl/clean.py → clean.parquet (1.17M rows)
                                      │ DuckDB read_parquet
                              web/lib/db.ts (@duckdb/node-api)
                                      │
                    web/app/api/query  ← 篩選+聚合+分頁 SQL（參數化）
                    web/app/api/options ← 級聯下拉選項
                                      │ JSON
                    web/app/page.tsx (React: 篩選/KPI/Recharts/TanStack Table)
```

## 資料規模

台北買賣 276k・租賃 126k｜新北買賣 637k・租賃 127k = 1,166,149 筆
