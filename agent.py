"""Aween – a general-purpose LiveKit voice agent (Gemini Live) with maps/places tools.

Tools: nearby places (Places API New), route planning that avoids crowd-reported
blockages (Routes API → OSRM fallback), road conditions ahead, DuckDuckGo web/news
search, Google Maps Grounding Lite, and hands-free blockage reports.

Run:  uv run agent.py dev
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx
from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, RunContext, ToolError, cli, function_tool
from livekit.plugins import google

from app.geo import LatLng, bearing, distance_to_path, haversine, offset, path_length
from app.dish import best_places_for_dish
from app.ev_parking import (
    apply_online,
    find_chargers,
    find_parking,
    merge_live,
    venue_parking,
    worth_checking_online,
)
from app.parking_live import coverage, live_lots_near
from app.parking_web import check_parking_online
from app.maps import PLACE_FIELDS, Maps, MapsError, Route
from app.search import web_search as ddgs_search

load_dotenv()
log = logging.getLogger("kendrive")

AGENT_NAME = os.getenv("AGENT_NAME", "kendrive")
# Latest Gemini Live (native audio) model. Tools run NON_BLOCKING on 3.8, so it keeps talking while they run.
GEMINI_LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-3.8-live")
GEMINI_API_KEY = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
API_BASE = os.getenv("API_BASE", "http://localhost:8000")
# Crowd-sourced "road blocked" reports (photo reports, rerouting around them, spoken alerts).
# Switched off for now; set ENABLE_ROAD_REPORTS=true in .env to bring it back.
ROAD_REPORTS = os.getenv("ENABLE_ROAD_REPORTS", "false").lower() in ("1", "true", "yes")
ON_ROUTE_M = 150  # a report closer than this to a route polyline blocks it
NEARBY_ALERT_M = 5000
TRAFFIC_WORDS = {"traffic", "jam", "diversion", "diversions", "diverted", "procession", "congestion", "closed",
                 "closure", "accident", "waterlogging", "waterlogged", "rally", "protest", "bandh", "blocked",
                 "advisory", "immersion", "flyover", "road", "roads"}
# find_stop_on_route: kind → (text query, Places type)
STOP_KINDS: dict[str, tuple[str, str]] = {
    "fuel": ("petrol station", "gas_station"),
    "coffee": ("coffee", "cafe"),
    "food": ("restaurant", "restaurant"),
    "restroom": ("public restroom", "public_bathroom"),
    "ev_charging": ("EV charging station", "electric_vehicle_charging_station"),
    "atm": ("ATM", "atm"),
    "pharmacy": ("pharmacy", "pharmacy"),
    "other": ("", ""),
}
# fuel_prices: spoken fuel → Google fuelOptions types, preferred first
FUEL_TYPES: dict[str, list[str]] = {
    "petrol": ["REGULAR_UNLEADED", "SP91", "SP92", "SP95", "SP91_E10", "SP95_E10", "MIDGRADE"],
    "diesel": ["DIESEL", "DIESEL_PLUS", "TRUCK_DIESEL", "BIO_DIESEL"],
    "premium": ["PREMIUM", "SP98", "SP99", "SP100"],
    "cng": ["METHANE"],
    "lpg": ["LPG"],
}
CITY_ALIASES = {"bengaluru": ("bangalore",), "mumbai": ("bombay",), "chennai": ("madras",), "kolkata": ("calcutta",),
                "gurugram": ("gurgaon",)}

INSTRUCTIONS = """You are Aween, a friendly general-purpose voice assistant. You can help with any question or task
the user brings up, and when they ask about places, directions, parking, fuel, charging, food or local
news you have tools for that too. Do not introduce yourself as a driving or car assistant, and do not
list what you can do unless asked.
Style: calm, brief, spoken. One to three short sentences. No lists, no markdown, no URLs, no
coordinates. Round distances ("about 800 metres", "2.4 kilometres") and times ("12 minutes").
When the session starts, your very first word must be مرحباً and the whole greeting must be exactly this,
nothing before it and nothing after it: مرحباً، أنا أوين. شو أقدر أساعدك فيه اليوم؟
Never say "Hi", "Hello", "هلا" or any other word in place of مرحباً, never add a preamble or title (no
"البث المباشر" or similar), and do not translate the greeting.
Only ever say words meant for the user. Never read out instructions, plans, steps, tool names or
parameters — call the tool silently, then tell the user the result.
Understand local usage: "petrol bunk" = fuel station, "signal" = traffic light, "Salik" = Dubai toll gate.
Language: ALWAYS answer in Arabic, in the Emirati dialect (اللهجة الإماراتية), for the whole session.
Stay in Arabic even when the user speaks or types in English or another language, and even when tool
results, search snippets, place names or news come back in English — translate the substance into
Arabic and keep only proper nouns (place, road, brand, person names) as they are. The only exception:
if the user explicitly asks you to speak another language ("speak English", "talk in Hindi", "بالإنجليزي
لو سمحت"), switch to it and stay there until they explicitly ask for Arabic again. Understanding the
user's English is fine; replying in English is not.
The Emirati greeting is only the opener: from the user's first Arabic words onward, match their dialect
(Emirati, other Gulf, Egyptian, Levantine, Iraqi, Moroccan…) and stay in it, never Modern Standard Arabic,
even in longer answers; if the user hasn't spoken Arabic yet or you can't tell the dialect, keep using Emirati. Everyday
Emirati words: شو (what), وايد (a lot), الحين (now), زين (good), أبا / تبا (I want / you want),
دوّار (roundabout), إشارة (traffic light), بترول (fuel), باركن (parking), سيده (straight on), كيلو (km).
Keep place names, road names and brand names as they are.

When a request matches one of these, use the tool instead of guessing:
- EV charging ("charger", "charge my car", "low battery") → find_ev_chargers. If they mention battery %
  or range, pass range_km. If a route is active and they want one "on the way", set along_route.
  Lead with the best option: name, how many ports are free (or that status is unknown), power, and
  how long to get there; mention how much range 30 minutes adds.
- Parking ("where can I park", "parking near X", "is there space at …") → find_parking. By default it
  looks near the active destination. Say you're checking live availability first. If live numbers exist
  (a car park's "live", live_api, or online.live_counts_found), lead with them ("Seng Poh Lane has 96 free
  spaces right now, a 2-minute walk"). If not, say live counts aren't published online and where the
  driver can see them (online.live_available_via, e.g. the Dubai Mall app), then give the best option with
  walking time and the free-parking rule. Never invent or guess space numbers.
  After plan_route to a busy place (mall, restaurant, downtown), offer to find parking.
- Fuel, restaurants, hospitals, ATMs, pharmacies, mechanics → find_nearby.
- "Where do I get the best / good <dish>?" (e.g. best pasta, bolognese, biryani, filter coffee) →
  find_best_dish with the most specific dish (for "best pasta" use "bolognese pasta" unless they name
  another pasta). Say you're checking reviews, then recommend the top place and give the proof in a few
  words ("it's on their menu", "reviewers rave about the bolognese"). Never recommend a place whose
  evidence is "no".
{routing_rules}
- A route from somewhere other than where they are ("from the airport to X") → plan_route with that start
  as origin; give the time and distance rather than turns. Never say a route starts anywhere other than
  the result's "from".
- Local events, festivals, diversions, news, or anything that needs current facts → web_search.
- Questions about a specific place (reviews, is it good, what's it known for) → ask_google_maps.
Everything else (general knowledge, advice, small talk, translations, explanations) you answer directly,
briefly, without a tool.
For medical emergencies, give the nearest hospital and remind them to call an ambulance: 108 in
India, 998 in the UAE.
If the user is driving, never encourage looking at the phone; the map on screen updates by itself."""

ROUTING_RULES_WITH_REPORTS = """- "Take me to / route to / how do I get to X" → plan_route. It automatically avoids roads that other
  drivers reported as blocked; tell the driver if you picked an alternative and why, then give only the
  first one or two turns.
- "Any traffic / congestion / problems ahead?" → check_road_conditions_ahead. Mention crowd reports
  first (e.g. a Ganesha procession), then traffic delay, then relevant news. If something blocks
  their route, offer to reroute.
- Driver says a road is blocked / there's an accident here → report_blockage."""

ROUTING_RULES = """- "Take me to / route to / how do I get to X" → plan_route; give only the first one or two turns.
- "Any traffic / congestion / problems ahead?" → check_road_conditions_ahead. Mention traffic delay on
  their route, then relevant local news (processions, diversions, closures). If nothing is known, say so
  briefly rather than guessing."""

INSTRUCTIONS = INSTRUCTIONS.replace("{routing_rules}", ROUTING_RULES_WITH_REPORTS if ROAD_REPORTS else ROUTING_RULES)


@dataclass
class DriveState:
    room: rtc.Room
    maps: Maps
    http: httpx.AsyncClient
    route: Route | None = None
    destination: dict[str, Any] | None = None
    origin: dict[str, Any] | None = None  # where the route starts if the driver named a place; None = their position
    stops: list[dict[str, Any]] = field(default_factory=list)  # waypoints added on the way, in order
    avoid: set[str] = field(default_factory=set)  # route preferences: tolls / highways / ferries
    stop_candidates: list[dict[str, Any]] = field(default_factory=list)  # last find_stop_on_route results
    announced: set[str] = field(default_factory=set)

    # ----- driver location comes from the web app via participant attributes
    def driver(self) -> rtc.RemoteParticipant | None:
        for p in self.room.remote_participants.values():
            if p.kind != rtc.ParticipantKind.PARTICIPANT_KIND_AGENT:
                return p
        return None

    def location(self) -> LatLng:
        p = self.driver()
        if p and p.attributes.get("lat") and p.attributes.get("lng"):
            return float(p.attributes["lat"]), float(p.attributes["lng"])
        raise ToolError("I don't have the driver's location yet. Ask them to allow location access in the app.")

    def route_start(self) -> LatLng:
        """Where the active route starts: the place the driver named, else their current position."""
        return (self.origin["lat"], self.origin["lng"]) if self.origin else self.location()

    def heading(self) -> float | None:
        p = self.driver()
        h = p.attributes.get("heading") if p else None
        return float(h) if h not in (None, "", "null") else None

    async def push_ui(self, event: dict[str, Any]) -> None:
        """Send a UI update (markers, routes) to the driver's screen."""
        p = self.driver()
        if not p:
            return
        try:
            await self.room.local_participant.send_text(
                json.dumps(event), topic="ui.event", destination_identities=[p.identity], compress=False
            )
        except Exception as e:
            log.warning("push_ui failed: %s", e)

    async def reports(self) -> list[dict[str, Any]]:
        if not ROAD_REPORTS:
            return []
        try:
            r = await self.http.get(f"{API_BASE}/api/reports")
            return r.json()
        except httpx.HTTPError as e:
            log.warning("could not fetch reports: %s", e)
            return []


# ------------------------------------------------------------------ helpers

def fmt_dist(m: float) -> str:
    return f"{round(m / 10) * 10:.0f} m" if m < 1000 else f"{m / 1000:.1f} km"


def fmt_dur(s: float) -> str:
    mins = round(s / 60)
    return f"{mins} min" if mins < 60 else f"{mins // 60} h {mins % 60} min"


def blockages_on(route: Route, reports: list[dict[str, Any]], start_idx: int = 0) -> list[dict[str, Any]]:
    """Reports lying on the route (after start_idx), with distance along the route."""
    hits = []
    path = route.path
    for rep in reports:
        d, idx = distance_to_path((rep["lat"], rep["lng"]), path)
        if d <= ON_ROUTE_M and idx >= start_idx:
            hits.append({**rep, "along_m": path_length(path, start_idx, idx)})
    return sorted(hits, key=lambda h: h["along_m"])


def report_brief(rep: dict[str, Any], dist_m: float | None = None) -> dict[str, Any]:
    return {
        "what": rep["summary"],
        "category": rep["category"],
        "severity": rep["severity"],
        "near": rep.get("locality") or None,
        "distance": fmt_dist(dist_m) if dist_m is not None else None,
        "confirmed_by_drivers": rep["confirms"],
        "photo_checked_by_ai": rep.get("ai_verified"),
    }


async def detour_routes(maps: Maps, origin: LatLng, dest: LatLng, route: Route, block: dict[str, Any]) -> list[Route]:
    """Try to route around a blockage by forcing a via-point off to each side of it."""
    _, idx = distance_to_path((block["lat"], block["lng"]), route.path)
    a, b = route.path[idx], route.path[min(idx + 1, len(route.path) - 1)]
    brg = bearing(a, b) if a != b else 0.0
    vias = [offset((block["lat"], block["lng"]), brg + side, dist) for dist in (600, 1200) for side in (90, -90)]
    results = await asyncio.gather(*(maps.routes(origin, dest, via=v) for v in vias), return_exceptions=True)
    return [r for res in results if isinstance(res, list) for r in res]


def destination_parking_card(venue: dict[str, Any], at_venue: dict[str, Any] | None,
                             online: dict[str, Any] | None) -> dict[str, Any]:
    """First card for the destination's own parking: live count if published, else where to see it."""
    online = online or {}
    if online.get("live_counts_found") and online.get("free_spaces") is not None:
        badge = {"text": f"{online['free_spaces']} free · live", "tone": "good" if online["free_spaces"] else "bad"}
    elif online.get("live_available_via"):
        badge = {"text": "Live count in app", "tone": "neutral"}
    else:
        badge = {"text": "No live count online", "tone": "neutral"}
    facts = "; ".join(x for x in (online.get("free_parking"), online.get("capacity"), online.get("rates")) if x)
    reviewers = (at_venue or {}).get("what_reviewers_say") or []
    return {
        **venue,
        "pinned": True,  # shown first as "Destination", not ranked against the car parks
        "name": f"{venue['name']} parking",
        "distance_m": 0,
        "walk_min": 0,
        "badge": badge,
        "tags": ((at_venue or {}).get("options") or [])[:3],
        "quote": facts[:220] if facts else (reviewers[0][:200] if reviewers else None),
        "quote_source": "web" if facts else "review" if reviewers else None,
        "website": online.get("source_url") or venue.get("website"),
    }


# ------------------------------------------------------------------ agent

class KenDrive(Agent):
    def __init__(self, state: DriveState) -> None:
        extra_tools = [function_tool(self.report_blockage)] if ROAD_REPORTS else []
        super().__init__(instructions=INSTRUCTIONS, tools=extra_tools)
        self.s = state

    @function_tool
    async def find_nearby(
        self,
        ctx: RunContext,
        category: Literal[
            "fuel", "ev_charging", "restaurant", "hospital", "parking", "atm", "pharmacy", "car_repair", "other"
        ],
        keyword: str | None = None,
    ) -> dict[str, Any]:
        """Find the closest places of a kind around the driver's current location.

        Args:
            category: Kind of place. Use "other" with a keyword for anything else.
            keyword: Optional extra filter, e.g. "vegetarian", "Indian Oil", "24 hour", "Tata Power".
        """
        loc = self.s.location()
        try:
            places = await self.s.maps.nearby(loc, category, query=keyword, radius_m=6000, limit=5)
        except MapsError as e:
            raise ToolError(str(e)) from e
        if not places:
            return {"result": f"No {category} found within 6 km."}
        # Title from what was asked for ("Coffee nearby"), not the broad category ("Restaurants nearby").
        title = f"{keyword.strip().capitalize()} nearby" if keyword and keyword.strip() else None
        await self.s.push_ui({"type": "places", "category": category, "title": title, "places": places})
        return {
            "places": [
                {
                    "name": p["name"],
                    "distance": fmt_dist(p["distance_m"]),
                    "area": p["address"],
                    "open_now": p["open_now"],
                    "rating": p["rating"],
                }
                for p in places[:3]
            ]
        }

    @function_tool
    async def find_best_dish(self, ctx: RunContext, dish: str) -> dict[str, Any]:
        """Find the best nearby place for a specific dish by reading Google reviews, Google's review
        summaries and menu snippets from the web, and keeping only places that actually serve it.
        Shows the results as cards on the driver's screen.

        Args:
            dish: The dish, as specific as possible, e.g. "bolognese pasta", "hyderabadi biryani".
        """
        loc = self.s.location()
        area = await self.s.maps.locality(loc)
        city = area.split(", ")[-1] if area else ""
        try:
            ranked = await best_places_for_dish(self.s.maps, loc, dish, city)
        except MapsError as e:
            raise ToolError(str(e)) from e
        serving = [r for r in ranked if r["evidence"] in ("on_menu", "reviewed", "likely")]
        if not serving:
            return {"result": f"No place within 10 km clearly serves {dish}."}

        await self.s.push_ui(
            {
                "type": "places",
                "category": "restaurant",
                "title": f"Best {dish} near you",
                "places": [
                    {k: v for k, v in r.items() if k not in ("reviews", "menu_snippets")} for r in serving[:5]
                ],
            }
        )
        return {
            "dish": dish,
            "ranked": [
                {
                    "name": r["name"],
                    "distance": fmt_dist(r["distance_m"]),
                    "rating": r["rating"],
                    "evidence": r["evidence"],
                    "proof": r["quote"],
                    "proof_from": r["quote_source"],
                    "why": r["why"],
                    "open_now": r["open_now"],
                }
                for r in serving[:3]
            ],
        }

    @function_tool
    async def find_ev_chargers(
        self,
        ctx: RunContext,
        along_route: bool = False,
        fast_only: bool = False,
        connector: Literal["any", "CCS2", "Type 2", "CHAdeMO", "GB/T", "Tesla"] = "any",
        vehicle: Literal["car", "two_wheeler"] = "car",
        range_km: float | None = None,
    ) -> dict[str, Any]:
        """Find EV charging stations with live free/busy ports (where the operator shares them),
        connector types and charging power. Shows them as cards on the driver's screen.

        Args:
            along_route: Search along the active route instead of around the driver (reports detour).
            fast_only: Only DC fast chargers (25 kW or more).
            connector: Required connector type; "any" if the driver didn't say.
            vehicle: "two_wheeler" for e-scooters/bikes (includes slow sockets); otherwise "car".
            range_km: Remaining driving range in km, if the driver said (e.g. from battery %).
        """
        route = self.s.route if along_route else None
        if along_route and not route:
            along_route = False
        try:
            chargers = await find_chargers(
                self.s.maps, self.s.route_start() if route else self.s.location(),
                route_path=route.path if route else None,
                route_duration_s=route.duration_s if route else None,
                vehicle=vehicle, connector=connector, fast_only=fast_only, range_km=range_km,
            )
        except MapsError as e:
            raise ToolError(str(e)) from e
        if not chargers:
            return {"result": "No matching chargers found" + (" within your range." if range_km else " nearby.")}
        title = "Chargers on your route" if route else ("Fast chargers nearby" if fast_only else "EV chargers nearby")
        await self.s.push_ui({"type": "places", "category": "ev_charging", "title": title, "places": chargers})
        return {
            "searched": "along route" if route else "around you",
            "chargers": [
                {
                    "name": c["name"],
                    "status": c["status"],
                    "free_ports": c["free_ports"],
                    "total_ports": c["total_ports"],
                    "max_kw": c["max_kw"],
                    "connectors": c["tags"],
                    "drive_min": c["drive_min"],
                    "detour_min": c["detour_min"],
                    "range_added_in_30_min_km": c["range_30min_km"],
                    "open_now": c["open_now"],
                }
                for c in chargers[:3]
            ],
        }

    @function_tool
    async def find_parking(
        self,
        ctx: RunContext,
        near: str | None = None,
        preference: Literal["any", "free", "covered", "valet", "street"] = "any",
    ) -> dict[str, Any]:
        """Smart parking finder with live availability where it exists. Combines: nearby car parks
        (Google Places), live free-space counts from open city APIs (e.g. Singapore), and a web search
        of the destination and named car parks that reads their websites for live counts, rates and
        free-parking rules. Shows the results as cards. Takes ~10 s — tell the driver you're checking.

        Args:
            near: Place to park near. Leave empty to use the active route's destination, or the driver's
                current location if there is no route.
            preference: What the driver asked for, e.g. "free", "covered" (garage), "valet", "street".
        """
        loc = self.s.location()
        venue: dict[str, Any] | None = None
        try:
            if near:
                venue = await self.s.maps.geocode(near, near=loc)
            elif self.s.destination:
                venue = self.s.destination
            target = (venue["lat"], venue["lng"]) if venue else loc
            lots, live, area, at_venue = await asyncio.gather(
                find_parking(self.s.maps, target, preference=preference),
                live_lots_near(self.s.http, target),
                self.s.maps.locality(target),
                venue_parking(self.s.maps, venue["id"]) if venue and venue.get("id") else asyncio.sleep(0),
            )
        except MapsError as e:
            raise ToolError(str(e)) from e
        lots = merge_live(lots, live)
        city = area.split(", ")[-1] if area else ""

        # Web-check the destination and the top named car parks, in parallel, within a time budget.
        async def online(name: str, website: str | None) -> dict[str, Any] | None:
            try:
                return await asyncio.wait_for(check_parking_online(self.s.http, name, city, website), 18)
            except (asyncio.TimeoutError, httpx.HTTPError) as e:
                log.info("web parking check for %s gave up: %s", name, e)
                return None

        to_check = [l for l in lots if worth_checking_online(l)][:2]
        checks = await asyncio.gather(
            online(venue["name"], venue.get("website")) if venue else asyncio.sleep(0),
            *(online(l["name"], l.get("website")) for l in to_check),
        )
        venue_online, lot_checks = checks[0], checks[1:]
        for lot, result in zip(to_check, lot_checks):
            apply_online(lot, result)

        where = venue["name"] if venue else "you"
        cards = list(lots)
        if venue:
            cards.insert(0, destination_parking_card(venue, at_venue, venue_online))
        if cards:
            await self.s.push_ui(
                {"type": "places", "category": "parking", "title": f"Parking near {where}", "places": cards}
            )

        def brief_online(o: dict[str, Any] | None) -> dict[str, Any] | None:
            if not o:
                return None
            keys = ("live_counts_found", "free_spaces", "total_spaces", "zones", "as_of", "live_available_via",
                    "capacity", "rates", "free_parking", "tips", "source_url")
            return {k: o.get(k) for k in keys if o.get(k) not in (None, [], "")}

        return {
            "near": where,
            "destination_parking": {**(at_venue or {}), "online": brief_online(venue_online)} if venue else None,
            "live_api": {
                "coverage": coverage(target) or "No open live-parking feed covers this city.",
                "car_parks": [
                    {"name": l["name"], "free": l["free"], "total": l["total"], "distance_m": l["distance_m"],
                     "updated": l["updated"]}
                    for l in live[:5]
                ],
            },
            "nearby_parking": [
                {
                    "name": l["name"],
                    "walk_min": l["walk_min"],
                    "type": l["kind"],
                    "options": l["options"],
                    "open_now": l["open_now"],
                    "live": l.get("live"),
                    "online": brief_online(l.get("online")),
                }
                for l in lots[:3]
            ] or "No public parking listed within 1.2 km.",
            "note": "Quote free-space numbers ONLY from 'live' / live_api / online.live_counts_found. "
                    "Otherwise say no live count is published and where it can be seen (live_available_via).",
        }

    @function_tool
    async def plan_route(self, ctx: RunContext, destination: str, origin: str | None = None) -> dict[str, Any]:
        """Plan a driving route to a destination (avoiding roads other drivers reported as blocked, when enabled).
        Shows the route on the driver's map and makes it the active route.

        Args:
            destination: Place name or address, e.g. "Koramangala", "Manipal Hospital Old Airport Road",
                or the name of a place returned by find_nearby.
            origin: Starting point, only when the driver names one ("from the airport to Koramangala").
                Leave empty to start from the driver's current location.
        """
        try:
            here = self.s.location()
        except ToolError:
            if not origin:
                raise
            here = None
        try:
            start = await self.s.maps.geocode(origin, near=here) if origin else None
            dest = await self.s.maps.geocode(destination, near=(start["lat"], start["lng"]) if start else here)
        except MapsError as e:
            raise ToolError(str(e)) from e
        self.s.origin, self.s.stops = start, []
        return await self._route_to(dest)

    async def _route_to(self, dest: dict[str, Any]) -> dict[str, Any]:
        """(Re)plan to `dest` via the current stops and route preferences; show it and make it active."""
        origin = self.s.route_start()
        stop_pts = [(st["lat"], st["lng"]) for st in self.s.stops]
        try:
            routes = await self.s.maps.routes(origin, (dest["lat"], dest["lng"]), stops=stop_pts, avoid=frozenset(self.s.avoid))
        except MapsError as e:
            raise ToolError(str(e)) from e
        if not routes:
            raise ToolError("No drivable route found.")

        reports = await self.s.reports()
        fastest = min(routes, key=lambda r: r.duration_s)
        fastest_blocks = blockages_on(fastest, reports)
        clear = [r for r in routes if not blockages_on(r, reports)]
        if not clear:
            # Every suggested route passes a reported blockage – force a detour around the first one.
            detours = await detour_routes(self.s.maps, origin, (dest["lat"], dest["lng"]), fastest, fastest_blocks[0])
            clear = [r for r in detours if not blockages_on(r, reports)]
        chosen = min(clear, key=lambda r: r.duration_s) if clear else fastest
        rerouted_around = fastest_blocks if chosen is not fastest else []
        blocks = blockages_on(chosen, reports)

        self.s.route, self.s.destination = chosen, dest
        others = [r for r in routes if r is not chosen][:2]
        await self.s.push_ui(
            {
                "type": "route",
                "origin": self.s.origin,
                "destination": dest,
                "chosen": chosen.to_ui(),
                "alternatives": [r.to_ui() for r in others],
                "blocked": [r for r in reports if any(b["id"] == r["id"] for b in rerouted_around + blocks)],
            }
        )

        o = self.s.origin
        result: dict[str, Any] = {
            "from": f'{o["name"]}, {o["address"]}' if o else "the driver's current location",
            "destination": f'{dest["name"]}, {dest["address"]}',
            "eta": fmt_dur(chosen.duration_s),
            "distance": fmt_dist(chosen.distance_m),
            "route": chosen.summary,
            "first_turns": chosen.steps[:3],
        }
        if self.s.stops:
            result["stops"] = [st["name"] for st in self.s.stops]
        if chosen.tolls:
            result["tolls"] = chosen.tolls
        if self.s.avoid:
            result["avoiding"] = sorted(self.s.avoid)
            if chosen.provider != "google":
                result["note_prefs"] = "Live routing is unavailable right now, so avoid-preferences couldn't be applied."
        if chosen.traffic_delay_s is not None:
            result["traffic_delay"] = fmt_dur(chosen.traffic_delay_s)
        else:
            result["note"] = "Live traffic data unavailable; ETA is free-flow."
        if rerouted_around:
            result["avoided_blockages"] = [report_brief(b) for b in rerouted_around]
            result["extra_time_vs_blocked_route"] = fmt_dur(max(0, chosen.duration_s - fastest.duration_s))
        if blocks:
            result["warning_route_still_blocked"] = [report_brief(b, b["along_m"]) for b in blocks]
        return result

    @function_tool
    async def check_road_conditions_ahead(self, ctx: RunContext) -> dict[str, Any]:
        """Check congestion, blockages and events on the road ahead: live traffic delay on the active
        route, today's local traffic news, and (when enabled) crowd-sourced driver reports."""
        loc = self.s.location()
        reports = await self.s.reports()
        out: dict[str, Any] = {}

        if self.s.route:
            off_m, my_idx = distance_to_path(loc, self.s.route.path)
            if self.s.origin and off_m > 1000:
                my_idx = 0  # a route from somewhere else that the driver isn't on yet: check all of it
            ahead = blockages_on(self.s.route, reports, start_idx=my_idx)
            if ROAD_REPORTS:
                out["on_your_route"] = [report_brief(b, b["along_m"]) for b in ahead] or "No driver reports on your route."
            if self.s.route.traffic_delay_s is not None:
                out["traffic_delay_on_route"] = fmt_dur(self.s.route.traffic_delay_s)
            out["destination"] = self.s.destination["name"] if self.s.destination else None
            if ahead:
                out["suggestion"] = "Offer to reroute with plan_route to the same destination."
        else:
            hdg = self.s.heading()
            nearby = []
            for r in reports:
                d = haversine(loc, (r["lat"], r["lng"]))
                if d > NEARBY_ALERT_M:
                    continue
                if hdg is not None and d > 300:
                    diff = abs((bearing(loc, (r["lat"], r["lng"])) - hdg + 180) % 360 - 180)
                    if diff > 70:
                        continue  # behind or well off to the side
                nearby.append(report_brief(r, d))
            if ROAD_REPORTS:
                out["driver_reports_nearby"] = nearby or "No driver reports within 5 km ahead."
            out["note"] = "No active route; set a destination for route-specific traffic."

        area = await self.s.maps.locality(loc)
        if area:
            city = area.split(", ")[-1]
            news = await ddgs_search(f"{city} traffic diversion procession road closed today", news=True,
                                     max_results=10, timelimit="d")
            names = {city.lower(), *CITY_ALIASES.get(city.lower(), ())}
            relevant = [
                n for n in news
                if TRAFFIC_WORDS.intersection((text := f'{n["title"]} {n["snippet"] or ""}'.lower()).split())
                and any(c in text for c in names)
            ]
            out["area"] = area
            out["local_news"] = [{"title": n["title"], "snippet": (n["snippet"] or "")[:200]} for n in relevant[:4]] \
                or "No traffic news for today."
        if ROAD_REPORTS:
            await self.s.push_ui({"type": "focus_reports"})
        return out

    # Registered in __init__ only when ROAD_REPORTS is on.
    async def report_blockage(self, ctx: RunContext, description: str) -> dict[str, Any]:
        """Report, hands-free, that the road at the driver's current location is blocked or congested.
        The report is shared live with every other driver using the app.

        Args:
            description: What the driver sees, e.g. "Ganesha procession blocking the road".
        """
        lat, lng = self.s.location()
        r = await self.s.http.post(
            f"{API_BASE}/api/reports",
            data={"lat": lat, "lng": lng, "note": description, "reporter": "voice",
                  "heading": self.s.heading() or ""},
        )
        if r.status_code != 200:
            raise ToolError("Could not submit the report right now.")
        rep = r.json()
        self.s.announced.add(rep["id"])  # don't alert the reporter about their own report
        return {"reported": True, "area": rep.get("locality"), "shared_with": "all drivers"}

    @function_tool
    async def web_search(self, ctx: RunContext, query: str, news: bool = False) -> dict[str, Any]:
        """Search the web with DuckDuckGo. Use for festivals, processions, road closures, diversions,
        weather events, or any general question.

        Args:
            query: Search query. Include the city/area for local topics.
            news: True for recent news (last few days) instead of general web results.
        """
        results = await ddgs_search(query, news=news, max_results=5, timelimit="w" if news else None)
        if not results:
            return {"results": "No results found."}
        return {"results": [{"title": r["title"], "snippet": (r["snippet"] or "")[:300], "date": r.get("date")}
                            for r in results]}

    @function_tool
    async def ask_google_maps(self, ctx: RunContext, question: str) -> dict[str, Any]:
        """Ask Google Maps (Grounding Lite) about places: reviews, what a place is known for,
        kid/family friendliness, specific dishes, facilities.

        Args:
            question: Natural-language question, e.g. "good South Indian breakfast near me with parking".
        """
        loc = self.s.location()
        res = await self.s.maps.ask_maps(question, near=loc)
        if res.get("places"):
            await self.s.push_ui({"type": "places", "category": "other", "places": res["places"]})
            res["places"] = [{"name": p["name"], "distance": fmt_dist(p["distance_m"]), "rating": p["rating"]}
                             for p in res["places"][:3]]
        return res

    # ----- stops, route preferences, fuel prices, weather

    @function_tool
    async def find_stop_on_route(
        self,
        ctx: RunContext,
        kind: Literal["fuel", "coffee", "food", "restroom", "ev_charging", "atm", "pharmacy", "other"],
        keyword: str | None = None,
    ) -> dict[str, Any]:
        """Find places to stop ALONG the active route ("coffee on the way", "petrol before the highway"),
        ranked by how much time the detour adds. Shows them as cards. Then offer to add the best one
        with add_stop.

        Args:
            kind: What to stop for. Use "other" with a keyword for anything else.
            keyword: Optional extra filter or brand, e.g. "Starbucks", "Shell", "biryani".
        """
        route = self.s.route
        if not route:
            raise ToolError("There's no active route. Plan a route first, or use find_nearby.")
        query, ptype = STOP_KINDS[kind]
        if not (keyword or query):
            raise ToolError("Say what kind of stop, e.g. a keyword like 'car wash'.")
        start = self.s.route_start()
        try:
            found = await self.s.maps.search_along_route(
                keyword or query, ptype, route.path, start, PLACE_FIELDS, limit=12
            )
        except MapsError as e:
            raise ToolError(str(e)) from e
        cards = []
        for raw, summary in found:
            card = self.s.maps.place(raw, start)
            legs = summary.get("legs", [])
            if len(legs) >= 2:
                via_s = sum(float(leg.get("duration", "0s").rstrip("s")) for leg in legs)
                card["drive_min"] = round(float(legs[0].get("duration", "0s").rstrip("s")) / 60)
                card["detour_min"] = max(0, round((via_s - route.duration_s) / 60))
            cards.append(card)
        cards.sort(key=lambda c: (c.get("detour_min") if c.get("detour_min") is not None else 99, c["distance_m"] or 1e9))
        cards = cards[:5]
        if not cards:
            return {"result": f"Nothing for {keyword or kind} along this route."}
        self.s.stop_candidates = cards
        await self.s.push_ui({"type": "places", "category": "other", "title": f"{(keyword or kind).capitalize()} on the way", "places": cards})
        return {
            "options": [
                {"name": c["name"], "adds": f"{c['detour_min']} min" if c.get("detour_min") is not None else "unknown",
                 "in": f"{c['drive_min']} min" if c.get("drive_min") is not None else fmt_dist(c["distance_m"]),
                 "open_now": c["open_now"]}
                for c in cards[:3]
            ]
        }

    @function_tool
    async def add_stop(self, ctx: RunContext, place_name: str) -> dict[str, Any]:
        """Add a stop to the active route (usually one returned by find_stop_on_route) and re-plan.

        Args:
            place_name: The stop's name, as returned by find_stop_on_route, or any place/address.
        """
        if not self.s.route or not self.s.destination:
            raise ToolError("There's no active route to add a stop to.")
        name = place_name.lower()
        stop = next((c for c in self.s.stop_candidates if name in c["name"].lower() or c["name"].lower() in name), None)
        if stop is None:
            try:
                stop = await self.s.maps.geocode(place_name, near=self.s.route_start())
            except MapsError as e:
                raise ToolError(str(e)) from e
        self.s.stops.append({"name": stop["name"], "lat": stop["lat"], "lng": stop["lng"]})
        result = await self._route_to(self.s.destination)
        result["added_stop"] = stop["name"]
        return result

    @function_tool
    async def set_route_preferences(
        self,
        ctx: RunContext,
        avoid_tolls: bool | None = None,
        avoid_highways: bool | None = None,
        avoid_ferries: bool | None = None,
    ) -> dict[str, Any]:
        """Change route preferences ("avoid tolls", "no highways", "tolls are fine") and re-plan the active
        route with them. They stay on for later routes too. Leave a field empty to keep it as is.
        """
        for key, value in (("tolls", avoid_tolls), ("highways", avoid_highways), ("ferries", avoid_ferries)):
            if value is True:
                self.s.avoid.add(key)
            elif value is False:
                self.s.avoid.discard(key)
        if self.s.route and self.s.destination:
            return await self._route_to(self.s.destination)
        return {"avoiding": sorted(self.s.avoid) or "nothing", "note": "Will apply to the next route."}

    @function_tool
    async def fuel_prices(
        self, ctx: RunContext, fuel: Literal["petrol", "diesel", "premium", "cng", "lpg"] = "petrol"
    ) -> dict[str, Any]:
        """Compare fuel prices at nearby petrol stations (Google's price data; not available in every
        country). Shows stations as cards, cheapest first when prices are known.

        Args:
            fuel: The fuel the driver needs.
        """
        loc = self.s.location()
        try:
            stations = await self.s.maps.fuel_stations(loc)
        except MapsError as e:
            raise ToolError(str(e)) from e
        if not stations:
            return {"result": "No petrol stations within 6 km."}
        wanted = FUEL_TYPES[fuel]
        priced = []
        for st in stations:
            price = next((st["fuel_prices"][t] for t in wanted if t in st["fuel_prices"]), None)
            if price:
                st["badge"] = {"text": f"{price['currency']} {price['amount']:.2f}", "tone": "good"}
                priced.append((price["amount"], st))
        if not priced:
            await self.s.push_ui({"type": "places", "category": "fuel", "places": stations[:5]})
            return {
                "prices": "Google has no fuel prices for stations in this area, so I can only show the nearest ones.",
                "nearest": [{"name": st["name"], "distance": fmt_dist(st["distance_m"])} for st in stations[:3]],
            }
        priced.sort(key=lambda x: (x[0], x[1]["distance_m"] or 1e9))
        cards = [st for _, st in priced[:5]]
        await self.s.push_ui({"type": "places", "category": "fuel", "title": f"Cheapest {fuel} nearby", "places": cards})
        return {
            "cheapest": [
                {"name": st["name"], "price": st["badge"]["text"], "distance": fmt_dist(st["distance_m"])} for st in cards[:3]
            ]
        }

    @function_tool
    async def weather(self, ctx: RunContext, where: Literal["here", "destination"] = "here") -> dict[str, Any]:
        """Weather for driving: now where the driver is, or at the destination around arrival time
        ("will it rain when I get there?").

        Args:
            where: "here" for current conditions, "destination" for the forecast at the active route's
                destination at the ETA.
        """
        try:
            if where == "destination":
                if not self.s.route or not self.s.destination:
                    raise ToolError("There's no active route, so I don't know the destination.")
                d = self.s.destination
                eta_h = self.s.route.duration_s / 3600
                out = await self.s.maps.weather_at((d["lat"], d["lng"]), eta_h)
                out["place"] = d["name"]
                out["arriving_in"] = fmt_dur(self.s.route.duration_s)
                title = f"{d['name']} when you arrive"
            else:
                loc = self.s.location()
                out, area = await asyncio.gather(self.s.maps.weather_now(loc), self.s.maps.locality(loc))
                out["place"] = area or "Here"
                title = f"Now in {area}" if area else "Weather here"
        except MapsError as e:
            raise ToolError(str(e)) from e
        await self.s.push_ui({"type": "weather", "title": title, **out})
        return {k: v for k, v in out.items() if k != "icon"}

    @function_tool
    async def where_am_i(self, ctx: RunContext) -> dict[str, Any]:
        """Tell the driver where they are right now: neighbourhood, city, the nearest landmark or
        street address, and which way they're heading. Use for "where am I?", "what area is this?"."""
        loc = self.s.location()
        area, nearest = await asyncio.gather(
            self.s.maps.locality(loc),
            self.s.maps.nearest_landmark(loc),
        )
        out: dict[str, Any] = {"area": area or "unknown area"}
        if nearest:
            out["near"] = nearest["name"]
            out["distance_to_it"] = fmt_dist(nearest["distance_m"])
            if nearest.get("address"):
                out["street_address"] = nearest["address"]
        hdg = self.s.heading()
        if hdg is not None:
            out["heading"] = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][
                round(hdg / 45) % 8
            ]
        return out

    @function_tool
    async def clear_route(self, ctx: RunContext) -> str:
        """Cancel the active route / navigation."""
        self.s.route = self.s.destination = self.s.origin = None
        await self.s.push_ui({"type": "clear_route"})
        return "Route cleared."


# ------------------------------------------------------------------ proactive alerts

async def watch_reports(state: DriveState, session: AgentSession) -> None:
    """Listen to the live report feed and warn the driver about new blockages that affect them."""
    while True:
        try:
            async with state.http.stream("GET", f"{API_BASE}/api/events", timeout=None) as resp:
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    evt = json.loads(line[6:])
                    rep = evt["report"]
                    if evt["type"] != "report_added" or rep["id"] in state.announced:
                        continue
                    try:
                        loc = state.location()
                    except ToolError:
                        continue
                    on_route = state.route and blockages_on(state.route, [rep], distance_to_path(loc, state.route.path)[1])
                    dist = haversine(loc, (rep["lat"], rep["lng"]))
                    if not on_route and dist > NEARBY_ALERT_M:
                        continue
                    state.announced.add(rep["id"])
                    where = "on your current route" if on_route else f"about {fmt_dist(dist)} away"
                    session.generate_reply(
                        instructions=(
                            f"Proactively alert the driver in one or two sentences: another driver just reported "
                            f"'{rep['summary']}' {where}"
                            f"{' near ' + rep['locality'] if rep.get('locality') else ''}. "
                            + ("Offer to find a way around it." if on_route else "")
                        )
                    )
        except (httpx.HTTPError, json.JSONDecodeError) as e:
            log.info("report feed disconnected (%s); retrying", e)
        await asyncio.sleep(3)


# ------------------------------------------------------------------ entrypoint

server = AgentServer()


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    if not (GEMINI_API_KEY or os.getenv("GOOGLE_GENAI_USE_VERTEXAI")):
        log.error("GOOGLE_API_KEY is empty – add a Gemini API key to .env and restart the agent")
        await ctx.connect()
        await ctx.room.local_participant.set_attributes({"kendrive.error": "missing_gemini_key"})
        await asyncio.sleep(2)
        ctx.shutdown(reason="missing GOOGLE_API_KEY")
        return
    await ctx.connect()
    http = httpx.AsyncClient(timeout=20)
    state = DriveState(room=ctx.room, maps=Maps(os.environ["GOOGLE_PLACES_API_KEY"]), http=http)

    log.info("starting Gemini Live session with %s", GEMINI_LIVE_MODEL)
    session = AgentSession(
        llm=google.realtime.RealtimeModel(
            model=GEMINI_LIVE_MODEL,
            api_key=GEMINI_API_KEY,
            voice=os.getenv("GEMINI_VOICE", "Kore"),  # female voice; Gemini voices are multilingual (Arabic ok)
        )
    )

    # Transcripts aren't shown in the UI, so keep the conversation in the agent log.
    @session.on("conversation_item_added")
    def _log_turn(ev) -> None:
        text = getattr(ev.item, "text_content", None)
        if text:
            log.info("%s: %s", getattr(ev.item, "role", "?"), text)

    await session.start(room=ctx.room, agent=KenDrive(state))
    watcher = asyncio.create_task(watch_reports(state, session)) if ROAD_REPORTS else None

    async def cleanup() -> None:
        if watcher:
            watcher.cancel()
        await http.aclose()
        await state.maps.http.aclose()

    ctx.add_shutdown_callback(cleanup)
    # Greeting comes from the system instructions. (Passing instructions= here makes the plugin inject
    # them as a *model* turn, which Gemini 3.x Live can read back aloud as its own "plan".)
    session.generate_reply()


if __name__ == "__main__":
    cli.run_app(server)
