"use client";

import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { DrawerSnap } from "@/lib/types";

interface Props {
  snap: DrawerSnap;
  onSnap: (snap: DrawerSnap) => void;
  /** Called once a resize has settled, so the map can re-frame. */
  onSettled: () => void;
  flashKey: number;
  phoneRef: RefObject<HTMLDivElement | null>;
  topbarRef: RefObject<HTMLElement | null>;
  orbRef: RefObject<HTMLButtonElement | null>;
  body: ReactNode; // map + overlays
  sheet: ReactNode; // quick actions (unused but kept for future)
}

/**
 * Bottom-sheet drawer holding everything except the orb. It slides over the orb, which stays put
 * in the layer underneath. Drag or tap the grip: peek (header + quick actions) ↔ half ↔ full.
 */
export default function MapDrawer({ snap, onSnap, onSettled, flashKey, phoneRef, topbarRef, orbRef, body, sheet }: Props) {
  const drawerRef = useRef<HTMLElement>(null);
  const gripRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const snapRef = useRef(snap);
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // hidden: only the chips sheet visible, tucked at the bottom (no map, no header).
  // peek: header + chips (no map body).
  // half: stops just below the orb so it stays visible above.
  // full: map fills everything below the top bar.
  const heights = useCallback(() => {
    const phone = phoneRef.current;
    const drawer = drawerRef.current;
    if (!phone || !drawer || !gripRef.current || !sheetRef.current) return { hidden: 0, peek: 184, half: 420, full: 700 };
    const full = phone.clientHeight; // full = entire phone, drawer slides under the topbar
    const sheet = sheetRef.current.offsetHeight;
    const peek = gripRef.current.offsetHeight + sheet;
    const orb = orbRef.current?.getBoundingClientRect();
    const safeGap = 48;
    const belowOrb = orb ? drawer.getBoundingClientRect().bottom - orb.bottom - safeGap : full * 0.55;
    const half = Math.round(Math.max(peek + 140, Math.min(full * 0.62, belowOrb)));
    // hidden: just the sheet (chips) height — drawer header and map are hidden off-screen.
    const hidden = sheet;
    return { hidden, peek, half, full };
  }, [phoneRef, topbarRef, orbRef]);

  const setHeight = useCallback(
    (px: number) => phoneRef.current?.style.setProperty("--drawer-h", `${px}px`),
    [phoneRef],
  );

  // Apply the snap height; re-frame the map once the transition is done.
  useLayoutEffect(() => {
    snapRef.current = snap;
    const h = heights();
    phoneRef.current?.style.setProperty("--drawer-peek", `${h.peek}px`);
    setHeight(h[snap]);
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(onSettled, 340);
  }, [snap, heights, setHeight, onSettled, phoneRef]);

  // Keep heights in sync with the screen (rotation, resize, fonts loading).
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const h = heights();
      phoneRef.current?.style.setProperty("--drawer-peek", `${h.peek}px`);
      setHeight(h[snapRef.current]);
    });
    if (phoneRef.current) ro.observe(phoneRef.current);
    if (sheetRef.current) ro.observe(sheetRef.current);
    return () => ro.disconnect();
  }, [heights, setHeight, phoneRef]);

  // New results: flash so the driver knows there's something to look at.
  useEffect(() => {
    if (!flashKey || !drawerRef.current) return;
    const el = drawerRef.current;
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  }, [flashKey]);

  return (
    <section className="drawer" ref={drawerRef} data-snap={snap} aria-label="Map and results">
      <div className="drawer-body">{body}</div>
      {/* sheetRef sentinel always mounted so heights() can measure it (0 when sheet is null) */}
      <div ref={sheetRef}>{sheet}</div>
    </section>
  );
}
