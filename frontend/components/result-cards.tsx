"use client";

import { type PointerEvent, type Ref, useEffect, useRef, useState } from "react";
import { Car, Footprints, Globe, Map as MapIcon, MapPin, Navigation, Phone, Star } from "lucide-react";
import { cleanName, fmtDist } from "@/lib/format";
import type { Badge, Place } from "@/lib/types";

const EVIDENCE_LABELS: Record<string, string> = {
  on_menu: "On the menu",
  reviewed: "Loved in reviews",
  likely: "Likely serves it",
};
const QUOTE_SOURCES: Record<string, string> = {
  review: "Google review",
  menu: "Menu (web)",
  summary: "Google review summary",
  web: "Website",
};

/** Where it is, relative to what the driver cares about: drive time (EV), walk (parking) or distance. */
function where(p: Place) {
  if (p.drive_min != null)
    return { icon: Car, text: `${p.drive_min} min${p.detour_min != null ? ` · +${p.detour_min} detour` : ""}` };
  if (p.walk_min === 0) return { icon: MapPin, text: "At your destination" };
  if (p.walk_min != null) return { icon: Footprints, text: `${p.walk_min} min · ${fmtDist(p.distance_m)}` };
  return { icon: MapPin, text: fmtDist(p.distance_m) };
}

interface Props {
  places: Place[];
  onNavigate: (p: Place) => void;
  onFocus: (index: number) => void;
  /** A pin was tapped on the map: bring its card into view. */
  scrollTo?: { index: number; at: number } | null;
  ref?: Ref<HTMLElement>;
}

/**
 * AppSheet card view, "List" layout: thumbnail · title · subtitle · badges · description · actions.
 * A swipeable carousel above the call bar: touch/trackpad scroll natively, a mouse can drag it, and the
 * map follows whichever card is in view.
 */
export default function ResultCards({ places, onNavigate, onFocus, scrollTo, ref }: Props) {
  const pinnedCount = places.filter((p) => p.pinned).length;
  const railRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);

  // Card in view → dots + map pin (debounced to the end of the swipe).
  const onFocusRef = useRef(onFocus);
  useEffect(() => {
    onFocusRef.current = onFocus;
  }, [onFocus]);
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    let t: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const card = rail.firstElementChild as HTMLElement | null;
        if (!card) return;
        const i = Math.round(rail.scrollLeft / (card.offsetWidth + 10));
        setActive((prev) => {
          if (prev !== i) onFocusRef.current(i);
          return i;
        });
      }, 120);
    };
    rail.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(t);
      rail.removeEventListener("scroll", onScroll);
    };
  }, []);

  const goTo = (i: number) => {
    const rail = railRef.current;
    const card = rail?.children[i] as HTMLElement | undefined;
    if (rail && card) rail.scrollTo({ left: card.offsetLeft - rail.offsetLeft - 12, behavior: "smooth" });
  };

  useEffect(() => {
    if (!scrollTo) return;
    const rail = railRef.current;
    const card = rail?.children[scrollTo.index] as HTMLElement | undefined;
    if (rail && card) rail.scrollTo({ left: card.offsetLeft - rail.offsetLeft - 12, behavior: "smooth" });
  }, [scrollTo]);

  // Mouse drag-to-swipe (touch already scrolls natively). Snap is paused while dragging.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || !railRef.current) return;
    drag.current = { x: e.clientX, left: railRef.current.scrollLeft, moved: false };
    railRef.current.classList.add("dragging");
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !railRef.current) return;
    const dx = e.clientX - drag.current.x;
    if (Math.abs(dx) > 4) drag.current.moved = true;
    railRef.current.scrollLeft = drag.current.left - dx;
  };
  const endDrag = () => {
    const rail = railRef.current;
    if (!drag.current || !rail) return;
    const moved = drag.current.moved;
    drag.current = null;
    rail.classList.remove("dragging");
    if (moved) {
      const card = rail.firstElementChild as HTMLElement;
      goTo(Math.round(rail.scrollLeft / (card.offsetWidth + 10)));
      // Swallow the click that ends a drag so it doesn't press a card button.
      rail.addEventListener("click", (ev) => ev.stopPropagation(), { capture: true, once: true });
    }
  };

  return (
    <section className="cards" ref={ref} aria-label="Results">
      <div
        className="cards-rail"
        ref={railRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
      >
        {places.map((p, i) => {
          const rankIndex = i - pinnedCount;
          const top = !p.pinned && rankIndex === 0;
          const rank = p.pinned ? "Destination" : top ? "Top pick" : `No. ${rankIndex + 1}`;
          const badge: Badge | null =
            p.badge ?? (p.evidence && EVIDENCE_LABELS[p.evidence] ? { text: EVIDENCE_LABELS[p.evidence], tone: p.evidence } : null);
          const loc = where(p);
          // Drop chips that repeat the meta row (e.g. "4 min walk").
          const dup = (t: string) => /min (walk|drive)/i.test(t);
          const chips = [badge, ...(p.tags ?? []).map((t) => ({ text: t, tone: "neutral" }))]
            .filter((c): c is Badge => !!c && !dup(c.text))
            .slice(0, 3);
          const isParking = p.walk_min != null;
          const Where = loc.icon;
          return (
            <article
              key={`${p.id ?? p.name}-${i}`}
              className={`card${top ? " top" : ""}`}
              onClick={(e) => {
                if (!(e.target as HTMLElement).closest("button, a")) onFocus(i);
              }}
            >
              <div className="card-head">
                <div className="card-thumb">
                  {p.photo ? (
                    // eslint-disable-next-line @next/next/no-img-element -- Google photo via our redirecting proxy
                    <img
                      src={`/api/place-photo?name=${encodeURIComponent(p.photo)}`}
                      alt=""
                      loading={i < 3 ? "eager" : "lazy"}
                      onError={(e) => e.currentTarget.remove()}
                    />
                  ) : (
                    <MapPin size={20} />
                  )}
                </div>
                <div className="card-main">
                  <div className={`card-kicker${top ? " top" : p.pinned ? " dest" : ""}`}>{rank}</div>
                  <div className="card-title">{cleanName(p.name)}</div>
                  <div className="card-meta">
                    {p.rating ? (
                      <span>
                        <Star size={12} className="star" /> {p.rating}
                        {p.ratings ? <em> ({p.ratings.toLocaleString()})</em> : null}
                      </span>
                    ) : null}
                    <span>
                      <Where size={12} /> {loc.text}
                    </span>
                    {p.open_now != null && <span className={p.open_now ? "open" : "closed"}>{p.open_now ? "Open" : "Closed"}</span>}
                  </div>
                </div>
              </div>

              {chips.length > 0 && (
                <div className="card-tags">
                  {chips.map((c) => (
                    <span className={`tag ${c.tone}`} key={c.text}>
                      {c.text}
                    </span>
                  ))}
                </div>
              )}
              {p.quote && (
                <p className="card-quote" title={`${QUOTE_SOURCES[p.quote_source ?? ""] ?? "Google Maps"}${p.quote_author ? ` · ${p.quote_author}` : ""}`}>
                  “{p.quote}”
                </p>
              )}

              <div className="card-actions">
                <button className="go" onClick={() => onNavigate(p)}>
                  <Navigation size={14} /> Navigate
                </button>
                {p.maps_url && (
                  <a href={p.maps_url} target="_blank" rel="noopener" aria-label="Open in Google Maps" title="Google Maps">
                    <MapIcon size={16} />
                  </a>
                )}
                {isParking && p.website ? (
                  <a href={p.website} target="_blank" rel="noopener" aria-label="Website" title="Website">
                    <Globe size={16} />
                  </a>
                ) : (
                  p.phone && (
                    <a href={`tel:${p.phone.replace(/\s+/g, "")}`} aria-label="Call" title="Call">
                      <Phone size={16} />
                    </a>
                  )
                )}
              </div>
            </article>
          );
        })}
      </div>
      {places.length > 1 && (
        <div className="cards-dots" role="tablist" aria-label="Results">
          {places.map((p, i) => (
            <button
              key={`${p.id ?? p.name}-${i}`}
              role="tab"
              aria-selected={i === active}
              aria-label={`Result ${i + 1}`}
              onClick={() => goTo(i)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
