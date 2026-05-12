"use strict";

const { verifyToken } = require("../lib/jwt");

function requireUserAuth(rt) {
  return async function requireUserAuthMiddleware(req, res, next) {
    const h = req.headers.authorization || "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    const token = m && m[1];
    if (!token) {
      res.status(401).json({ error: "Missing bearer token" });
      return;
    }
    try {
      const payload = await verifyToken(token);
      if (payload.typ !== "user") {
        res.status(403).json({ error: "User token required" });
        return;
      }
      req.user = { email: payload.email || payload.sub };
      next();
    } catch (e) {
      res.status(401).json({ error: "Invalid token" });
    }
  };
}

function requireNodeAuth(rt) {
  return async function requireNodeAuthMiddleware(req, res, next) {
    const h = req.headers.authorization || "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    const token = m && m[1];
    if (!token) {
      res.status(401).json({ error: "Missing bearer token" });
      return;
    }
    try {
      const payload = await verifyToken(token);
      if (payload.typ !== "node") {
        res.status(403).json({ error: "Node token required" });
        return;
      }
      req.node = { nodeId: payload.nodeId, email: payload.email || payload.sub };
      next();
    } catch (e) {
      res.status(401).json({ error: "Invalid token" });
    }
  };
}

module.exports = { requireUserAuth, requireNodeAuth };
