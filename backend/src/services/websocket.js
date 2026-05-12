"use strict";

const WebSocket = require("ws");
const { URL } = require("url");
const { verifyToken } = require("../lib/jwt");

/**
 * @typedef {import('./scheduler').Scheduler} Scheduler
 * @typedef {import('./nodeState').NodeStateStore} NodeStateStore
 * @typedef {import('./jobRegistry').JobRegistry} JobRegistry
 */

function parseToken(req) {
  try {
    const u = new URL(req.url, "http://localhost");
    const q = u.searchParams.get("token");
    if (q) return q;
  } catch {
    /* ignore */
  }
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

/**
 * @param {import('http').Server} server
 * @param {{ scheduler: Scheduler, nodeStore: NodeStateStore, jobRegistry: JobRegistry }} ctx
 */
function initWebSocket(server, ctx) {
  /** @type {Map<string, import('ws')>} */
  const nodeSockets = new Map();
  /** @type {Map<string, Set<import('ws')>>} */
  const jobSubscribers = new Map();

  const wssNode = new WebSocket.Server({ noServer: true });
  const wssJobs = new WebSocket.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const path = req.url.split("?")[0];
    if (path === "/ws/node" || path.startsWith("/ws/node/")) {
      wssNode.handleUpgrade(req, socket, head, (ws) => onNodeConnection(ws, req));
    } else if (path === "/ws/jobs" || path.startsWith("/ws/jobs/")) {
      wssJobs.handleUpgrade(req, socket, head, (ws) => onUserConnection(ws, req));
    } else {
      socket.destroy();
    }
  });

  async function onNodeConnection(ws, req) {
    const token = parseToken(req);
    if (!token) {
      ws.close(4001, "missing token");
      return;
    }
    let payload;
    try {
      payload = await verifyToken(token);
    } catch {
      ws.close(4002, "invalid token");
      return;
    }
    if (payload.typ !== "node" || !payload.nodeId) {
      ws.close(4003, "not a node token");
      return;
    }
    const nodeId = String(payload.nodeId);
    ws.nodeId = nodeId;
    nodeSockets.set(nodeId, ws);
    ctx.nodeStore.setConnected(nodeId, true);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        ctx.scheduler.handleNodeMessage(nodeId, msg);
      } catch (e) {
        console.error("[ws/node] bad message", e.message);
      }
    });

    ws.on("close", () => {
      if (nodeSockets.get(nodeId) === ws) nodeSockets.delete(nodeId);
      ctx.nodeStore.markDisconnected(nodeId);
    });

    ws.send(JSON.stringify({ type: "PING", ts: Date.now() }));
  }

  async function onUserConnection(ws, req) {
    const token = parseToken(req);
    if (!token) {
      ws.close(4001, "missing token");
      return;
    }
    let payload;
    try {
      payload = await verifyToken(token);
    } catch {
      ws.close(4002, "invalid token");
      return;
    }
    if (payload.typ !== "user") {
      ws.close(4003, "not a user token");
      return;
    }
    ws.userEmail = String(payload.email || payload.sub || "");

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "SUBSCRIBE_JOB" && msg.jobId) {
          const set = jobSubscribers.get(msg.jobId) || new Set();
          set.add(ws);
          jobSubscribers.set(msg.jobId, set);
          ws.send(JSON.stringify({ type: "SUBSCRIBED", jobId: msg.jobId }));
        }
      } catch (e) {
        console.error("[ws/jobs] bad message", e.message);
      }
    });

    ws.on("close", () => {
      for (const [, set] of jobSubscribers) {
        set.delete(ws);
      }
    });
  }

  function sendToNode(nodeId, payload) {
    const ws = nodeSockets.get(nodeId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  function broadcastJob(jobId, payload) {
    const set = jobSubscribers.get(jobId);
    if (!set) return;
    const data = JSON.stringify(payload);
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  function disconnectNode(nodeId) {
    const ws = nodeSockets.get(nodeId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(
          JSON.stringify({
            type: "NODE_DEREGISTERED",
            message: "This node was removed from the pool",
          }),
        );
      } catch {
        /* ignore */
      }
      ws.close(4408, "node deregistered");
    }
    nodeSockets.delete(nodeId);
  }

  return { sendToNode, broadcastJob, disconnectNode };
}

module.exports = { initWebSocket };
