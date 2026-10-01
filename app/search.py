"""Web search: Gemini with Google Search grounding, and DuckDuckGo (`ddgs`) web + news as a fallback."""

from __future__ import annotations

import asyncio
import os
import logging
from typing import Any

from ddgs import DDGS

log = logging.getLogger("search")


def _search(query: str, news: bool, max_results: int, timelimit: str | None) -> list[dict[str, Any]]:
    ddgs = DDGS()
    try:
        if news:
            rows = ddgs.news(query, max_results=max_results, timelimit=timelimit)
            return [
                {"title": r.get("title"), "snippet": r.get("body"), "date": r.get("date"),
                 "source": r.get("source"), "url": r.get("url")}
                for r in rows
            ]
        rows = ddgs.text(query, max_results=max_results, timelimit=timelimit)
        return [{"title": r.get("title"), "snippet": r.get("body"), "url": r.get("href")} for r in rows]
    except Exception as e:  # ddgs raises on "no results" and on rate limiting
        log.info("ddgs %s search for %r: %s", "news" if news else "text", query, e)
        return []


async def web_search(
    query: str, *, news: bool = False, max_results: int = 5, timelimit: str | None = None
) -> list[dict[str, Any]]:
    return await asyncio.to_thread(_search, query, news, max_results, timelimit)


GROUNDED_PROMPT = """Today is {today}. The user is in {place}.
Answer this using a Google search for current information: {query}
Rules: only include things that are current, ongoing or upcoming from today onward (drop anything that
already ended). For events give the name, venue, and dates/times. Be concrete and brief: at most 5 items,
one short line each, plain text, no URLs, no markdown. If you can't find anything current, say so."""


async def grounded_search(query: str, *, today: str, place: str) -> str | None:
    """Gemini + Google Search grounding: a short, date-aware answer with real names. None on failure."""
    key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
    if not key:
        return None
    from google import genai
    from google.genai import types

    try:
        client = genai.Client(api_key=key)
        resp = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=os.getenv("GEMINI_TEXT_MODEL", "gemini-flash-latest"),
                contents=GROUNDED_PROMPT.format(today=today, place=place or "an unknown city", query=query),
                config=types.GenerateContentConfig(
                    tools=[types.Tool(google_search=types.GoogleSearch())],
                    temperature=0.2,
                    thinking_config=types.ThinkingConfig(thinking_level="low"),
                ),
            ),
            timeout=20,
        )
        return (resp.text or "").strip() or None
    except Exception as e:
        log.warning("grounded search for %r failed: %s", query, e)
        return None
