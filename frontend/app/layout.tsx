import type { Metadata, Viewport } from "next";
import { Fraunces, Fragment_Mono, Instrument_Sans } from "next/font/google";
import "./globals.css";

// Kenpath brand fonts (same picks as kenpath-labs-website / svara-platform-ui): Instrument Sans for the
// interface, Fraunces for the one editorial line (the greeting), Fragment Mono for small status labels.
const sans = Instrument_Sans({ variable: "--font-sans", subsets: ["latin"], style: ["normal", "italic"] });
const serif = Fraunces({ variable: "--font-serif", subsets: ["latin"], style: ["normal", "italic"], axes: ["opsz", "SOFT"] });
const mono = Fragment_Mono({ variable: "--font-mono", subsets: ["latin"], weight: "400" });

export const metadata: Metadata = {
  title: "KenDrive",
  description: "A hands-free co-pilot: fuel, parking, chargers and traffic, just by asking.",
};

export const viewport: Viewport = {
  themeColor: "#08090a",
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
