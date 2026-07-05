import { src } from './db';

export type Filters = {
  city?: string;
  district?: string;
  buildingType?: string;         // 單選（表格模式相容）
  buildingTypes?: string[];      // 多選 checkbox（優先於 buildingType）
  txType?: string; // 買賣 | 租賃
  road?: string;
  roadSeg?: string;
  roadLane?: string;
  fromQ?: string; // 2013Q1
  toQ?: string;
  excludeOutlier?: boolean; // 預設 true
  onlyHighRatio?: boolean; // 主建物佔比 >=50%
  mapMode?: boolean;             // 地圖模式：忽略行政區/路段，改用地圖 bounds
};

// 依單價種類選欄位
export const PRICE_COLS: Record<string, string> = {
  deed: '單價_權狀',
  main: '單價_主建物',
  incl: '單價_含附屬',
};

// 期別可比較：轉成 year*10+quarter 的整數（2013Q2 -> 20132）
function qToInt(q?: string): number | null {
  if (!q) return null;
  const m = /^(\d{4})Q([1-4])$/.exec(q);
  return m ? parseInt(m[1], 10) * 10 + parseInt(m[2], 10) : null;
}

// 組 WHERE + params。全部走 prepared params，無字串拼接使用者輸入。
export function buildWhere(f: Filters): { where: string; params: unknown[] } {
  const cond: string[] = [];
  const params: unknown[] = [];
  const eq = (col: string, val?: string) => {
    if (val) { cond.push(`"${col}" = ?`); params.push(val); }
  };
  eq('縣市', f.city);
  // 地圖模式：忽略行政區/路段（改用地圖 bounds 篩選），只保留縣市/型別/類型/期間
  if (!f.mapMode) {
    eq('行政區', f.district);
    eq('路', f.road);
    eq('路段', f.roadSeg);
    eq('路段巷', f.roadLane);
  }
  eq('交易類型', f.txType);
  // 建物型別：多選優先（IN 清單），否則單選
  const types = (f.buildingTypes ?? []).filter(Boolean);
  if (types.length) {
    cond.push(`"建物型別" IN (${types.map(() => '?').join(',')})`);
    params.push(...types);
  } else {
    eq('建物型別', f.buildingType);
  }

  const from = qToInt(f.fromQ);
  const to = qToInt(f.toQ);
  // 期別整數化比較：CAST 出年季
  const qExpr = `(CAST(substr("期別",1,4) AS INTEGER)*10 + CAST(substr("期別",6,1) AS INTEGER))`;
  if (from !== null) { cond.push(`${qExpr} >= ?`); params.push(from); }
  if (to !== null) { cond.push(`${qExpr} <= ?`); params.push(to); }

  if (f.excludeOutlier) cond.push(`is_outlier = FALSE`);
  // 只看主建物佔比 ≥50%（嚴格：NULL 視為不符，不納入）
  if (f.onlyHighRatio) cond.push(`主建物佔比 >= 0.5`);

  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  return { where, params };
}

export function table(): string {
  return src();
}
