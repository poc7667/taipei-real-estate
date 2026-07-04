import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { buildWhere, table, PRICE_COLS, Filters } from '@/lib/filters';

export const dynamic = 'force-dynamic';

// 樣本聚合門檻：地段選到「巷」但該巷樣本 < 這個數 → 前端會被通知需聚合到「段」
const LANE_MIN_SAMPLE = 8;

export async function POST(req: NextRequest) {
  try {
    const f: Filters & { priceKind?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: string } =
      await req.json();
    const priceCol = PRICE_COLS[f.priceKind ?? 'main'] ?? PRICE_COLS.main;
    const { where, params } = buildWhere(f);
    const t = table();

    // 若選到巷，檢查樣本數決定是否建議聚合
    let aggregatedToSeg = false;
    if (f.roadLane) {
      const [{ n }] = await query<{ n: number }>(
        `SELECT COUNT(*)::INT AS n FROM ${t} ${where}`, params
      );
      if (n < LANE_MIN_SAMPLE) aggregatedToSeg = true;
    }

    // 趨勢：按期別 group，算單價中位 + 成交量
    // 折線圖固定用「權狀單價」（總價÷權狀坪），不跟隨單價下拉 — 權狀單價是市場行情通用基準
    const TREND_PRICE = '單價_權狀';
    const trendWhere = aggregatedToSeg
      ? buildWhere({ ...f, roadLane: undefined }) // 聚合：放寬到「段」
      : { where, params };
    const trend = await query(
      `SELECT "期別" AS q,
              MEDIAN("${TREND_PRICE}") AS price,
              COUNT(*)::INT AS volume
       FROM ${t} ${trendWhere.where}
       GROUP BY "期別" ORDER BY "期別"`,
      trendWhere.params
    );

    // 型別比較：未選特定建物型別時，回各型別×期別的單價中位（多線圖用，同樣用權狀單價）
    let trendByType: Record<string, unknown>[] | null = null;
    if (!f.buildingType) {
      const typeCond = trendWhere.where
        ? `${trendWhere.where} AND "建物型別" IN ('公寓','華廈','住宅大樓','透天厝')`
        : `WHERE "建物型別" IN ('公寓','華廈','住宅大樓','透天厝')`;
      const rows = await query<{ q: string; bt: string; price: number }>(
        `SELECT "期別" AS q, "建物型別" AS bt, MEDIAN("${TREND_PRICE}") AS price
         FROM ${t} ${typeCond}
         GROUP BY "期別", "建物型別" ORDER BY "期別"`,
        trendWhere.params
      );
      // long → wide：每期一列，各型別一欄
      const byQ = new Map<string, Record<string, unknown>>();
      for (const r of rows) {
        if (!byQ.has(r.q)) byQ.set(r.q, { q: r.q });
        byQ.get(r.q)![r.bt] = r.price;
      }
      trendByType = Array.from(byQ.values());
    }

    // KPI
    const [kpi] = await query(
      `SELECT COUNT(*)::INT AS count,
              MEDIAN("${priceCol}") AS median_price,
              MEDIAN("主建物佔比") AS median_ratio
       FROM ${t} ${trendWhere.where}`, trendWhere.params
    );

    // 明細表（分頁 + 排序）— page/pageSize 一律 clamp 成合法正整數
    const toInt = (v: unknown, def: number) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) ? n : def;
    };
    const page = Math.max(1, toInt(f.page, 1));
    // 上限放寬到 5000，讓「顯示全部」可行（單一地段/巷通常遠低於此）
    const pageSize = Math.min(5000, Math.max(1, toInt(f.pageSize, 1000)));
    const sortable: Record<string, string> = {
      date: '期別', price: priceCol, deedPrice: '單價_權狀', mainPrice: '單價_主建物',
      total: '總價_萬', deedPing: '權狀總坪', mainPing: '主建物坪', ratio: '主建物佔比',
    };
    const sortCol = sortable[f.sortBy ?? 'date'] ?? '期別';
    const sortDir = f.sortDir === 'asc' ? 'ASC' : 'DESC';
    const rows = await query(
      `SELECT *, "${priceCol}" AS 選定單價
       FROM ${t} ${trendWhere.where}
       ORDER BY "${sortCol}" ${sortDir} NULLS LAST
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      trendWhere.params
    );

    return NextResponse.json({
      kpi, trend, trendByType, rows, total: kpi?.count ?? 0,
      aggregatedToSeg, priceCol,
    });
  } catch (e) {
    console.error(e);
    // 不外洩內部 SQL/錯誤細節給 client
    return NextResponse.json({ error: '查詢失敗，請調整條件後重試' }, { status: 500 });
  }
}
