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

    // 趨勢：按期別 group，算選定單價中位 + 成交量
    const trendWhere = aggregatedToSeg
      ? buildWhere({ ...f, roadLane: undefined }) // 聚合：放寬到「段」
      : { where, params };
    const trend = await query(
      `SELECT "期別" AS q,
              MEDIAN("${priceCol}") AS price,
              COUNT(*)::INT AS volume
       FROM ${t} ${trendWhere.where}
       GROUP BY "期別" ORDER BY "期別"`,
      trendWhere.params
    );

    // KPI
    const [kpi] = await query(
      `SELECT COUNT(*)::INT AS count,
              MEDIAN("${priceCol}") AS median_price,
              MEDIAN("主建物佔比") AS median_ratio
       FROM ${t} ${where}`, params
    );

    // 明細表（分頁 + 排序）
    const page = Math.max(1, f.page ?? 1);
    const pageSize = Math.min(200, f.pageSize ?? 50);
    const sortable: Record<string, string> = {
      date: '期別', price: priceCol, total: '總價_萬',
      deedPing: '權狀總坪', mainPing: '主建物坪', ratio: '主建物佔比',
    };
    const sortCol = sortable[f.sortBy ?? 'date'] ?? '期別';
    const sortDir = f.sortDir === 'asc' ? 'ASC' : 'DESC';
    const rows = await query(
      `SELECT "期別", "西元年", "月", "行政區", "路段巷", "路段", "路", "建物型別",
              "權狀總坪", "主建物坪", "${priceCol}" AS 選定單價,
              "總價_萬", "主建物佔比", is_outlier, is_low_ratio
       FROM ${t} ${where}
       ORDER BY "${sortCol}" ${sortDir} NULLS LAST
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params
    );

    return NextResponse.json({
      kpi, trend, rows, total: kpi?.count ?? 0,
      aggregatedToSeg, priceCol,
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
