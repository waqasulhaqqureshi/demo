import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Dev-only allow-list of origins that may request Next.js dev resources
   * (HMR websocket, /_next/*). This setting is IGNORED in production builds,
   * so it has no effect on the Vercel deploy.
   *
   * - "*.e2b.app"  → the Arena live-preview host.
   * - "*.local"    → mDNS / Bonjour hostnames (e.g. my-machine.local).
   * - "*.*.*.*"    → any IPv4 address, so a changing LAN IP (10.x, 172.16-31.x,
   *                 192.168.x) never re-triggers the cross-origin block warning.
   *
   * `localhost` and `**.localhost` are always allowed by Next.js automatically.
   */
  allowedDevOrigins: ["*.e2b.app", "*.local", "*.*.*.*"],
};

export default nextConfig;
