import {
  Room,
  RoomEvent,
  Track,
  ParticipantKind,
} from "https://cdn.jsdelivr.net/npm/livekit-client@2.22.3/dist/livekit-client.esm.mjs";
import { createPersona } from "./persona.js";

const $ = (id) => document.getElementById(id);
const DEMO_LOCATION = { lat: 25.1972, lng: 55.2744, heading: null }; // Downtown Dubai (Burj Khalifa)
const CATEGORY_COLORS = {
  fuel: "#ffb020", ev_charging: "#3ecf8e", restaurant: "#ff7a45", hospital: "#ff4f6d",
  parking: "#4f9dff", atm: "#8a7dff", pharmacy: "#33d6c2", car_repair: "#9aa5b1", other: "#4f9dff",
};

// ------------------------------------------------------------------ state
const state = {
  room: null,
  connecting: false,
  micOn: false,
  loc: null, // {lat, lng, heading}
  demo: false,
  geoWatch: null,
  route: null, // decoded chosen route [[lat,lng],...]
  simTimer: null,
  pickMode: false,
  reportLoc: null, // override location for the report being composed
  lastAttrSent: 0,
};

// ------------------------------------------------------------------ map
const map = L.map("map", { zoomControl: false, attributionControl: true }).setView(
  [DEMO_LOCATION.lat, DEMO_LOCATION.lng], 14,
);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  className: "dark-tiles",
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Places © Google',
}).addTo(map);

const layers = {
  me: L.marker([0, 0], { icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18] }), zIndexOffset: 1000 }),
  places: L.layerGroup().addTo(map),
  route: L.layerGroup().addTo(map),
  reports: L.layerGroup().addTo(map),
};
const reportMarkers = new Map();

function decodePolyline(str) {
  const out = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d; else lng += d;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

const fmtDist = (m) => (m == null ? "" : m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const fmtDur = (s) => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ago = (t) => { const m = Math.round((Date.now() / 1000 - t) / 60); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

// ------------------------------------------------------------------ map drawer (peek ↔ half ↔ full)
let lastFit = null;
const drawer = $("drawer");
const PEEK_H = 76;
const drawerSnap = () => drawer.dataset.snap;

// Height available to the drawer: everything between the header and the quick-action bar.
function drawerHeights() {
  const avail = $("phone").clientHeight - document.querySelector(".topbar").offsetHeight - $("sheet").offsetHeight;
  return { peek: PEEK_H, half: Math.round(avail * 0.55), full: avail };
}

function fitTo(latlngs) {
  lastFit = latlngs;
  if (drawerSnap() === "peek") return; // re-framed when the drawer opens
  const routeH = $("route-card").hidden ? 0 : $("route-card").offsetHeight + 8;
  map.fitBounds(L.latLngBounds(latlngs), { paddingTopLeft: [16, 16], paddingBottomRight: [16, routeH + 16], maxZoom: 16 });
}

function refreshMap() {
  map.invalidateSize();
  if (lastFit) fitTo(lastFit);
  else if (state.loc) map.setView([state.loc.lat, state.loc.lng]);
}

function setDrawer(snap) {
  drawer.dataset.snap = snap;
  drawer.style.setProperty("--drawer-h", `${drawerHeights()[snap]}px`);
  $("drawer-grip").setAttribute("aria-expanded", String(snap !== "peek"));
  $("drawer-grip").setAttribute("aria-label", snap === "peek" ? "Show map" : "Hide map");
  setTimeout(refreshMap, 340); // after the height transition
}

// Keep the drawer anchored above the quick-action bar and its snap heights in sync with the screen.
new ResizeObserver(() => {
  $("phone").style.setProperty("--sheet-h", `${$("sheet").offsetHeight}px`);
  $("phone").style.setProperty("--topbar-h", `${document.querySelector(".topbar").offsetHeight}px`);
  $("phone").style.setProperty("--drawer-peek", `${PEEK_H}px`);
  drawer.style.setProperty("--drawer-h", `${drawerHeights()[drawerSnap()]}px`);
}).observe($("phone"));

// Drag the grip to resize; release snaps to the nearest height (a quick flick goes one step).
(function drawerGestures() {
  const grip = $("drawer-grip");
  let startY = 0, startH = 0, lastY = 0, lastT = 0, velocity = 0, moved = false, dragging = false;
  grip.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    dragging = true; moved = false;
    startY = lastY = e.clientY; lastT = performance.now(); velocity = 0;
    startH = drawer.getBoundingClientRect().height;
    grip.setPointerCapture(e.pointerId);
    drawer.classList.add("dragging");
  });
  grip.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    if (Math.abs(dy) > 4) moved = true;
    const { peek, full } = drawerHeights();
    drawer.style.setProperty("--drawer-h", `${Math.max(peek, Math.min(full, startH + dy))}px`);
    const now = performance.now();
    velocity = (lastY - e.clientY) / Math.max(1, now - lastT); // px/ms, positive = upwards
    lastY = e.clientY; lastT = now;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    drawer.classList.remove("dragging");
    const order = ["peek", "half", "full"];
    const heights = drawerHeights();
    if (!moved) {
      // Tap: peek → half, anything open → peek.
      return setDrawer(drawerSnap() === "peek" ? "half" : "peek");
    }
    const h = drawer.getBoundingClientRect().height;
    let snap = order.reduce((best, k) => (Math.abs(heights[k] - h) < Math.abs(heights[best] - h) ? k : best), "peek");
    if (Math.abs(velocity) > 0.5) {
      const i = order.indexOf(drawerSnap());
      snap = order[Math.max(0, Math.min(2, i + (velocity > 0 ? 1 : -1)))];
    }
    setDrawer(snap);
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
  grip.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDrawer(drawerSnap() === "peek" ? "half" : "peek"); }
    if (e.key === "ArrowUp") setDrawer(drawerSnap() === "peek" ? "half" : "full");
    if (e.key === "ArrowDown") setDrawer(drawerSnap() === "full" ? "half" : "peek");
  });
})();

function setDrawerSummary(title, sub) {
  $("drawer-title").textContent = title;
  $("drawer-sub").textContent = sub;
}

// New results on the map: flash the drawer so the driver knows there's something to look at.
function mapUpdated() {
  drawer.classList.remove("flash");
  void drawer.offsetWidth;
  drawer.classList.add("flash");
}

// ------------------------------------------------------------------ location
function setLocation(loc, { center = false } = {}) {
  state.loc = loc;
  layers.me.setLatLng([loc.lat, loc.lng]);
  if (!map.hasLayer(layers.me)) layers.me.addTo(map);
  if (center) map.setView([loc.lat, loc.lng], 15);
  pushLocationAttrs();
}

async function pushLocationAttrs(force = false) {
  const p = state.room?.localParticipant;
  if (!p || !state.loc) return;
  const now = Date.now();
  if (!force && now - state.lastAttrSent < 2000) return;
  state.lastAttrSent = now;
  try {
    await p.setAttributes({
      lat: state.loc.lat.toFixed(6),
      lng: state.loc.lng.toFixed(6),
      heading: state.loc.heading == null ? "" : String(Math.round(state.loc.heading)),
    });
  } catch (e) { console.warn("setAttributes", e); }
}

let whereTimer;
function updateWhereLabel() {
  clearTimeout(whereTimer);
  whereTimer = setTimeout(() => {
    $("where").textContent = state.demo ? "Driving tracker · Dubai demo" : "Driving tracker · live GPS";
  }, 300);
}

function useDemo(on) {
  state.demo = on;
  $("demo-loc").checked = on;
  if (on) {
    if (state.geoWatch != null) navigator.geolocation.clearWatch(state.geoWatch);
    state.geoWatch = null;
    setLocation({ ...DEMO_LOCATION }, { center: true });
  } else startGeolocation();
  updateWhereLabel();
}

function startGeolocation() {
  if (!("geolocation" in navigator)) return useDemo(true);
  let gotFix = false;
  const fallback = setTimeout(() => { if (!gotFix) { toast("Couldn't get GPS — using demo location.", "info"); useDemo(true); } }, 8000);
  state.geoWatch = navigator.geolocation.watchPosition(
    (pos) => {
      if (state.demo || state.simTimer) return;
      const first = !gotFix;
      gotFix = true;
      clearTimeout(fallback);
      const { latitude: lat, longitude: lng, heading } = pos.coords;
      setLocation({ lat, lng, heading: Number.isFinite(heading) ? heading : null }, { center: first });
      updateWhereLabel();
    },
    () => { clearTimeout(fallback); if (!gotFix) { toast("Location blocked — using demo location.", "info"); useDemo(true); } },
    { enableHighAccuracy: true, maximumAge: 5000 },
  );
}

// ------------------------------------------------------------------ orb + audio levels
const orb = $("orb");
const miniOrb = $("mini-orb");
// Orb state as spoken by screen readers / shown on hover (no text is drawn around the orb).
const LABELS = {
  idle: "Tap to start",
  connecting: "Connecting...",
  listening: "Listening...",
  thinking: "Thinking...",
  speaking: "Speaking...",
  muted: "Mic unavailable — type below",
  paused: "Paused · tap to resume",
};
// UI state → AI Elements Persona state (idle | listening | thinking | speaking | asleep).
// ("asleep" renders as a near-black orb, invisible on this dark UI, so idle/paused use "idle".)
const PERSONA_STATE = {
  idle: "idle",
  connecting: "thinking",
  listening: "listening",
  thinking: "thinking",
  speaking: "speaking",
  muted: "idle",
  paused: "idle",
};
// KenDrive blue (Tailwind blue-400, the brighter tint reads better on the dark UI).
const PERSONA_BLUE = [96, 165, 250];
let agentState = "idle";

let audioCtx, agentAnalyser, micAnalyser;
function analyserFor(mediaStreamTrack) {
  audioCtx ??= new AudioContext();
  const src = audioCtx.createMediaStreamSource(new MediaStream([mediaStreamTrack]));
  const an = audioCtx.createAnalyser();
  an.fftSize = 256;
  src.connect(an);
  return an;
}
const buf = new Uint8Array(128);
function level(an) {
  if (!an) return 0;
  an.getByteTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += ((v - 128) / 128) ** 2;
  return Math.min(1, Math.sqrt(sum / buf.length) * 4);
}

const orbs = [
  createPersona($("orb-gl"), { variant: "obsidian", color: PERSONA_BLUE }),
  createPersona($("mini-orb-gl"), { variant: "obsidian", color: PERSONA_BLUE }),
];

function setOrb(s) {
  agentState = s;
  const shown = !state.room ? (state.connecting ? "connecting" : "idle") : state.paused ? "paused" : !state.micOn && s === "listening" ? "muted" : s === "initializing" ? "connecting" : s;
  orb.dataset.state = miniOrb.dataset.state = shown;
  const label = `KenDrive: ${LABELS[shown] ?? shown}`;
  for (const b of [orb, miniOrb]) { b.setAttribute("aria-label", label); b.title = label; }
  for (const o of orbs) o.setState(PERSONA_STATE[shown] ?? "idle");
}

// ------------------------------------------------------------------ LiveKit
async function connect() {
  if (state.room || state.connecting) return;
  state.connecting = true;
  setConn("connecting");
  setOrb("idle");
  try {
    const res = await fetch("/api/token?name=Driver");
    if (!res.ok) throw new Error(await res.text());
    const { url, token } = await res.json();
    const room = new Room({ adaptiveStream: true, dynacast: true });

    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach();
      el.dataset.lk = participant.identity;
      el.muted = state.paused;
      document.body.appendChild(el);
      agentAnalyser = analyserFor(track.mediaStreamTrack);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()));
    room.on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
      if (participant.kind !== ParticipantKind.AGENT) return;
      if (changed["lk.agent.state"]) {
        clearTimeout(agentTimer);
        if (changed["lk.agent.state"] === "listening") agentHasListened = true;
        setOrb(changed["lk.agent.state"]);
      }
      if (changed["kendrive.error"] === "missing_gemini_key") {
        clearTimeout(agentTimer);
        agentProblem("The voice agent has no Gemini API key. Add GOOGLE_API_KEY to .env and restart ./run.sh.");
      }
    });
    room.on(RoomEvent.ParticipantDisconnected, (p) => { if (p.kind === ParticipantKind.AGENT) showNotice("KenDrive left the session."); });
    room.on(RoomEvent.Disconnected, () => teardown());
    room.on(RoomEvent.LocalTrackPublished, (pub) => {
      if (pub.kind === Track.Kind.Audio && pub.track) micAnalyser = analyserFor(pub.track.mediaStreamTrack);
    });

    room.registerTextStreamHandler("lk.transcription", handleTranscription);
    room.registerTextStreamHandler("ui.event", async (reader) => {
      try { handleUiEvent(JSON.parse(await reader.readAll())); } catch (e) { console.error("ui.event", e); }
    });

    await room.connect(url, token);
    state.room = room;
    agentTimer = setTimeout(
      () => agentProblem("KenDrive didn't join. Check that the agent is running (./run.sh) and see its logs."),
      15000,
    );
    await audioCtx?.resume();
    await pushLocationAttrs(true);
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      state.micOn = state.micAvailable = true;
    } catch (e) {
      toast("Microphone unavailable — you can type instead.", "info");
    }
    setConn("live");
    setOrb("initializing");
    $("hangup-btn").disabled = false;
  } catch (e) {
    console.error(e);
    toast(`Couldn't start voice: ${e.message}`, "info");
    setConn("offline");
  } finally {
    state.connecting = false;
    setOrb(agentState);
  }
}

let agentTimer;
function agentProblem(msg) {
  toast(esc(msg), "danger");
  showNotice(msg);
  state.room?.disconnect();
}

function teardown() {
  state.paused = false;
  state.micAvailable = false;
  if (state.room) showNotice("Session ended. Tap KenDrive to start again.");
  clearTimeout(agentTimer);
  agentHasListened = false;
  document.querySelectorAll("audio[data-lk]").forEach((el) => el.remove());
  state.room = null;
  state.micOn = false;
  agentAnalyser = micAnalyser = null;
  setConn("offline");
  setOrb("idle");
  $("hangup-btn").disabled = true;
}

function setConn(s) {
  const pill = $("conn");
  pill.className = `pill ${s}`;
  pill.querySelector("b").textContent = { live: "Live", connecting: "Connecting", offline: "Offline" }[s];
}

// Pause keeps the session (and KenDrive's context) alive but stops the mic and silences KenDrive.
async function togglePause(force) {
  if (!state.room) return;
  state.paused = force ?? !state.paused;
  document.querySelectorAll("audio[data-lk]").forEach((a) => (a.muted = state.paused));
  if (state.micAvailable) {
    try { await state.room.localParticipant.setMicrophoneEnabled(!state.paused); } catch (e) { console.warn(e); }
    state.micOn = !state.paused;
  }
  setOrb(agentState);
}


// The orb is the only voice control (like apurva-livekit's persona): tap to start a session,
// then tap to pause / resume it. "End voice session" in the ⋯ menu ends it.
async function orbTap() {
  if (state.connecting) return;
  if (state.room) await togglePause();
  else await connect();
}

// Gemini Live drops text that arrives mid-greeting, so wait until the agent has listened once.
let agentHasListened = false;
const agentReady = () => agentHasListened;

// Text sent before the agent has joined would reach nobody, so wait for it (up to 20 s).
async function waitForAgent() {
  for (let i = 0; i < 80 && state.room && !agentReady(); i++) await new Promise((r) => setTimeout(r, 250));
  return state.room && agentReady();
}

async function say(text) {
  if (!text.trim()) return;
  if (!state.room) await connect();
  if (!state.room) return;
  if (state.paused) await togglePause(false);
  if (!(await waitForAgent())) return;
  await state.room.localParticipant.sendText(text, { topic: "lk.chat" });
}

// ------------------------------------------------------------------ transcriptions
// Transcripts are not displayed. The streams still have to be read so LiveKit can release them.
async function handleTranscription(reader) {
  for await (const _ of reader); // eslint-disable-line no-unused-vars
}

// Short notices (session ended, KenDrive left…) use the toast at the top, keeping the centre clear.
function showNotice(msg) {
  toast(esc(msg), "info");
}


// ------------------------------------------------------------------ UI events from the agent
function handleUiEvent(evt) {
  switch (evt.type) {
    case "places": return showPlaces(evt.places, evt.category, evt.title);
    case "route": return showRoute(evt);
    case "clear_route": return clearRoute();
    case "focus_reports": {
      const pts = [...reportMarkers.values()].map((m) => m.getLatLng());
      if (state.loc) pts.push(L.latLng(state.loc.lat, state.loc.lng));
      if (pts.length > 1 && !state.route) fitTo(pts);
      return;
    }
  }
}

const CATEGORY_TITLES = {
  fuel: "Nearest petrol bunks", ev_charging: "EV charging nearby", restaurant: "Restaurants nearby",
  hospital: "Nearest hospitals", parking: "Parking nearby", atm: "ATMs nearby", pharmacy: "Pharmacies nearby",
  car_repair: "Mechanics nearby", other: "Places nearby",
};
const EVIDENCE_LABELS = { on_menu: "On the menu", reviewed: "Loved in reviews", likely: "Likely serves it" };
const QUOTE_SOURCES = { review: "Google review", menu: "Menu (web)", summary: "Google review summary" };
const placeMarkers = [];
const cleanName = (name) => name.split(/\s[|\-–—]\s/)[0];

function showPlaces(places, category, title) {
  layers.places.clearLayers();
  placeMarkers.length = 0;
  const color = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.other;
  places.forEach((p, i) => {
    if (p.lat == null) return;
    const m = L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: "", html: `<div class="place-pin" style="background:${color}"><span>${i + 1}</span></div>`, iconSize: [28, 28], iconAnchor: [14, 28] }),
    });
    const open = p.open_now == null ? "" : p.open_now ? ' · <span style="color:var(--ok)">Open</span>' : ' · <span style="color:var(--danger)">Closed</span>';
    m.bindPopup(`
      <h3>${esc(p.name)}</h3>
      <div class="muted">${esc(p.address)}</div>
      <div class="muted">${fmtDist(p.distance_m)}${p.rating ? ` · ★ ${p.rating}` : ""}${open}</div>
      ${p.maps_url ? `<div class="muted" style="margin-top:4px"><a href="${esc(p.maps_url)}" target="_blank" rel="noopener">View on Google Maps</a></div>` : ""}
      <div class="row"><button class="go" data-go="${esc(p.name)}, ${esc(p.address)}">Navigate</button></div>`);
    layers.places.addLayer(m);
    placeMarkers[i] = m;
  });
  showCards(places, title ?? CATEGORY_TITLES[category] ?? CATEGORY_TITLES.other);
  if (!state.route) setDrawerSummary(title ?? CATEGORY_TITLES[category] ?? CATEGORY_TITLES.other, `${places.length} on the map · tap to view`);
  const pts = places.filter((p) => p.lat != null).map((p) => [p.lat, p.lng]);
  if (state.loc) pts.push([state.loc.lat, state.loc.lng]);
  if (pts.length) setTimeout(() => { map.invalidateSize(); fitTo(pts); }, 320);
  mapUpdated();
}

// ------------------------------------------------------------------ card view
// Mirrors AppSheet's card view "Large" layout: main image, header badge, title, subtitle,
// description and action blocks.
function showCards(places, title) {
  $("cards-title").textContent = title;
  $("cards-rail").innerHTML = places.map((p, i) => {
    const photo = p.photo ? `<img src="/api/place-photo?name=${encodeURIComponent(p.photo)}" alt="" loading="${i < 2 ? "eager" : "lazy"}" onerror="this.remove()" /><span class="credit">Photo · Google Maps</span>` : "";
    const open = p.open_now == null ? "" : p.open_now ? ' · <span class="open">Open</span>' : ' · <span class="closed">Closed</span>';
    const rating = p.rating ? `★ ${p.rating}${p.ratings ? ` (${p.ratings.toLocaleString()})` : ""} · ` : "";
    // Where it is, relative to what the driver cares about: drive time (EV), or distance (everything else).
    const where = p.drive_min != null
      ? `${p.drive_min} min drive${p.detour_min != null ? ` · +${p.detour_min} min detour` : ""}`
      : p.walk_min != null ? `${fmtDist(p.distance_m)} from destination` : fmtDist(p.distance_m);
    // Top-right badge: dish evidence, charger availability, or parking walk time.
    const badge = p.badge ?? (EVIDENCE_LABELS[p.evidence] ? { text: EVIDENCE_LABELS[p.evidence], tone: p.evidence } : null);
    const tags = (p.tags ?? []).slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
    const desc = p.quote
      ? `<div class="card-desc">“${esc(p.quote)}”</div><div class="card-cite">— ${esc(p.quote_author ? `${p.quote_author}, ` : "")}${esc(QUOTE_SOURCES[p.quote_source] ?? "Google Maps")}</div>`
      : `<div class="card-desc">${esc(p.address ?? "")}</div>`;
    return `
      <article class="card${i === 0 ? " top" : ""}" data-idx="${i}">
        <div class="card-media">
          ${photo}
          <span class="card-badge${i === 0 ? " top" : ""}">${i === 0 ? "Top pick" : `#${i + 1}`}</span>
          ${badge ? `<span class="card-evidence ${esc(badge.tone)}">${esc(badge.text)}</span>` : ""}
        </div>
        <div class="card-body">
          <div class="card-title">${esc(cleanName(p.name))}</div>
          <div class="card-sub">${rating}${where}${open}</div>
          ${tags ? `<div class="card-tags">${tags}</div>` : ""}
          ${tags && !p.quote ? "" : desc}
        </div>
        <div class="card-actions">
          <button class="go" data-go="${esc(p.name)}, ${esc(p.address ?? "")}">Navigate</button>
          ${p.maps_url ? `<a href="${esc(p.maps_url)}" target="_blank" rel="noopener">Maps</a>` : ""}
          ${p.phone ? `<a href="tel:${esc(p.phone.replace(/\s+/g, ""))}">Call</a>` : ""}
        </div>
      </article>`;
  }).join("");
  $("cards-rail").scrollLeft = 0;
  $("phone").classList.add("has-cards");
}

function hideCards() {
  $("phone").classList.remove("has-cards");
  setTimeout(() => map.invalidateSize(), 320);
}

// Tapping a card (outside its buttons) shows that place on the map.
$("cards-rail").addEventListener("click", (e) => {
  if (e.target.closest("button, a")) return;
  const card = e.target.closest(".card");
  const m = card && placeMarkers[Number(card.dataset.idx)];
  if (!m) return;
  const show = () => { map.setView(m.getLatLng(), Math.max(map.getZoom(), 15)); m.openPopup(); };
  if (drawerSnap() === "peek") { setDrawer("half"); setTimeout(show, 400); } else show();
});
$("cards-close").addEventListener("click", hideCards);

function showRoute(evt) {
  layers.route.clearLayers();
  for (const alt of evt.alternatives) {
    L.polyline(decodePolyline(alt.polyline), { color: "#5b6677", weight: 5, opacity: 0.7 }).addTo(layers.route);
  }
  hideCards();
  const path = decodePolyline(evt.chosen.polyline);
  state.route = path;
  L.polyline(path, { color: "#0b0f14", weight: 10, opacity: 0.9 }).addTo(layers.route);
  L.polyline(path, { color: "#4f9dff", weight: 6 }).addTo(layers.route);
  const d = evt.destination;
  L.marker([d.lat, d.lng], { icon: L.divIcon({ className: "", html: '<div class="dest-pin"></div>', iconSize: [16, 16] }) })
    .bindPopup(`<h3>${esc(d.name)}</h3><div class="muted">${esc(d.address)}</div>`).addTo(layers.route);
  layers.places.clearLayers();

  const c = evt.chosen;
  $("route-eta").innerHTML = `${fmtDur(c.duration_s)}<small>${fmtDist(c.distance_m)}</small>`;
  const traffic = c.traffic_delay_s == null ? "free-flow ETA" : c.traffic_delay_s > 60 ? `+${fmtDur(c.traffic_delay_s)} traffic` : "light traffic";
  $("route-sub").textContent = `To ${d.name} · ${c.summary || "fastest route"} · ${traffic}`;
  const avoided = evt.blocked ?? [];
  $("route-avoided").hidden = !avoided.length;
  $("route-avoided").innerHTML = avoided.length
    ? `<span>⚠</span><span>Avoiding ${avoided.map((r) => `<b>${esc(r.summary)}</b>${r.locality ? ` near ${esc(r.locality)}` : ""}`).join("; ")} — reported by drivers.</span>`
    : "";
  $("route-card").hidden = false;
  $("sim-btn").disabled = false;
  setDrawerSummary(`${fmtDur(c.duration_s)} to ${d.name}`, `${fmtDist(c.distance_m)} · ${c.summary || "fastest route"}`);
  if (drawerSnap() === "peek") setDrawer("half"); // a new route is worth a glance
  mapUpdated();
  setTimeout(() => fitTo(path), 60); // after the route card has grown the sheet
}

function clearRoute() {
  layers.route.clearLayers();
  lastFit = null;
  setDrawerSummary("Map", "Your location");
  state.route = null;
  stopSim();
  $("route-card").hidden = true;
  $("sim-btn").disabled = true;
  mapUpdated();
}

// ------------------------------------------------------------------ drive simulation (demo)
function stopSim() {
  clearInterval(state.simTimer);
  state.simTimer = null;
  $("sim-btn").textContent = "▶ Simulate drive along route";
}

function startSim() {
  if (!state.route) return;
  if (state.simTimer) return stopSim();
  state.demo = true;
  $("demo-loc").checked = true;
  if (state.geoWatch != null) navigator.geolocation.clearWatch(state.geoWatch);
  const path = state.route;
  let i = 0, t = 0;
  const STEP_M = 60; // ~ 60 m per tick ≈ fast-forwarded city driving
  state.simTimer = setInterval(() => {
    if (i >= path.length - 1) { stopSim(); return; }
    const a = L.latLng(path[i]), b = L.latLng(path[i + 1]);
    const segLen = a.distanceTo(b) || 1;
    t += STEP_M / segLen;
    while (t >= 1 && i < path.length - 1) { t -= 1; i++; }
    const p = i >= path.length - 1 ? L.latLng(path.at(-1)) : L.latLng(path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t);
    const heading = (Math.atan2(b.lng - a.lng, b.lat - a.lat) * 180) / Math.PI;
    setLocation({ lat: p.lat, lng: p.lng, heading: (heading + 360) % 360 });
    map.panTo(p, { animate: true });
  }, 700);
  $("sim-btn").textContent = "■ Stop simulation";
  $("where").textContent = "Driving tracker · simulated drive";
}

// ------------------------------------------------------------------ crowd reports (shared by all users)
const SEV_ICON = { high: "!", medium: "!", low: "·" };
function upsertReport(r) {
  reportMarkers.get(r.id)?.remove();
  const m = L.marker([r.lat, r.lng], {
    icon: L.divIcon({ className: "", html: `<div class="report-pin ${esc(r.severity)}">${SEV_ICON[r.severity] ?? "!"}</div>`, iconSize: [34, 34] }),
    zIndexOffset: 500,
  });
  const verified = r.ai_verified === true ? " · ✓ photo checked by Gemini" : r.ai_verified === false ? " · photo unverified" : "";
  m.bindPopup(`
    <h3>${esc(r.summary)}</h3>
    <div class="muted">${esc(r.locality || "Reported location")} · ${ago(r.created_at)}</div>
    ${r.photo_url ? `<img src="${esc(r.photo_url)}" alt="Reported road photo" />` : ""}
    ${r.note && r.note !== r.summary ? `<div>${esc(r.note)}</div>` : ""}
    <div class="muted">${r.confirms} driver${r.confirms === 1 ? "" : "s"} confirmed${verified}</div>
    <div class="row">
      <button data-vote="still_there" data-id="${r.id}">Still there</button>
      <button data-vote="cleared" data-id="${r.id}">Cleared</button>
    </div>`);
  m.addTo(layers.reports);
  reportMarkers.set(r.id, m);
}

function removeReport(r) {
  reportMarkers.get(r.id)?.remove();
  reportMarkers.delete(r.id);
}

async function loadReports() {
  const res = await fetch("/api/reports");
  (await res.json()).forEach(upsertReport);
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    const { type, report } = JSON.parse(e.data);
    if (type === "report_removed") return removeReport(report);
    upsertReport(report);
    if (type === "report_added" && !myReports.has(report.id)) {
      toast(`<b>New driver report:</b> ${esc(report.summary)}${report.locality ? ` near ${esc(report.locality)}` : ""}`, "danger", report.photo_url);
    }
  };
}

// ------------------------------------------------------------------ report flow
const myReports = new Set();
function openReport() {
  $("report-modal").hidden = false;
  $("report-loc").textContent = state.reportLoc ? "At the point you picked on the map" : "At your current location";
}
function closeReport(reset = true) {
  $("report-modal").hidden = true;
  if (reset) {
    $("report-form").reset();
    $("photo-preview").hidden = true;
    $("photo-hint").hidden = false;
    state.reportLoc = null;
  }
}

$("photo-input").addEventListener("change", () => {
  const f = $("photo-input").files[0];
  if (!f) return;
  $("photo-preview").src = URL.createObjectURL(f);
  $("photo-preview").hidden = false;
  $("photo-hint").hidden = true;
});

$("pick-on-map").addEventListener("click", () => {
  closeReport(false);
  state.pickMode = true;
  state.pickWasSnap = drawerSnap();
  setDrawer("full");
  const banner = document.createElement("div");
  banner.className = "pick-banner";
  banner.id = "pick-banner";
  banner.textContent = "Tap the blocked spot on the map";
  document.querySelector(".phone").appendChild(banner);
});

map.on("click", (e) => {
  if (!state.pickMode) return;
  state.pickMode = false;
  $("pick-banner")?.remove();
  setDrawer(state.pickWasSnap ?? "peek");
  state.reportLoc = { lat: e.latlng.lat, lng: e.latlng.lng };
  openReport();
});

$("report-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const loc = state.reportLoc ?? state.loc;
  if (!loc) return toast("Waiting for your location…", "info");
  const btn = $("report-submit");
  btn.disabled = true;
  btn.textContent = "Sharing…";
  try {
    const fd = new FormData($("report-form"));
    if (!$("photo-input").files[0]) fd.delete("photo");
    fd.set("lat", loc.lat);
    fd.set("lng", loc.lng);
    if (state.loc?.heading != null && !state.reportLoc) fd.set("heading", state.loc.heading);
    fd.set("reporter", "app");
    const res = await fetch("/api/reports", { method: "POST", body: fd });
    if (!res.ok) throw new Error((await res.json()).detail ?? res.statusText);
    const r = await res.json();
    myReports.add(r.id);
    upsertReport(r);
    closeReport();
    toast(`Thanks! Shared with all drivers: <b>${esc(r.summary)}</b>`, "info");
  } catch (err) {
    toast(`Report failed: ${esc(err.message)}`, "danger");
  } finally {
    btn.disabled = false;
    btn.textContent = "Share report";
  }
});

// ------------------------------------------------------------------ toast
let toastTimer;
function toast(html, kind = "danger", img = null) {
  const t = $("toast");
  t.className = `toast ${kind}`;
  t.innerHTML = `${img ? `<img src="${esc(img)}" alt="" />` : ""}<div>${html}</div>`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}

// ------------------------------------------------------------------ wiring
orb.addEventListener("click", orbTap);
miniOrb.addEventListener("click", orbTap);
$("chips").addEventListener("click", (e) => { const b = e.target.closest("button[data-say]"); if (b) say(b.dataset.say); });
$("text-form").addEventListener("submit", (e) => { e.preventDefault(); const v = $("text-input").value; $("text-input").value = ""; say(v); });
$("report-btn").addEventListener("click", openReport);
$("report-cancel").addEventListener("click", () => closeReport());
$("route-clear").addEventListener("click", () => (state.room ? say("Cancel the route") : clearRoute()));
$("menu-btn").addEventListener("click", () => ($("menu").hidden = !$("menu").hidden));
$("demo-loc").addEventListener("change", (e) => useDemo(e.target.checked));
$("sim-btn").addEventListener("click", () => { $("menu").hidden = true; startSim(); });
$("recenter-btn").addEventListener("click", () => { $("menu").hidden = true; if (state.loc) map.setView([state.loc.lat, state.loc.lng], 15); });
$("hangup-btn").addEventListener("click", () => { $("menu").hidden = true; state.room?.disconnect(); });

// Buttons inside Leaflet popups
document.addEventListener("click", async (e) => {
  const go = e.target.closest("button[data-go]");
  if (go) { map.closePopup(); return say(`Take me to ${go.dataset.go}`); }
  const v = e.target.closest("button[data-vote]");
  if (v) {
    map.closePopup();
    const res = await fetch(`/api/reports/${v.dataset.id}/vote`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: v.dataset.vote }),
    });
    toast(res.ok ? "Thanks for confirming — all drivers see the update." : "That report is already gone.", "info");
  }
});

const params = new URLSearchParams(location.search);
useDemo(params.has("demo") || !window.isSecureContext);

// Crowd-sourced road reports can be switched off server-side (ENABLE_ROAD_REPORTS).
fetch("/api/config")
  .then((r) => r.json())
  .then((cfg) => {
    $("report-btn").hidden = !cfg.road_reports;
    if (cfg.road_reports) loadReports();
  })
  .catch(() => ($("report-btn").hidden = true));
setOrb("idle");

// Debug hook: lets you replay agent UI events from the console.
window.driveMate = { handleUiEvent, map };
