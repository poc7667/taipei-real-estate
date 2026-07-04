#!/usr/bin/env python3
# 實價登錄 臺北市 買賣+租賃：從 data/raw/*.zip 抽取 -> 存全臺北 -> 篩大安區合併
# 用 csv parser 處理引號內換行；一步到位取代 shell 抽取
import csv, glob, io, os, re, zipfile
from collections import Counter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
RAW, CITY, DAAN = (os.path.join(ROOT, d) for d in ("raw", "taipei", "daan"))
for d in (CITY, DAAN): os.makedirs(d, exist_ok=True)

MEMBERS = {"sale": "a_lvr_land_a.csv", "rent": "a_lvr_land_c.csv"}  # 臺北=a, 買賣=a 租賃=c
DISTRICT = "大安區"

def season_of(z): return re.search(r"(\d+S\d)\.zip$", z).group(1)

def read_csv_from_zip(zf, name):
    with zf.open(name) as fh:
        text = io.TextIOWrapper(fh, encoding="utf-8-sig")
        return list(csv.reader(text))

for kind, member in MEMBERS.items():
    all_out = os.path.join(DAAN, f"daan_{kind}_ALL.csv")
    header, n_daan, n_seasons = None, 0, 0
    dist_totals = Counter()
    with open(all_out, "w", newline="", encoding="utf-8-sig") as fo:
        w = csv.writer(fo)
        for z in sorted(glob.glob(os.path.join(RAW, "*.zip"))):
            season = season_of(z)
            try:
                zf = zipfile.ZipFile(z)
            except zipfile.BadZipFile:
                continue
            if member not in zf.namelist():
                continue
            rows = read_csv_from_zip(zf, member)
            if len(rows) < 3:
                continue
            n_seasons += 1
            # 存該期全臺北原始
            with open(os.path.join(CITY, f"{kind}_{season}.csv"), "w",
                      newline="", encoding="utf-8-sig") as cf:
                csv.writer(cf).writerows(rows)
            if header is None:
                header = rows[0] + ["來源期"]
                w.writerow(header)
            for r in rows[2:]:
                if r: dist_totals[r[0]] += 1
                if r and r[0] == DISTRICT:
                    w.writerow(r + [season])
                    n_daan += 1
    print(f"{kind}: {n_seasons} 期, 大安 {n_daan} 筆 -> {all_out}")
    print(f"   全臺北各區前5: {dist_totals.most_common(5)}")
