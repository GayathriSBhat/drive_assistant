"""Live car-park availability from open APIs, where a city publishes one.

Providers (only called when the target is inside their coverage):
  * Singapore HDB car parks — data.gov.sg, no key: ~2,000 public car parks, free lots per minute.
  * Singapore LTA DataMall — malls, attractions and URA/HDB car parks; needs a free AccountKey
    (set LTA_ACCOUNT_KEY). Untested here without a key.

Dubai (RTA / PRKN) and most Indian cities don't publish live occupancy openly — there the
web check in parking_web.py reports where live counts can be seen instead (e.g. a mall's app).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

import httpx

from .geo import LatLng, haversine
from .svy21 import to_latlng

log = logging.getLogger("parking_live")


class HDBSingapore:
    name = "Singapore HDB car parks (data.gov.sg)"
    INFO_URL = "https://data.gov.sg/api/action/datastore_search"
    INFO_RESOURCE = "d_23f946fa557947f93a8043bbef41dd09"  # HDB Carpark Information
    AVAIL_URL = "https://api.data.gov.sg/v1/transport/carpark-availability"
    BBOX = (1.15, 1.48, 103.6, 104.1)  # lat_min, lat_max, lng_min, lng_max

    def __init__(self) -> None:
        self._info: dict[str, dict[str, Any]] | None = None
        self._avail: tuple[float, list[dict[str, Any]]] | None = None
        self._lock = asyncio.Lock()

    def covers(self, p: LatLng) -> bool:
        return self.BBOX[0] <= p[0] <= self.BBOX[1] and self.BBOX[2] <= p[1] <= self.BBOX[3]

    async def _load_info(self, http: httpx.AsyncClient) -> dict[str, dict[str, Any]]:
        async with self._lock:
            if self._info is None:
                r = await http.get(self.INFO_URL, params={"resource_id": self.INFO_RESOURCE, "limit": 5000})
                info = {}
                for rec in r.json()["result"]["records"]:
                    try:
                        lat, lng = to_latlng(float(rec["y_coord"]), float(rec["x_coord"]))
                    except (KeyError, ValueError):
                        continue
                    info[rec["car_park_no"]] = {
                        "address": rec.get("address", "").title(),
                        "lat": lat,
                        "lng": lng,
                        "type": (rec.get("car_park_type") or "").title(),
                        "free_parking": rec.get("free_parking"),
                        "gantry_m": rec.get("gantry_height"),
                    }
                self._info = info
                log.info("loaded %d HDB car parks", len(info))
            return self._info

    async def _availability(self, http: httpx.AsyncClient) -> list[dict[str, Any]]:
        if self._avail and time.time() - self._avail[0] < 60:  # the feed updates about once a minute
            return self._avail[1]
        r = await http.get(self.AVAIL_URL)
        data = r.json()["items"][0]["carpark_data"]
        self._avail = (time.time(), data)
        return data

    async def near(self, http: httpx.AsyncClient, target: LatLng, radius_m: float) -> list[dict[str, Any]]:
        info, avail = await asyncio.gather(self._load_info(http), self._availability(http))
        out = []
        for cp in avail:
            meta = info.get(cp["carpark_number"])
            if not meta:
                continue
            d = haversine(target, (meta["lat"], meta["lng"]))
            if d > radius_m:
                continue
            cars = next((x for x in cp["carpark_info"] if x.get("lot_type") == "C"), None)
            if not cars:
                continue
            free_note = meta["free_parking"] if meta["free_parking"] not in (None, "", "NO") else None
            gantry = meta["gantry_m"]
            try:
                gantry = None if not gantry or float(gantry) >= 9 else gantry  # 9.99 = open-air, no height limit
            except ValueError:
                gantry = None
            out.append(
                {
                    "name": meta["address"],
                    "lat": meta["lat"],
                    "lng": meta["lng"],
                    "free": int(cars["lots_available"]),
                    "total": int(cars["total_lots"]),
                    "updated": cp.get("update_datetime"),
                    "kind": meta["type"] or "Car park",
                    "notes": [n for n in (f"Free {free_note.replace('FR ', '').replace('SUN & PH', 'Sun & PH')}" if free_note else None,
                                          f"Height limit {gantry} m" if gantry else None) if n],
                    "source": self.name,
                    "source_url": "https://data.gov.sg/datasets?query=carpark+availability",
                }
            )
        return out


class LTASingapore:
    """LTA DataMall CarParkAvailabilityv2 — covers malls/attractions (e.g. Orchard, Marina Bay)."""

    name = "Singapore LTA DataMall"
    URL = "https://datamall2.mytransport.sg/ltaodataservice/CarParkAvailabilityv2"
    BBOX = HDBSingapore.BBOX

    def __init__(self) -> None:
        self.key = os.getenv("LTA_ACCOUNT_KEY")
        self._cache: tuple[float, list[dict[str, Any]]] | None = None

    def covers(self, p: LatLng) -> bool:
        return bool(self.key) and self.BBOX[0] <= p[0] <= self.BBOX[1] and self.BBOX[2] <= p[1] <= self.BBOX[3]

    async def _all(self, http: httpx.AsyncClient) -> list[dict[str, Any]]:
        if self._cache and time.time() - self._cache[0] < 60:
            return self._cache[1]
        rows: list[dict[str, Any]] = []
        for skip in range(0, 5000, 500):  # OData paging, 500 rows per page
            r = await http.get(self.URL, params={"$skip": skip}, headers={"AccountKey": self.key, "accept": "application/json"})
            page = r.json().get("value", [])
            rows += page
            if len(page) < 500:
                break
        self._cache = (time.time(), rows)
        return rows

    async def near(self, http: httpx.AsyncClient, target: LatLng, radius_m: float) -> list[dict[str, Any]]:
        out = []
        for row in await self._all(http):
            if row.get("LotType") != "C" or row.get("Agency") == "HDB":  # HDB comes from data.gov.sg with totals
                continue
            try:
                lat, lng = map(float, row["Location"].split())
            except (KeyError, ValueError):
                continue
            if haversine(target, (lat, lng)) > radius_m:
                continue
            out.append(
                {
                    "name": row.get("Development") or row.get("CarParkID"),
                    "lat": lat,
                    "lng": lng,
                    "free": int(row["AvailableLots"]),
                    "total": None,
                    "updated": None,  # the feed is refreshed every minute
                    "kind": "Car park",
                    "notes": [],
                    "source": self.name,
                    "source_url": "https://datamall.lta.gov.sg/",
                }
            )
        return out


PROVIDERS = [LTASingapore(), HDBSingapore()]


def coverage(target: LatLng) -> list[str]:
    return [p.name for p in PROVIDERS if p.covers(target)]


async def live_lots_near(http: httpx.AsyncClient, target: LatLng, radius_m: float = 900) -> list[dict[str, Any]]:
    """Live car-park availability around `target` from every provider that covers it."""
    providers = [p for p in PROVIDERS if p.covers(target)]
    if not providers:
        return []
    results = await asyncio.gather(*(p.near(http, target, radius_m) for p in providers), return_exceptions=True)
    lots: list[dict[str, Any]] = []
    for provider, res in zip(providers, results):
        if isinstance(res, Exception):
            log.warning("%s failed: %s", provider.name, res)
            continue
        lots += res
    for lot in lots:
        lot["distance_m"] = round(haversine(target, (lot["lat"], lot["lng"])))
    return sorted(lots, key=lambda l: l["distance_m"])
