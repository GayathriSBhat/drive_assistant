import { CloudSun, Coffee, Languages, Lightbulb, Newspaper } from "lucide-react";

// Sent as Arabic so the first turn is already in the assistant's language.
const PROMPTS = [
  { icon: CloudSun, label: "Weather today", say: "شو الجو اليوم؟" },
  { icon: Newspaper, label: "What's happening nearby", say: "شو في فعاليات قريبة مني نهاية الأسبوع؟" },
  { icon: Coffee, label: "Good coffee nearby", say: "وين ألقى قهوة زينة قريبة؟" },
  { icon: Languages, label: "Translate something", say: "كيف أقول 'thank you very much' بالعربي؟" },
  { icon: Lightbulb, label: "Tell me a fun fact", say: "قول لي معلومة طريفة" },
];

/** First screen before a call: who Aween is and a few things to ask. Tapping one starts the call. */
export default function Hero({ onPrompt }: { onPrompt: (text: string) => void }) {
  return (
    <>
      <div className="hero">
        <h1>
          Hi, I&apos;m Aween. <em>How can I help?</em>
        </h1>
        <p>Ask me anything, or try one of these.</p>
      </div>
      <div className="below-orb hero-prompts">
        {PROMPTS.map(({ icon: Icon, label, say }) => (
          <button key={label} onClick={() => onPrompt(say)}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>
    </>
  );
}
