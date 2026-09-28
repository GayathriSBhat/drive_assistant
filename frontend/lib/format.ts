import type { LatLng } from "./types";

export const fmtDist = (m?: number | null) =>
  m == null ? "" : m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;

export const fmtDur = (s: number) => {
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/** "Dal Moro's Nexus Koramangala | Fresh Pasta To Go" → "Dal Moro's Nexus Koramangala" */
export const cleanName = (name: string) => name.split(/\s[|\-–—]\s/)[0];

/** For the few bits of HTML we hand to Leaflet popups. */
export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function decodePolyline(str: string): LatLng[] {
  const out: LatLng[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0;
      let result = 0;
      let b: number;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d;
      else lng += d;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}
