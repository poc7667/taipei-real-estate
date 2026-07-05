import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { buildWhere, table } from '@/lib/filters';
import path from 'path';

export const dynamic = 'force-dynamic';

// 地圖：把成交聚合到「段」質心，回 {lat,lon,中位權狀單價,成交量}。跟隨現有篩選。
export async function POST(req: NextRequest) {
  try {
    const f = await req.json();
    const { where, params } = buildWhere(f);
    const t = table();
    const geo = `read_parquet('${path.join(process.cwd(), '..', 'seg_geo.parquet').replace(/'/g, "''")}')`;

    // 段級聚合 + join 座標。先在子查詢用 buildWhere 篩 clean（無 alias），再 join geo。
    const rows = await query(
      `WITH filtered AS (
         SELECT "縣市", "行政區", "路段", "單價_權狀", "主建物佔比"
         FROM ${t} ${where}
       )
       SELECT g.lat AS lat, g.lon AS lon,
              f."縣市" AS city, f."行政區" AS district, f."路段" AS seg,
              MEDIAN(f."單價_權狀") AS price,
              COUNT(*)::INT AS volume,
              MEDIAN(f."主建物佔比") AS ratio
       FROM filtered f
       JOIN ${geo} g
         ON f."縣市" = g."縣市" AND f."行政區" = g."行政區" AND f."路段" = g."路段"
       WHERE f."路段" IS NOT NULL
       GROUP BY g.lat, g.lon, f."縣市", f."行政區", f."路段"
       ORDER BY volume DESC
       LIMIT 3000`,
      params
    );

    return NextResponse.json({ points: rows, count: rows.length });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: '地圖資料載入失敗' }, { status: 500 });
  }
}
