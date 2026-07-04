'use client';
import { useEffect, useState, useCallback } from 'react';
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import {
  useReactTable, getCoreRowModel, flexRender, createColumnHelper,
} from '@tanstack/react-table';

type Options = {
  cities: string[]; districts: string[]; buildingTypes: string[];
  roads: string[]; roadSegs: string[]; roadLanes: string[]; quarters: string[];
};
type Row = Record<string, any>;
type Result = {
  kpi: { count: number; median_price: number; median_ratio: number } | null;
  trend: { q: string; price: number; volume: number }[];
  rows: Row[]; total: number; aggregatedToSeg: boolean; priceCol: string;
};

const PRICE_KINDS = [
  { v: 'main', label: '② 主建物淨坪 ★' },
  { v: 'deed', label: '① 權狀' },
  { v: 'incl', label: '③ 含附屬' },
];

const wan = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('zh-TW', { maximumFractionDigits: 1 });

export default function Page() {
  const [opt, setOpt] = useState<Options | null>(null);
  const [f, setF] = useState<any>({
    city: '臺北市', district: '大安區', buildingType: '', txType: '買賣',
    road: '', roadSeg: '', roadLane: '', fromQ: '', toQ: '',
    priceKind: 'main', excludeOutlier: true, onlyHighRatio: false,
    page: 1, pageSize: 50, sortBy: 'date', sortDir: 'desc',
  });
  const [res, setRes] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));

  // 表格
  const ch = createColumnHelper<Row>();
  const columns = [
    ch.accessor((r) => `${r['西元年']}/${String(r['月']).padStart(2, '0')}`, { id: 'date', header: '交易日期' }),
    ch.accessor((r) => r['路段巷'] || r['路段'] || r['路'] || r['行政區'], { id: 'seg', header: '地段' }),
    ch.accessor('建物型別', { header: '型別' }),
    ch.accessor('權狀總坪', { header: '權狀坪', cell: (c) => wan(c.getValue() as number) }),
    ch.accessor('主建物坪', { header: '主建物坪', cell: (c) => wan(c.getValue() as number) }),
    ch.accessor('選定單價', { header: '單價(萬/坪)', cell: (c) => wan(c.getValue() as number) }),
    ch.accessor('總價_萬', { header: '總價(萬)', cell: (c) => wan(c.getValue() as number) }),
    ch.accessor('主建物佔比', { header: '佔比', cell: (c) => { const v = c.getValue() as number; return v == null ? '—' : `${(v * 100).toFixed(0)}%`; } }),
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
  ];
  const table = useReactTable({ data: res?.rows ?? [], columns, getCoreRowModel: getCoreRowModel() });

  const sortBy = (id: string) => {
    const map: Record<string, string> = { date: 'date', seg: 'date', 選定單價: 'price', '總價_萬': 'total', '權狀總坪': 'deedPing', '主建物坪': 'mainPing', '主建物佔比': 'ratio' };
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
          <Field label="縣市"><Sel v={f.city} on={(v) => set('city', v)} opts={opt?.cities} /></Field>
          <Field label="行政區"><Sel v={f.district} on={(v) => set('district', v)} opts={opt?.districts} allowEmpty /></Field>
          <Field label="建物型別"><Sel v={f.buildingType} on={(v) => set('buildingType', v)} opts={opt?.buildingTypes} allowEmpty emptyLabel="全部" /></Field>
          <Field label="交易類型"><Sel v={f.txType} on={(v) => set('txType', v)} opts={['買賣', '租賃']} /></Field>
        </div>
        <div style={grid4}>
          <Field label="路"><Sel v={f.road} on={(v) => set('road', v)} opts={opt?.roads} allowEmpty emptyLabel="全部" /></Field>
          <Field label="段"><Sel v={f.roadSeg} on={(v) => set('roadSeg', v)} opts={opt?.roadSegs} allowEmpty emptyLabel="全部" /></Field>
          <Field label="巷"><Sel v={f.roadLane} on={(v) => set('roadLane', v)} opts={opt?.roadLanes} allowEmpty emptyLabel="全部" /></Field>
          <Field label="單價種類"><Sel v={f.priceKind} on={(v) => set('priceKind', v)} opts={PRICE_KINDS.map((k) => k.v)} labels={PRICE_KINDS.reduce((a, k) => ({ ...a, [k.v]: k.label }), {})} /></Field>
        </div>
        <div style={grid4}>
          <Field label="期間(起)"><Sel v={f.fromQ} on={(v) => set('fromQ', v)} opts={opt?.quarters} allowEmpty emptyLabel="最早" /></Field>
          <Field label="期間(迄)"><Sel v={f.toQ} on={(v) => set('toQ', v)} opts={opt?.quarters} allowEmpty emptyLabel="最新" /></Field>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
          <label style={chk}><input type="checkbox" checked={f.excludeOutlier} onChange={(e) => set('excludeOutlier', e.target.checked)} /> 排除 outlier</label>
          <label style={chk}><input type="checkbox" checked={f.onlyHighRatio} onChange={(e) => set('onlyHighRatio', e.target.checked)} /> 只看主建物佔比 ≥50%</label>
          <button style={btn} onClick={() => runQuery({ page: 1 })}>查詢</button>
        </div>
      </section>

      {loading && <div style={{ ...card, textAlign: 'center', color: '#64748b' }}>查詢中…</div>}
      {error && <div style={{ ...card, borderColor: '#ef4444', color: '#ef4444' }}>查詢失敗：{error}</div>}

      {res && !loading && (
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
              <h3 style={{ margin: 0, fontSize: '.95rem' }}>價量趨勢</h3>
              {res.aggregatedToSeg && <span style={{ marginLeft: 'auto', fontSize: '.7rem', color: '#f59e0b', background: '#fffbeb', padding: '2px 8px', borderRadius: 999 }}>⚠ 樣本&lt;8，已聚合至「段」</span>}
            </div>
            <div style={{ width: '100%', height: 260 }}>
              <ResponsiveContainer>
                <ComposedChart data={res.trend} margin={{ top: 16, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="q" fontSize={11} />
                  <YAxis yAxisId="l" fontSize={11} label={{ value: '萬/坪', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                  <YAxis yAxisId="r" orientation="right" fontSize={11} label={{ value: '件', angle: 90, position: 'insideRight', fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  <Bar yAxisId="r" dataKey="volume" name="成交量(件)" fill="#c7d2fe" />
                  <Line yAxisId="l" dataKey="price" name="單價(萬/坪)" stroke="#2563eb" strokeWidth={2.5} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* 明細表 */}
          <section style={card}>
            <h3 style={{ margin: '0 0 8px', fontSize: '.95rem' }}>成交明細</h3>
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
            {/* 分頁 */}
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 10, fontSize: '.78rem', color: '#64748b' }}>
              <span>共 {res.total} 筆</span>
              <button style={pg} disabled={f.page <= 1} onClick={() => { const p = f.page - 1; set('page', p); runQuery({ page: p }); }}>‹</button>
              <span style={{ padding: '2px 8px' }}>第 {f.page} 頁</span>
              <button style={pg} disabled={f.page * f.pageSize >= res.total} onClick={() => { const p = f.page + 1; set('page', p); runQuery({ page: p }); }}>›</button>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

/* ---- 小元件 & 樣式 ---- */
const card: React.CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '16px 18px', margin: '12px 0' };
const grid4: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 8 };
const chk: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: '.82rem' };
const btn: React.CSSProperties = { marginLeft: 'auto', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 22px', fontWeight: 600, cursor: 'pointer' };
const pg: React.CSSProperties = { border: '1px solid #e2e8f0', borderRadius: 5, padding: '2px 9px', background: '#fff', cursor: 'pointer' };
function badge(color: string, bg: string): React.CSSProperties {
  return { display: 'inline-block', fontSize: '.62rem', padding: '1px 5px', borderRadius: 3, fontWeight: 600, color, background: bg, marginLeft: 3 };
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}><label style={{ fontSize: '.72rem', color: '#64748b', fontWeight: 600 }}>{label}</label>{children}</div>;
}
function Kpi({ k, v }: { k: string; v: string }) {
  return <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '11px 13px', background: '#f8fafc' }}>
    <div style={{ fontSize: '.68rem', color: '#64748b' }}>{k}</div>
    <div style={{ fontSize: '1.1rem', fontWeight: 700, marginTop: 2 }}>{v}</div>
  </div>;
}
function Sel({ v, on, opts, allowEmpty, emptyLabel, labels }: { v: string; on: (v: string) => void; opts?: string[]; allowEmpty?: boolean; emptyLabel?: string; labels?: Record<string, string> }) {
  return (
    <select value={v} onChange={(e) => on(e.target.value)}
      style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: '7px 9px', fontSize: '.82rem', background: '#fff', color: '#0f172a' }}>
      {allowEmpty && <option value="">{emptyLabel ?? '全部'}</option>}
      {(opts ?? []).map((o) => <option key={o} value={o}>{labels?.[o] ?? o}</option>)}
    </select>
  );
}
