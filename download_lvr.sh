#!/usr/bin/env bash
# 實價登錄 全歷史下載器 — 臺北市 買賣(a) + 租賃(c)，並篩出大安區
# 資料來源：plvr.land.moi.gov.tw 官方大量下載，一期一 zip
set -euo pipefail

BASE="https://plvr.land.moi.gov.tw/DownloadSeason?type=zip&fileName=lvr_landcsv.zip&season="
ROOT="$(cd "$(dirname "$0")" && pwd)/data"
RAW="$ROOT/raw"          # 每期原始 zip
CITY="$ROOT/taipei"      # 臺北市全區 csv（保留原始）
DAAN="$ROOT/daan"        # 大安區篩出
mkdir -p "$RAW" "$CITY" "$DAAN"

# 期數：101S1 ~ 現在。實價登錄 2012Q3(101S3) 起，往前抓也無妨（不存在自動跳過）
START_YEAR=101
END_YEAR=114   # 民國年，涵蓋 2025
SALE="a_lvr_land_a.csv"   # 臺北市買賣
RENT="a_lvr_land_c.csv"   # 臺北市租賃

# 累積合併檔（含表頭，只寫一次）
SALE_ALL="$DAAN/daan_sale_ALL.csv"
RENT_ALL="$DAAN/daan_rent_ALL.csv"
: > "$SALE_ALL"; : > "$RENT_ALL"

extract_one() {  # $1=season $2=member(sale/rent) $3=csvname $4=cityout $5=allout
  local season=$1 kind=$2 csv=$3 cityfile="$4/${2}_${1}.csv" allfile=$5
  local zip="$RAW/$season.zip"
  if ! unzip -l "$zip" 2>/dev/null | grep -q " $csv$"; then return; fi
  unzip -p "$zip" "$csv" > "$cityfile"
  # 表頭：第1行中文、第2行英文。合併檔只保留第一期的中文表頭
  if [ ! -s "$allfile" ]; then head -1 "$cityfile" > "$allfile"; fi
  # 篩大安區（第1欄=鄉鎮市區）；跳過兩行表頭，加上來源期欄位
  awk -F',' -v s="$season" 'NR>2 && $1=="大安區"{print $0","s}' "$cityfile" >> "$allfile"
}

for y in $(seq $START_YEAR $END_YEAR); do
  for q in 1 2 3 4; do
    season="${y}S${q}"
    zip="$RAW/$season.zip"
    if [ ! -s "$zip" ]; then
      code=$(curl -sS -o "$zip" -w "%{http_code}" "${BASE}${season}" || echo 000)
      # 非 zip（404/空）→ 刪掉跳過
      if [ "$code" != "200" ] || ! unzip -l "$zip" >/dev/null 2>&1; then
        rm -f "$zip"; printf "skip  %s\n" "$season"; continue
      fi
    fi
    extract_one "$season" sale "$SALE" "$CITY" "$SALE_ALL"
    extract_one "$season" rent "$RENT" "$CITY" "$RENT_ALL"
    printf "ok    %s  (sale=%s rent=%s)\n" "$season" \
      "$([ -f "$CITY/sale_$season.csv" ] && wc -l < "$CITY/sale_$season.csv" || echo 0)" \
      "$([ -f "$CITY/rent_$season.csv" ] && wc -l < "$CITY/rent_$season.csv" || echo 0)"
  done
done

echo "=== 大安區合併結果 ==="
echo "買賣: $(($(wc -l < "$SALE_ALL")-1)) 筆  → $SALE_ALL"
echo "租賃: $(($(wc -l < "$RENT_ALL")-1)) 筆  → $RENT_ALL"
