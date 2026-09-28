import type { CSSProperties } from "react";

interface Props {
  text: string;
  /** Seconds per sweep. */
  duration?: number;
  /** Highlight band width, as a multiple of the text length (px per character). */
  spread?: number;
  /** Keep sweeping; false = one sweep, then plain text. */
  repeat?: boolean;
  className?: string;
}

/**
 * Text with a highlight sweeping across it (a CSS port of ElevenLabs UI's ShimmeringText, no
 * framer-motion). Used for live states: "Listening…", "Thinking…". Styles: .shimmer in globals.css.
 */
export default function ShimmeringText({ text, duration = 2, spread = 2, repeat = true, className }: Props) {
  const style = {
    "--shimmer-spread": `${Math.max(24, text.length * spread)}px`,
    "--shimmer-duration": `${duration}s`,
    "--shimmer-repeat": repeat ? "infinite" : "1",
  } as CSSProperties;
  return (
    <span className={`shimmer ${className ?? ""}`} style={style} key={text}>
      {text}
    </span>
  );
}
