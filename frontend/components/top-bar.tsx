"use client";

import { Crosshair, MoreHorizontal, PhoneOff, Play, Square } from "lucide-react";
import { type Ref, useEffect, useRef, useState } from "react";

export type LocMode = "gps" | "dubai" | "singapore" | "sim";

interface Props {
  where: string;
  conn: "offline" | "connecting" | "live";
  locMode: LocMode;
  onLocMode: (mode: LocMode) => void;
  canSimulate: boolean;
  simulating: boolean;
  onSimulate: () => void;
  onRecenter: () => void;
  canEnd: boolean;
  onEnd: () => void;
  ref?: Ref<HTMLElement>;
}

export default function TopBar({ where, conn, locMode, onLocMode, canSimulate, simulating, onSimulate, onRecenter, canEnd, onEnd, ref }: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the menu on any outside click.
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.parentElement?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <header className="topbar" ref={ref}>
      <div className="brand" />
      <div className="top-actions">
        <button className="icon-btn" aria-label="Options" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <MoreHorizontal size={18} />
        </button>
      </div>
      {open && (
        <div className="menu" ref={menuRef}>
          <label className="menu-field">
            Location
            <select
              value={locMode === "sim" ? "" : locMode === "gps" ? "" : locMode}
              onChange={(e) => {
                setOpen(false);
                onLocMode((e.target.value || "gps") as LocMode);
              }}
            >
              <option value="">Live GPS</option>
              <option value="dubai">Demo · Dubai</option>
              <option value="singapore">Demo · Singapore (live parking data)</option>
            </select>
          </label>
          <button disabled={!canSimulate} onClick={pick(onSimulate)}>
            {simulating ? <Square size={14} /> : <Play size={14} />}
            {simulating ? "Stop simulation" : "Simulate drive along route"}
          </button>
          <button onClick={pick(onRecenter)}>
            <Crosshair size={14} /> Recenter map
          </button>
          <button disabled={!canEnd} onClick={pick(onEnd)}>
            <PhoneOff size={14} /> End voice session
          </button>
        </div>
      )}
    </header>
  );
}
