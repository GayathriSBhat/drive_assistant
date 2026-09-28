"""Google Maps Platform access (Places API New, Routes API, Grounding Lite MCP) with fallbacks.

Routes API → falls back to the public OSRM demo server (no live traffic) when the
key is not allowed to call it. Grounding Lite → falls back to Places Text Search.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import httpx

from .geo import LatLng, decode_polyline, encode_polyline, haversine

log = logging.getLogger("maps")

PLACES_URL = "https://places.googleapis.com/v1/places"
ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
GROUNDING_LITE_URL = "https://mapstools.googleapis.com/mcp"
OSRM_URL = "https://router.project-osrm.org/route/v1/driving"
WEATHER_URL = "https://weather.googleapis.com/v1"

CATEGORY_TYPES: dict[str, list[str]] = {
    "fuel": ["gas_station"],
    "ev_charging": ["electric_vehicle_charging_station"],
    "restaurant": ["restaurant"],
    "hospital": ["hospital"],
    "parking": ["parking"],
    "atm": ["atm"],
    "pharmacy": ["pharmacy"],
    "car_repair": ["car_repair"],
}
# Google's type tags are noisy for these (clinics/suppliers tagged "hospital"); require some reviews.
MIN_REVIEWS: dict[str, int] = {"hospital": 50, "restaurant": 20}
# Categories where a type-filtered text search ranks real matches better than Nearby Search.
TEXT_QUERIES: dict[str, str] = {"hospital": "hospital emergency"}

PLACE_FIELDS = [
    "id",
    "displayName",
    "formattedAddress",
    "shortFormattedAddress",
    "location",
    "rating",
    "userRatingCount",
    "currentOpeningHours.openNow",
    "googleMapsUri",
    "websiteUri",
    "photos",
    "nationalPhoneNumber",
]
# Extra fields for "which place is best for X" questions (Places API New, Enterprise + Atmosphere).
REVIEW_FIELDS = PLACE_FIELDS + ["reviews", "reviewSummary", "generativeSummary", "editorialSummary", "priceLevel"]


@dataclass
class Route:
    provider: str
    duration_s: float
    distance_m: float
    path: list[LatLng]
    summary: str = ""
    steps: list[str] = field(default_factory=list)
    static_duration_s: float | None = None  # duration without traffic (Routes API only)
    tolls: str | None = None  # Routes API only: "AED 8", "tolls (price unknown)", "no tolls"; None = unknown

    @property
    def traffic_delay_s(self) -> float | None:
        if self.static_duration_s is None:
            return None
        return max(0.0, self.duration_s - self.static_duration_s)

    def to_ui(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "duration_s": round(self.duration_s),
            "distance_m": round(self.distance_m),
            "summary": self.summary,
            "polyline": encode_polyline(self.path),
            "traffic_delay_s": None if self.traffic_delay_s is None else round(self.traffic_delay_s),
            "tolls": self.tolls,
        }


class MapsError(Exception):
    pass


class Maps:
    def __init__(self, api_key: str) -> None:
        self.api_key = api_key
        self.http = httpx.AsyncClient(timeout=15)
        # Flipped off after the first PERMISSION_DENIED so we don't keep paying the round trip.
        self.routes_api_enabled = True
        self.grounding_lite_enabled = True

    # ---------- Places API (New) ----------

    def place(self, p: dict[str, Any], origin: LatLng | None) -> dict[str, Any]:
        """Card/marker-ready fields for a raw Places API place."""
        return self._place(p, origin)

    def _place(self, p: dict[str, Any], origin: LatLng | None) -> dict[str, Any]:
        loc = p.get("location", {})
        latlng = (loc.get("latitude"), loc.get("longitude"))
        return {
            "id": p.get("id"),
            "name": p.get("displayName", {}).get("text", "Unknown"),
            "address": p.get("shortFormattedAddress") or p.get("formattedAddress", ""),
            "lat": latlng[0],
            "lng": latlng[1],
            "distance_m": round(haversine(origin, latlng)) if origin and latlng[0] is not None else None,
            "rating": p.get("rating"),
            "ratings": p.get("userRatingCount"),
            "open_now": p.get("currentOpeningHours", {}).get("openNow"),
            "maps_url": p.get("googleMapsUri"),
            "website": p.get("websiteUri"),
            "phone": p.get("nationalPhoneNumber"),
            # Resource name only; the browser loads it through /api/place-photo so the key stays server-side.
            "photo": (p.get("photos") or [{}])[0].get("name"),
        }

    async def _places_post(self, path: str, body: dict[str, Any], fields: list[str]) -> list[dict[str, Any]]:
        r = await self.http.post(
            f"{PLACES_URL}:{path}",
            json=body,
            headers={
                "X-Goog-Api-Key": self.api_key,
                "X-Goog-FieldMask": ",".join(f"places.{f}" for f in fields),
            },
        )
        if r.status_code != 200:
            raise MapsError(f"Places {path} failed: {r.status_code} {r.text[:200]}")
        return r.json().get("places", [])

    async def nearby(
        self, origin: LatLng, category: str, query: str | None = None, radius_m: int = 5000, limit: int = 5
    ) -> list[dict[str, Any]]:
        circle = {"center": {"latitude": origin[0], "longitude": origin[1]}, "radius": float(radius_m)}
        if category in TEXT_QUERIES and not query:
            places = await self._places_post(
                "searchText",
                {
                    "textQuery": TEXT_QUERIES[category],
                    "includedType": CATEGORY_TYPES[category][0],
                    "strictTypeFiltering": True,
                    "rankPreference": "DISTANCE",
                    "pageSize": 20,
                    "locationBias": {"circle": circle},
                },
                PLACE_FIELDS,
            )
        elif category in CATEGORY_TYPES and not query:
            places = await self._places_post(
                "searchNearby",
                {
                    "includedPrimaryTypes": CATEGORY_TYPES[category],
                    "maxResultCount": 20,
                    "rankPreference": "DISTANCE",
                    "locationRestriction": {"circle": circle},
                },
                PLACE_FIELDS,
            )
        else:
            text = query or category.replace("_", " ")
            places = await self._places_post(
                "searchText",
                {"textQuery": text, "pageSize": limit, "locationBias": {"circle": circle}},
                PLACE_FIELDS,
            )
        results = [self._place(p, origin) for p in places]
        min_reviews = MIN_REVIEWS.get(category, 0)
        results = [p for p in results if (p["ratings"] or 0) >= min_reviews] or results
        results.sort(key=lambda p: p["distance_m"] if p["distance_m"] is not None else 1e12)
        return results[:limit]

    async def places(self, method: str, body: dict[str, Any], fields: list[str]) -> list[dict[str, Any]]:
        """Raw Places API (New) searchNearby / searchText; returns the unparsed place dicts."""
        return await self._places_post(method, body, fields)

    async def search_along_route(
        self, query: str, included_type: str, path: list[LatLng], origin: LatLng, fields: list[str], limit: int = 20
    ) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        """Text search restricted to places along a route; pairs each place with its routing summary
        (legs origin → place → end of route, which gives the detour cost)."""
        r = await self.http.post(
            f"{PLACES_URL}:searchText",
            json={
                "textQuery": query,
                **({"includedType": included_type} if included_type else {}),
                "pageSize": limit,
                "searchAlongRouteParameters": {"polyline": {"encodedPolyline": encode_polyline(path)}},
                "routingParameters": {"origin": {"latitude": origin[0], "longitude": origin[1]}},
            },
            headers={
                "X-Goog-Api-Key": self.api_key,
                "X-Goog-FieldMask": ",".join([*(f"places.{f}" for f in fields), "routingSummaries"]),
            },
        )
        if r.status_code != 200:
            raise MapsError(f"Search along route failed: {r.status_code} {r.text[:200]}")
        data = r.json()
        places = data.get("places", [])
        summaries = data.get("routingSummaries", [{}] * len(places))
        return list(zip(places, summaries))

    async def place_details(self, place_id: str, fields: list[str]) -> dict[str, Any]:
        r = await self.http.get(
            f"{PLACES_URL}/{place_id}",
            params={"fields": ",".join(fields)},
            headers={"X-Goog-Api-Key": self.api_key},
        )
        if r.status_code != 200:
            raise MapsError(f"Place details failed: {r.status_code} {r.text[:200]}")
        return r.json()

    async def search_with_reviews(self, origin: LatLng, query: str, radius_m: int = 8000, limit: int = 8) -> list[dict[str, Any]]:
        """Text search that also returns up to 5 reviews and Google's AI review summary per place."""
        places = await self._places_post(
            "searchText",
            {
                "textQuery": query,
                "pageSize": limit,
                "locationBias": {
                    "circle": {"center": {"latitude": origin[0], "longitude": origin[1]}, "radius": float(radius_m)}
                },
            },
            REVIEW_FIELDS,
        )
        out = []
        for p in places:
            place = self._place(p, origin)
            place["reviews"] = [
                {
                    "rating": r.get("rating"),
                    "text": (r.get("text") or r.get("originalText") or {}).get("text", ""),
                    "author": r.get("authorAttribution", {}).get("displayName", "Google user"),
                    "when": r.get("relativePublishTimeDescription"),
                }
                for r in p.get("reviews", [])
            ]
            place["review_summary"] = (p.get("reviewSummary") or {}).get("text", {}).get("text")
            place["overview"] = ((p.get("generativeSummary") or {}).get("overview") or {}).get("text") or (
                p.get("editorialSummary") or {}
            ).get("text")
            place["price_level"] = p.get("priceLevel")
            out.append(place)
        return out

    async def photo_url(self, photo_name: str, max_width: int = 480) -> str:
        """Resolve a Places photo resource name to a short-lived, key-less googleusercontent URL."""
        r = await self.http.get(
            f"https://places.googleapis.com/v1/{photo_name}/media",
            params={"maxWidthPx": max_width, "skipHttpRedirect": "true"},
            headers={"X-Goog-Api-Key": self.api_key},
        )
        if r.status_code != 200:
            raise MapsError(f"Place photo failed: {r.status_code}")
        return r.json()["photoUri"]

    async def geocode(self, text: str, near: LatLng | None) -> dict[str, Any]:
        body: dict[str, Any] = {"textQuery": text, "pageSize": 1}
        if near:
            body["locationBias"] = {
                "circle": {"center": {"latitude": near[0], "longitude": near[1]}, "radius": 50000.0}
            }
        places = await self._places_post("searchText", body, PLACE_FIELDS)
        if not places:
            raise MapsError(f"Could not find a place called '{text}'")
        return self._place(places[0], near)

    async def locality(self, origin: LatLng) -> str:
        """Human-readable neighbourhood + city for the given point (Places reverse lookup)."""
        try:
            places = await self._places_post(
                "searchNearby",
                {
                    "maxResultCount": 1,
                    "rankPreference": "DISTANCE",
                    "locationRestriction": {
                        "circle": {"center": {"latitude": origin[0], "longitude": origin[1]}, "radius": 500.0}
                    },
                },
                ["addressComponents"],
            )
        except MapsError as e:
            log.warning("locality lookup failed: %s", e)
            return ""
        if not places:
            return ""
        parts: dict[str, str] = {}
        for c in places[0].get("addressComponents", []):
            for t in c.get("types", []):
                parts.setdefault(t, c.get("longText", ""))
        area = parts.get("sublocality_level_1") or parts.get("neighborhood") or ""
        city = parts.get("locality") or parts.get("administrative_area_level_2") or ""
        return ", ".join(x for x in (area, city) if x)

    async def nearest_landmark(self, origin: LatLng) -> dict[str, Any] | None:
        """The closest named place (shop, building, landmark) within 300 m, for "where am I?"."""
        try:
            places = await self._places_post(
                "searchNearby",
                {
                    "maxResultCount": 1,
                    "rankPreference": "DISTANCE",
                    "locationRestriction": {
                        "circle": {"center": {"latitude": origin[0], "longitude": origin[1]}, "radius": 300.0}
                    },
                    "languageCode": "en",
                },
                ["displayName", "shortFormattedAddress", "location"],
            )
        except MapsError as e:
            log.warning("nearest landmark lookup failed: %s", e)
            return None
        if not places:
            return None
        p = places[0]
        at = p.get("location") or {}
        return {
            "name": (p.get("displayName") or {}).get("text", ""),
            "address": p.get("shortFormattedAddress"),
            "distance_m": haversine(origin, (at.get("latitude", origin[0]), at.get("longitude", origin[1]))),
        }

    # ---------- Weather API ----------

    async def _weather(self, path: str, at: LatLng, **params: Any) -> dict[str, Any]:
        r = await self.http.get(
            f"{WEATHER_URL}/{path}",
            params={"location.latitude": at[0], "location.longitude": at[1], **params},
            headers={"X-Goog-Api-Key": self.api_key},
        )
        if r.status_code == 403:
            raise MapsError("Weather isn't available: the Weather API isn't enabled for this Google key.")
        if r.status_code != 200:
            raise MapsError(f"Weather lookup failed: {r.status_code} {r.text[:200]}")
        return r.json()

    async def weather_now(self, at: LatLng) -> dict[str, Any]:
        d = await self._weather("currentConditions:lookup", at)
        return _weather_brief(d)

    async def weather_at(self, at: LatLng, in_hours: float) -> dict[str, Any]:
        """Hourly forecast for the hour `in_hours` from now (e.g. at the driver's ETA)."""
        hours = max(1, min(240, int(in_hours) + 1))
        d = await self._weather("forecast/hours:lookup", at, hours=hours)
        slots = d.get("forecastHours", [])
        if not slots:
            raise MapsError("No forecast available for that place.")
        return _weather_brief(slots[min(int(in_hours), len(slots) - 1)])

    # ---------- Fuel prices (Places fuelOptions) ----------

    async def fuel_stations(self, origin: LatLng, radius_m: int = 6000, limit: int = 12) -> list[dict[str, Any]]:
        """Nearby petrol stations with Google's fuel prices where it has them (coverage varies by country)."""
        raw = await self._places_post(
            "searchNearby",
            {
                "includedPrimaryTypes": ["gas_station"],
                "maxResultCount": 20,
                "rankPreference": "DISTANCE",
                "locationRestriction": {
                    "circle": {"center": {"latitude": origin[0], "longitude": origin[1]}, "radius": float(radius_m)}
                },
            },
            [*PLACE_FIELDS, "fuelOptions"],
        )
        out = []
        for p in raw[:limit]:
            place = self._place(p, origin)
            place["fuel_prices"] = {
                fp["type"]: {
                    "amount": int(fp["price"].get("units", 0)) + fp["price"].get("nanos", 0) / 1e9,
                    "currency": fp["price"].get("currencyCode", ""),
                    "updated": fp.get("updateTime"),
                }
                for fp in (p.get("fuelOptions") or {}).get("fuelPrices", [])
                if fp.get("price")
            }
            out.append(place)
        return out

    # ---------- Routing ----------

    async def routes(
        self,
        origin: LatLng,
        dest: LatLng,
        via: LatLng | None = None,
        *,
        stops: list[LatLng] | None = None,
        avoid: frozenset[str] = frozenset(),
    ) -> list[Route]:
        """Driving routes. `stops` are real stops (waypoints) in order; `via` is a pass-through point used to
        force detours. `avoid` ⊆ {"tolls", "highways", "ferries"} (Routes API only; OSRM ignores it)."""
        stops = stops or []
        if self.routes_api_enabled:
            try:
                return await self._google_routes(origin, dest, via, stops, avoid)
            except MapsError as e:
                if "PERMISSION_DENIED" in str(e) or "403" in str(e):
                    log.warning("Routes API not enabled for this key; using OSRM fallback (no live traffic)")
                    self.routes_api_enabled = False
                else:
                    log.warning("Routes API error, falling back to OSRM: %s", e)
        return await self._osrm_routes(origin, dest, via, stops)

    async def _google_routes(
        self, origin: LatLng, dest: LatLng, via: LatLng | None, stops: list[LatLng], avoid: frozenset[str]
    ) -> list[Route]:
        def wp(p: LatLng) -> dict[str, Any]:
            return {"location": {"latLng": {"latitude": p[0], "longitude": p[1]}}}

        body: dict[str, Any] = {
            "origin": wp(origin),
            "destination": wp(dest),
            "travelMode": "DRIVE",
            "routingPreference": "TRAFFIC_AWARE",
            "polylineQuality": "OVERVIEW",
            "languageCode": "en",  # road names / turn text in English (else local script, e.g. Arabic in Dubai)
            "extraComputations": ["TOLLS"],
            "routeModifiers": {
                "avoidTolls": "tolls" in avoid,
                "avoidHighways": "highways" in avoid,
                "avoidFerries": "ferries" in avoid,
            },
        }
        intermediates = [wp(s) for s in stops] + ([{**wp(via), "via": True}] if via else [])
        if intermediates:
            body["intermediates"] = intermediates
        else:
            body["computeAlternativeRoutes"] = True
        r = await self.http.post(
            ROUTES_URL,
            json=body,
            headers={
                "X-Goog-Api-Key": self.api_key,
                "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters,"
                "routes.polyline.encodedPolyline,routes.description,"
                "routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters,"
                "routes.travelAdvisory.tollInfo",
            },
        )
        if r.status_code != 200:
            raise MapsError(f"Routes API {r.status_code}: {r.text[:300]}")
        out: list[Route] = []
        for rt in r.json().get("routes", []):
            steps = []
            for leg in rt.get("legs", []):
                for s in leg.get("steps", []):
                    instr = s.get("navigationInstruction", {}).get("instructions")
                    if instr:
                        steps.append(f"{instr.replace(chr(10), ' ')} ({s.get('distanceMeters', 0)} m)")
            out.append(
                Route(
                    provider="google",
                    duration_s=float(rt.get("duration", "0s").rstrip("s")),
                    static_duration_s=float(rt.get("staticDuration", "0s").rstrip("s")),
                    distance_m=float(rt.get("distanceMeters", 0)),
                    path=decode_polyline(rt["polyline"]["encodedPolyline"]),
                    summary=rt.get("description", ""),
                    steps=steps,
                    tolls=_toll_text(rt.get("travelAdvisory", {})),
                )
            )
        return out

    async def _osrm_routes(self, origin: LatLng, dest: LatLng, via: LatLng | None, stops: list[LatLng]) -> list[Route]:
        pts = [origin, *stops, *([via] if via else []), dest]
        coords = ";".join(f"{p[1]:.6f},{p[0]:.6f}" for p in pts)
        r = await self.http.get(
            f"{OSRM_URL}/{coords}",
            params={
                "alternatives": "false" if via or stops else "3",
                "overview": "full",
                "steps": "true",
                "geometries": "polyline",
            },
        )
        data = r.json()
        if data.get("code") != "Ok":
            raise MapsError(f"Routing failed: {data.get('message', data.get('code'))}")
        out: list[Route] = []
        for rt in data["routes"]:
            steps, names = [], []
            for leg in rt["legs"]:
                for s in leg["steps"]:
                    m = s["maneuver"]
                    if m["type"] in ("depart", "arrive"):
                        continue
                    name = s.get("name") or "the road"
                    if s.get("name") and s["distance"] > 500:
                        names.append(s["name"])
                    turn = f"{m['type']} {m.get('modifier', '')}".strip().replace("new name", "continue")
                    steps.append(f"{turn.capitalize()} onto {name} ({round(s['distance'])} m)")
            summary = "via " + ", ".join(dict.fromkeys(names[:3])) if names else ""
            out.append(
                Route(
                    provider="osrm",
                    duration_s=rt["duration"],
                    distance_m=rt["distance"],
                    path=decode_polyline(rt["geometry"]),
                    summary=summary,
                    steps=steps,
                )
            )
        return out

    # ---------- Maps Grounding Lite (MCP over streamable HTTP) ----------

    async def ask_maps(self, question: str, near: LatLng | None) -> dict[str, Any]:
        """Grounded answer from Google Maps. Falls back to Places Text Search."""
        if self.grounding_lite_enabled:
            args: dict[str, Any] = {"textQuery": question}
            if near:
                args["locationBias"] = {
                    "circle": {"center": {"latitude": near[0], "longitude": near[1]}, "radiusMeters": 10000}
                }
            try:
                r = await self.http.post(
                    GROUNDING_LITE_URL,
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": {"name": "search_places", "arguments": args},
                    },
                    headers={
                        "X-Goog-Api-Key": self.api_key,
                        "Accept": "application/json, text/event-stream",
                    },
                )
                result = r.json().get("result", {})
                text = "\n".join(c.get("text", "") for c in result.get("content", []))
                if result.get("isError"):
                    raise MapsError(text)
                return {"source": "grounding_lite", "answer": text, "structured": result.get("structuredContent")}
            except (MapsError, httpx.HTTPError, ValueError) as e:
                if "blocked" in str(e) or "PERMISSION" in str(e):
                    log.warning("Maps Grounding Lite not enabled for this key; using Places Text Search")
                    self.grounding_lite_enabled = False
                else:
                    log.warning("Grounding Lite error: %s", e)
        places = await self.nearby(near or (0, 0), "text", query=question, radius_m=10000)
        return {"source": "places_text_search", "places": places}


def _toll_text(advisory: dict[str, Any]) -> str:
    """Routes API tollInfo → short spoken text. Absent tollInfo means the route has no tolls."""
    if "tollInfo" not in advisory:
        return "no tolls"
    prices = advisory["tollInfo"].get("estimatedPrice") or []
    if not prices:
        return "has tolls (price unknown)"
    parts = []
    for p in prices:
        amount = int(p.get("units", 0)) + p.get("nanos", 0) / 1e9
        parts.append(f"{p.get('currencyCode', '')} {amount:.2f}".rstrip("0").rstrip("."))
    return " + ".join(parts)


def _weather_brief(d: dict[str, Any]) -> dict[str, Any]:
    """The few fields worth saying out loud while driving."""
    wc = d.get("weatherCondition") or {}
    cond = wc.get("description", {}).get("text")
    precip = (d.get("precipitation") or {}).get("probability", {}).get("percent")
    out: dict[str, Any] = {
        "conditions": cond,
        "temperature_c": (d.get("temperature") or {}).get("degrees"),
        "feels_like_c": (d.get("feelsLikeTemperature") or {}).get("degrees"),
        "chance_of_rain_pct": precip,
        "wind_kmh": ((d.get("wind") or {}).get("speed") or {}).get("value"),
        "visibility_km": ((d.get("visibility") or {}).get("distance")),
    }
    if wc.get("iconBaseUri"):
        out["icon"] = wc["iconBaseUri"] + "_dark.svg"  # Google's condition icon, dark-theme variant
    if (d.get("interval") or {}).get("startTime"):
        out["for_time"] = d["interval"]["startTime"]
    return {k: v for k, v in out.items() if v is not None}
