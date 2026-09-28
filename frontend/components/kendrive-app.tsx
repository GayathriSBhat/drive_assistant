"use client";

import { LiveKitRoom } from "@livekit/components-react";
import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtDist, fmtDur } from "@/lib/format";
import { MapController } from "@/lib/map-controller";
import type { DrawerSnap, LatLng, Loc, OrbState, Place, UiEvent } from "@/lib/types";
import MapDrawer from "./map-drawer";
import ResultCards from "./result-cards";
import SessionBridge, { type SessionApi } from "./session-bridge";
import TopBar, { type LocMode } from "./top-bar";
import VoiceOrb from "./voice-orb";

// Demo locations. Dubai has no open live-parking feed; Singapore publishes live car-park availability.
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
}

function initialLocMode(): LocMode {
  const demo = new URLSearchParams(location.search).get("demo");
  if (demo !== null) return demo === "singapore" ? "singapore" : "dubai";
  return window.isSecureContext && "geolocation" in navigator ? "gps" : "dubai";
}

export default function KenDriveApp() {
  const phoneRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  const orbRef = useRef<HTMLButtonElement>(null);
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
  const [paused, setPaused] = useState(false);
  const [micAvailable, setMicAvailable] = useState(true);
  const [locMode, setLocMode] = useState<LocMode>(initialLocMode);
  const [trackedLoc, setTrackedLoc] = useState<Loc | null>(null); // from GPS or the drive simulator
  const [results, setResults] = useState<{ title: string; category: string; places: Place[] } | null>(null);
  const [route, setRoute] = useState<RouteState | null>(null);
  const [snap, setSnap] = useState<DrawerSnap>("hidden");
  const [flashKey, setFlashKey] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const [simulating, setSimulating] = useState(false);

  const loc: Loc | null = locMode === "dubai" || locMode === "singapore" ? DEMO[locMode] : trackedLoc;
  const locRef = useRef(loc);
  useEffect(() => {
    locRef.current = loc;
  }, [loc]);
  const liveRef = useRef(false);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  const showToast = useCallback((msg: string, kind: Toast["kind"] = "info") => {
    setToast({ text: msg, kind, id: Date.now() });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // ---------------------------------------------------------------- map
  useEffect(() => {
    if (!mapElRef.current) return;
    const ctl = new MapController(mapElRef.current, [DEMO.dubai.lat, DEMO.dubai.lng], () => {
      const overlay = cardsRef.current ?? routeCardRef.current;
      return overlay ? overlay.offsetHeight + 8 : 0;
    });
    mapRef.current = ctl;
    return () => {
      ctl.destroy();
      mapRef.current = null;
    };
  }, []);

  const refreshMap = useCallback(() => mapRef.current?.refresh(locRef.current), []);

  // ---------------------------------------------------------------- location (GPS or demo)
  useEffect(() => {
    if (locMode === "sim") return; // the simulator drives the location
    if (locMode !== "gps") {
      mapRef.current?.setMe(DEMO[locMode], true);
      return;
    }
    let gotFix = false;
    const fallback = setTimeout(() => {
      if (!gotFix) {
        showToast("Couldn't get GPS — using the Dubai demo location.");
        setLocMode("dubai");
      }
    }, 8000);
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
        if (!gotFix) {
          showToast("Location blocked — using the Dubai demo location.");
          setLocMode("dubai");
        }
      },
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
    return () => {
      clearTimeout(fallback);
      navigator.geolocation.clearWatch(id);
    };
  }, [locMode, showToast]);

  const where = `Driving tracker · ${locMode === "gps" ? "live GPS" : locMode === "sim" ? "simulated drive" : DEMO[locMode].label}`;

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
      showToast(`Couldn't start voice: ${(e as Error).message}`, "danger");
      setConnecting(false);
    }
  }, [conn, connecting, showToast]);

  const endSession = useCallback(() => setConn(null), []);
  const onSessionReady = useCallback((api: SessionApi) => {
    apiRef.current = api;
  }, []);

  const onConnected = useCallback(() => {
    setLive(true);
    setConnecting(false);
  }, []);
  const onDisconnected = useCallback(() => {
    if (liveRef.current) showToast("Session ended. Tap KenDrive to start again.");
    setLive(false);
    setConn(null);
    setConnecting(false);
    setPaused(false);
    setAgentState("idle");
  }, [showToast]);
  const onMediaDeviceFailure = useCallback(() => {
    setMicAvailable(false);
    showToast("Microphone unavailable — you can type instead.");
  }, [showToast]);

  // Tap the orb: start a session, then pause / resume it.
  const onOrbTap = useCallback(() => {
    if (connecting) return;
    if (live) setPaused((p) => !p);
    else void startSession();
  }, [connecting, live, startSession]);

  // M key = mute / unmute (keyboard shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "m" && e.key !== "M") return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (live) setPaused((p) => !p);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live]);

  const say = useCallback(
    async (msg: string) => {
      if (!msg.trim()) return;
      setPaused(false);
      if (!live) await startSession();
      await apiRef.current?.sendText(msg);
    },
    [live, startSession],
  );

  const orbState: OrbState = !live
    ? connecting || conn
      ? "connecting"
      : "idle"
    : paused
      ? "paused"
      : agentState === "listening"
        ? micAvailable
          ? "listening"
          : "muted"
        : agentState === "thinking"
          ? "thinking"
          : agentState === "speaking"
            ? "speaking"
            : "connecting";

  // ---------------------------------------------------------------- agent → UI
  const onUiEvent = useCallback(
    (evt: UiEvent) => {
      const ctl = mapRef.current;
      if (evt.type === "places") {
        setResults({ title: evt.title ?? CATEGORY_TITLES[evt.category] ?? CATEGORY_TITLES.other, category: evt.category, places: evt.places });
        ctl?.showPlaces(evt.places, evt.category, locRef.current);
        setSnap("full");
        setFlashKey((k) => k + 1);
        setTimeout(refreshMap, 60);
      } else if (evt.type === "route") {
        const c = evt.chosen;
        const path = ctl?.showRoute(evt) ?? [];
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
        setSnap("full");
        setFlashKey((k) => k + 1);
        setTimeout(refreshMap, 60);
      } else if (evt.type === "clear_route") {
        ctl?.clearRoute();
        setRoute(null);
        setSnap("hidden");
      }
    },
    [refreshMap],
  );

  const clearResults = useCallback(() => {
    setResults(null);
    setSnap("hidden");
    mapRef.current?.clearPlaces();
    mapRef.current?.setFit(route?.path ?? null);
    setTimeout(refreshMap, 60);
  }, [route, refreshMap]);

  const clearRoute = useCallback(() => {
    if (live) void say("Cancel the route");
    mapRef.current?.clearRoute();
    mapRef.current?.setFit(null);
    setRoute(null);
    setSnap("hidden");
  }, [live, say]);

  // Navigate buttons inside Leaflet popups.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const go = (e.target as HTMLElement).closest<HTMLElement>("button[data-go]");
      if (!go) return;
      mapRef.current?.map.closePopup();
      void say(`Take me to ${go.dataset.go}`);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [say]);

  // ---------------------------------------------------------------- drive simulation (demo)
  const simTimer = useRef<ReturnType<typeof setInterval>>(undefined);
  const stopSim = useCallback(() => {
    clearInterval(simTimer.current);
    simTimer.current = undefined;
    setSimulating(false);
  }, []);
  const startSim = useCallback(() => {
    if (!route?.path.length) return;
    if (simTimer.current) return stopSim();
    setLocMode("sim");
    setSimulating(true);
    const path = route.path;
    let i = 0;
    let t = 0;
    const STEP_M = 60; // ~60 m per tick ≈ fast-forwarded city driving
    const dist = (a: LatLng, b: LatLng) => Math.hypot((b[0] - a[0]) * 111_320, (b[1] - a[1]) * 111_320 * Math.cos((a[0] * Math.PI) / 180));
    simTimer.current = setInterval(() => {
      if (i >= path.length - 1) return stopSim();
      t += STEP_M / (dist(path[i], path[i + 1]) || 1);
      while (t >= 1 && i < path.length - 1) {
        t -= 1;
        i++;
      }
      const a = path[i];
      const b = path[Math.min(i + 1, path.length - 1)];
      const lat = a[0] + (b[0] - a[0]) * t;
      const lng = a[1] + (b[1] - a[1]) * t;
      const heading = ((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 360) % 360;
      const next = { lat, lng, heading };
      setTrackedLoc(next);
      mapRef.current?.setMe(next);
      mapRef.current?.panTo(next);
    }, 700);
  }, [route, stopSim]);
  useEffect(() => stopSim, [stopSim]);

  // ---------------------------------------------------------------- drawer summary
  const summary = useMemo(() => {
    if (results) return { title: results.title, sub: `${results.places.length} result${results.places.length === 1 ? "" : "s"}` };
    if (route) return { title: route.title, sub: route.sub };
    return { title: "Map", sub: "Your location" };
  }, [results, route]);

  return (
    <div className="phone" ref={phoneRef} data-drawer={snap}>
      <TopBar
        ref={topbarRef}
        where={where}
        conn={live ? "live" : connecting || conn ? "connecting" : "offline"}
        locMode={locMode}
        onLocMode={(m) => {
          stopSim();
          setLocMode(m);
        }}
        canSimulate={!!route}
        simulating={simulating}
        onSimulate={startSim}
        onRecenter={() => loc && mapRef.current?.setMe(loc, true)}
        canEnd={live}
        onEnd={endSession}

      />

      {/* Lower layer: only the orb. It never moves or resizes; the drawer slides over it. */}
      <main className="stage">
        <VoiceOrb ref={orbRef} state={orbState} onTap={onOrbTap} />
      </main>

      {/* Upper layer: everything else. */}
      <MapDrawer
        snap={snap}
        onSnap={setSnap}
        onSettled={refreshMap}
        flashKey={flashKey}
        phoneRef={phoneRef}
        topbarRef={topbarRef}
        orbRef={orbRef}
        body={
          <>
            <div id="map" ref={mapElRef} aria-label="Map" />
            {snap !== "hidden" && (
              <div className="map-overlay-header">
                <div className="map-overlay-text">
                  <div className="map-overlay-title">{summary.title}</div>
                  <div className="map-overlay-sub">{summary.sub}</div>
                </div>
                <button
                  className="map-overlay-close icon-btn"
                  aria-label="Close map"
                  onClick={results ? clearResults : clearRoute}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {results && (
              <ResultCards
                ref={cardsRef}
                places={results.places}
                onNavigate={(p) => void say(`Take me to ${p.name}, ${p.address ?? ""}`)}
                onFocus={(i) => mapRef.current?.focus(i)}
              />
            )}
            {route && !results && (
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
                    ✕
                  </button>
                </div>
              </div>
            )}
          </>
        }
        sheet={null}
      />

      {toast && (
        <div className={`toast ${toast.kind}`} key={toast.id} role="status">
          {toast.text}
        </div>
      )}

      {/* Voice session (no visible UI of its own). */}
      <LiveKitRoom
        serverUrl={conn?.url}
        token={conn?.token}
        connect={!!conn}
        audio
        onConnected={onConnected}
        onDisconnected={onDisconnected}
        onMediaDeviceFailure={onMediaDeviceFailure}
        onError={(e) => showToast(`Voice error: ${e.message}`, "danger")}
        style={{ display: "none" }}
      >
        <SessionBridge
          loc={loc}
          paused={paused}
          micAvailable={micAvailable}
          onAgentState={setAgentState}
          onUiEvent={onUiEvent}
          onReady={onSessionReady}
        />
      </LiveKitRoom>
    </div>
  );
}
