"""Check a place's parking online: web-search it, read the pages (official site first), and pull
out live free-space counts if a page actually publishes them — otherwise capacity, rates, free
parking rules and where a driver *can* see live availability (e.g. the mall's app, RTA/PRKN).

Gemini Flash does the reading, told never to treat capacity as availability or invent numbers.
"""

from __future__ import annotations

import asyncio
import html
import json
import logging
import os
import re
from typing import Any
from urllib.parse import urlparse

import httpx

from .search import web_search

log = logging.getLogger("parking_web")

MAX_PAGES = 3
PAGE_TIMEOUT_S = 7
MAX_PAGE_BYTES = 1_500_000
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36"

PROMPT = """You check whether LIVE parking availability for "{name}" ({city}) is published online,
for a driver who is on the way there. Below are web search results and extracts from pages that
mention parking (the official site first, if found).

Reply with JSON only:
{{"live_counts_found": bool,
  "free_spaces": int or null,
  "total_spaces": int or null,
  "zones": [{{"name": str, "free": int or null, "total": int or null}}],
  "as_of": str or null,
  "live_available_via": str or null,
  "capacity": str or null,
  "rates": str or null,
  "free_parking": str or null,
  "tips": str or null,
  "source_url": str or null}}

Rules:
- live_counts_found is true ONLY if a page shows CURRENT free/available spaces for this place
  (e.g. "Grand Parking: 312 available", "Free spaces now: 540"). Capacity / total bays is NOT availability.
- Never invent numbers; use null when unknown.
- live_available_via: where a driver CAN see live availability if it isn't on the web
  (e.g. "the Dubai Mall app", "RTA Dubai / PRKN app", "LED counters at the entrances").
- capacity, rates, free_parking, tips: short (<= 25 words each), from the sources only.
- source_url: the page backing the most important fact.

SEARCH RESULTS:
{results}

PAGE EXTRACTS:
{pages}"""


def _domain(url: str | None) -> str:
    return (urlparse(url).hostname or "").removeprefix("www.") if url else ""


def _page_text(raw: str) -> str:
    raw = re.sub(r"(?is)<(script|style|noscript|svg|head)\b.*?</\1>", " ", raw)
    raw = re.sub(r"(?s)<[^>]+>", " ", raw)
    return re.sub(r"\s+", " ", html.unescape(raw)).strip()


def _parking_windows(text: str, limit: int = 5000) -> str:
    """Keep only the parts of a page that talk about parking."""
    spans: list[list[int]] = []
    for m in re.finditer(r"(?i)\bpark(ing|ed)?\b|\bvalet\b|\bspaces?\b|\bbays?\b", text):
        a, b = max(0, m.start() - 350), min(len(text), m.end() + 350)
        if spans and a <= spans[-1][1]:
            spans[-1][1] = b
        else:
            spans.append([a, b])
    out = " … ".join(text[a:b] for a, b in spans)
    return out[:limit]


async def _fetch(http: httpx.AsyncClient, url: str) -> tuple[str, str] | None:
    try:
        r = await http.get(url, headers={"User-Agent": UA, "Accept-Language": "en"}, timeout=PAGE_TIMEOUT_S,
                           follow_redirects=True)
        if r.status_code != 200 or "html" not in r.headers.get("content-type", ""):
            return None
        text = _parking_windows(_page_text(r.text[:MAX_PAGE_BYTES]))
        return (str(r.url), text) if text else None
    except (httpx.HTTPError, UnicodeDecodeError) as e:
        log.info("could not read %s: %s", url, e)
        return None


async def _judge(name: str, city: str, results: list[dict[str, Any]], pages: list[tuple[str, str]]) -> dict[str, Any] | None:
    key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
    if not key:
        return None
    from google import genai
    from google.genai import types

    prompt = PROMPT.format(
        name=name,
        city=city or "unknown city",
        results=json.dumps([{k: r.get(k) for k in ("title", "snippet", "url")} for r in results], ensure_ascii=False),
        pages="\n\n".join(f"[{url}]\n{text}" for url, text in pages) or "(no page could be read)",
    )
    try:
        client = genai.Client(api_key=key)
        resp = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=os.getenv("GEMINI_TEXT_MODEL", "gemini-flash-latest"),
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=0.1,
                    thinking_config=types.ThinkingConfig(thinking_level="low"),
                ),
            ),
            timeout=20,
        )
        return json.loads(resp.text)
    except Exception as e:
        log.warning("Gemini parking check failed: %s", e)
        return None


async def check_parking_online(http: httpx.AsyncClient, name: str, city: str, website: str | None = None) -> dict[str, Any]:
    """Web search + page reading for one place. Always returns a dict with 'searched': True."""
    official = _domain(website)
    queries = [f"{name} {city} parking availability".strip()]
    if official:
        queries.append(f"site:{official} parking")
    batches = await asyncio.gather(*(web_search(q, max_results=6) for q in queries))
    seen: dict[str, dict[str, Any]] = {}
    for batch in batches:
        for r in batch:
            if r.get("url") and r["url"] not in seen:
                seen[r["url"]] = r
    results = sorted(seen.values(), key=lambda r: _domain(r["url"]) != official)  # official site first
    urls = [r["url"] for r in results[:MAX_PAGES]]
    if website and not any(_domain(u) == official for u in urls):
        urls.insert(0, website)
    pages = [p for p in await asyncio.gather(*(_fetch(http, u) for u in urls[:MAX_PAGES])) if p]

    verdict = await _judge(name, city, results[:8], pages) or {
        "live_counts_found": False,
        "tips": results[0]["snippet"][:200] if results else None,
        "source_url": results[0]["url"] if results else None,
    }
    # Guard rail: "live" needs an actual number.
    if verdict.get("live_counts_found") and verdict.get("free_spaces") is None and not any(
        z.get("free") is not None for z in verdict.get("zones") or []
    ):
        verdict["live_counts_found"] = False
    verdict["searched"] = True
    verdict["pages_read"] = [u for u, _ in pages]
    return verdict
