#!/usr/bin/env python3
# 篩大安區 — 用 csv parser 正確處理引號內換行；掃 data/taipei/*.csv 合併
import csv, glob, os, re, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
CITY = os.path.join(ROOT, "taipei")
DAAN = os.path.join(ROOT, "daan")
os.makedirs(DAAN, exist_ok=True)
DISTRICT = "大安區"

def season_of(path):  # sale_102S1.csv -> 102S1
    m = re.search(r"_(\d+S\d)\.csv$", os.path.basename(path))
    return m.group(1) if m else "?"

def merge(kind, outname):
    files = sorted(glob.glob(os.path.join(CITY, f"{kind}_*.csv")))
    out = os.path.join(DAAN, outname)
    header = None
    n = 0
    with open(out, "w", newline="", encoding="utf-8-sig") as fo:
        w = csv.writer(fo)
        for f in files:
            season = season_of(f)
            rows = list(csv.reader(open(f, encoding="utf-8-sig")))
            if len(rows) < 3:
                continue
            if header is None:
                header = rows[0] + ["來源期"]
                w.writerow(header)
            for r in rows[2:]:              # 跳過中/英兩行表頭
                if r and r[0] == DISTRICT:
                    w.writerow(r + [season])
                    n += 1
    print(f"{kind}: {n} 筆 -> {out}")
    return n

s = merge("sale", "daan_sale_ALL.csv")
r = merge("rent", "daan_rent_ALL.csv")
