import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { table } from '@/lib/filters';

export const dynamic = 'force-dynamic';

// 提供下拉選項，級聯：傳 city→回該市行政區；傳 district→回該區的路 …
export async function GET(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams;
    const city = p.get('city') ?? undefined;
    const district = p.get('district') ?? undefined;
    const road = p.get('road') ?? undefined;
    const roadSeg = p.get('roadSeg') ?? undefined;
    const t = table();

    const distinct = async (col: string, conds: [string, string | undefined][]) => {
      const where: string[] = [];
      const params: unknown[] = [];
      for (const [c, v] of conds) if (v) { where.push(`"${c}" = ?`); params.push(v); }
      where.push(`"${col}" IS NOT NULL`);
      const rows = await query<Record<string, string>>(
        `SELECT DISTINCT "${col}" AS v FROM ${t} WHERE ${where.join(' AND ')} ORDER BY "${col}" LIMIT 5000`,
        params
      );
      return rows.map((r) => r.v);
    };

    return NextResponse.json({
      cities: await distinct('縣市', []),
      buildingTypes: await distinct('建物型別', []),
      districts: city ? await distinct('行政區', [['縣市', city]]) : [],
      roads: district ? await distinct('路', [['縣市', city], ['行政區', district]]) : [],
      roadSegs: road ? await distinct('路段', [['縣市', city], ['行政區', district], ['路', road]]) : [],
      roadLanes: roadSeg ? await distinct('路段巷', [['縣市', city], ['行政區', district], ['路段', roadSeg]]) : [],
      quarters: await distinct('期別', []),
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: '選項載入失敗' }, { status: 500 });
  }
}
