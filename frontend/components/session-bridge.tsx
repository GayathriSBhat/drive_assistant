"use client";

import { RoomAudioRenderer, useConnectionState, useRoomContext, useVoiceAssistant } from "@livekit/components-react";
import { ConnectionState, type TextStreamReader } from "livekit-client";
import { useEffect, useRef } from "react";
import type { Loc, UiEvent } from "@/lib/types";

export interface SessionApi {
  /** Sends a typed question once connected and KenDrive has finished greeting. */
  sendText: (text: string) => Promise<void>;
}

interface Props {
  loc: Loc | null;
  paused: boolean;
  micAvailable: boolean;
  onAgentState: (state: string) => void;
  onUiEvent: (evt: UiEvent) => void;
  onReady: (api: SessionApi) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Lives inside <LiveKitRoom>: mirrors agent state out, receives the agent's UI events, shares the
 * driver's location as participant attributes, applies pause, and plays KenDrive's voice.
 */
export default function SessionBridge({ loc, paused, micAvailable, onAgentState, onUiEvent, onReady }: Props) {
  const room = useRoomContext();
  const connection = useConnectionState();
  const { state } = useVoiceAssistant();

  // Agent state → orb.
  useEffect(() => onAgentState(state), [state, onAgentState]);

  // Typed text that arrives while KenDrive is still greeting gets merged into the greeting (and
  // Gemini can fumble the request), so hold it until the greeting has finished.
  const greeted = useRef(false);
  const spoke = useRef(false);
  const greetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (connection !== ConnectionState.Connected) {
      greeted.current = spoke.current = false;
      clearTimeout(greetTimer.current);
      greetTimer.current = undefined;
    }
  }, [connection]);
  useEffect(() => {
    if (state === "speaking") {
      spoke.current = true;
      clearTimeout(greetTimer.current);
    }
    if (state === "listening") {
      if (spoke.current) greeted.current = true;
      else if (!greetTimer.current) greetTimer.current = setTimeout(() => (greeted.current = true), 6000);
    }
  }, [state]);

  // Agent → UI events (cards, routes). Transcripts are read by <LiveCaptions> (useTranscriptions).
  const onUiEventRef = useRef(onUiEvent);
  useEffect(() => {
    onUiEventRef.current = onUiEvent;
  }, [onUiEvent]);
  useEffect(() => {
    const ui = async (reader: TextStreamReader) => {
      try {
        onUiEventRef.current(JSON.parse(await reader.readAll()) as UiEvent);
      } catch (e) {
        console.error("ui.event", e);
      }
    };
    room.registerTextStreamHandler("ui.event", ui);
    return () => {
      room.unregisterTextStreamHandler("ui.event");
    };
  }, [room]);

  // Driver location → participant attributes (the agent's tools read lat/lng/heading), ≤ every 2 s.
  const lastSent = useRef(0);
  const trailing = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!loc || connection !== ConnectionState.Connected) return;
    const send = () => {
      lastSent.current = Date.now();
      room.localParticipant
        .setAttributes({
          lat: loc.lat.toFixed(6),
          lng: loc.lng.toFixed(6),
          heading: loc.heading == null ? "" : String(Math.round(loc.heading)),
        })
        .catch((e) => console.warn("setAttributes", e));
    };
    clearTimeout(trailing.current);
    const wait = 2000 - (Date.now() - lastSent.current);
    if (wait <= 0) send();
    else trailing.current = setTimeout(send, wait);
  }, [loc, connection, room]);

  // Pause: mic off (KenDrive's audio is muted by <RoomAudioRenderer muted>).
  useEffect(() => {
    if (connection !== ConnectionState.Connected || !micAvailable) return;
    room.localParticipant.setMicrophoneEnabled(!paused).catch((e) => console.warn("mic", e));
  }, [paused, micAvailable, connection, room]);

  // Expose sendText to the app.
  useEffect(() => {
    onReady({
      sendText: async (text) => {
        for (let i = 0; i < 100 && (room.state !== ConnectionState.Connected || !greeted.current); i++) await sleep(250);
        if (room.state !== ConnectionState.Connected) return;
        await room.localParticipant.sendText(text, { topic: "lk.chat" });
      },
    });
  }, [room, onReady]);

  return <RoomAudioRenderer muted={paused} />;
}
