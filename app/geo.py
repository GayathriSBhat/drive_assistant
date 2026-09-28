"""Small geometry helpers: haversine, polyline codec, point-to-route distance."""

from __future__ import annotations

import math

LatLng = tuple[float, float]

EARTH_R = 6_371_000.0


def haversine(a: LatLng, b: LatLng) -> float:
    """Distance in metres between two (lat, lng) points."""
    lat1, lng1 = map(math.radians, a)
    lat2, lng2 = map(math.radians, b)
    dlat, dlng = lat2 - lat1, lng2 - lng1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(h))


def bearing(a: LatLng, b: LatLng) -> float:
    """Initial compass bearing from a to b, degrees 0-360."""
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlng = math.radians(b[1] - a[1])
    x = math.sin(dlng) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlng)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def offset(p: LatLng, bearing_deg: float, dist_m: float) -> LatLng:
    """Point dist_m away from p along bearing_deg."""
    lat, lng = map(math.radians, p)
    brg, d = math.radians(bearing_deg), dist_m / EARTH_R
    lat2 = math.asin(math.sin(lat) * math.cos(d) + math.cos(lat) * math.sin(d) * math.cos(brg))
    lng2 = lng + math.atan2(math.sin(brg) * math.sin(d) * math.cos(lat), math.cos(d) - math.sin(lat) * math.sin(lat2))
    return math.degrees(lat2), math.degrees(lng2)


def decode_polyline(encoded: str, precision: int = 5) -> list[LatLng]:
    coords: list[LatLng] = []
    index = lat = lng = 0
    factor = 10**precision
    while index < len(encoded):
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += delta
            else:
                lng += delta
        coords.append((lat / factor, lng / factor))
    return coords


def encode_polyline(coords: list[LatLng], precision: int = 5) -> str:
    factor = 10**precision
    out: list[str] = []
    prev_lat = prev_lng = 0
    for lat, lng in coords:
        ilat, ilng = round(lat * factor), round(lng * factor)
        for delta in (ilat - prev_lat, ilng - prev_lng):
            v = ~(delta << 1) if delta < 0 else delta << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        prev_lat, prev_lng = ilat, ilng
    return "".join(out)


def _point_segment_distance(p: LatLng, a: LatLng, b: LatLng) -> float:
    # Equirectangular projection around p is accurate enough at city scale.
    k = math.cos(math.radians(p[0]))
    ax, ay = (a[1] - p[1]) * k, a[0] - p[0]
    bx, by = (b[1] - p[1]) * k, b[0] - p[0]
    dx, dy = bx - ax, by - ay
    seg2 = dx * dx + dy * dy
    t = 0.0 if seg2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / seg2))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(cx, cy) * (math.pi / 180) * EARTH_R


def distance_to_path(p: LatLng, path: list[LatLng]) -> tuple[float, int]:
    """Minimum distance (m) from p to the polyline and the index of the closest segment."""
    if len(path) == 1:
        return haversine(p, path[0]), 0
    best, best_i = float("inf"), 0
    for i in range(len(path) - 1):
        d = _point_segment_distance(p, path[i], path[i + 1])
        if d < best:
            best, best_i = d, i
    return best, best_i


def path_length(path: list[LatLng], start: int = 0, end: int | None = None) -> float:
    end = len(path) - 1 if end is None else end
    return sum(haversine(path[i], path[i + 1]) for i in range(start, end))
