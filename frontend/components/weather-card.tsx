import { CloudRain, Thermometer, Wind, X } from "lucide-react";
import type { WeatherEvent } from "@/lib/types";

/** Compact weather card in the dock: icon + temperature, conditions, and the few numbers that matter on the road. */
export default function WeatherCard({ weather: w, onClose }: { weather: WeatherEvent; onClose: () => void }) {
  const temp = w.temperature_c != null ? Math.round(w.temperature_c) : null;
  return (
    <div className="weather-card" role="status">
      {w.icon && (
        // eslint-disable-next-line @next/next/no-img-element -- Google's weather condition icon (SVG)
        <img className="weather-icon" src={w.icon} alt="" />
      )}
      <div className="weather-main">
        <div className="weather-title">{w.title}</div>
        <div className="weather-now">
          {temp != null && <span className="weather-temp">{temp}°</span>}
          {w.conditions && <span className="weather-cond">{w.conditions}</span>}
        </div>
        <div className="weather-meta">
          {w.chance_of_rain_pct != null && (
            <span>
              <CloudRain size={12} /> {w.chance_of_rain_pct}%
            </span>
          )}
          {w.feels_like_c != null && (
            <span>
              <Thermometer size={12} /> feels {Math.round(w.feels_like_c)}°
            </span>
          )}
          {w.wind_kmh != null && (
            <span>
              <Wind size={12} /> {Math.round(w.wind_kmh)} km/h
            </span>
          )}
        </div>
      </div>
      <button className="icon-btn small" onClick={onClose} aria-label="Close weather">
        <X size={14} />
      </button>
    </div>
  );
}
