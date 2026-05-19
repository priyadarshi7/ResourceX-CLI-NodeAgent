"use strict";

const express = require("express");
const { body, validationResult } = require("express-validator");
const { ensureUser, getUser, verifyPassword } = require("../lib/users");
const { signNodeToken } = require("../lib/jwt");
const { requireNodeAuth } = require("../middleware/auth");

function createNodesRouter(rt) {
  const r = express.Router();
  const nodeAuth = requireNodeAuth(rt);

  r.delete("/me", nodeAuth, async (req, res) => {
    const nodeId = req.node.nodeId;
    rt.challengeEngine.cancelPendingForNode(nodeId);
    rt.scheduler.forgetNode(nodeId);
    if (typeof rt.disconnectNode === "function") {
      rt.disconnectNode(nodeId);
    }
    await rt.nodeStore.remove(nodeId);
    res.json({ ok: true, nodeId, message: "Node removed from pool" });
  });

  r.post(
    "/register",
    body("email").isEmail(),
    body("password").isString().isLength({ min: 1 }),
    body("nodeId").isUUID(),
    body("cpu").isInt({ min: 1 }),
    body("memory").isString(),
    body("gpu").optional().isBoolean(),
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }
      const {
        email,
        password,
        nodeId,
        cpu,
        memory,
        gpu,
        gpuInfo,
        os,
        network,
      } = req.body;

      let user = await getUser(email);
      if (!user) {
        await ensureUser(email, password);
      } else {
        const ok = await verifyPassword(email, password);
        if (!ok) {
          res.status(401).json({ error: "Invalid credentials" });
          return;
        }
      }

      const node = await rt.nodeStore.register(nodeId, {
        email,
        cpu,
        memory,
        gpu: !!gpu,
        gpuInfo: gpuInfo || null,
        os: os || {},
        network: network || {},
        challengeScore: 0.5,
        trustTier: "COLD_START",
        connected: false,
        status: "offline",
      });

      const token = await signNodeToken({ email, nodeId });
      res.json({
        token,
        node: {
          nodeId: node.nodeId,
          trustTier: node.trustTier,
          challengeScore: node.challengeScore,
        },
      });
    },
  );

  return r;
}

module.exports = { createNodesRouter };
