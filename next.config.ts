import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow access from the local network IP during development
  // so the app works when accessed from phones on the same WiFi.
  allowedDevOrigins: ["192.168.4.69", "localhost", "127.0.0.1"],
};

export default nextConfig;
