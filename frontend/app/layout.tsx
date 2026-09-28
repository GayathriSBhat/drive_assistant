import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "leaflet/dist/leaflet.css";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "KenDrive",
  description: "Voice co-pilot for drivers — LiveKit + Gemini Live + Google Maps",
};

export const viewport: Viewport = {
  themeColor: "#0b0f14",
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
