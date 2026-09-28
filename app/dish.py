"""Where do I get the best <dish>?" - rank nearby places by evidence that they actually serve it.

Evidence per candidate:
  * Google reviews (up to 5 per place) and Google's AI review summary / overview (Places API New)
  * Menu snippets from the web (ddgs), e.g. Zomato / Swiggy / the restaurant's own menu page
Gemini Flash reads all of it and returns a ranking with a short quote as proof. If Gemini is
unavailable, a keyword heuristic over the same evidence is used instead.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from typing import Any

from .geo import LatLng
from .maps import Maps
from .search import web_search

log = logging.getLogger("dish")

MAX_CANDIDATES = 5
MENU_SEARCH_TIMEOUT_S = 6
MAX_DISTANCE_M = 10_000

# Spelling variants people (and menus) use; the judge model handles anything beyond these.
SYNONYMS: dict[str, list[str]] = {
    "bolognese": ["bolognese", "bolognaise", "ragu", "ragù", "spag bol"],
    "biryani": ["biryani", "biriyani", "biriani"],
    "dosa": ["dosa", "dosai", "dose"],
}

JUDGE_PROMPT = """You help a driver pick where to eat. They want: "{dish}".
Below are nearby places with Google review excerpts, Google's review summary, and web/menu search
snippets. Decide for each place whether it really serves "{dish}" and how good it is likely to be there.
Treat these spellings as the same dish: {variants}.

evidence levels:
  "on_menu"            – a menu/web snippet lists the dish (or a clear variant) for THIS place
  "reviewed"           – a review or the review summary mentions eating the dish here
  "likely"             – cuisine strongly suggests it (e.g. Italian trattoria for bolognese) but no direct proof
  "no"                 – nothing suggests it

Reply with JSON only: {{"ranking": [{{"id": str, "evidence": str, "score": 0-10,
"quote": "<= 20 words copied from the strongest evidence, or empty",
"quote_source": "review" | "menu" | "summary" | "",
"why": "<= 12 words, spoken-friendly"}}]}}
Rank best first. Penalise "no"/"likely" heavily versus "on_menu"/"reviewed"; use rating and
praise for the dish as tie-breakers, distance only as a last tie-breaker.

PLACES:
{places}"""


def dish_terms(dish: str) -> list[str]:
    d = dish.lower()
    for key, variants in SYNONYMS.items():
        if key in d or any(v in d for v in variants):
            return variants
    words = [w for w in re.findall(r"[a-zà-ü]+", d) if w not in {"pasta", "best", "good", "the", "a"}]
    return words or [d]


def _mentions(text: str, terms: list[str]) -> bool:
    t = text.lower()
    return any(term in t for term in terms)


def _sentence_with(text: str, terms: list[str], max_words: int = 22) -> str:
    for sentence in re.split(r"(?<=[.!?])\s+|\n+", text):
        if _mentions(sentence, terms):
            words = sentence.split()
            return " ".join(words[:max_words]) + ("…" if len(words) > max_words else "")
    return ""


def _clean_name(name: str) -> str:
    """'Dal Moro's Nexus Koramangala | Fresh Pasta To Go' -> 'Dal Moro's Nexus Koramangala'."""
    name = name.replace("’", "'").replace("‘", "'")  # curly quotes break web search matching
    return re.split(r"\s[|\-–—]\s", name)[0].strip()


async def _menu_snippets(place: dict[str, Any], terms: list[str], city: str) -> list[str]:
    query = f"{_clean_name(place['name'])} {city} menu {terms[0]}"
    try:
        results = await asyncio.wait_for(web_search(query, max_results=5), MENU_SEARCH_TIMEOUT_S)
    except asyncio.TimeoutError:
        return []
    return [f'{r["title"]}: {r["snippet"]}' for r in results if r.get("snippet")]


def _excerpt(text: str, terms: list[str], head: int = 500) -> str:
    """Start of the review, plus the sentence naming the dish if it comes later."""
    if len(text) <= head:
        return text
    hit = _sentence_with(text[head:], terms, max_words=40)
    return text[:head] + "…" + (f" […] {hit}" if hit else "")


async def _judge(dish: str, candidates: list[dict[str, Any]]) -> dict[str, dict[str, Any]] | None:
    key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
    if not key:
        return None
    from google import genai
    from google.genai import types

    compact = [
        {
            "id": c["id"],
            "name": c["name"],
            "rating": c["rating"],
            "ratings": c["ratings"],
            "distance_m": c["distance_m"],
            "overview": c.get("overview"),
            "review_summary": c.get("review_summary"),
            "reviews": [f'({r["rating"]}★) {_excerpt(r["text"], dish_terms(dish))}' for r in c["reviews"]],
            "web_menu_snippets": [s[:300] for s in c["menu_snippets"]],
        }
        for c in candidates
    ]
    try:
        client = genai.Client(api_key=key)
        resp = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=os.getenv("GEMINI_TEXT_MODEL", "gemini-flash-latest"),
                contents=JUDGE_PROMPT.format(
                    dish=dish, variants=", ".join(dish_terms(dish)), places=json.dumps(compact, ensure_ascii=False)
                ),
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=0.2,
                    # Low thinking keeps this under a few seconds; the driver is waiting on a voice reply.
                    thinking_config=types.ThinkingConfig(thinking_level="low"),
                ),
            ),
            timeout=20,
        )
        return {row["id"]: row for row in json.loads(resp.text)["ranking"]}
    except Exception as e:
        log.warning("Gemini judge failed, using keyword ranking: %s", e)
        return None


def _heuristic(c: dict[str, Any], terms: list[str]) -> dict[str, Any]:
    review_hits = [r for r in c["reviews"] if _mentions(r["text"], terms)]
    menu_hits = [s for s in c["menu_snippets"] if _mentions(s, terms)]
    summary_hit = _mentions(f'{c.get("review_summary") or ""} {c.get("overview") or ""}', terms)
    if menu_hits:
        evidence, quote, src = "on_menu", _sentence_with(menu_hits[0], terms), "menu"
    elif review_hits:
        evidence, quote, src = "reviewed", _sentence_with(review_hits[0]["text"], terms), "review"
    elif summary_hit:
        evidence, quote, src = "reviewed", _sentence_with(c.get("review_summary") or c.get("overview") or "", terms), "summary"
    else:
        evidence, quote, src = "no", "", ""
    base = {"on_menu": 6, "reviewed": 5, "likely": 2, "no": 0}[evidence]
    score = base + len(review_hits) * 0.5 + (c["rating"] or 0) / 2
    return {"id": c["id"], "evidence": evidence, "score": round(score, 1), "quote": quote,
            "quote_source": src, "why": ""}


async def best_places_for_dish(maps: Maps, origin: LatLng, dish: str, city: str) -> list[dict[str, Any]]:
    """Ranked candidates (best first), each with evidence level, a proof quote and card-ready fields."""
    terms = dish_terms(dish)
    batches = await asyncio.gather(
        maps.search_with_reviews(origin, dish),
        maps.search_with_reviews(origin, f"{dish} restaurant"),
        return_exceptions=True,
    )
    seen: dict[str, dict[str, Any]] = {}
    for batch in batches:
        if isinstance(batch, list):
            for p in batch:
                if p["distance_m"] is not None and p["distance_m"] <= MAX_DISTANCE_M:
                    seen.setdefault(p["id"], p)
    if not seen:
        return []
    def prior(p: dict[str, Any]) -> tuple[int, float]:
        # Places whose reviews/summary already mention the dish go first; then well-rated, well-reviewed ones.
        text = " ".join([r["text"] for r in p["reviews"]] + [p.get("review_summary") or "", p.get("overview") or ""])
        return (_mentions(text, terms), (p["rating"] or 0) * min(1, (p["ratings"] or 0) / 50))

    candidates = sorted(seen.values(), key=prior, reverse=True)[:MAX_CANDIDATES]

    t0 = time.monotonic()
    snippets = await asyncio.gather(*(_menu_snippets(c, terms, city) for c in candidates))
    for c, snips in zip(candidates, snippets):
        c["menu_snippets"] = snips

    t1 = time.monotonic()
    judged = await _judge(dish, candidates) or {}
    log.info("dish ranking for %r: menu search %.1fs, judge %.1fs", dish, t1 - t0, time.monotonic() - t1)
    ranked = []
    for c in candidates:
        verdict = judged.get(c["id"]) or _heuristic(c, terms)
        if not verdict.get("quote"):
            # Prefer a real review sentence over nothing, so the card can show proof.
            hit = next((r for r in c["reviews"] if _mentions(r["text"], terms)), None)
            if hit:
                verdict.update(quote=_sentence_with(hit["text"], terms), quote_source="review")
        author = next((r["author"] for r in c["reviews"] if verdict.get("quote") and verdict["quote"][:25].lower()
                       in r["text"].lower()), None)
        ranked.append({**c, **{k: verdict.get(k) for k in ("evidence", "score", "quote", "quote_source", "why")},
                       "quote_author": author})
    ranked.sort(key=lambda r: (r["evidence"] in ("on_menu", "reviewed"), r["score"] or 0), reverse=True)
    return ranked
