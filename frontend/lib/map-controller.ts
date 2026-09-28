import L from "leaflet";
import { decodePolyline, esc, fmtDist } from "./format";
import type { LatLng, Loc, Place, RouteEvent } from "./types";

const CATEGORY_COLORS: Record<string, string> = {
  fuel: "#ffb020",
  ev_charging: "#3ecf8e",
  restaurant: "#ff7a45",
  hospital: "#ff4f6d",
  parking: "#3b82f6",
  atm: "#8a7dff",
  pharmacy: "#33d6c2",
  car_repair: "#9aa5b1",
  other: "#3b82f6",
};

/**
 * Imperative Leaflet wrapper: the driver's dot, result pins, the route and map framing.
 * `bottomOverlay` reports how much of the map's bottom is covered (results carousel / route card)
 * so fitted pins stay visible.
 */
export class MapController {
  readonly map: L.Map;
  private readonly me: L.Marker;
  private readonly places = L.layerGroup();
  private readonly route = L.layerGroup();
  private placeMarkers: L.Marker[] = [];
  private lastFit: LatLng[] | null = null;

  constructor(el: HTMLElement, center: LatLng, private readonly bottomOverlay: () => number) {
    this.map = L.map(el, { zoomControl: false }).setView(center, 14);
    this.map.attributionControl.setPosition("topright"); // the bottom holds the results carousel
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      className: "dark-tiles",
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Places © Google',
    }).addTo(this.map);
    this.places.addTo(this.map);
    this.route.addTo(this.map);
    this.me = L.marker(center, {
      icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18] }),
      zIndexOffset: 1000,
    });
  }

  destroy() {
    this.map.remove();
  }

  setMe(loc: Loc, center = false) {
    this.me.setLatLng([loc.lat, loc.lng]);
    if (!this.map.hasLayer(this.me)) this.me.addTo(this.map);
    if (center) this.map.setView([loc.lat, loc.lng], 15);
  }

  panTo(loc: Loc) {
    this.map.panTo([loc.lat, loc.lng], { animate: true });
  }

  showPlaces(places: Place[], category: string, me: Loc | null) {
    this.clearPlaces();
    const color = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.other;
    const pinned = places.filter((p) => p.pinned).length;
    places.forEach((p, i) => {
      if (p.lat == null || p.lng == null) return;
      const label = p.pinned ? "★" : i - pinned + 1; // numbers match the card ranks
      const m = L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          className: "",
          html: `<div class="place-pin" style="background:${color}"><span>${label}</span></div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 28],
        }),
      });
      const open =
        p.open_now == null ? "" : p.open_now ? ' · <span style="color:var(--ok)">Open</span>' : ' · <span style="color:var(--danger)">Closed</span>';
      m.bindPopup(`
        <h3>${esc(p.name)}</h3>
        <div class="muted">${esc(p.address)}</div>
        <div class="muted">${fmtDist(p.distance_m)}${p.rating ? ` · ★ ${p.rating}` : ""}${open}</div>
        ${p.maps_url ? `<div class="muted" style="margin-top:4px"><a href="${esc(p.maps_url)}" target="_blank" rel="noopener">View on Google Maps</a></div>` : ""}
        <div class="row"><button class="go" data-go="${esc(p.name)}, ${esc(p.address)}">Navigate</button></div>`);
      this.places.addLayer(m);
      this.placeMarkers[i] = m;
    });
    const pts: LatLng[] = places.filter((p) => p.lat != null && p.lng != null).map((p) => [p.lat!, p.lng!]);
    if (me) pts.push([me.lat, me.lng]);
    if (pts.length) this.lastFit = pts;
  }

  clearPlaces() {
    this.places.clearLayers();
    this.placeMarkers = [];
  }

  /** Draws the chosen route (plus greyed alternatives) and returns its path. */
  showRoute(evt: RouteEvent): LatLng[] {
    this.route.clearLayers();
    for (const alt of evt.alternatives) {
      L.polyline(decodePolyline(alt.polyline), { color: "#5b6677", weight: 5, opacity: 0.7 }).addTo(this.route);
    }
    const path = decodePolyline(evt.chosen.polyline);
    L.polyline(path, { color: "#0b0f14", weight: 10, opacity: 0.9 }).addTo(this.route);
    L.polyline(path, { color: "#4f9dff", weight: 6 }).addTo(this.route);
    const d = evt.destination;
    L.marker([d.lat, d.lng], { icon: L.divIcon({ className: "", html: '<div class="dest-pin"></div>', iconSize: [16, 16] }) })
      .bindPopup(`<h3>${esc(d.name)}</h3><div class="muted">${esc(d.address)}</div>`)
      .addTo(this.route);
    this.clearPlaces();
    this.lastFit = path;
    return path;
  }

  clearRoute() {
    this.route.clearLayers();
  }

  setFit(pts: LatLng[] | null) {
    this.lastFit = pts;
  }

  /** After the drawer resizes: tell Leaflet, then re-frame whatever is on show. */
  refresh(me: Loc | null) {
    this.map.invalidateSize();
    if (this.map.getSize().y < 60) return; // drawer peeking: nothing visible to frame
    if (this.lastFit?.length) {
      this.map.fitBounds(L.latLngBounds(this.lastFit), {
        paddingTopLeft: [16, 16],
        paddingBottomRight: [16, this.bottomOverlay() + 16],
        maxZoom: 16,
      });
    } else if (me) {
      this.map.setView([me.lat, me.lng]);
    }
  }

  focus(i: number) {
    const m = this.placeMarkers[i];
    if (!m) return;
    this.map.setView(m.getLatLng(), Math.max(this.map.getZoom(), 15));
    if (this.map.getSize().y > 260) m.openPopup(); // too cramped for a popup in the half-open drawer
  }
}
