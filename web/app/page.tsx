'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import {
  useReactTable, getCoreRowModel, flexRender, createColumnHelper,
} from '@tanstack/react-table';

// 地圖用 Leaflet，需在 client 端載入（no SSR）
const MapView = dynamic(() => import('./MapView'), { ssr: false });
type MapPoint = { lat: number; lon: number; city: string; district: string; seg: string; price: number; volume: number; ratio: number | null; };

type Options = {
  cities: string[]; districts: string[]; buildingTypes: string[];
  roads: string[]; roadSegs: string[]; roadLanes: string[]; quarters: string[];
};
type Row = Record<string, any>;
type Result = {
  kpi: { count: number; median_price: number; median_ratio: number } | null;
  trend: { q: string; price: number; volume: number }[];
  trendByType: Record<string, any>[] | null;
  rows: Row[]; total: number; aggregatedToSeg: boolean; priceCol: string;
};

const PRICE_KINDS = [
  { v: 'main', label: '② 主建物淨坪 ★' },
  { v: 'deed', label: '① 權狀' },
  { v: 'incl', label: '③ 含附屬' },
];

const wan = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('zh-TW', { maximumFractionDigits: 1 });

// 建物型別多線圖：型別 + 配色
const BUILDING_TYPES = ['公寓', '華廈', '住宅大樓', '透天厝'];
const TYPE_COLORS: Record<string, string> = {
  公寓: '#2563eb', 華廈: '#10b981', 住宅大樓: '#f59e0b', 透天厝: '#8b5cf6',
};

// 把成交量(trend)併進各型別趨勢(trendByType)，同一期別一列
function mergeTrend(res: Result): Record<string, unknown>[] {
  if (!res.trendByType) return res.trend as unknown as Record<string, unknown>[];
  const vol = new Map(res.trend.map((t) => [t.q, t.volume]));
  return res.trendByType.map((row: any) => ({ ...row, volume: vol.get(row.q) ?? 0 }));
}

export default function Page() {
  const [opt, setOpt] = useState<Options | null>(null);
  // 預設不鎖任何地段，首屏即顯示 臺北市+新北市 全部買賣。
  // 大安信義路三段147巷研究快捷（要用再填回）:
  //   city:'臺北市', district:'大安區', buildingType:'公寓',
  //   road:'信義路', roadSeg:'信義路三段', roadLane:'信義路三段147巷',
  const [f, setF] = useState<any>({
    city: '', district: '', buildingType: '', buildingTypes: [], txType: '買賣',
    road: '', roadSeg: '', roadLane: '', fromQ: '', toQ: '',
    priceKind: 'main', excludeOutlier: true, onlyHighRatio: false,
    page: 1, pageSize: 1000, sortBy: 'date', sortDir: 'desc',
  });
  const [res, setRes] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<Row | null>(null); // 點列顯示原始資料
  const [view, setView] = useState<'table' | 'map'>('table'); // 表格/地圖切換
  const [mapPoints, setMapPoints] = useState<MapPoint[]>([]);
  const [mapLoading, setMapLoading] = useState(false);

  // 載入下拉選項（級聯）
  const loadOptions = useCallback(async () => {
    const qs = new URLSearchParams();
    if (f.city) qs.set('city', f.city);
    if (f.district) qs.set('district', f.district);
    if (f.road) qs.set('road', f.road);
    if (f.roadSeg) qs.set('roadSeg', f.roadSeg);
    const r = await fetch('/api/options?' + qs.toString());
    setOpt(await r.json());
  }, [f.city, f.district, f.road, f.roadSeg]);
  useEffect(() => { loadOptions(); }, [loadOptions]);

  const runQuery = useCallback(async (override?: any) => {
    setLoading(true); setError(null);
    try {
      const body = { ...f, ...override };
      const r = await fetch('/api/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await r.json();
      if (json.error) throw new Error(json.error);
      setRes(json);
    } catch (e: any) { setError(String(e.message ?? e)); setRes(null); }
    finally { setLoading(false); }
  }, [f]);

  useEffect(() => { runQuery(); /* 初次載入自動查 */ }, []); // eslint-disable-line

  // 地圖資料：依「目前地圖 bounds + 篩選」載入（忽略行政區/路段）
  const boundsRef = useRef<any>(null);
  const fetchMap = useCallback(async (bounds?: any) => {
    const b = bounds ?? boundsRef.current;
    if (b) boundsRef.current = b;
    setMapLoading(true);
    try {
      const body = { ...f, bounds: b };
      const r = await fetch('/api/map', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await r.json();
      setMapPoints(json.points ?? []);
    } catch { setMapPoints([]); }
    finally { setMapLoading(false); }
  }, [f]);

  // 地圖 tab 開啟時、或篩選變動時 → 用目前 bounds 重擈
  useEffect(() => { if (view === 'map' && boundsRef.current) fetchMap(); }, [view, fetchMap]); // eslint-disable-line

  const set = (k: string, v: any) => setF((p: any) => {
    const next = { ...p, [k]: v };
    // 土地連動：土地用地號定位（無路/段/巷），單價只有「權狀」有值
    // → 選土地時清空地段三級並切「①權狀」；離開土地時單價切回「②主建物」
    if (k === 'buildingType') {
      if (v === '土地') {
        next.road = ''; next.roadSeg = ''; next.roadLane = ''; next.priceKind = 'deed';
      } else if (p.buildingType === '土地') {
        next.priceKind = 'main';
      }
    }
    return next;
  });
  const isLand = f.buildingType === '土地';

  // 目前生效、且會縮小結果的篩選（不含 txType/priceKind/排序/分頁 — 那些不會造成 0 筆）
  // 用於 empty state 解釋「是哪些條件把結果篩空的」+ 提供一鍵清除。
  const NARROWING: { k: string; label: string; v: string }[] = [
    { k: 'city', label: '縣市', v: f.city },
    { k: 'district', label: '行政區', v: f.district },
    { k: 'buildingType', label: '建物型別', v: f.buildingType },
    { k: 'road', label: '路', v: f.road },
    { k: 'roadSeg', label: '段', v: f.roadSeg },
    { k: 'roadLane', label: '巷', v: f.roadLane },
    { k: 'fromQ', label: '期間起', v: f.fromQ },
    { k: 'toQ', label: '期間迄', v: f.toQ },
  ].filter((x) => x.v);

  // 清除地段三級（路/段/巷）—— 最常見的互斥來源
  const clearAddr = () => {
    setF((p: any) => ({ ...p, road: '', roadSeg: '', roadLane: '', page: 1 }));
    runQuery({ road: '', roadSeg: '', roadLane: '', page: 1 });
  };
  // 清除全部篩選（保留交易類型=買賣，回到首屏兩市全量）
  const clearAll = () => {
    const reset = { city: '', district: '', buildingType: '', road: '', roadSeg: '', roadLane: '', fromQ: '', toQ: '', page: 1 };
    setF((p: any) => ({ ...p, ...reset, priceKind: 'main' }));
    runQuery({ ...reset, priceKind: 'main' });
  };

  // 表格
  const ch = createColumnHelper<Row>();
  const columns = [
    ch.accessor((r) => `${r['西元年']}/${String(r['月']).padStart(2, '0')}`, { id: 'date', header: '交易日期' }),
    ch.accessor((r) => r['門牌'] || r['路段巷'] || r['路段'] || r['路'] || r['行政區'], { id: 'addr', header: '完整地址' }),
    ch.accessor((r) => r['移轉層次'] ? `${r['移轉層次']}/${r['總樓層數'] ?? '?'}` : '—', { id: 'floor', header: '樓層/總樓' }),
    ch.accessor('建物型別', { header: '型別' }),
    ch.accessor('權狀總坪', { header: '權狀坪', cell: (c) => wan(c.getValue() as number) }),
    ch.accessor('主建物坪', { header: '主建物坪', cell: (c) => wan(c.getValue() as number) }),
    ch.accessor('單價_權狀', { header: '權狀單價(萬/坪)', cell: (c) => wan(c.getValue() as number) }),
    ch.accessor('單價_主建物', { header: '主建物單價(萬/坪)', cell: (c) => wan(c.getValue() as number) }),
    ch.accessor('總價_萬', { header: '總價(萬)', cell: (c) => wan(c.getValue() as number) }),
    ch.accessor('主建物佔比', { header: '主建物佔比', cell: (c) => { const v = c.getValue() as number; return v == null ? '—' : `${(v * 100).toFixed(0)}%`; } }),
    ch.display({
      id: 'flags', header: '標記',
      cell: (c) => {
        const r = c.row.original;
        return (
          <>
            {r.is_outlier && <span style={badge('#ef4444', '#fef2f2')}>outlier</span>}
            {r.is_low_ratio && <span style={badge('#f59e0b', '#fffbeb')}>低實用</span>}
          </>
        );
      },
    }),
    ch.display({
      id: 'detail', header: '原始資料',
      cell: (c) => (
        <a onClick={(e) => { e.stopPropagation(); setDetail(c.row.original); }}
          style={{ color: '#2563eb', cursor: 'pointer', textDecoration: 'underline', fontSize: '.75rem' }}>
          查看 ↗
        </a>
      ),
    }),
  ];
  const table = useReactTable({ data: res?.rows ?? [], columns, getCoreRowModel: getCoreRowModel() });

  const sortBy = (id: string) => {
    const map: Record<string, string> = { date: 'date', addr: 'date', floor: 'date', 單價_權狀: 'deedPrice', 單價_主建物: 'mainPrice', '總價_萬': 'total', '權狀總坪': 'deedPing', '主建物坪': 'mainPing', '主建物佔比': 'ratio' };
    const key = map[id] ?? 'date';
    const dir = f.sortBy === key && f.sortDir === 'desc' ? 'asc' : 'desc';
    setF((p: any) => ({ ...p, sortBy: key, sortDir: dir }));
    runQuery({ sortBy: key, sortDir: dir });
  };

  return (
    <main style={{ maxWidth: 1000, margin: '0 auto', padding: '20px 16px' }}>
      <h1 style={{ fontSize: '1.3rem', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: '#2563eb' }}>◉</span> 實價登錄查詢
      </h1>

      {/* 篩選 */}
      <section style={card}>
        <div style={grid4}>
          <Field label="縣市"><SearchSelect v={f.city} on={(v) => set('city', v)} opts={opt?.cities} allowEmpty emptyLabel="全部" /></Field>
          <Field label="行政區"><SearchSelect v={f.district} on={(v) => set('district', v)} opts={opt?.districts} allowEmpty emptyLabel="全部" /></Field>
          <Field label="建物型別（可多選）"><TypeChecks selected={f.buildingTypes} opts={opt?.buildingTypes} onToggle={(t) => {
            setF((p: any) => {
              const cur: string[] = p.buildingTypes ?? [];
              const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t];
              return { ...p, buildingTypes: next, buildingType: '' };
            });
          }} /></Field>
          <Field label="交易類型"><SearchSelect v={f.txType} on={(v) => set('txType', v)} opts={['買賣', '租賃']} /></Field>
        </div>
        <div style={grid4}>
          <Field label="路"><SearchSelect v={f.road} on={(v) => set('road', v)} opts={opt?.roads} allowEmpty emptyLabel={isLand ? '土地無路名' : '全部'} disabled={isLand} /></Field>
          <Field label="段"><SearchSelect v={f.roadSeg} on={(v) => set('roadSeg', v)} opts={opt?.roadSegs} allowEmpty emptyLabel={isLand ? '土地無路段' : '全部'} disabled={isLand} /></Field>
          <Field label="巷"><SearchSelect v={f.roadLane} on={(v) => set('roadLane', v)} opts={opt?.roadLanes} allowEmpty emptyLabel={isLand ? '土地無巷弄' : '全部'} disabled={isLand} /></Field>
          <Field label="單價種類"><SearchSelect v={f.priceKind} on={(v) => set('priceKind', v)} opts={PRICE_KINDS.map((k) => k.v)} labels={PRICE_KINDS.reduce((a, k) => ({ ...a, [k.v]: k.label }), {})} /></Field>
        </div>
        <div style={grid4}>
          <Field label="期間(起)"><SearchSelect v={f.fromQ} on={(v) => set('fromQ', v)} opts={opt?.quarters} allowEmpty emptyLabel="最早" /></Field>
          <Field label="期間(迄)"><SearchSelect v={f.toQ} on={(v) => set('toQ', v)} opts={opt?.quarters} allowEmpty emptyLabel="最新" /></Field>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
          <label style={chk}><input type="checkbox" checked={f.excludeOutlier} onChange={(e) => set('excludeOutlier', e.target.checked)} /> 排除 outlier</label>
          <label style={chk}><input type="checkbox" checked={f.onlyHighRatio} onChange={(e) => set('onlyHighRatio', e.target.checked)} /> 只看主建物佔比 ≥50%</label>
          <button style={btn} onClick={() => { runQuery({ page: 1 }); if (view === 'map') fetchMap(); }}>查詢</button>
        </div>
      </section>

      {/* 表格 / 地圖 切換 tab */}
      <div style={{ display: 'flex', gap: 8, margin: '4px 0 12px' }}>
        <button onClick={() => setView('table')} style={tab(view === 'table')}>📋 表格</button>
        <button onClick={() => setView('map')} style={tab(view === 'map')}>🗺️ 地圖</button>
      </div>

      {view === 'map' && (
        <section style={card}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <h3 style={{ margin: 0, fontSize: '.95rem' }}>地圖（段級聚合 · 色=權狀單價 · 大小=成交量）</h3>
            <span style={{ marginLeft: 'auto', fontSize: '.72rem', color: '#64748b' }}>
              {mapLoading ? '載入中…' : `${mapPoints.length} 個地段`}
            </span>
          </div>
          <MapView points={mapPoints} onBoundsChange={(b) => fetchMap(b)} />
          <p style={{ margin: '8px 0 0', fontSize: '.7rem', color: '#64748b' }}>
            🗺️ 地圖模式：<b>忽略行政區／路段篩選</b>，改顯示<b>地圖可視範圍內</b>所有符合（縣市／建物型別／期間）的地段。拖曳或縮放地圖即重新載入。點圓點看中位權狀單價／成交量／佔比。座標為 OSM 段質心（涵蓋約 88%）。
          </p>
        </section>
      )}

      {view === 'table' && loading && <div style={{ ...card, textAlign: 'center', color: '#64748b' }}>查詢中…</div>}
      {error && <div style={{ ...card, borderColor: '#ef4444', color: '#ef4444' }}>查詢失敗：{error}</div>}

      {view === 'table' && res && !loading && res.total === 0 && (
        <section style={{ ...card, textAlign: 'center', padding: '32px 24px' }}>
          <div style={{ fontSize: '2rem', marginBottom: 8 }}>🔍</div>
          <h3 style={{ margin: '0 0 6px', fontSize: '1rem' }}>此篩選組合查無成交資料</h3>
          <p style={{ margin: '0 0 4px', fontSize: '.82rem', color: '#64748b' }}>
            資料庫本身有 1,293,190 筆台北+新北實價登錄；空白是<b>目前的篩選條件太窄或互斥</b>，不是資料缺失。
          </p>
          {NARROWING.length > 0 && (
            <div style={{ margin: '14px 0', display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
              <span style={{ fontSize: '.78rem', color: '#64748b', alignSelf: 'center' }}>目前生效篩選：</span>
              {NARROWING.map((x) => (
                <span key={x.k} style={{ fontSize: '.75rem', background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: 999, padding: '3px 10px' }}>
                  {x.label}：{x.v}
                </span>
              ))}
            </div>
          )}
          {(f.road || f.roadSeg || f.roadLane) && (
            <p style={{ margin: '0 0 14px', fontSize: '.78rem', color: '#f59e0b' }}>
              ⚠ 常見原因：所選「路/段/巷」在此「縣市×行政區×型別」下沒有成交（例如土地用地號登記、無路名）。
            </p>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            {(f.road || f.roadSeg || f.roadLane) && (
              <button style={btnOutline} onClick={clearAddr}>清除地段（路/段/巷）</button>
            )}
            <button style={btn} onClick={clearAll}>清除全部篩選</button>
          </div>
        </section>
      )}

      {view === 'table' && res && !loading && res.total > 0 && (
        <>
          {/* KPI */}
          <div style={grid4}>
            <Kpi k="成交筆數" v={`${wan(res.kpi?.count)} 件`} />
            <Kpi k="中位單價" v={`${wan(res.kpi?.median_price)} 萬/坪`} />
            <Kpi k="樣本數" v={`${res.total}`} />
            <Kpi k="中位主建物佔比" v={res.kpi?.median_ratio == null ? '—' : `${(res.kpi.median_ratio * 100).toFixed(0)}%`} />
          </div>

          {/* 價量圖 */}
          <section style={card}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: '.95rem' }}>
                {res.trendByType ? '各型別權狀單價趨勢 + 成交量' : '權狀單價量趨勢'}
              </h3>
              {res.aggregatedToSeg && <span style={{ marginLeft: 'auto', fontSize: '.7rem', color: '#f59e0b', background: '#fffbeb', padding: '2px 8px', borderRadius: 999 }}>⚠ 樣本&lt;8，已聚合至「段」</span>}
            </div>
            <div style={{ width: '100%', height: 300 }}>
              <ResponsiveContainer>
                <ComposedChart data={mergeTrend(res)} margin={{ top: 16, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="q" fontSize={11} />
                  <YAxis yAxisId="l" fontSize={11} label={{ value: '萬/坪', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                  <YAxis yAxisId="r" orientation="right" fontSize={11} label={{ value: '件', angle: 90, position: 'insideRight', fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  <Bar yAxisId="r" dataKey="volume" name="成交量(件)" fill="#e2e8f0" />
                  {res.trendByType ? (
                    // 型別「全部」→ 各型別一條線
                    BUILDING_TYPES.map((bt) => (
                      <Line key={bt} yAxisId="l" dataKey={bt} name={bt}
                        stroke={TYPE_COLORS[bt]} strokeWidth={2} dot={false} connectNulls />
                    ))
                  ) : (
                    // 選特定型別 → 單線
                    <Line yAxisId="l" dataKey="price" name="權狀單價(萬/坪)" stroke="#2563eb" strokeWidth={2.5} dot={false} />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* 明細表 */}
          <section style={card}>
            <h3 style={{ margin: '0 0 4px', fontSize: '.95rem' }}>成交明細</h3>
            {res.aggregatedToSeg && (
              <p style={{ margin: '0 0 6px', fontSize: '.74rem', color: '#f59e0b', background: '#fffbeb', padding: '6px 10px', borderRadius: 6 }}>
                ⚠ 此巷（含所選型別）樣本 &lt;8，KPI／圖／表已一併放寬到「段」層級顯示，確保三者一致。
              </p>
            )}
            <p style={{ margin: '0 0 8px', fontSize: '.72rem', color: '#64748b' }}>
              「主建物佔比」= 主建物坪 ÷ 權狀總坪。愈高代表室內實坪愈實在（公設/陽台佔比愈低）；&lt;50% 標「低實用」。點「查看」可看原始完整資料。
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.8rem' }}>
                <thead>
                  {table.getHeaderGroups().map((hg) => (
                    <tr key={hg.id}>
                      {hg.headers.map((h) => (
                        <th key={h.id} onClick={() => sortBy(h.column.id)}
                          style={{ borderBottom: '1px solid #e2e8f0', padding: '7px 8px', textAlign: 'right', background: '#f8fafc', color: '#64748b', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                          {flexRender(h.column.columnDef.header, h.getContext())}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {table.getRowModel().rows.map((r) => (
                    <tr key={r.id}>
                      {r.getVisibleCells().map((c) => (
                        <td key={c.id} style={{ borderBottom: '1px solid #f1f5f9', padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {flexRender(c.column.columnDef.cell, c.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* 全部顯示：共 N 筆（若超過上限才提示） */}
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 10, fontSize: '.78rem', color: '#64748b' }}>
              <span>共 {res.total} 筆{res.total > res.rows.length ? `（顯示前 ${res.rows.length} 筆，請縮小地段範圍看完整）` : '（全部顯示）'}</span>
            </div>
          </section>
        </>
      )}

      {/* 原始資料明細 modal */}
      {detail && (
        <div onClick={() => setDetail(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 10, maxWidth: 640, width: '100%', maxHeight: '85vh', overflow: 'auto', padding: '20px 24px', boxShadow: '0 10px 40px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: '1rem' }}>原始資料（實價登錄）</h3>
              <button onClick={() => setDetail(null)} style={{ marginLeft: 'auto', border: 'none', background: 'none', fontSize: '1.3rem', cursor: 'pointer', color: '#64748b' }}>×</button>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.8rem' }}>
              <tbody>
                {Object.entries(detail)
                  .filter(([k]) => k !== '選定單價')
                  .map(([k, v]) => (
                    <tr key={k}>
                      <td style={{ borderBottom: '1px solid #f1f5f9', padding: '6px 10px', color: '#64748b', whiteSpace: 'nowrap', width: '38%' }}>{k}</td>
                      <td style={{ borderBottom: '1px solid #f1f5f9', padding: '6px 10px', fontWeight: 500 }}>
                        {v === null || v === undefined || v === '' ? '—' : String(v)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}

/* ---- 小元件 & 樣式 ---- */
const card: React.CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '16px 18px', margin: '12px 0' };
const grid4: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 8 };
const chk: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: '.82rem' };
const btn: React.CSSProperties = { marginLeft: 'auto', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 22px', fontWeight: 600, cursor: 'pointer' };
const tab = (active: boolean): React.CSSProperties => ({
  background: active ? '#2563eb' : '#fff', color: active ? '#fff' : '#64748b',
  border: '1px solid ' + (active ? '#2563eb' : '#e2e8f0'), borderRadius: 6,
  padding: '6px 18px', fontWeight: 600, cursor: 'pointer', fontSize: '.85rem',
});
const btnOutline: React.CSSProperties = { background: '#fff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: 6, padding: '8px 18px', fontWeight: 600, cursor: 'pointer' };
function badge(color: string, bg: string): React.CSSProperties {
  return { display: 'inline-block', fontSize: '.62rem', padding: '1px 5px', borderRadius: 3, fontWeight: 600, color, background: bg, marginLeft: 3 };
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}><label style={{ fontSize: '.72rem', color: '#64748b', fontWeight: 600 }}>{label}</label>{children}</div>;
}
// 建物型別多選 checkbox（chip 樣式，勾選=藍底）
function TypeChecks({ selected, opts, onToggle }: { selected: string[]; opts?: string[]; onToggle: (t: string) => void }) {
  const list = opts ?? [];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      {list.length === 0 && <span style={{ fontSize: '.75rem', color: '#94a3b8' }}>載入中…</span>}
      {list.map((t) => {
        const on = selected?.includes(t);
        return (
          <button key={t} type="button" onClick={() => onToggle(t)}
            style={{
              fontSize: '.75rem', padding: '4px 9px', borderRadius: 6, cursor: 'pointer',
              border: '1px solid ' + (on ? '#2563eb' : '#e2e8f0'),
              background: on ? '#2563eb' : '#fff', color: on ? '#fff' : '#334155', fontWeight: on ? 600 : 400,
            }}>
            {on ? '✓ ' : ''}{t}
          </button>
        );
      })}
    </div>
  );
}
function Kpi({ k, v }: { k: string; v: string }) {
  return <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '11px 13px', background: '#f8fafc' }}>
    <div style={{ fontSize: '.68rem', color: '#64748b' }}>{k}</div>
    <div style={{ fontSize: '1.1rem', fontWeight: 700, marginTop: 2 }}>{v}</div>
  </div>;
}
// 可搜尋下拉：輸入即時過濾清單，點選才套值（限定只能選清單內選項）。disabled 時灰化不可用。
function SearchSelect({ v, on, opts, allowEmpty, emptyLabel, labels, disabled }: {
  v: string; on: (v: string) => void; opts?: string[]; allowEmpty?: boolean; emptyLabel?: string; labels?: Record<string, string>; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const label = (val: string) => labels?.[val] ?? val;
  const display = v ? label(v) : (emptyLabel ?? '全部');

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const list = (opts ?? []).filter((o) => label(o).toLowerCase().includes(q.toLowerCase()));
  const pick = (val: string) => { on(val); setOpen(false); setQ(''); };

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <input
        value={open ? q : display}
        placeholder={display}
        disabled={disabled}
        onFocus={() => { if (!disabled) { setOpen(true); setQ(''); } }}
        onChange={(e) => setQ(e.target.value)}
        style={{
          width: '100%', boxSizing: 'border-box', border: '1px solid #e2e8f0', borderRadius: 6,
          padding: '7px 9px', fontSize: '.82rem', color: disabled ? '#94a3b8' : '#0f172a',
          background: disabled ? '#f1f5f9' : '#fff', cursor: disabled ? 'not-allowed' : 'text',
        }}
      />
      {open && !disabled && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, marginTop: 2,
          background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, maxHeight: 240,
          overflowY: 'auto', boxShadow: '0 6px 20px rgba(0,0,0,.1)',
        }}>
          {allowEmpty && <Opt label={emptyLabel ?? '全部'} active={v === ''} onClick={() => pick('')} muted />}
          {list.length === 0 && <div style={{ padding: '7px 10px', fontSize: '.78rem', color: '#94a3b8' }}>無符合項目</div>}
          {list.map((o) => <Opt key={o} label={label(o)} active={v === o} onClick={() => pick(o)} />)}
        </div>
      )}
    </div>
  );
}
function Opt({ label, active, onClick, muted }: { label: string; active: boolean; onClick: () => void; muted?: boolean }) {
  return (
    <div onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      style={{
        padding: '7px 10px', fontSize: '.82rem', cursor: 'pointer',
        background: active ? '#eff6ff' : 'transparent', color: muted ? '#64748b' : '#0f172a',
        fontWeight: active ? 600 : 400,
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = active ? '#eff6ff' : '#f8fafc'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = active ? '#eff6ff' : 'transparent'; }}>
      {label}
    </div>
  );
}
