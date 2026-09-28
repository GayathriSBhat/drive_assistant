"use client";

import { useLocalParticipant, useTranscriptions } from "@livekit/components-react";
import type { OrbState } from "@/lib/types";
import ShimmeringText from "./shimmering-text";

const STATUS: Partial<Record<OrbState, string>> = {
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Looking into it",
  speaking: "KenDrive",
  muted: "No mic — type instead",
  paused: "Muted · tap the mic to talk",
};

/**
 * The tail of a streaming transcript, cut at a sentence start (never mid-word or mid-sentence), with a
 * stable index per word so only newly arrived words animate in.
 */
function captionWords(text: string, maxWords: number) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return { words, start: 0 };
  // The earliest sentence start that still fits; if the last sentence alone is too long, its last maxWords words.
  let start = words.length - maxWords;
  for (let i = start; i < words.length; i++) {
    if (/[.!?…]["”')]?$/.test(words[i - 1])) {
      start = i;
      break;
    }
  }
  return { words: words.slice(start), start };
}

/** Live state + what's being heard / said, under the orb. Shorter while cards are on screen. */
export default function LiveCaptions({ state, compact = false }: { state: OrbState; compact?: boolean }) {
  const { localParticipant } = useLocalParticipant();
  const transcriptions = useTranscriptions();
  const last = transcriptions.at(-1);
  const fromDriver = last?.participantInfo.identity === localParticipant.identity;
  const status = STATUS[state];
  if (!status) return null;

  const { words, start } = captionWords(last?.text ?? "", compact ? 16 : 30);

  return (
    <div className="below-orb captions" aria-live="polite">
      {state === "speaking" || state === "paused" || state === "muted" ? (
        <span className="captions-status">{status}</span>
      ) : (
        <ShimmeringText text={status} className="captions-status" />
      )}
      {words.length > 0 && (
        <p className={`captions-text ${fromDriver ? "you" : "agent"}`} key={last?.streamInfo.id}>
          {fromDriver && <span className="captions-who">You </span>}
          {start > 0 && <span className="captions-more">… </span>}
          {words.map((w, i) => (
            <span className="w" key={start + i}>
              {w}{" "}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
