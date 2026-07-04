#!/usr/bin/env python3
"""
實價登錄 ETL — 台北(a)+新北(f) 買賣(a)+租賃(c) → clean.parquet
清洗：扣車位 / 民國→西元 / m²→坪 / 型別enum / 四種單價 / outlier標記 / 地段三級
買賣有主建物面積→四單價齊；租賃無主建物→只有租金權狀單價。
"""
import zipfile, csv, io, re, glob, os, math
import polars as pl
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 專案根（etl 的上一層）
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "clean.parquet")

PING = 3.3058                       # 1 坪 = 3.3058 m²
CITY = {"a": "臺北市", "f": "新北市"}
KIND = {"a": "買賣", "c": "租賃"}    # a_lvr_land_<a|c>.csv

# 交易標的白名單（住宅房地；排除純土地/純車位/純建物）
SALE_TARGETS = {"房地(土地+建物)", "房地(土地+建物)+車位"}
RENT_TARGETS = {"租賃房屋", "租賃房屋+車位"}

FULLWIDTH = str.maketrans("０１２３４５６７８９", "0123456789")

def norm_type(s):
    if not s: return "其他"
    if s.startswith("住宅大樓"): return "住宅大樓"
    if s.startswith("華廈"):     return "華廈"
    if s.startswith("公寓"):     return "公寓"
    if "透天" in s:             return "透天厝"
    if "套房" in s:             return "套房"
    if "店" in s or "辦" in s or "商" in s: return "商辦店面"
    return "其他"

def roc_to_ce(s):
    """民國年月日(1131103 / 990331) → (西元年, 月, 'YYYYQn')。壞值回 (None,)*3"""
    s = (s or "").strip()
    if not s.isdigit() or len(s) < 6: return None, None, None
    s = s.zfill(7)                    # 補到 7 碼：YYYMMDD
    y = int(s[:3]) + 1911; m = int(s[3:5])
    if not (1 <= m <= 12): return None, None, None
    q = (m - 1)//3 + 1
    return y, m, f"{y}Q{q}"

ADDR_RE = re.compile(r'(.*?[路街道大道])((?:[一二三四五六七八九十]+段)?)((?:\d+巷)?)')
def parse_addr(addr):
    """回 (路, 路+段, 路+段+巷)。抓不到路名回 (None,)*3"""
    if not addr: return None, None, None
    a = addr.translate(FULLWIDTH)     # 全形數字→半形
    m = ADDR_RE.match(a)
    if not m or not m.group(1): return None, None, None
    road = m.group(1)
    seg  = road + m.group(2)
    lane = seg + m.group(3)
    return road, seg, lane

def fnum(x):
    try:
        v = float(x); return v if math.isfinite(v) else None
    except (ValueError, TypeError):
        return None

def read_zip_csv(zf, name):
    with zf.open(name) as fh:
        return list(csv.reader(io.TextIOWrapper(fh, encoding="utf-8-sig")))

def process_member(zf, member, city, kind):
    rows = read_zip_csv(zf, member)
    if len(rows) < 3: return []
    h = {c: i for i, c in enumerate(rows[0])}
    G = h.get
    out = []
    is_sale = (kind == "買賣")
    date_col = "交易年月日" if is_sale else "租賃年月日"
    price_col = "總價元" if is_sale else "總額元"
    pk_col = "車位總價元" if is_sale else "車位總額元"
    bld_col = "建物移轉總面積平方公尺" if is_sale else "建物總面積平方公尺"
    targets = SALE_TARGETS if is_sale else RENT_TARGETS

    for r in rows[2:]:
        if len(r) <= max(h.values()): continue
        tgt = r[G("交易標的")] if G("交易標的") is not None else ""
        if tgt not in targets: continue
        y, mth, ym = roc_to_ce(r[G(date_col)])
        if y is None: continue
        price = fnum(r[G(price_col)]);  pk = fnum(r[G(pk_col)]) or 0.0
        if not price or price <= 1: continue
        def cell(col):                    # 安全取值：欄不存在回 ""
            i = G(col)
            return r[i] if i is not None else ""
        bld_m2 = fnum(cell(bld_col)) or 0.0
        pk_area_col = "車位移轉總面積平方公尺" if is_sale else "車位面積平方公尺"
        pk_m2 = fnum(cell(pk_area_col)) or 0.0
        main_m2 = fnum(cell("主建物面積")) if is_sale else None
        bal_m2  = fnum(cell("陽台面積")) if is_sale else None
        aux_m2  = fnum(cell("附屬建物面積")) if is_sale else None

        net_price = price - pk                         # 房屋淨價（扣車位）
        # 權狀單價：分母扣掉車位面積，避免車位坪灌大分母
        deed_m2 = bld_m2 - pk_m2
        def unit_wan_per_ping(m2):
            if not m2 or m2 <= 0 or net_price <= 0: return None
            return round(net_price / (m2 / PING) / 10000, 3)   # 萬/坪
        u_deed = unit_wan_per_ping(deed_m2)
        u_main = unit_wan_per_ping(main_m2) if main_m2 else None
        incl = (main_m2 or 0) + (bal_m2 or 0) + (aux_m2 or 0)
        u_incl = unit_wan_per_ping(incl) if incl > 0 else None
        ratio = round(main_m2 / bld_m2, 4) if (main_m2 and bld_m2 > 0) else None

        road, seg, lane = parse_addr(r[G("土地位置建物門牌")])
        out.append(dict(
            縣市=city, 交易類型=kind, 行政區=r[G("鄉鎮市區")],
            西元年=y, 月=mth, 期別=ym,
            路=road, 路段=seg, 路段巷=lane,
            建物型別=norm_type(r[G("建物型態")]),
            權狀總坪=round(bld_m2/PING, 3) if bld_m2 else None,
            主建物坪=round(main_m2/PING, 3) if main_m2 else None,
            車位坪=round(pk_m2/PING, 3) if pk_m2 else None,
            總價_萬=round(price/10000, 2),
            車位總價_萬=round(pk/10000, 2),
            房屋淨價_萬=round(net_price/10000, 2),
            單價_權狀=u_deed, 單價_主建物=u_main, 單價_含附屬=u_incl,
            主建物佔比=ratio,
            is_車位交易=("車位" in tgt),
            is_low_ratio=(ratio is not None and ratio < 0.5),
            來源期=member_season,
            房=fnum(r[G("建物現況格局-房")]),
        ))
    return out

records = []
for z in sorted(glob.glob(os.path.join(RAW, "*.zip"))):
    member_season = re.search(r"(\d+S\d)\.zip$", z).group(1)
    try:
        zf = zipfile.ZipFile(z)
    except zipfile.BadZipFile:
        continue
    names = set(zf.namelist())
    for cprefix, city in CITY.items():
        for kprefix, kind in KIND.items():
            member = f"{cprefix}_lvr_land_{kprefix}.csv"
            if member in names:
                records += process_member(zf, member, city, kind)

df = pl.DataFrame(records, infer_schema_length=None)

# 日期合理範圍：實價登錄 2012 上路。範圍外多為補登舊約/key錯 → 濾除避免拉歪趨勢
df = df.filter((pl.col("西元年") >= 2012) & (pl.col("西元年") <= 2026))

# ---- outlier 標記：同(縣市,行政區,建物型別,交易類型) 群組內，用主建物單價(買賣)/權狀單價(租賃) IQR 1.5 ----
price_key = pl.when(pl.col("交易類型") == "買賣").then(pl.col("單價_主建物")).otherwise(pl.col("單價_權狀"))
df = df.with_columns(price_key.alias("_pk"))
grp = ["縣市", "行政區", "建物型別", "交易類型"]
q1 = df.group_by(grp).agg(pl.col("_pk").quantile(0.25).alias("q1"),
                          pl.col("_pk").quantile(0.75).alias("q3"))
df = df.join(q1, on=grp, how="left").with_columns(
    (pl.col("q3") - pl.col("q1")).alias("iqr")
).with_columns(
    ((pl.col("_pk") < pl.col("q1") - 1.5*pl.col("iqr")) |
     (pl.col("_pk") > pl.col("q3") + 1.5*pl.col("iqr"))).fill_null(False).alias("is_outlier")
).drop(["_pk", "q1", "q3", "iqr"])

df.write_parquet(OUT)

print(f"clean.parquet 產出：{df.height} 筆")
print(df.group_by(["縣市", "交易類型"]).len().sort(["縣市", "交易類型"]))
print("outlier:", df.select(pl.col("is_outlier").sum()).item(),
      "low_ratio:", df.select(pl.col("is_low_ratio").sum()).item())
