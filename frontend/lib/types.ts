export type LatLng = [number, number];

export interface Loc {
  lat: number;
  lng: number;
  heading: number | null;
}

export interface Badge {
  text: string;
  tone: string; // good | bad | neutral | likely | on_menu | reviewed
}

/** A place card as sent by the agent's tools (find_nearby, find_best_dish, EV, parking). */
export interface Place {
  id?: string | null;
  name: string;
  address?: string | null;
  lat: number | null;
  lng: number | null;
  distance_m?: number | null;
  rating?: number | null;
  ratings?: number | null;
  open_now?: boolean | null;
  maps_url?: string | null;
  website?: string | null;
  phone?: string | null;
  photo?: string | null; // Places photo resource name, loaded through /api/place-photo
  drive_min?: number | null;
  detour_min?: number | null;
  walk_min?: number | null;
  badge?: Badge | null;
  tags?: string[];
  evidence?: string;
  quote?: string | null;
  quote_source?: string | null;
  quote_author?: string | null;
  pinned?: boolean; // e.g. the destination's own parking, shown first
}

export interface RouteInfo {
  provider: string;
  duration_s: number;
  distance_m: number;
  summary: string;
  polyline: string;
  traffic_delay_s: number | null;
}

export interface Destination {
  name: string;
  address: string;
  lat: number;
  lng: number;
}

export interface RouteEvent {
  type: "route";
  destination: Destination;
  chosen: RouteInfo;
  alternatives: RouteInfo[];
  blocked?: { summary: string; locality?: string }[];
}

/** UI updates the agent streams on the "ui.event" text-stream topic. */
export type UiEvent =
  | { type: "places"; category: string; title?: string; places: Place[] }
  | RouteEvent
  | { type: "clear_route" }
  | { type: "focus_reports" };

/** What the orb shows. */
export type OrbState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "muted" | "paused";

export type DrawerSnap = "hidden" | "peek" | "half" | "full";
