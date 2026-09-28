"""API backend for the Next.js app in ./frontend: LiveKit tokens, place photos, road reports (+ SSE).

Run:  uv run uvicorn server:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import time
import uuid
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from livekit import api
from pydantic import BaseModel

from app.maps import Maps

load_dotenv()
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("server")

ROOT = Path(__file__).parent
DATA_DIR = ROOT / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
REPORTS_FILE = DATA_DIR / "reports.json"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

AGENT_NAME = os.getenv("AGENT_NAME", "kendrive")
REPORT_TTL_S = int(os.getenv("REPORT_TTL_HOURS", "3")) * 3600
CLEARED_VOTES_TO_REMOVE = 2
MAX_PHOTO_BYTES = 8 * 1024 * 1024
# Crowd-sourced road reports are switched off for now; set ENABLE_ROAD_REPORTS=true to bring them back.
ROAD_REPORTS = os.getenv("ENABLE_ROAD_REPORTS", "false").lower() in ("1", "true", "yes")

maps = Maps(os.environ["GOOGLE_PLACES_API_KEY"])
app = FastAPI(title="KenDrive")


# ---------------------------------------------------------------- reports store

class ReportStore:
    """Tiny JSON-file backed store; good enough for a single-process demo."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.reports: dict[str, dict[str, Any]] = {}
        if path.exists():
            self.reports = {r["id"]: r for r in json.loads(path.read_text())}
        self.subscribers: set[asyncio.Queue[str]] = set()

    def _save(self) -> None:
        self.path.write_text(json.dumps(list(self.reports.values()), indent=1))

    def active(self) -> list[dict[str, Any]]:
        now = time.time()
        expired = [rid for rid, r in self.reports.items() if r["expires_at"] < now]
        for rid in expired:
            self.remove(rid)
        return sorted(self.reports.values(), key=lambda r: r["created_at"], reverse=True)

    def add(self, report: dict[str, Any]) -> None:
        self.reports[report["id"]] = report
        self._save()
        self.publish("report_added", report)

    def update(self, report: dict[str, Any]) -> None:
        self._save()
        self.publish("report_updated", report)

    def remove(self, rid: str) -> None:
        report = self.reports.pop(rid, None)
        if report:
            self._save()
            self.publish("report_removed", report)

    def publish(self, kind: str, report: dict[str, Any]) -> None:
        msg = json.dumps({"type": kind, "report": report})
        for q in list(self.subscribers):
            q.put_nowait(msg)


store = ReportStore(REPORTS_FILE)


# ---------------------------------------------------------------- Gemini photo check

VISION_PROMPT = """You are verifying a crowd-sourced road report from a driver in India.
Look at the photo (and the driver's note, if any) and reply with JSON only:
{"is_road_issue": bool, "category": one of ["procession","accident","construction","waterlogging",
"fallen_tree","vehicle_breakdown","protest","heavy_traffic","road_closed","other"],
"severity": one of ["low","medium","high"], "blocks_road": bool,
"summary": "<= 15 words describing what blocks the road"}"""


async def analyze_photo(photo: bytes, mime: str, note: str) -> dict[str, Any] | None:
    key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
    if not key:
        return None
    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=key)
        resp = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=os.getenv("GEMINI_VISION_MODEL", "gemini-flash-latest"),
                contents=[
                    types.Part.from_bytes(data=photo, mime_type=mime),
                    f"{VISION_PROMPT}\nDriver's note: {note or '(none)'}",
                ],
                config=types.GenerateContentConfig(response_mime_type="application/json"),
            ),
            timeout=20,
        )
        return json.loads(resp.text)
    except Exception as e:
        log.warning("Gemini photo analysis failed: %s", e)
        return None


# ---------------------------------------------------------------- API

def require_reports() -> None:
    if not ROAD_REPORTS:
        raise HTTPException(404, "Road reports are disabled")


@app.get("/api/config")
async def config() -> dict[str, bool]:
    return {"road_reports": ROAD_REPORTS}


@app.get("/api/token")
async def token(name: str = "Driver") -> dict[str, str]:
    lk_key, lk_secret = os.getenv("LIVEKIT_API_KEY"), os.getenv("LIVEKIT_API_SECRET")
    if not (lk_key and lk_secret):
        raise HTTPException(500, "LIVEKIT_API_KEY / LIVEKIT_API_SECRET not configured")
    room = f"drive-{secrets.token_hex(4)}"
    identity = f"driver-{secrets.token_hex(3)}"
    jwt = (
        api.AccessToken(lk_key, lk_secret)
        .with_identity(identity)
        .with_name(name)
        .with_grants(api.VideoGrants(
                room_join=True, room=room, can_publish=True, can_subscribe=True,
                can_update_own_metadata=True,  # lets the browser publish lat/lng as participant attributes
            ))
        .with_room_config(api.RoomConfiguration(agents=[api.RoomAgentDispatch(agent_name=AGENT_NAME)]))
        .to_jwt()
    )
    public_url = os.getenv("LIVEKIT_PUBLIC_URL") or os.getenv("LIVEKIT_URL", "ws://localhost:7880")
    return {"url": public_url, "token": jwt, "room": room, "identity": identity}


PHOTO_NAME = re.compile(r"^places/[A-Za-z0-9_-]+/photos/[A-Za-z0-9_-]+$")
_photo_cache: dict[str, str] = {}


@app.get("/api/place-photo")
async def place_photo(name: str) -> RedirectResponse:
    """Redirect to a Places photo without exposing the API key to the browser."""
    if not PHOTO_NAME.match(name):
        raise HTTPException(400, "Invalid photo name")
    if name not in _photo_cache:
        try:
            _photo_cache[name] = await maps.photo_url(name)
        except Exception as e:
            raise HTTPException(502, str(e)) from e
    return RedirectResponse(_photo_cache[name], headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/reports")
async def list_reports() -> list[dict[str, Any]]:
    require_reports()
    return store.active()


@app.post("/api/reports")
async def create_report(
    lat: float = Form(...),
    lng: float = Form(...),
    note: str = Form(""),
    heading: float | None = Form(None),
    reporter: str = Form("anonymous"),
    photo: UploadFile | None = File(None),
) -> dict[str, Any]:
    require_reports()
    rid = uuid.uuid4().hex[:10]
    photo_url, analysis = None, None
    if photo and photo.filename:
        data = await photo.read()
        if len(data) > MAX_PHOTO_BYTES:
            raise HTTPException(413, "Photo too large (max 8 MB)")
        mime = photo.content_type or "image/jpeg"
        if not mime.startswith("image/"):
            raise HTTPException(400, "Photo must be an image")
        ext = {"image/png": ".png", "image/webp": ".webp", "image/heic": ".heic"}.get(mime, ".jpg")
        (UPLOAD_DIR / f"{rid}{ext}").write_bytes(data)
        photo_url = f"/uploads/{rid}{ext}"
        analysis = await analyze_photo(data, mime, note)

    locality = await maps.locality((lat, lng))
    now = time.time()
    report = {
        "id": rid,
        "lat": lat,
        "lng": lng,
        "heading": heading,
        "note": note.strip()[:280],
        "reporter": reporter[:40],
        "photo_url": photo_url,
        "locality": locality,
        "category": (analysis or {}).get("category", "road_closed"),
        "severity": (analysis or {}).get("severity", "high"),
        "summary": (analysis or {}).get("summary") or note.strip()[:120] or "Road reported blocked",
        "ai_verified": None if analysis is None else bool(analysis.get("is_road_issue")),
        "confirms": 1,
        "cleared": 0,
        "created_at": now,
        "expires_at": now + REPORT_TTL_S,
    }
    store.add(report)
    log.info("New report %s at %s: %s", rid, locality, report["summary"])
    return report


class Vote(BaseModel):
    kind: str  # "still_there" | "cleared"


@app.post("/api/reports/{rid}/vote")
async def vote(rid: str, v: Vote) -> dict[str, Any]:
    require_reports()
    report = store.reports.get(rid)
    if not report:
        raise HTTPException(404, "Report not found or already cleared")
    if v.kind == "still_there":
        report["confirms"] += 1
        report["expires_at"] = time.time() + REPORT_TTL_S
    elif v.kind == "cleared":
        report["cleared"] += 1
        if report["cleared"] >= CLEARED_VOTES_TO_REMOVE:
            store.remove(rid)
            return {**report, "removed": True}
    else:
        raise HTTPException(400, "kind must be still_there or cleared")
    store.update(report)
    return report


@app.get("/api/events")
async def events(request: Request) -> StreamingResponse:
    require_reports()
    q: asyncio.Queue[str] = asyncio.Queue()
    store.subscribers.add(q)

    async def stream():
        try:
            yield "retry: 3000\n\n"
            while not await request.is_disconnected():
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            store.subscribers.discard(q)

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")


@app.get("/")
async def index() -> RedirectResponse:
    """The UI is the Next.js app in ./frontend (it proxies /api/* back here)."""
    return RedirectResponse(os.getenv("FRONTEND_URL", "http://localhost:3000"))
