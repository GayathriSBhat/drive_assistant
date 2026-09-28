"""EV charging station finder and smart parking finder (Places API New).

EV: connector types, max power and — where the operator shares it — live free/busy port counts
(`evChargeOptions`). Searches around the driver or along the active route (with detour cost).

Parking: parking lots/garages near a destination ranked by walking time, opening status, rating
and the driver's preference, plus the destination's own parking (valet, lot, street) and what its
reviewers say about parking there. Google has no live occupancy data for parking, so the ranking
never claims a spot is free.
"""

from __future__ import annotations

import re
from typing import Any

from .geo import LatLng, haversine
from .maps import PLACE_FIELDS, Maps

# ------------------------------------------------------------------ EV chargers

CONNECTOR_LABELS = {
    "EV_CONNECTOR_TYPE_CCS_COMBO_2": "CCS2",
    "EV_CONNECTOR_TYPE_CCS_COMBO_1": "CCS1",
    "EV_CONNECTOR_TYPE_TYPE_2": "Type 2",
    "EV_CONNECTOR_TYPE_CHADEMO": "CHAdeMO",
    "EV_CONNECTOR_TYPE_GB_T": "GB/T",
    "EV_CONNECTOR_TYPE_J1772": "J1772",
    "EV_CONNECTOR_TYPE_TESLA": "Tesla",
    "EV_CONNECTOR_TYPE_NACS": "NACS",
    "EV_CONNECTOR_TYPE_UNSPECIFIED_WALL_OUTLET": "Wall socket",
    "EV_CONNECTOR_TYPE_UNSPECIFIED_GB_T": "GB/T",
    "EV_CONNECTOR_TYPE_OTHER": "Other",
}
EV_FIELDS = PLACE_FIELDS + ["evChargeOptions", "parkingOptions"]
FAST_KW = 25          # DC fast charging threshold
CAR_MIN_KW = 7        # below this it's a 2/3-wheeler or slow wall socket
KM_PER_KWH = 6.5      # typical Indian compact EV (Nexon/ZS/Tiago EV ballpark)
CAR_MAX_ACCEPT_KW = 60  # most cars can't take more than this on DC


def _ev_ports(p: dict[str, Any]) -> list[dict[str, Any]]:
    ports = []
    for a in p.get("evChargeOptions", {}).get("connectorAggregation", []):
        ports.append(
            {
                "type": CONNECTOR_LABELS.get(a.get("type", ""), "Unknown"),
                "kw": round(a["maxChargeRateKw"], 1) if a.get("maxChargeRateKw") else None,
                "count": a.get("count", 0),
                "available": a.get("availableCount"),
                "out_of_service": a.get("outOfServiceCount"),
            }
        )
    return ports


def _range_added_km(kw: float | None, minutes: int = 30) -> int | None:
    if not kw:
        return None
    return round(min(kw, CAR_MAX_ACCEPT_KW) * minutes / 60 * KM_PER_KWH / 10) * 10


def _ev_card(maps: Maps, p: dict[str, Any], origin: LatLng, ports: list[dict[str, Any]]) -> dict[str, Any]:
    place = maps.place(p, origin)
    max_kw = max((x["kw"] or 0 for x in ports), default=0) or None
    known = [x for x in ports if x["available"] is not None]
    total = sum(x["count"] for x in ports)
    free = sum(x["available"] for x in known) if known else None
    if free is None:
        status, badge = "unknown", ("Status unknown", "neutral")
    elif free > 0:
        status, badge = "free", (f"{free}/{total} free", "good")
    else:
        status, badge = "busy", ("All busy", "bad")
    tags = [f'{x["type"]}{f" · {x["kw"]:g} kW" if x["kw"] else ""} ×{x["count"]}' for x in ports]
    if max_kw and max_kw >= FAST_KW:
        tags.insert(0, "DC fast")
    park = p.get("parkingOptions", {})
    if park.get("freeParkingLot") or park.get("freeStreetParking"):
        tags.append("Free parking")
    return {
        **place,
        "badge": {"text": badge[0], "tone": badge[1]},
        "tags": tags,
        "status": status,
        "free_ports": free,
        "total_ports": total or None,
        "max_kw": max_kw,
        "range_30min_km": _range_added_km(max_kw),
    }


def _matches_connector(ports: list[dict[str, Any]], connector: str) -> bool:
    if connector == "any":
        return True
    want = connector.lower().replace(" ", "")
    return any(want in x["type"].lower().replace(" ", "") for x in ports)


async def find_chargers(
    maps: Maps,
    origin: LatLng,
    *,
    route_path: list[LatLng] | None = None,
    route_duration_s: float | None = None,
    vehicle: str = "car",
    connector: str = "any",
    fast_only: bool = False,
    range_km: float | None = None,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Ranked chargers. Ranking = drive minutes + detour + a penalty for busy/unknown ports,
    minus a bonus for charging power (so a free 60 kW charger 2 minutes further beats a busy one)."""
    results: list[dict[str, Any]] = []
    if route_path:
        pairs = await maps.search_along_route(
            "EV charging station", "electric_vehicle_charging_station", route_path, origin, EV_FIELDS
        )
        for p, summary in pairs:
            legs = summary.get("legs", [])
            via_s = sum(float(leg.get("duration", "0s").rstrip("s")) for leg in legs)
            card = _ev_card(maps, p, origin, _ev_ports(p))
            card["drive_min"] = round(float(legs[0].get("duration", "0s").rstrip("s")) / 60) if legs else None
            card["detour_min"] = (
                max(0, round((via_s - route_duration_s) / 60)) if legs and route_duration_s else None
            )
            card["_ports"] = _ev_ports(p)
            results.append(card)
    else:
        raw = await maps.places(
            "searchNearby",
            {
                "includedPrimaryTypes": ["electric_vehicle_charging_station"],
                "maxResultCount": 20,
                "rankPreference": "DISTANCE",
                "locationRestriction": {
                    "circle": {"center": {"latitude": origin[0], "longitude": origin[1]}, "radius": 10000.0}
                },
            },
            EV_FIELDS,
        )
        for p in raw:
            card = _ev_card(maps, p, origin, _ev_ports(p))
            # City driving: ~1.35× straight-line distance at ~22 km/h average.
            card["drive_min"] = max(1, round(card["distance_m"] * 1.35 / 1000 / 22 * 60))
            card["detour_min"] = None
            card["_ports"] = _ev_ports(p)
            results.append(card)

    def keep(c: dict[str, Any]) -> bool:
        ports = c["_ports"]
        if vehicle == "car" and ports and (c["max_kw"] or 0) < CAR_MIN_KW:
            return False
        if fast_only and (c["max_kw"] or 0) < FAST_KW:
            return False
        if not _matches_connector(ports, connector):
            return False
        if range_km and c["distance_m"] * 1.35 > range_km * 1000 * 0.9:  # keep a 10% reserve
            return False
        return c["status"] != "busy" or len(results) < 3

    def rank(c: dict[str, Any]) -> float:
        penalty = {"free": 0, "unknown": 6, "busy": 25}[c["status"]]
        no_data = 4 if not c["_ports"] else 0
        power_bonus = min(c["max_kw"] or 0, CAR_MAX_ACCEPT_KW) / 10
        return (c["drive_min"] or 0) + (c["detour_min"] or 0) + penalty + no_data - power_bonus

    kept = sorted(filter(keep, results), key=rank)
    for c in kept:
        c.pop("_ports", None)
    return kept[:limit]


# ------------------------------------------------------------------ smart parking

PARKING_FIELDS = PLACE_FIELDS + ["parkingOptions", "primaryType", "reviewSummary"]
PARKING_TYPES = {"parking", "parking_lot", "parking_garage"}
# Not car parking: two-wheeler stands, taxi points, bus/truck parking (listings come in many languages
# in Dubai), and EV chargers that Google also tags as parking.
NOT_CAR_PARKING = re.compile(
    r"two[\s-]?wheeler|2[\s-]?wheeler|bike|scooter|charg(ing|er)|supercharger|taxi|pick[\s-]?up|drop[\s-]?off|"
    r"\bbus\b|coach|truck|lorry|автобус|حافل|شاحن", re.I
)
WALK_M_PER_MIN = 75
PARKING_WORDS = re.compile(r"\bpark(ing|ed)?\b|\bvalet\b", re.I)
NEGATIVE_PARKING = re.compile(r"no parking|difficult|challeng|hard to (find|get)|limited|tough|issue|problem|"
                              r"nightmare|not enough|scarce|struggle|tiny|no space|crowded|packed|full|busy|"
                              r"expensive|pricey", re.I)

OPTION_LABELS = {
    "valetParking": "Valet",
    "freeParkingLot": "Free lot",
    "paidParkingLot": "Paid lot",
    "freeGarageParking": "Free garage",
    "paidGarageParking": "Paid garage",
    "freeStreetParking": "Free street parking",
    "paidStreetParking": "Paid street parking",
}


def _parking_labels(options: dict[str, bool]) -> list[str]:
    return [label for key, label in OPTION_LABELS.items() if options.get(key)]


def _prefers(options: dict[str, bool], primary_type: str, preference: str) -> bool:
    if preference == "free":
        return any(v for k, v in options.items() if k.startswith("free"))
    if preference == "covered":
        return primary_type == "parking_garage" or options.get("paidGarageParking") or options.get("freeGarageParking")
    if preference == "valet":
        return bool(options.get("valetParking"))
    if preference == "street":
        return bool(options.get("freeStreetParking") or options.get("paidStreetParking"))
    return True


async def venue_parking(maps: Maps, place_id: str) -> dict[str, Any]:
    """The destination's own parking options and what its reviewers say about parking."""
    d = await maps.place_details(place_id, ["displayName", "parkingOptions", "reviews", "reviewSummary"])
    quotes = []
    for r in d.get("reviews", []):
        text = (r.get("text") or {}).get("text", "")
        for sentence in re.split(r"(?<=[.!?])\s+|\n+", text):
            if PARKING_WORDS.search(sentence) and len(sentence) < 240:
                quotes.append(sentence.strip())
    summary = (d.get("reviewSummary") or {}).get("text", {}).get("text", "")
    if PARKING_WORDS.search(summary):
        quotes.insert(0, summary)
    negative = sum(bool(NEGATIVE_PARKING.search(q)) for q in quotes)
    return {
        "name": d.get("displayName", {}).get("text"),
        "options": _parking_labels(d.get("parkingOptions", {})),
        "what_reviewers_say": quotes[:3],
        "reviewers_complain_about_parking": negative > 0 and negative >= len(quotes) / 2,
    }


async def find_parking(
    maps: Maps, target: LatLng, *, preference: str = "any", limit: int = 5
) -> list[dict[str, Any]]:
    """Parking places near `target`, ranked for a car driver.

    Rank = walking minutes to the target + penalties (closed/unknown hours, poor or few ratings,
    doesn't match the preference). There is no live occupancy data, so we never promise a free spot.
    """
    raw = await maps.places(
        "searchNearby",
        {
            "includedTypes": sorted(PARKING_TYPES),
            "maxResultCount": 20,
            "rankPreference": "DISTANCE",
            "locationRestriction": {
                "circle": {"center": {"latitude": target[0], "longitude": target[1]}, "radius": 1200.0}
            },
        },
        PARKING_FIELDS,
    )
    out = []
    for p in raw:
        primary = p.get("primaryType", "")
        name = p.get("displayName", {}).get("text", "")
        if primary not in PARKING_TYPES or NOT_CAR_PARKING.search(name):
            continue
        card = maps.place(p, target)  # distance measured from the destination, not the driver
        open_now = card["open_now"]
        if open_now is False:
            continue
        options = p.get("parkingOptions", {})
        walk_min = max(1, round(card["distance_m"] * 1.25 / WALK_M_PER_MIN))
        kind = {"parking_garage": "Garage", "parking_lot": "Lot"}.get(primary, "Parking")
        rating, count = card["rating"] or 0, card["ratings"] or 0
        penalty = (
            (2 if open_now is None else 0)
            + (3 if count >= 5 and rating < 3.5 else 0)
            + (1.5 if count < 5 else 0)
            + (6 if not _prefers(options, primary, preference) else 0)
        )
        summary = (p.get("reviewSummary") or {}).get("text", {}).get("text")
        out.append(
            {
                **card,
                "walk_min": walk_min,
                "kind": kind,
                "options": _parking_labels(options),
                "badge": {"text": f"{walk_min} min walk", "tone": "good" if walk_min <= 5 else "neutral"},
                "tags": [kind, *(_parking_labels(options) or []), *(["Open now"] if open_now else [])],
                "quote": summary,
                "quote_source": "summary" if summary else None,
                "_score": walk_min + penalty,
            }
        )
    out.sort(key=lambda c: c["_score"])
    return out[:limit]  # "_score" is kept for merge_live(), which re-ranks and removes it


# ------------------------------------------------------------------ live availability

GENERIC_LOT_NAME = re.compile(r"^\W*(public\s+)?(car\s*)?park(ing)?(\s+(lot|area|garage|entrance))?\W*$", re.I)


def _live_badge(free: int, total: int | None) -> dict[str, str]:
    if free == 0:
        return {"text": "Full · live", "tone": "bad"}
    return {"text": f"{free}{f'/{total}' if total else ''} free · live", "tone": "good" if free >= 10 else "likely"}


def _attach_live(lot: dict[str, Any], live: dict[str, Any]) -> None:
    lot["live"] = {k: live.get(k) for k in ("free", "total", "updated", "source")}
    lot["badge"] = _live_badge(live["free"], live.get("total"))
    updated = live.get("updated")
    extra = [f"Updated {updated[11:16]}" if updated and len(updated) >= 16 else "Live", *live.get("notes", [])]
    lot["tags"] = list(dict.fromkeys([*(lot.get("tags") or [])[:1], *extra]))[:4]


def merge_live(lots: list[dict[str, Any]], live: list[dict[str, Any]], limit: int = 6) -> list[dict[str, Any]]:
    """Attach live counts to matching Google parking places, add car parks only the live feed
    knows, and re-rank: walking time first, then availability (full car parks sink)."""
    unused = list(live)
    for lot in lots:
        near = min(unused, key=lambda l: haversine((lot["lat"], lot["lng"]), (l["lat"], l["lng"])), default=None)
        if near and haversine((lot["lat"], lot["lng"]), (near["lat"], near["lng"])) <= 80:
            unused.remove(near)
            _attach_live(lot, near)
    for l in unused:
        walk = max(1, round(l["distance_m"] * 1.25 / WALK_M_PER_MIN))
        lot = {
            "id": None, "name": l["name"], "address": l["source"], "lat": l["lat"], "lng": l["lng"],
            "distance_m": l["distance_m"], "rating": None, "ratings": None, "open_now": None, "phone": None,
            "photo": None, "website": None,
            "maps_url": f"https://www.google.com/maps/search/?api=1&query={l['lat']:.6f},{l['lng']:.6f}",
            "walk_min": walk, "kind": l.get("kind") or "Car park", "options": [], "tags": [l.get("kind") or "Car park"],
            "_score": walk,
        }
        _attach_live(lot, l)
        lots.append(lot)
    for lot in lots:
        live_info = lot.get("live")
        if live_info:
            free = live_info["free"]
            lot["_score"] += 0 if free >= 10 else 2 if free > 0 else 25
        elif live:
            lot["_score"] += 3  # the city has live data but not for this one
    lots.sort(key=lambda c: c["_score"])
    for lot in lots:
        lot.pop("_score", None)
    return lots[:limit]


def worth_checking_online(lot: dict[str, Any]) -> bool:
    """Named car parks (or ones with a website) are worth a web search; 'Parking Lot' isn't."""
    name = lot["name"] or ""
    named = re.search(r"[A-Za-z]", name) and not GENERIC_LOT_NAME.match(name)
    return not lot.get("live") and (bool(lot.get("website")) or bool(named))


def apply_online(lot: dict[str, Any], online: dict[str, Any] | None) -> None:
    """Fold a web check into a car-park card: live counts if published, else rates / where to see live."""
    if not online:
        return
    lot["online"] = online
    if online.get("live_counts_found") and online.get("free_spaces") is not None:
        lot["badge"] = _live_badge(int(online["free_spaces"]), online.get("total_spaces"))
    elif online.get("live_available_via"):
        lot["tags"] = list(dict.fromkeys([*(lot.get("tags") or []), "Live count in app"]))[:4]
    facts = "; ".join(x for x in (online.get("free_parking"), online.get("rates")) if x)
    if facts:
        lot["quote"], lot["quote_source"] = facts[:220], "web"
    if online.get("source_url"):
        lot["website"] = online["source_url"]
