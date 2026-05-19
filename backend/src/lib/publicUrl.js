"use strict";

const os = require("os");

function isUsableLanAddress(addr) {
  if (!addr || addr.startsWith("127.")) return false;
  // Windows/APIPA link-local — wrong for cross-machine downloads
  if (addr.startsWith("169.254.")) return false;
  return true;
}

/** Prefer typical LAN ranges (192.168.x, 10.x) over random virtual adapters. */
function getLanBaseUrl(port) {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      if (!isUsableLanAddress(iface.address)) continue;
      const score =
        iface.address.startsWith("192.168.") ? 3 : iface.address.startsWith("10.") ? 2 : 1;
      candidates.push({ address: iface.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;
  return `http://${candidates[0].address}:${port}`;
}

function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_URL) {
    return process.env.PUBLIC_URL.replace(/\/$/, "");
  }
  const port = Number(process.env.PORT || 4000);
  const lan = getLanBaseUrl(port);
  if (lan) return lan;
  if (req) {
    const proto = req.get("x-forwarded-proto") || req.protocol || "http";
    const host = req.get("x-forwarded-host") || req.get("host");
    if (host && !/localhost|127\.0\.0\.1/i.test(host)) {
      return `${proto}://${host}`;
    }
  }
  return `http://localhost:${port}`;
}

function isLocalhostUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

module.exports = { getPublicBaseUrl, isLocalhostUrl, getLanBaseUrl };