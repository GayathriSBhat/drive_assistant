"use client";

import { useEffect, useRef } from "react";

const SRC = "/sounds/thinking.wav";
const DELAY_MS = 1200; // only for longer waits (tool calls), never a blip on quick replies
const VOLUME = 0.12; // well under KenDrive's voice
const FADE_S = 0.3;

/**
 * A soft, gap-free loop while KenDrive is thinking for more than a moment. Never plays while
 * listening or speaking: it fades out as soon as the state changes.
 */
export function useThinkingSound(thinking: boolean) {
  const ctx = useRef<AudioContext | null>(null);
  const buffer = useRef<Promise<AudioBuffer> | null>(null);
  const playing = useRef<{ src: AudioBufferSourceNode; gain: GainNode } | null>(null);

  useEffect(() => {
    if (!thinking) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        ctx.current ??= new AudioContext();
        const ac = ctx.current;
        if (ac.state === "suspended") await ac.resume();
        buffer.current ??= fetch(SRC)
          .then((r) => r.arrayBuffer())
          .then((b) => ac.decodeAudioData(b));
        const buf = await buffer.current;
        if (cancelled || playing.current) return;
        const src = ac.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const gain = ac.createGain();
        gain.gain.setValueAtTime(0, ac.currentTime);
        gain.gain.linearRampToValueAtTime(VOLUME, ac.currentTime + FADE_S);
        src.connect(gain).connect(ac.destination);
        src.start();
        playing.current = { src, gain };
      } catch (e) {
        console.warn("thinking sound", e);
      }
    }, DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      const p = playing.current;
      const ac = ctx.current;
      if (!p || !ac) return;
      playing.current = null;
      p.gain.gain.cancelScheduledValues(ac.currentTime);
      p.gain.gain.setValueAtTime(p.gain.gain.value, ac.currentTime);
      p.gain.gain.linearRampToValueAtTime(0, ac.currentTime + FADE_S);
      p.src.stop(ac.currentTime + FADE_S);
    };
  }, [thinking]);

  useEffect(() => () => void ctx.current?.close(), []);
}
