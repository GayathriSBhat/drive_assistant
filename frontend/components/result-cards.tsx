"use client";

import type { Ref } from "react";
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
function whereText(p: Place) {
  if (p.drive_min != null) return `${p.drive_min} min drive${p.detour_min != null ? ` · +${p.detour_min} min detour` : ""}`;
  if (p.walk_min === 0) return "At your destination";
  if (p.walk_min != null) return `${p.walk_min} min walk · ${fmtDist(p.distance_m)}`;
  return fmtDist(p.distance_m);
}

interface Props {
  places: Place[];
  onNavigate: (p: Place) => void;
  onFocus: (index: number) => void;
  ref?: Ref<HTMLElement>;
}

/**
 * AppSheet card view, "List" layout: thumbnail · title · subtitle · badges · description · actions.
 * Shown as a swipeable carousel over the bottom of the map in the drawer.
 */
export default function ResultCards({ places, onNavigate, onFocus, ref }: Props) {
  const pinnedCount = places.filter((p) => p.pinned).length;
  return (
    <section className="cards" ref={ref} aria-label="Results">
      <div className="cards-rail">
        {places.map((p, i) => {
          const rankIndex = i - pinnedCount;
          const top = !p.pinned && rankIndex === 0;
          const rank = p.pinned ? "Destination" : top ? "Top pick" : `#${rankIndex + 1}`;
          const badge: Badge | null =
            p.badge ?? (p.evidence && EVIDENCE_LABELS[p.evidence] ? { text: EVIDENCE_LABELS[p.evidence], tone: p.evidence } : null);
          const tags = (p.tags ?? []).slice(0, 3);
          const hasChips = !!badge || tags.length > 0;
          const isParking = p.walk_min != null;
          return (
            <article
              key={`${p.id ?? p.name}-${i}`}
              className={`card${top ? " top" : ""}`}
              onClick={(e) => {
                if (!(e.target as HTMLElement).closest("button, a")) onFocus(i);
              }}
            >
              <div className="card-thumb">
                {p.photo && (
                  // eslint-disable-next-line @next/next/no-img-element -- Google photo via our redirecting proxy
                  <img
                    src={`/api/place-photo?name=${encodeURIComponent(p.photo)}`}
                    alt=""
                    loading={i < 3 ? "eager" : "lazy"}
                    onError={(e) => e.currentTarget.remove()}
                  />
                )}
                {p.photo && <span className="credit">© Google</span>}
                <span className={`card-rank${top ? " top" : p.pinned ? " dest" : ""}`}>{rank}</span>
              </div>
              <div className="card-main">
                <div className="card-title">{cleanName(p.name)}</div>
                <div className="card-sub">
                  {p.rating ? `★ ${p.rating}${p.ratings ? ` (${p.ratings.toLocaleString()})` : ""} · ` : ""}
                  {whereText(p)}
                  {p.open_now != null && (
                    <>
                      {" · "}
                      <span className={p.open_now ? "open" : "closed"}>{p.open_now ? "Open" : "Closed"}</span>
                    </>
                  )}
                </div>
                {hasChips && (
                  <div className="card-tags">
                    {badge && <span className={`tag ${badge.tone}`}>{badge.text}</span>}
                    {tags.map((t) => (
                      <span className="tag" key={t}>
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {p.quote ? (
                  <div className="card-quote">
                    “{p.quote}”{" "}
                    <cite>
                      — {p.quote_author ? `${p.quote_author}, ` : ""}
                      {QUOTE_SOURCES[p.quote_source ?? ""] ?? "Google Maps"}
                    </cite>
                  </div>
                ) : (
                  !hasChips && p.address && <div className="card-quote">{p.address}</div>
                )}
                <div className="card-actions">
                  <button className="go" onClick={() => onNavigate(p)}>
                    Navigate
                  </button>
                  {p.maps_url && (
                    <a href={p.maps_url} target="_blank" rel="noopener">
                      Maps
                    </a>
                  )}
                  {isParking && p.website ? (
                    <a href={p.website} target="_blank" rel="noopener">
                      Website
                    </a>
                  ) : (
                    p.phone && <a href={`tel:${p.phone.replace(/\s+/g, "")}`}>Call</a>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
