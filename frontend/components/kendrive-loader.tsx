"use client";

import dynamic from "next/dynamic";

// The app talks to the browser only (Leaflet, WebRTC, WebGL, geolocation), so skip prerendering.
const KenDriveApp = dynamic(() => import("./kendrive-app"), {
  ssr: false,
  loading: () => <div className="phone" />,
});

export default function KenDriveLoader() {
  return <KenDriveApp />;
}
