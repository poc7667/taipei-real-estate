'use client';
import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';

export type MapPoint = {
  lat: number; lon: number; city: string; district: string; seg: string;
  price: number; volume: number; ratio: number | null;
};
export type Bounds = { south: number; west: number; north: number; east: number };

// 純 Leaflet 地圖（避開 react-leaflet 的 React19 peer 衝突）
// 色階=權狀單價、半徑=成交量、點擊 popup。
// 拖曳/縮放 → onBoundsChange（debounce）→ 父層依 bounds 重擈可視範圍內的段。
export default function MapView({
  points, onBoundsChange,
}: {
  points: MapPoint[];
  onBoundsChange?: (b: Bounds) => void;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const cbRef = useRef(onBoundsChange);
  cbRef.current = onBoundsChange;

  // 初始化地圖（只一次）+ moveend 監聽
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled || !elRef.current || mapRef.current) return;
      const map = L.map(elRef.current).setView([25.04, 121.55], 13); // 台北市中心
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap', maxZoom: 19,
      }).addTo(map);
      layerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;

      // 拖曳/縮放結束 → debounce 回報 bounds
      let timer: any = null;
      const emit = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const b = map.getBounds();
          cbRef.current?.({
            south: b.getSouth(), west: b.getWest(),
            north: b.getNorth(), east: b.getEast(),
          });
        }, 400);
      };
      map.on('moveend', emit);
      emit(); // 首次載入即回報初始 bounds
    })();
    return () => { cancelled = true; };
  }, []);

  // points 變動 → 重繪標記（不 fitBounds，因為 bounds 現在驅動資料）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await import('leaflet').then((m) => m.default);
      const L = (await import('leaflet')).default;
      if (cancelled || !layerRef.current) return;
      const layer = layerRef.current;
      layer.clearLayers();
      if (!points.length) return;

      const prices = points.map((p) => p.price).filter((v) => v != null);
      const lo = Math.min(...prices), hi = Math.max(...prices);
      const color = (v: number) => {
        const t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
        const r = Math.round(255 * Math.min(1, t * 2));
        const g = Math.round(255 * Math.min(1, 1 - Math.abs(t - 0.5) * 2));
        const b = Math.round(255 * Math.max(0, 1 - t * 2));
        return `rgb(${r},${g},${b})`;
      };
      const maxVol = Math.max(...points.map((p) => p.volume));
      for (const p of points) {
        const radius = 5 + 18 * Math.sqrt(p.volume / maxVol);
        L.circleMarker([p.lat, p.lon], {
          radius, color: '#333', weight: 0.5,
          fillColor: color(p.price), fillOpacity: 0.72,
        })
          .bindPopup(
            `<b>${p.district} ${p.seg}</b><br/>` +
            `權狀中位單價：<b>${p.price?.toFixed(1) ?? '—'}</b> 萬/坪<br/>` +
            `成交量：${p.volume} 件<br/>` +
            `中位主建物佔比：${p.ratio != null ? (p.ratio * 100).toFixed(0) + '%' : '—'}`
          )
          .addTo(layer);
      }
    })();
    return () => { cancelled = true; };
  }, [points]);

  return <div ref={elRef} style={{ width: '100%', height: 460, borderRadius: 8, overflow: 'hidden' }} />;
}
