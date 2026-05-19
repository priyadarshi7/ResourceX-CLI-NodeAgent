"use strict";

const express = require("express");

function createAdminRouter(rt) {
  const r = express.Router();

  r.get("/stats", (req, res) => {
    res.json({
      nodes: rt.nodeStore.getStats(),
      jobs: {
        total: rt.jobRegistry.jobs.size,
        active: [...rt.jobRegistry.jobs.values()].filter((j) =>
          ["queued", "running", "waiting_nodes"].includes(j.status),
        ).length,
      },
      challengesPending: rt.challengeEngine.pendingChallenges.size,
    });
  });

  r.get("/nodes", (req, res) => {
    res.json(
      rt.nodeStore.getAll().map((n) => ({
        nodeId: n.nodeId,
        email: n.email,
        trustTier: n.trustTier,
        challengeScore: n.challengeScore,
        challengesPassed: n.challengesPassed,
        challengesFailed: n.challengesFailed,
        failureRate: n.failureRate,
        connected: n.connected,
        status: n.status,
        cpu: n.cpu,
        memory: n.memory,
        activeTasks: n.activeTasks,
        lastSeen: n.lastSeen,
      })),
    );
  });

  /** Reset trust after bad cold-start (dev / LAN testing). */
  r.post("/nodes/:nodeId/reset-trust", (req, res) => {
    const node = rt.nodeStore.get(req.params.nodeId);
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    rt.challengeEngine.cancelPendingForNode(node.nodeId);
    Object.assign(node, {
      challengeScore: 0.5,
      trustTier: "COLD_START",
      challengesPassed: 0,
      challengesFailed: 0,
      failureRate: 0,
      status: "active",
    });
    const { saveNodeState } = require("../lib/nodePersistence");
    saveNodeState(node).catch(() => {});
    res.json({
      ok: true,
      nodeId: node.nodeId,
      message: "Trust reset — node can receive jobs again",
      node: {
        status: node.status,
        challengeScore: node.challengeScore,
        trustTier: node.trustTier,
      },
    });
  });

  return r;
}

module.exports = { createAdminRouter };
