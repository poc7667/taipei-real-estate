'use client';
import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';

export type MapPoint = {
  lat: number; lon: number; city: string; district: string; seg: string;
  price: number; volume: number; ratio: number | null;
};

// 純 Leaflet 地圖（避開 react-leaflet 的 React19 peer 衝突）
// 色階=權狀單價、半徑=成交量、點擊 popup。
export default function MapView({ points }: { points: MapPoint[] }) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled || !elRef.current) return;
      if (!mapRef.current) {
        mapRef.current = L.map(elRef.current).setView([25.04, 121.55], 12); // 台北市中心
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenStreetMap', maxZoom: 19,
        }).addTo(mapRef.current);
        layerRef.current = L.layerGroup().addTo(mapRef.current);
      }
      const map = mapRef.current;
      const layer = layerRef.current;
      layer.clearLayers();
      if (!points.length) return;

      // 色階：權狀單價 low→high = 藍→黃→紅
      const prices = points.map((p) => p.price).filter((v) => v != null);
      const lo = Math.min(...prices), hi = Math.max(...prices);
      const color = (v: number) => {
        const t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
        const r = Math.round(255 * Math.min(1, t * 2));
        const g = Math.round(255 * Math.min(1, (1 - Math.abs(t - 0.5) * 2)));
        const b = Math.round(255 * Math.max(0, 1 - t * 2));
        return `rgb(${r},${g},${b})`;
      };
      const maxVol = Math.max(...points.map((p) => p.volume));
      const bounds: [number, number][] = [];
      for (const p of points) {
        const radius = 5 + 18 * Math.sqrt(p.volume / maxVol); // 半徑=量（sqrt 壓縮）
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
        bounds.push([p.lat, p.lon]);
      }
      if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
    })();
    return () => { cancelled = true; };
  }, [points]);

  return <div ref={elRef} style={{ width: '100%', height: 460, borderRadius: 8, overflow: 'hidden' }} />;
}
