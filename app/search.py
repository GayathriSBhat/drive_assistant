"""DuckDuckGo web + news search via the `ddgs` package."""

from __future__ import annotations

import asyncio
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
