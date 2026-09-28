import { Car, Fuel, ParkingSquare, UtensilsCrossed, Zap } from "lucide-react";

const PROMPTS = [
  { icon: Fuel, label: "Fuel nearby", say: "Find the nearest petrol pump" },
  { icon: ParkingSquare, label: "Where can I park?", say: "Where can I park near here?" },
  { icon: Zap, label: "Fast charger", say: "Find me a fast EV charger nearby" },
  { icon: Car, label: "Traffic ahead", say: "How's the traffic on the road ahead?" },
  { icon: UtensilsCrossed, label: "Best biryani around", say: "Where do I get the best biryani nearby?" },
];

/** First screen before a call: who KenDrive is and a few things to ask. Tapping one starts the call. */
export default function Hero({ onPrompt }: { onPrompt: (text: string) => void }) {
  return (
    <>
      <div className="hero">
        <h1>
          Eyes on the road. <em>I&apos;ll find the rest.</em>
        </h1>
        <p>Fuel, parking, chargers, traffic. Just ask.</p>
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
