"use client";

import { LiveKitRoom } from "@livekit/components-react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fmtDist, fmtDur } from "@/lib/format";
import { MapController } from "@/lib/map-controller";
import { useThinkingSound } from "@/lib/use-thinking-sound";
import type { LatLng, Loc, OrbState, Place, UiEvent, WeatherEvent } from "@/lib/types";
import ResultCards from "./result-cards";
import SessionBridge, { type SessionApi } from "./session-bridge";
import ConversationBar from "./conversation-bar";
import Hero from "./hero";
import LiveCaptions from "./live-captions";
import TopBar from "./top-bar";
import VoiceOrb from "./voice-orb";
import WeatherCard from "./weather-card";

// Demo locations. Dubai has no open live-parking feed; Singapore publishes live car-park availability.
// Live GPS by default; ?demo (Dubai) or ?demo=singapore pins a demo location.
type LocMode = "gps" | "dubai" | "singapore";

const DEMO: Record<"dubai" | "singapore", Loc & { label: string }> = {
  dubai: { lat: 25.1972, lng: 55.2744, heading: null, label: "Dubai demo" }, // Downtown Dubai (Burj Khalifa)
  singapore: { lat: 1.2847, lng: 103.8325, heading: null, label: "Singapore demo" }, // Tiong Bahru
};


const CATEGORY_TITLES: Record<string, string> = {
  fuel: "Nearest petrol bunks",
  ev_charging: "EV charging nearby",
  restaurant: "Restaurants nearby",
  hospital: "Nearest hospitals",
  parking: "Parking nearby",
  atm: "ATMs nearby",
  pharmacy: "Pharmacies nearby",
  car_repair: "Mechanics nearby",
  other: "Places nearby",
};

interface RouteState {
  path: LatLng[];
  title: string;
  sub: string;
  eta: string;
  distance: string;
  detail: string;
}

interface Toast {
  text: string;
  kind: "info" | "danger";
  id: number;
  action?: { label: string; run: () => void };
}

const gpsSupported = () => window.isSecureContext && "geolocation" in navigator;

function initialLocMode(): LocMode {
  const demo = new URLSearchParams(location.search).get("demo");
  if (demo !== null) return demo === "singapore" ? "singapore" : "dubai";
  return gpsSupported() ? "gps" : "dubai";
}

// "denied" means the browser won't show the prompt again; the driver has to allow it in site settings.
async function gpsPermission(): Promise<PermissionState | "unknown"> {
  try {
    return (await navigator.permissions.query({ name: "geolocation" })).state;
  } catch {
    return "unknown";
  }
}

export default function KenDriveApp() {
  const phoneRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  const orbRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const mapCardRef = useRef<HTMLElement>(null);
  const mapElRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLElement>(null);
  const routeCardRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapController | null>(null);
  const apiRef = useRef<SessionApi | null>(null);

  // ---------------------------------------------------------------- state
  const [conn, setConn] = useState<{ url: string; token: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [live, setLive] = useState(false);
  const [agentState, setAgentState] = useState("idle");
  const [micMuted, setMicMuted] = useState(false); // the driver's mic only; KenDrive keeps talking
  const [micAvailable, setMicAvailable] = useState(true);
  const [locMode, setLocMode] = useState<LocMode>(initialLocMode);
  const [trackedLoc, setTrackedLoc] = useState<Loc | null>(null); // from GPS
  const [results, setResults] = useState<{ title: string; category: string; places: Place[] } | null>(null);
  const [route, setRoute] = useState<RouteState | null>(null);
  const [weather, setWeather] = useState<WeatherEvent | null>(null);
  // The map floats in as a card when there's something to show (results or a route); tap to expand it.
  const [mapView, setMapView] = useState<"hidden" | "card" | "expanded">("hidden");
  const [toast, setToast] = useState<Toast | null>(null);

  const loc: Loc | null = locMode === "gps" ? trackedLoc : DEMO[locMode];
  const locRef = useRef(loc);
  useEffect(() => {
    locRef.current = loc;
  }, [loc]);
  const liveRef = useRef(false);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  const showToast = useCallback((msg: string, kind: Toast["kind"] = "info", action?: Toast["action"]) => {
    setToast({ text: msg, kind, id: Date.now(), action });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.action ? 12000 : 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // ---------------------------------------------------------------- map
  // Google Maps loads asynchronously; a tapped pin scrolls its card into view.
  const [pinFocus, setPinFocus] = useState<{ index: number; at: number } | null>(null);
  const [mapReady, setMapReady] = useState(false); // false if Maps failed to load: cards still work without it
  useEffect(() => {
    if (!mapElRef.current) return;
    let cancelled = false;
    // Google calls this when the key is rejected (e.g. Maps JavaScript API not enabled for it).
    (window as unknown as { gm_authFailure?: () => void }).gm_authFailure = () => setMapReady(false);
    MapController.create(mapElRef.current, [DEMO.dubai.lat, DEMO.dubai.lng], (index) => setPinFocus({ index, at: Date.now() }))
      .then((ctl) => {
        if (cancelled) return ctl.destroy();
        mapRef.current = ctl;
        setMapReady(true);
        if (locRef.current) ctl.setMe(locRef.current, true);
      })
      .catch((e) => console.warn("Google Maps unavailable; showing cards without a map.", e));
    return () => {
      cancelled = true;
      mapRef.current?.destroy();
      mapRef.current = null;
    };
  }, []);

  const refreshMap = useCallback(() => mapRef.current?.refresh(locRef.current), []);

  // ---------------------------------------------------------------- location (GPS or demo)
  // Falls back to the Dubai demo location, with a button to ask for GPS again.
  const gpsFallback = useCallback(
    async (reason: "timeout" | "error") => {
      setLocMode("dubai");
      if (!gpsSupported()) {
        showToast("Live location needs a secure (https) link. Showing Dubai for now.");
        return;
      }
      const retry = { label: "Use my location", run: () => setLocMode("gps") };
      if (reason === "timeout") {
        showToast("No GPS signal yet. Showing Dubai for now.", "info", retry);
      } else if ((await gpsPermission()) === "denied") {
        showToast("Location is off for this site. Turn it on in your browser settings, then try again.", "info", retry);
      } else {
        showToast("KenDrive works best with your location. Showing Dubai for now.", "info", retry);
      }
    },
    [showToast],
  );

  useEffect(() => {
    if (locMode !== "gps") {
      mapRef.current?.setMe(DEMO[locMode], true);
      return;
    }
    let gotFix = false;
    const fallback = setTimeout(() => {
      if (!gotFix) void gpsFallback("timeout");
    }, 10000);
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const first = !gotFix;
        gotFix = true;
        clearTimeout(fallback);
        const { latitude: lat, longitude: lng, heading } = pos.coords;
        const next = { lat, lng, heading: Number.isFinite(heading) ? heading : null };
        setTrackedLoc(next);
        mapRef.current?.setMe(next, first);
      },
      () => {
        clearTimeout(fallback);
        if (!gotFix) void gpsFallback("error");
      },
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
    return () => {
      clearTimeout(fallback);
      navigator.geolocation.clearWatch(id);
    };
  }, [locMode, gpsFallback]);


  // ---------------------------------------------------------------- session
  const startSession = useCallback(async () => {
    if (conn || connecting) return;
    setConnecting(true);
    try {
      const res = await fetch("/api/token?name=Driver");
      if (!res.ok) throw new Error(await res.text());
      const { url, token } = await res.json();
      setMicAvailable(true);
      setConn({ url, token });
    } catch (e) {
      showToast(`Couldn't connect: ${(e as Error).message}`, "danger");
      setConnecting(false);
    }
  }, [conn, connecting, showToast]);

  const endSession = useCallback(() => {
    setConn(null);
    setConnecting(false);
  }, []);
  const onSessionReady = useCallback((api: SessionApi) => {
    apiRef.current = api;
  }, []);

  const onConnected = useCallback(() => {
    setLive(true);
    setConnecting(false);
  }, []);
  const onDisconnected = useCallback(() => {
    if (liveRef.current) showToast("Call ended. Tap the orb whenever you need me.");
    setLive(false);
    setConn(null);
    setConnecting(false);
    setMicMuted(false);
    setAgentState("idle");
    setWeather(null);
  }, [showToast]);
  const onMediaDeviceFailure = useCallback(() => {
    setMicAvailable(false);
    showToast("Can't reach your microphone. You can type instead.");
  }, [showToast]);

  // Tap the orb: start a session, then mute / unmute the mic.
  const onOrbTap = useCallback(() => {
    if (connecting) return;
    if (live) setMicMuted((m) => !m);
    else void startSession();
  }, [connecting, live, startSession]);

  // M key = mute / unmute (keyboard shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "m" && e.key !== "M") return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (live) setMicMuted((m) => !m);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live]);

  const say = useCallback(
    async (msg: string) => {
      if (!msg.trim()) return;
      if (!live) await startSession();
      await apiRef.current?.sendText(msg);
    },
    [live, startSession],
  );

  const orbState: OrbState = !live
    ? connecting || conn
      ? "connecting"
      : "idle"
    : agentState === "listening"
      ? !micAvailable
        ? "muted"
        : micMuted
          ? "paused" // waiting for the driver, but their mic is off
          : "listening"
      : agentState === "thinking"
          ? "thinking"
          : agentState === "speaking"
            ? "speaking"
            : "connecting";

  useThinkingSound(orbState === "thinking");

  // ---------------------------------------------------------------- agent → UI
  const onUiEvent = useCallback(
    (evt: UiEvent) => {
      const ctl = mapRef.current;
      if (evt.type === "places") {
        setWeather(null); // the dock shows the newest card only
        setResults({ title: evt.title ?? CATEGORY_TITLES[evt.category] ?? CATEGORY_TITLES.other, category: evt.category, places: evt.places });
        try {
          ctl?.showPlaces(evt.places, evt.category, locRef.current);
        } catch (e) {
          console.warn("map pins", e);
        }
        setMapView((v) => (v === "hidden" ? "card" : v));
      } else if (evt.type === "route") {
        setWeather(null);
        const c = evt.chosen;
        let path: LatLng[] = [];
        try {
          path = ctl?.showRoute(evt) ?? [];
        } catch (e) {
          console.warn("map route", e);
        }
        const traffic =
          c.traffic_delay_s == null ? "free-flow ETA" : c.traffic_delay_s > 60 ? `+${fmtDur(c.traffic_delay_s)} traffic` : "light traffic";
        setResults(null);
        setRoute({
          path,
          title: `${fmtDur(c.duration_s)} to ${evt.destination.name}`,
          sub: `${fmtDist(c.distance_m)} · ${c.summary || "fastest route"}`,
          eta: fmtDur(c.duration_s),
          distance: fmtDist(c.distance_m),
          detail: `To ${evt.destination.name} · ${c.summary || "fastest route"} · ${traffic}`,
        });
        setMapView((v) => (v === "hidden" ? "card" : v));
      } else if (evt.type === "weather") {
        setWeather(evt);
      } else if (evt.type === "clear_route") {
        ctl?.clearRoute();
        setRoute(null);
        setMapView("hidden");
      }
    },
    [refreshMap],
  );

  const clearResults = useCallback(() => {
    setResults(null);
    if (!route) setMapView("hidden");
    mapRef.current?.clearPlaces();
    mapRef.current?.setFit(route?.path ?? null);
  }, [route]);

  const clearRoute = useCallback(() => {
    if (live) void say("Cancel the route");
    mapRef.current?.clearRoute();
    mapRef.current?.setFit(null);
    setRoute(null);
    if (!results) setMapView("hidden");
  }, [live, say, results]);

  // Leaflet needs a resize once the card has finished growing / shrinking.
  useEffect(() => {
    if (mapView === "hidden") return;
    const t = setTimeout(refreshMap, 380);
    return () => clearTimeout(t);
  }, [mapView, results, route, refreshMap]);



  // ---------------------------------------------------------------- map card title
  const summary = useMemo(() => {
    if (results) return { title: results.title, sub: `${results.places.length} result${results.places.length === 1 ? "" : "s"}` };
    if (route) return { title: route.title, sub: route.sub };
    return { title: "Map", sub: "Your location" };
  }, [results, route]);

  // ---------------------------------------------------------------- compact layout
  // While cards are up, shrink the orb and centre it + the captions in the space that's actually free:
  // between the top (or the map card, when it's showing) and the top of the dock. Measured, not guessed,
  // so it holds on any screen and whether or not the map is available.
  const compact = mapView !== "hidden" || !!results || !!route || !!weather;
  const mapShown = mapReady && mapView === "card";
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const dock = dockRef.current;
    if (!stage || !dock || !compact) return;
    const place = () => {
      const stageTop = stage.offsetTop;
      const barSpace = 92; // matches --bar-space
      const natural = (stage.offsetHeight - barSpace) / 2; // the orb's resting centre
      const map = mapCardRef.current;
      const top = (mapShown && map ? map.offsetTop + map.offsetHeight : stageTop) - stageTop + 14;
      const bottom = dock.offsetTop + (dock.firstElementChild as HTMLElement | null)!.offsetTop - stageTop - 14;
      const captions = 84; // status line + two short caption lines
      const room = bottom - top;
      const scale = Math.max(0.36, Math.min(0.62, (room - captions - 14) / 208));
      const r = 104 * scale;
      const cy = top + Math.max(0, (room - (2 * r + 14 + captions)) / 2) + r;
      stage.style.setProperty("--orb-shift", `${Math.round(cy - natural)}px`);
      stage.style.setProperty("--orb-scale", scale.toFixed(3));
      stage.style.setProperty("--below-top", `${Math.round(cy + r + 14)}px`);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(stage);
    ro.observe(dock);
    if (mapCardRef.current) ro.observe(mapCardRef.current); // its height animates when expanding / shrinking
    return () => ro.disconnect();
  }, [compact, mapShown, results, route, weather, live, conn]);

  return (
    <div className="phone" ref={phoneRef} data-map={mapView}>
      {/* Floating map card: outside the room, which remounts its children on connect (Leaflet must keep its element). */}
      <section
        className="float-map"
        ref={mapCardRef}
        data-view={mapReady ? mapView : "hidden"}
        aria-hidden={!mapReady || mapView === "hidden"}
        aria-label="Map"
      >
        <div id="map" ref={mapElRef} />
        <div className="float-map-head">
          <div className="float-map-text">
            <div className="float-map-title">{summary.title}</div>
            <div className="float-map-sub">{summary.sub}</div>
          </div>
          <button
            className="icon-btn"
            aria-label={mapView === "expanded" ? "Shrink map" : "Expand map"}
            onClick={() => setMapView((v) => (v === "expanded" ? "card" : "expanded"))}
          >
            {mapView === "expanded" ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button className="icon-btn" aria-label="Close" onClick={results ? clearResults : clearRoute}>
            <X size={15} />
          </button>
        </div>
      </section>

      {/* The whole UI sits in the room (display: contents) so the call controls and captions can use its hooks. */}
      <LiveKitRoom
        serverUrl={conn?.url}
        token={conn?.token}
        connect={!!conn}
        audio
        onConnected={onConnected}
        onDisconnected={onDisconnected}
        onMediaDeviceFailure={onMediaDeviceFailure}
        onError={(e) => showToast(`Voice error: ${e.message}`, "danger")}
        className="room"
      >
        <TopBar ref={topbarRef} />

        {/* The orb, with the intro before a call and live captions during one. It shrinks while cards float in. */}
        <main className="stage" ref={stageRef} data-compact={compact || undefined}>
          {orbState === "idle" && <Hero onPrompt={(t) => void say(t)} />}
          <VoiceOrb ref={orbRef} state={orbState} onTap={onOrbTap} />
          <LiveCaptions state={orbState} compact={compact} />
        </main>

        {/* Bottom dock: notices, results and the route float in above the call bar, then go. */}
        <div className="dock" ref={dockRef}>
          {toast && (
            <div className={`toast ${toast.kind}`} key={toast.id} role="status">
              {toast.text}
              {toast.action && (
                <button
                  className="toast-action"
                  onClick={() => {
                    const { run } = toast.action!;
                    setToast(null);
                    run();
                  }}
                >
                  {toast.action.label}
                </button>
              )}
            </div>
          )}
          {weather && <WeatherCard weather={weather} onClose={() => setWeather(null)} />}
          {/* Weather sits on top of the route / results; closing it brings them back. */}
          {results && !weather && mapView !== "expanded" && (
            <ResultCards
              ref={cardsRef}
              places={results.places}
              onNavigate={(p) => void say(`Take me to ${p.name}, ${p.address ?? ""}`)}
              onFocus={(i) => mapRef.current?.focus(i)}
              scrollTo={pinFocus}
            />
          )}
          {route && !results && !weather && (
            <div className="route-card" ref={routeCardRef}>
              <div className="route-main">
                <div>
                  <div className="eta">
                    {route.eta}
                    <small>{route.distance}</small>
                  </div>
                  <div className="route-sub">{route.detail}</div>
                </div>
                <button className="icon-btn small" onClick={clearRoute} aria-label="Clear route">
                  <X size={14} />
                </button>
              </div>
            </div>
          )}
          <ConversationBar
            live={live}
            connecting={connecting || (!!conn && !live)}
            muted={micMuted}
            onToggleMute={() => setMicMuted((m) => !m)}
            onCall={() => void startSession()}
            onEnd={endSession}
            onSend={(t) => void say(t)}
          />
        </div>

        <SessionBridge
          loc={loc}
          micMuted={micMuted}
          micAvailable={micAvailable}
          onAgentState={setAgentState}
          onUiEvent={onUiEvent}
          onReady={onSessionReady}
        />
      </LiveKitRoom>
    </div>
  );
}
