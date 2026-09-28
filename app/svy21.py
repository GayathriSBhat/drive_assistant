"""SVY21 (Singapore's national grid, EPSG:3414) → WGS84 lat/lng.

Transverse Mercator inverse used by Singapore Land Authority; Singapore's open datasets
(e.g. HDB carpark information) publish coordinates in SVY21.
"""

from __future__ import annotations

from math import cos, pi, sin, tan

_A = 6378137.0
_F = 1 / 298.257223563
_O_LAT = 1.366666      # origin latitude (deg)
_O_LNG = 103.833333    # origin longitude (deg)
_O_N = 38744.572       # false northing
_O_E = 28001.642       # false easting
_K = 1.0               # central meridian scale factor

_B = _A * (1 - _F)
_E2 = 2 * _F - _F * _F
_E4 = _E2 * _E2
_E6 = _E4 * _E2
_A0 = 1 - _E2 / 4 - 3 * _E4 / 64 - 5 * _E6 / 256
_A2 = 3 / 8 * (_E2 + _E4 / 4 + 15 * _E6 / 128)
_A4 = 15 / 256 * (_E4 + 3 * _E6 / 4)
_A6 = 35 * _E6 / 3072


def _meridian_distance(lat_deg: float) -> float:
    r = lat_deg * pi / 180
    return _A * (_A0 * r - _A2 * sin(2 * r) + _A4 * sin(4 * r) - _A6 * sin(6 * r))


def to_latlng(northing: float, easting: float) -> tuple[float, float]:
    n = (_A - _B) / (_A + _B)
    n2, n3, n4 = n**2, n**3, n**4
    g = _A * (1 - n) * (1 - n2) * (1 + 9 * n2 / 4 + 225 * n4 / 64) * (pi / 180)
    m_prime = _meridian_distance(_O_LAT) + (northing - _O_N) / _K
    sigma = (m_prime / g) * pi / 180
    lat_p = (
        sigma
        + (3 * n / 2 - 27 * n3 / 32) * sin(2 * sigma)
        + (21 * n2 / 16 - 55 * n4 / 32) * sin(4 * sigma)
        + (151 * n3 / 96) * sin(6 * sigma)
        + (1097 * n4 / 512) * sin(8 * sigma)
    )
    s2 = sin(lat_p) ** 2
    rho = _A * (1 - _E2) / (1 - _E2 * s2) ** 1.5
    nu = _A / (1 - _E2 * s2) ** 0.5
    psi = nu / rho
    psi2, psi3, psi4 = psi**2, psi**3, psi**4
    t = tan(lat_p)
    t2, t4, t6 = t**2, t**4, t**6
    e_prime = easting - _O_E
    x = e_prime / (_K * nu)
    x3, x5, x7 = x**3, x**5, x**7

    f = t / (_K * rho)
    lat = (
        lat_p
        - f * (e_prime * x / 2)
        + f * (e_prime * x3 / 24) * (-4 * psi2 + 9 * psi * (1 - t2) + 12 * t2)
        - f * (e_prime * x5 / 720) * (
            8 * psi4 * (11 - 24 * t2) - 12 * psi3 * (21 - 71 * t2)
            + 15 * psi2 * (15 - 98 * t2 + 15 * t4) + 180 * psi * (5 * t2 - 3 * t4) + 360 * t4
        )
        + f * (e_prime * x7 / 40320) * (1385 - 3633 * t2 + 4095 * t4 + 1575 * t6)
    )
    sec = 1 / cos(lat_p)
    lng = (
        _O_LNG * pi / 180
        + x * sec
        - (x3 * sec / 6) * (psi + 2 * t2)
        + (x5 * sec / 120) * (-4 * psi3 * (1 - 6 * t2) + psi2 * (9 - 68 * t2) + 72 * psi * t2 + 24 * t4)
        - (x7 * sec / 5040) * (61 + 662 * t2 + 1320 * t4 + 720 * t6)
    )
    return lat * 180 / pi, lng * 180 / pi
