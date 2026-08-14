import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Uploaded closet photos can be large; allow generous body size on server actions/routes.
  experimental: {
    serverActions: {
      bodySizeLimit: "15mb",
    },
  },
};

export default nextConfig;
