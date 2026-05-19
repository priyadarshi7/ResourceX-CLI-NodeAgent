"use strict";

const os = require("os");

function getLanBaseUrl(port) {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === "IPv4" && !iface.internal) {
        return `http://${iface.address}:${port}`;
      }
    }
  }
  return null;
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