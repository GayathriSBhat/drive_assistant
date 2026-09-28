import { X } from "lucide-react";
import type { WeatherEvent } from "@/lib/types";

/** Weather in the dock: where/when, a big temperature with Google's icon, then three labelled stats. */
export default function WeatherCard({ weather: w, onClose }: { weather: WeatherEvent; onClose: () => void }) {
  const temp = w.temperature_c != null ? Math.round(w.temperature_c) : null;
  const when = w.arriving_in ? `On arrival · ${w.arriving_in}` : "Now";
  const stats = [
    w.chance_of_rain_pct != null && { label: "Rain", value: `${w.chance_of_rain_pct}%` },
    w.feels_like_c != null && { label: "Feels like", value: `${Math.round(w.feels_like_c)}°` },
    w.wind_kmh != null && { label: "Wind", value: `${Math.round(w.wind_kmh)} km/h` },
  ].filter(Boolean) as { label: string; value: string }[];

  return (
    <div className="weather-card" role="status">
      <div className="weather-head">
        <span className="weather-place">{w.place ?? "Weather"}</span>
        <span className="weather-when">{when}</span>
        <button className="weather-close" onClick={onClose} aria-label="Close weather">
          <X size={14} />
        </button>
      </div>

      <div className="weather-hero">
        <div>
          {temp != null && <div className="weather-temp">{temp}°</div>}
          {w.conditions && <div className="weather-cond">{w.conditions}</div>}
        </div>
        {w.icon && (
          // eslint-disable-next-line @next/next/no-img-element -- Google's weather condition icon (SVG)
          <img className="weather-icon" src={w.icon} alt="" />
        )}
      </div>

      {stats.length > 0 && (
        <div className="weather-stats">
          {stats.map((s) => (
            <div key={s.label}>
              <span>{s.label}</span>
              <strong>{s.value}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
