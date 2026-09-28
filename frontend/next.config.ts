import type { NextConfig } from "next";

// FastAPI (../server.py) serves the API: LiveKit tokens, Google place photos, road reports.
const API_ORIGIN = process.env.KENDRIVE_API_ORIGIN ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  output: "standalone", // self-contained server for the Docker image
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` }];
  },
};

export default nextConfig;
