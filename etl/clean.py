#!/usr/bin/env python3
"""
實價登錄 ETL — 台北(a)+新北(f) 買賣(a)+租賃(c) → clean.parquet
清洗：扣車位 / 民國→西元 / m²→坪 / 型別enum / 四種單價 / outlier標記 / 地段三級

Codex review 修正（2026-07-03）：
  1. 車位面積欄名跨期不一致（舊期含括號）→ 用容錯比對
  2. 租賃/建物 交易標的白名單放寬（原漏掉「建物」等大宗歷史）
  3. 地址正則：路名擇一而非字元集；去掉縣市/行政區前綴；段吃阿拉伯+中文數字
  4. net_price<=0 濾除；車位面積>0 但車位價=0 → 無法可靠扣除，標記 is_price_suspect
  5. 權狀總坪 存「扣車位後」淨權狀坪，與單價_權狀分母一致
  6. outlier IQR 加最小樣本門檻(n>=30)，樣本不足不標
  7. member_season 改為參數傳入
"""
import zipfile, csv, io, re, glob, os, math
import polars as pl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "clean.parquet")

PING = 3.3058
CITY = {"a": "臺北市", "f": "新北市"}
KIND = {"a": "買賣", "c": "租賃"}

# 交易標的白名單：含住宅/建物（租賃歷史大宗是「建物」）+ 純土地；排除純車位
SALE_TARGETS = {"房地(土地+建物)", "房地(土地+建物)+車位", "建物", "土地"}
RENT_TARGETS = {"租賃房屋", "租賃房屋+車位", "建物", "房地(土地+建物)", "房地(土地+建物)+車位"}
IQR_MIN_SAMPLE = 30  # outlier 分群最小樣本

FULLWIDTH = str.maketrans("０１２３４５６７８９", "0123456789")

def norm_type(s):
    if not s: return "其他"
    if s.startswith("住宅大樓"): return "住宅大樓"
    if s.startswith("華廈"):     return "華廈"
    if s.startswith("公寓"):     return "公寓"
    if "透天" in s:             return "透天厝"
    if "套房" in s:             return "套房"
    if any(k in s for k in ("店", "辦", "商")): return "商辦店面"
    return "其他"

def roc_to_ce(s):
    s = (s or "").strip()
    if not s.isdigit() or len(s) < 6: return None, None, None
    s = s.zfill(7)
    y = int(s[:3]) + 1911; m = int(s[3:5])
    if not (1 <= m <= 12): return None, None, None
    return y, m, f"{y}Q{(m - 1)//3 + 1}"

# 路名：路/街/道/大道 擇一（大道優先，避免被「道」搶先）
# 段：原始門牌一律國字（一段~六段），阿拉伯數字都是門牌/巷號，故段只認國字
# 巷：阿拉伯數字 + 巷（FULLWIDTH 已把全形轉半形）
ROAD_RE = re.compile(r'([一-鿿]+?(?:大道|路|街|道))([一二三四五六七八九十]段)?(\d+巷)?')
def parse_addr(addr, district):
    """去掉縣市+行政區前綴後抽路名。回 (路, 路+段, 路+段+巷)。抓不到回 (None,)*3"""
    if not addr: return None, None, None
    a = addr.translate(FULLWIDTH)
    # 用「行政區」在地址中的位置切分（最穩健）：取行政區之後的字串
    if district and district in a:
        a = a.split(district, 1)[1]
    else:
        a = re.sub(r'^.*?[市縣]', '', a)             # 退路：砍到縣市
        a = re.sub(r'^[一-鿿]{1,4}區', '', a)         # 砍行政區
    a = re.sub(r'^[一-鿿]{1,4}里', '', a)            # 砍里
    a = re.sub(r'^\d+鄰', '', a)                      # 砍鄰（如「29鄰」）
    a = re.sub(r'^[一-鿿]{1,4}里', '', a)            # 里可能在鄰之後，再砍一次
    m = ROAD_RE.match(a)
    if not m: return None, None, None
    road = m.group(1)
    # 最後保險：只在「…區/…里」前綴殘留時剝除（避免誤砍「市民大道」這種合法路名）
    road = re.sub(r'^[一-鿿]{2,3}[市縣][一-鿿]{1,3}區', '', road)  # 台北市大安區
    road = re.sub(r'^[一-鿿]{1,3}區', '', road)                    # 大安區
    road = re.sub(r'^[一-鿿]{1,3}里', '', road)                    # 某某里
    if not road: return None, None, None
    # 仍殘留行政區/縣市字（非「大道」合法用字）→ 視為 parse 失敗
    if road != "市民大道" and re.search(r'[區縣]|.{2}市', road):
        return None, None, None
    seg = road + (m.group(2) or "")            # m.group(2) 已含「段」，如「二段」
    lane = seg + (m.group(3) or "")            # m.group(3) 已含「巷」，如「147巷」
    return road, seg, lane

def fnum(x):
    try:
        v = float(x); return v if math.isfinite(v) else None
    except (ValueError, TypeError):
        return None

def read_zip_csv(zf, name):
    with zf.open(name) as fh:
        return list(csv.reader(io.TextIOWrapper(fh, encoding="utf-8-sig")))

def find_col(h, *cands):
    """容錯欄名比對：忽略括號全半形差異"""
    def norm(s): return s.replace("(", "").replace(")", "").replace("（", "").replace("）", "")
    hn = {norm(k): v for k, v in h.items()}
    for c in cands:
        if c in h: return h[c]
        if norm(c) in hn: return hn[norm(c)]
    return None

def process_member(zf, member, city, kind, season):
    rows = read_zip_csv(zf, member)
    if len(rows) < 3: return []
    h = {c: i for i, c in enumerate(rows[0])}
    out = []
    is_sale = (kind == "買賣")
    ci_date = find_col(h, "交易年月日" if is_sale else "租賃年月日")
    ci_price = find_col(h, "總價元" if is_sale else "總額元")
    ci_pk_price = find_col(h, "車位總價元" if is_sale else "車位總額元")
    ci_bld = find_col(h, "建物移轉總面積平方公尺", "建物總面積平方公尺")
    ci_land = find_col(h, "土地移轉總面積平方公尺", "土地移轉總面積(平方公尺)")
    ci_pk_area = find_col(h, "車位移轉總面積平方公尺", "車位移轉總面積(平方公尺)", "車位面積平方公尺")
    ci_tgt = find_col(h, "交易標的")
    ci_dist = find_col(h, "鄉鎮市區")
    ci_bt = find_col(h, "建物型態")
    ci_addr = find_col(h, "土地位置建物門牌")
    ci_main = find_col(h, "主建物面積")
    ci_bal = find_col(h, "陽台面積")
    ci_aux = find_col(h, "附屬建物面積")
    ci_room = find_col(h, "建物現況格局-房")
    ci_floor = find_col(h, "移轉層次")
    ci_total_floor = find_col(h, "總樓層數")
    targets = SALE_TARGETS if is_sale else RENT_TARGETS
    maxidx = max(h.values())

    def g(r, i): return r[i] if (i is not None and i < len(r)) else ""

    for r in rows[2:]:
        if len(r) <= maxidx: continue
        tgt = g(r, ci_tgt)
        if tgt not in targets: continue
        y, mth, ym = roc_to_ce(g(r, ci_date))
        if y is None: continue
        price = fnum(g(r, ci_price))
        if not price or price <= 1: continue
        pk_price = fnum(g(r, ci_pk_price)) or 0.0
        bld_m2 = fnum(g(r, ci_bld)) or 0.0
        land_m2 = fnum(g(r, ci_land)) or 0.0
        pk_m2 = fnum(g(r, ci_pk_area)) or 0.0
        is_land = (tgt == "土地")  # 純土地：無建物，用土地坪當單價分母
        main_m2 = fnum(g(r, ci_main)) if (is_sale and not is_land) else None
        bal_m2 = fnum(g(r, ci_bal)) if (is_sale and not is_land) else None
        aux_m2 = fnum(g(r, ci_aux)) if (is_sale and not is_land) else None

        net_price = price - pk_price
        if net_price <= 0:  # 車位價 >= 總價：資料異常，整列丟
            continue
        # 有車位面積但車位價=0 → 淨價其實仍含車位，標記存疑
        price_suspect = (pk_m2 > 0 and pk_price == 0)

        # 單價分母：土地交易用土地坪；建物交易用扣車位後的權狀坪
        deed_m2 = land_m2 if is_land else (bld_m2 - pk_m2)
        def upp(m2):
            # 面積 <3.3㎡(≈1坪) 視為無效分母（原始資料填 0/0.01 造成單價爆表）
            if not m2 or m2 < 3.3: return None
            v = round(net_price / (m2 / PING) / 10000, 3)
            # 單價 >500 萬/坪 = 原始面積漏填的髒列（雙北實際最貴約 200-300）→ 無效
            return v if v <= 500 else None
        u_deed = upp(deed_m2)
        u_main = upp(main_m2) if main_m2 else None
        incl = (main_m2 or 0) + (bal_m2 or 0) + (aux_m2 or 0)
        u_incl = upp(incl) if incl > 0 else None
        ratio = round(main_m2 / bld_m2, 4) if (main_m2 and bld_m2 > 0) else None
        road, seg, lane = parse_addr(g(r, ci_addr), g(r, ci_dist))

        out.append(dict(
            縣市=city, 交易類型=kind, 行政區=g(r, ci_dist),
            西元年=y, 月=mth, 期別=ym,
            路=road, 路段=seg, 路段巷=lane,
            門牌=g(r, ci_addr).strip(),          # 完整地址門牌（最細粒度）
            移轉層次=g(r, ci_floor).strip() or None,
            總樓層數=g(r, ci_total_floor).strip() or None,
            建物型別="土地" if is_land else norm_type(g(r, ci_bt)),
            權狀總坪=round(deed_m2 / PING, 3) if deed_m2 > 0 else None,  # 土地=土地坪；建物=淨權狀坪
            主建物坪=round(main_m2 / PING, 3) if main_m2 else None,
            車位坪=round(pk_m2 / PING, 3) if pk_m2 else None,
            總價_萬=round(price / 10000, 2),
            車位總價_萬=round(pk_price / 10000, 2),
            房屋淨價_萬=round(net_price / 10000, 2),
            單價_權狀=u_deed, 單價_主建物=u_main, 單價_含附屬=u_incl,
            主建物佔比=ratio,
            is_車位交易=("車位" in tgt),
            is_low_ratio=(ratio is not None and ratio < 0.5),
            is_price_suspect=price_suspect,
            來源期=season,
            房=fnum(g(r, ci_room)),
        ))
    return out

records = []
for z in sorted(glob.glob(os.path.join(RAW, "*.zip"))):
    m = re.search(r"(\d+S\d)\.zip$", z)
    if not m: continue
    season = m.group(1)
    try:
        zf = zipfile.ZipFile(z)
    except zipfile.BadZipFile:
        continue
    names = set(zf.namelist())
    for cprefix, city in CITY.items():
        for kprefix, kind in KIND.items():
            member = f"{cprefix}_lvr_land_{kprefix}.csv"
            if member in names:
                records += process_member(zf, member, city, kind, season)

df = pl.DataFrame(records, infer_schema_length=None)

# 日期合理範圍（實價登錄 2012 上路）
df = df.filter((pl.col("西元年") >= 2012) & (pl.col("西元年") <= 2026))

# outlier：同(縣市,行政區,建物型別,交易類型) 群組 IQR 1.5；樣本 <30 不標
price_key = pl.when(pl.col("交易類型") == "買賣").then(pl.col("單價_主建物")).otherwise(pl.col("單價_權狀"))
df = df.with_columns(price_key.alias("_pk"))
grp = ["縣市", "行政區", "建物型別", "交易類型"]
stats = df.group_by(grp).agg(
    pl.col("_pk").quantile(0.25).alias("q1"),
    pl.col("_pk").quantile(0.75).alias("q3"),
    pl.col("_pk").count().alias("n"),
)
df = df.join(stats, on=grp, how="left").with_columns(
    (pl.col("q3") - pl.col("q1")).alias("iqr")
).with_columns(
    pl.when(pl.col("n") < IQR_MIN_SAMPLE).then(False)
      .otherwise(
        (pl.col("_pk") < pl.col("q1") - 1.5 * pl.col("iqr")) |
        (pl.col("_pk") > pl.col("q3") + 1.5 * pl.col("iqr"))
      ).fill_null(False).alias("is_outlier")
).drop(["_pk", "q1", "q3", "iqr", "n"])

df.write_parquet(OUT)

print(f"clean.parquet 產出：{df.height} 筆")
print(df.group_by(["縣市", "交易類型"]).len().sort(["縣市", "交易類型"]))
print("outlier:", df.select(pl.col("is_outlier").sum()).item(),
      "| low_ratio:", df.select(pl.col("is_low_ratio").sum()).item(),
      "| price_suspect:", df.select(pl.col("is_price_suspect").sum()).item())
print("路 抽NULL比例:", round(df.select(pl.col("路").is_null().mean()).item(), 4))
