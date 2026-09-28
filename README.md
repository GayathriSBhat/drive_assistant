# KenDrive — driving tracker voice co-pilot (POC)

A mobile-first web app with a voice orb you talk to while driving. It runs on a
**LiveKit** voice agent backed by **Gemini Live**, with tools for **Google Maps Platform**
and **DuckDuckGo (`ddgs`) web search**, plus crowd-sourced **"road blocked" photo reports**
that appear live for every user.

> "Hey, are there road congestions ahead?"
> → "There's a Ganesha procession ahead near Richmond Road. I've routed you via Cubbon Road instead; take a right onto Central Street."

## What it does

| Need | How |
|---|---|
| Nearest petrol bunk / EV charging / restaurant / hospital (and parking, ATM, pharmacy, mechanic) | `find_nearby` → Places API (New); results appear as pins on the map |
| "Where do I get the best pasta?" | `find_best_dish` pulls up to 5 reviews per nearby place plus Google's AI review summary (Places API New), searches each place's menu on the web (ddgs), and has **Gemini Flash** judge which ones actually serve the dish (e.g. bolognese). It returns the top pick with a quoted proof. Places with no evidence are never recommended |
| "Find me an EV charger" / "a fast charger on the way" | `find_ev_chargers` uses Places `evChargeOptions`: connector types, kW, and live free/busy ports where the operator shares them. It searches around you or **along the active route** (Search Along Route) with the detour cost. Filters: car or two-wheeler, connector, DC fast (≥ 25 kW), remaining range. It ranks by availability, drive time and power, and says how much range 30 minutes adds |
| "Where can I park (near X)?" | `find_parking` (smart parking) targets the active destination by default. It reports the venue's own parking (valet, lot, street) and what its reviewers say about parking, then nearby lots and garages ranked by walking time, opening hours, rating and preference (free / covered / valet / street). There's no live occupancy data, so it never promises a free spot |
| "Take me to …" | `plan_route` → Routes API (live traffic); if that isn't enabled, OSRM. Routes that pass a reported blockage are rejected and a detour is forced around it |
| "Any congestion ahead?" | `check_road_conditions_ahead` → driver reports on your route (or ahead of you), traffic delay, and today's local traffic news via ddgs |
| General / event questions | `web_search` → ddgs text or news |
| Place questions ("is it good for kids?") | `ask_google_maps` → Maps **Grounding Lite** MCP (`search_places`); falls back to Places Text Search |
| "The road here is blocked" (hands-free) | `report_blockage` → shared with everyone |
| Photo report | **Report** button → camera photo, note, your location or a point picked on the map. Gemini checks the photo, and all clients get it over SSE. Other drivers can tap **Still there** or **Cleared** (2 "cleared" votes remove it; reports expire after 3 h) |
| Proactive alerts | The agent listens to the report feed and speaks up when a new report lands on your route or within 5 km |

> **Road reports are switched off for now** (`ENABLE_ROAD_REPORTS=false` in `.env`). That hides the Report
> button and report pins, drops `report_blockage`, and turns off rerouting around reports and spoken alerts.
> "Congestion ahead?" then uses route traffic delay and news only. Set it to `true` and restart to bring it all back.

## Screen
- **Orb** (centre): the AI Elements **Persona** (Rive "obsidian"), tinted KenDrive blue (`web/persona.js`). Nothing but the orb is shown in the centre: no name, status, caption or transcript. Its state is in its hover title and accessible label. **Tap the orb** to start a session, then tap again to **pause or resume** (the orb dims while paused). "End voice session" in the ⋯ menu ends the session. Short notices appear as a toast at the top.
- **Cards** (AppSheet-style "Large" card view): photo, badges, title, subtitle, tags, a review or menu quote, and Navigate / Maps / Call actions.
- **Map drawer**: a bottom sheet above the quick actions. Drag the grip between **peek** (a one-line summary such as "3 min to Dubai Mall"), **half** and **full**; tap it to toggle, or use arrow keys. A new route opens it to half automatically. When full, its header shows a mini orb and pause button.

## Architecture

```
Browser (web/)  ──WebRTC audio + text──►  LiveKit server  ◄──►  agent.py (LiveKit Agents + Gemini Live)
   │  participant attributes: lat/lng/heading                     │  tools: Places / Routes / Grounding Lite / ddgs
   │  ◄── "ui.event" text stream: pins, routes ───────────────────┘
   └──HTTP/SSE──► server.py (FastAPI): /api/token, /api/reports (+photo), /api/events (live feed)
```

## Run

Needs `uv`, and `livekit-server` (`brew install livekit`).

1. Fill in `.env` (see `.env.example`):
   - `GOOGLE_API_KEY`: **Gemini API key** from https://aistudio.google.com/apikey (required for voice).
   - `GOOGLE_PLACES_API_KEY`: Maps key with **Places API (New)**. Optionally also enable
     **Routes API** (traffic-aware ETAs and delays) and **Maps Grounding Lite API** on the key.
2. `./run.sh` starts `livekit-server --dev`, the web server (:8000) and the agent.
3. Open http://localhost:8000 (add `?demo` to use a fixed Downtown Dubai location), tap the orb and talk,
   or tap a chip or type.

Demo tips: the **⋯** menu can switch to the demo location and **simulate driving** along the
active route. To show "other users", post a report from a second browser tab or with curl:

```bash
curl -X POST localhost:8000/api/reports -F lat=12.9661 -F lng=77.6085 -F "note=Ganesha procession blocking Richmond Road"
```

### On a real phone
Mic and GPS need HTTPS. Expose port 8000 and port 7880 through a tunnel (e.g. `cloudflared`/`ngrok`),
set `LIVEKIT_PUBLIC_URL=wss://<tunnel-for-7880>`, and open the 8000 tunnel URL. Or use LiveKit Cloud:
set `LIVEKIT_URL/API_KEY/API_SECRET` to your project and skip the local server.

## Notes / limits
- Without the Routes API, ETAs are free-flow (OSRM public demo server, not for production).
- The report store is a JSON file in `data/` (single process). Swap for a DB for multi-instance use.
- Show Google Maps attribution and the place links the app already includes, as the Grounding Lite / Places terms require.
