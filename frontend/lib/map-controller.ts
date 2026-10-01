/// <reference types="google.maps" />
import { decodePolyline } from "./format";
import type { Destination, LatLng, Loc, Place, RouteEvent } from "./types";

const CATEGORY_COLORS: Record<string, string> = {
  fuel: "#e8935c",
  ev_charging: "#3ecf8e",
  restaurant: "#ff7a45",
  hospital: "#ff4f6d",
  parking: "#6b8afd",
  atm: "#8a7dff",
  pharmacy: "#33d6c2",
  car_repair: "#9aa5b1",
  other: "#edaa57",
};

// Browser key for the Maps JavaScript API (restrict it to your domains). Inlined at build time.
const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";

let loading: Promise<void> | null = null;

/** Loads the Maps JavaScript API once (async loader + importLibrary). */
function loadGoogleMaps(): Promise<void> {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    if (!MAPS_KEY) return reject(new Error("NEXT_PUBLIC_GOOGLE_MAPS_KEY is not set"));
    const w = window as unknown as Record<string, unknown>;
    w.__kendriveMapsReady = () => resolve();
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_KEY)}&v=weekly&loading=async&libraries=marker&callback=__kendriveMapsReady`;
    s.async = true;
    s.onerror = () => reject(new Error("Couldn't load Google Maps"));
    document.head.appendChild(s);
  });
  return loading;
}

const el = (html: string) => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.firstElementChild as HTMLElement;
};

/**
 * Imperative Google Maps wrapper: the driver's dot, result pins, the route and map framing.
 * Normal roadmap in Google's dark colour scheme; pins are HTML (AdvancedMarkerElement).
 * Tapping a pin calls `onPinClick(index)` so the matching card can scroll into view.
 */
export class MapController {
  private me: google.maps.marker.AdvancedMarkerElement | null = null;
  private placeMarkers: google.maps.marker.AdvancedMarkerElement[] = [];
  private routeLayers: (google.maps.Polyline | google.maps.marker.AdvancedMarkerElement)[] = [];
  private lastFit: LatLng[] | null = null;

  private constructor(
    readonly map: google.maps.Map,
    private readonly onPinClick: (index: number) => void,
  ) {}

  static async create(host: HTMLElement, center: LatLng, onPinClick: (index: number) => void): Promise<MapController> {
    await loadGoogleMaps();
    const { Map } = (await google.maps.importLibrary("maps")) as google.maps.MapsLibrary;
    await google.maps.importLibrary("marker");
    const map = new Map(host, {
      center: { lat: center[0], lng: center[1] },
      zoom: 14,
      mapId: "DEMO_MAP_ID", // required for HTML markers; DARK below styles the normal roadmap
      colorScheme: google.maps.ColorScheme.DARK,
      mapTypeId: "roadmap",
      disableDefaultUI: true,
      clickableIcons: false,
      gestureHandling: "greedy",
      keyboardShortcuts: false,
    });
    return new MapController(map, onPinClick);
  }

  destroy() {
    this.clearPlaces();
    this.clearRoute();
    if (this.me) this.me.map = null;
  }

  setMe(loc: Loc, center = false) {
    const position = { lat: loc.lat, lng: loc.lng };
    if (!this.me) {
      this.me = new google.maps.marker.AdvancedMarkerElement({ position, content: el('<div class="me-dot"></div>'), zIndex: 1000 });
    }
    this.me.position = position;
    this.me.map = this.map;
    if (center) {
      this.map.setCenter(position);
      this.map.setZoom(15);
    }
  }

  showPlaces(places: Place[], category: string, me: Loc | null) {
    this.clearPlaces();
    const color = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.other;
    const pinned = places.filter((p) => p.pinned).length;
    places.forEach((p, i) => {
      if (p.lat == null || p.lng == null) return;
      const label = p.pinned ? "★" : i - pinned + 1; // numbers match the card ranks
      const m = new google.maps.marker.AdvancedMarkerElement({
        map: this.map,
        position: { lat: p.lat, lng: p.lng },
        content: el(`<div class="place-pin" style="--pin:${color}"><span>${label}</span></div>`),
        title: p.name,
        gmpClickable: true,
      });
      m.addListener("click", () => this.onPinClick(i));
      this.placeMarkers[i] = m;
    });
    const pts: LatLng[] = places.filter((p) => p.lat != null && p.lng != null).map((p) => [p.lat!, p.lng!]);
    if (me) pts.push([me.lat, me.lng]);
    if (pts.length) this.lastFit = pts;
  }

  clearPlaces() {
    for (const m of this.placeMarkers) if (m) m.map = null;
    this.placeMarkers = [];
  }

  /** Draws the chosen route (plus greyed alternatives) and returns its path. */
  showRoute(evt: RouteEvent): LatLng[] {
    this.clearRoute();
    const line = (pts: LatLng[], color: string, weight: number, opacity = 1, zIndex = 1) =>
      new google.maps.Polyline({
        map: this.map,
        path: pts.map(([lat, lng]) => ({ lat, lng })),
        strokeColor: color,
        strokeWeight: weight,
        strokeOpacity: opacity,
        zIndex,
      });
    for (const alt of evt.alternatives) this.routeLayers.push(line(decodePolyline(alt.polyline), "#3a3c42", 5, 0.8));
    const path = decodePolyline(evt.chosen.polyline);
    this.routeLayers.push(line(path, "#08090a", 10, 0.9, 2), line(path, "#edaa57", 6, 1, 3));
    const pin = (p: Destination, cls: string) =>
      new google.maps.marker.AdvancedMarkerElement({
        map: this.map,
        position: { lat: p.lat, lng: p.lng },
        content: el(`<div class="${cls}"></div>`),
        title: p.name,
      });
    this.routeLayers.push(pin(evt.destination, "dest-pin"));
    if (evt.origin) this.routeLayers.push(pin(evt.origin, "origin-pin"));
    this.clearPlaces();
    this.lastFit = path;
    return path;
  }

  clearRoute() {
    for (const l of this.routeLayers) {
      if (l instanceof google.maps.Polyline) l.setMap(null);
      else l.map = null;
    }
    this.routeLayers = [];
  }

  setFit(pts: LatLng[] | null) {
    this.lastFit = pts;
  }

  /** After the card resizes: re-frame whatever is on show (clear of the title bar at the top). */
  refresh(me: Loc | null) {
    if (this.lastFit?.length) {
      const b = new google.maps.LatLngBounds();
      for (const [lat, lng] of this.lastFit) b.extend({ lat, lng });
      this.map.fitBounds(b, { top: 72, left: 24, right: 24, bottom: 24 });
      if ((this.map.getZoom() ?? 0) > 16) this.map.setZoom(16);
    } else if (me) {
      this.map.setCenter({ lat: me.lat, lng: me.lng });
    }
  }

  /** Card in view → centre its pin and lift it above the others. */
  focus(i: number) {
    this.placeMarkers.forEach((m, j) => {
      if (!m) return;
      (m.content as HTMLElement).classList.toggle("active", i === j);
      m.zIndex = i === j ? 999 : j;
    });
    const m = this.placeMarkers[i];
    if (m?.position) this.map.panTo(m.position);
  }
}
