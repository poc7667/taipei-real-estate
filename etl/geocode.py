#!/usr/bin/env python3
"""
geocode ETL — 對 unique (縣市,行政區,路段) 用 Nominatim 查 WGS84 座標
→ seg_geo.parquet。可續跑（快取已查過的），禮貌限速 1.1s/req。
巷級地圖用段座標 fallback（v1）。
"""
import polars as pl, json, os, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLEAN = os.path.join(ROOT, "clean.parquet")
CACHE = os.path.join(ROOT, "data", "geocode_cache.json")
OUT = os.path.join(ROOT, "seg_geo.parquet")
UA = "lvr-analysis-geocode/1.0 (personal research)"

cache = {}
if os.path.exists(CACHE):
    cache = json.load(open(CACHE, encoding="utf-8"))

def geocode(city, dist, seg):
    key = f"{city}{dist}{seg}"
    if key in cache:
        return cache[key]
    q = urllib.parse.quote(f"{city}{dist}{seg}")
    url = f"https://nominatim.openstreetmap.org/search?q={q}&format=json&limit=1&countrycodes=tw"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            d = json.load(r)
        res = {"lat": float(d[0]["lat"]), "lon": float(d[0]["lon"])} if d else None
    except Exception as e:
        res = None
    cache[key] = res
    return res

df = pl.read_parquet(CLEAN)
segs = (df.filter(pl.col("路段").is_not_null())
          .select("縣市", "行政區", "路段").unique().sort("縣市", "行政區", "路段"))
total = segs.height
print(f"unique 段: {total}")

rows = []
done = 0
for i, r in enumerate(segs.iter_rows(named=True)):
    city, dist, seg = r["縣市"], r["行政區"], r["路段"]
    key = f"{city}{dist}{seg}"
    was_cached = key in cache
    g = geocode(city, dist, seg)
    if g:
        rows.append({"縣市": city, "行政區": dist, "路段": seg, "lat": g["lat"], "lon": g["lon"]})
        done += 1
    if not was_cached:
        time.sleep(1.1)  # 禮貌限速
    if (i + 1) % 50 == 0:
        json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
        print(f"  {i+1}/{total} 已查, 命中 {done}")

json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
geo = pl.DataFrame(rows)
# 座標須在雙北範圍（資料只含台北+新北，過濾同名路段誤植到外縣市）
geo = geo.filter((pl.col("lat").is_between(24.6, 25.35)) & (pl.col("lon").is_between(121.2, 122.05)))
geo.write_parquet(OUT)
print(f"seg_geo.parquet: {geo.height}/{total} 段有座標 ({geo.height/total:.1%}) -> {OUT}")
