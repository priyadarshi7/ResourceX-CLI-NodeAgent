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
        connected: n.connected,
        status: n.status,
        cpu: n.cpu,
        memory: n.memory,
        activeTasks: n.activeTasks,
        lastSeen: n.lastSeen,
      })),
    );
  });

  return r;
}

module.exports = { createAdminRouter };
