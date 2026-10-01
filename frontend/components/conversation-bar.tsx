"use client";

import { BarVisualizer, useVoiceAssistant } from "@livekit/components-react";
import { ArrowUp, ChevronDown, Keyboard, Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import ShimmeringText from "./shimmering-text";

interface Props {
  live: boolean;
  connecting: boolean;
  muted: boolean;
  onToggleMute: () => void;
  onCall: () => void;
  onEnd: () => void;
  onSend: (text: string) => void;
}

/**
 * Basic call controls, modelled on ElevenLabs UI's ConversationBar: waveform pill · mic · keyboard | call.
 * The keyboard opens a text box above the controls; typing works before a call too (it starts one).
 */
export default function ConversationBar({ live, connecting, muted, onToggleMute, onCall, onEnd, onSend }: Props) {
  const { state, audioTrack } = useVoiceAssistant();
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [text, setText] = useState("");
  const active = live || connecting;

  const send = () => {
    const msg = text.trim();
    if (!msg) return;
    setText("");
    onSend(msg);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="convo-bar">
      <div className={`convo-input ${keyboardOpen ? "open" : ""}`}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder="Ask anything…"
          rows={2}
          tabIndex={keyboardOpen ? 0 : -1}
        />
        <button className="convo-send" onClick={send} disabled={!text.trim()} aria-label="Send">
          <ArrowUp size={16} />
        </button>
      </div>

      <div className="convo-controls">
        <div className="convo-wave">
          {active ? (
            <BarVisualizer state={connecting ? "connecting" : state} track={audioTrack} barCount={14} options={{ minHeight: 12 }} />
          ) : (
            <ShimmeringText text="Aween" duration={3} className="convo-name" />
          )}
        </div>

        <button
          className="convo-btn"
          onClick={onToggleMute}
          disabled={!live}
          aria-pressed={muted}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          title={muted ? "Unmute (M)" : "Mute (M)"}
        >
          {muted ? <MicOff size={20} /> : <Mic size={20} />}
        </button>
        <button
          className="convo-btn keyboard"
          onClick={() => setKeyboardOpen((v) => !v)}
          aria-pressed={keyboardOpen}
          aria-label={keyboardOpen ? "Hide keyboard" : "Type a message"}
        >
          <Keyboard size={20} className={keyboardOpen ? "out" : ""} />
          <ChevronDown size={20} className={keyboardOpen ? "" : "out"} />
        </button>
        <span className="convo-sep" />
        <button
          className={`convo-btn call ${active ? "end" : ""}`}
          onClick={active ? onEnd : onCall}
          aria-label={active ? "End call" : "Start call"}
        >
          {active ? <PhoneOff size={20} /> : <Phone size={20} />}
        </button>
      </div>
    </div>
  );
}
