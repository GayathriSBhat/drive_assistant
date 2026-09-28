"use client";

import type { Ref } from "react";
import type { OrbState } from "@/lib/types";
import { Persona, type PersonaState } from "./persona";

// "asleep" renders a near-black orb that disappears on the dark UI, so idle/paused use "idle".
const PERSONA_STATE: Record<OrbState, PersonaState> = {
  idle: "idle",
  connecting: "thinking",
  listening: "listening",
  thinking: "thinking",
  speaking: "speaking",
  muted: "idle",
  paused: "idle",
};

// No text is drawn around the orb; its state lives in the accessible label / hover title.
const LABELS: Record<OrbState, string> = {
  idle: "Tap to talk",
  connecting: "Connecting...",
  listening: "Listening...",
  thinking: "Thinking...",
  speaking: "Speaking...",
  muted: "Mic unavailable — type below",
  paused: "Your mic is off · tap to turn it on",
};

interface Props {
  state: OrbState;
  onTap: () => void;
  ref?: Ref<HTMLButtonElement>;
}

/** The only voice control: tap to start a session, then tap to pause / resume it. */
export default function VoiceOrb({ state, onTap, ref }: Props) {
  const label = `KenDrive: ${LABELS[state]}`;
  return (
    <button ref={ref} className="orb" data-state={state} aria-label={label} title={label} onClick={onTap}>
      <Persona state={PERSONA_STATE[state]} className="persona" />
    </button>
  );
}
