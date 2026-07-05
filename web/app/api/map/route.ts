import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { buildWhere, table } from '@/lib/filters';
import path from 'path';

export const dynamic = 'force-dynamic';

// 地圖：段質心聚合，回 {lat,lon,中位權狀單價,成交量}。
// 地圖模式忽略行政區/路段，改用地圖可視範圍(bounds)篩選。
export async function POST(req: NextRequest) {
  try {
    const f = await req.json();
    // 地圖一律 mapMode：不受行政區/路段限制，只受縣市/型別/類型/期間 + bounds
    const { where, params } = buildWhere({ ...f, mapMode: true });
    const t = table();
    const geo = `read_parquet('${path.join(process.cwd(), '..', 'seg_geo.parquet').replace(/'/g, "''")}')`;

    // bounds: {south, west, north, east}（可選）→ 只回可視範圍內的段
    const b = f.bounds;
    const boundCond: string[] = [];
    const geoParams: unknown[] = [];
    if (b && [b.south, b.west, b.north, b.east].every((v: any) => typeof v === 'number' && isFinite(v))) {
      boundCond.push('g.lat BETWEEN ? AND ?', 'g.lon BETWEEN ? AND ?');
      geoParams.push(b.south, b.north, b.west, b.east);
    }
    const geoWhere = ['g.lat IS NOT NULL', ...boundCond].join(' AND ');

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
       WHERE ${geoWhere}
       GROUP BY g.lat, g.lon, f."縣市", f."行政區", f."路段"
       ORDER BY volume DESC
       LIMIT 3000`,
      [...params, ...geoParams]
    );

    return NextResponse.json({ points: rows, count: rows.length });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: '地圖資料載入失敗' }, { status: 500 });
  }
}
