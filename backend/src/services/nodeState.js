"use strict";

const { EventEmitter } = require("events");
const {
  loadPersistedNode,
  saveNodeState,
  removePersistedNode,
} = require("../lib/nodePersistence");

const TRUST_TIERS = {
  COLD_START: {
    min: 0.0,
    max: 0.35,
    challengeFrequency: 0.9,
    label: "COLD_START",
  },
  WARM: { min: 0.35, max: 0.6, challengeFrequency: 0.5, label: "WARM" },
  TRUSTED: { min: 0.6, max: 0.85, challengeFrequency: 0.2, label: "TRUSTED" },
  ELITE: { min: 0.85, max: 1.0, challengeFrequency: 0.05, label: "ELITE" },
};

const ALPHA = 0.85;
const BETA = 0.15;
const GAMMA = 0.25;

function getTier(score) {
  for (const [key, tier] of Object.entries(TRUST_TIERS)) {
    if (score >= tier.min && score < tier.max) return key;
  }
  return score >= 1.0 ? "ELITE" : "COLD_START";
}

function persistNode(node) {
  saveNodeState(node).catch((err) =>
    console.error("[db] save node", node.nodeId, err.message),
  );
}

class NodeStateStore extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, object>} */
    this.nodes = new Map();
  }

  async register(nodeId, info) {
    const persisted = await loadPersistedNode(nodeId);
    const existing = this.nodes.get(nodeId) || persisted || {};
    const state = {
      ...existing,
      nodeId,
      ...info,
      challengeScore:
        info.challengeScore ?? existing.challengeScore ?? 0.5,
      trustTier: existing.trustTier ?? "COLD_START",
      failureRate: existing.failureRate ?? 0,
      tasksCompleted: existing.tasksCompleted ?? 0,
      challengesPassed: existing.challengesPassed ?? 0,
      challengesFailed: existing.challengesFailed ?? 0,
      lastSeen: Date.now(),
      lastChallenge: existing.lastChallenge ?? null,
      connected: info.connected !== undefined ? !!info.connected : false,
      status:
        info.connected === false
          ? "offline"
          : existing.status === "offline" || !existing.status
            ? "active"
            : existing.status,
      registeredAt: existing.registeredAt ?? Date.now(),
      cpuUsage: existing.cpuUsage ?? 0,
      memoryUsage: existing.memoryUsage ?? 0,
      activeTasks: existing.activeTasks ?? 0,
    };
    this.nodes.set(nodeId, state);
    persistNode(state);
    this.emit("nodeRegistered", state);
    return state;
  }

  get(nodeId) {
    return this.nodes.get(nodeId);
  }

  getAll() {
    return Array.from(this.nodes.values());
  }

  getActive() {
    return this.getAll().filter((n) => n.connected && n.status === "active");
  }

  updateTrust(nodeId, { success }) {
    const node = this.nodes.get(nodeId);
    if (!node) return null;

    const prevScore = node.challengeScore;
    const prevTier = node.trustTier;

    let newScore =
      ALPHA * prevScore + (success ? BETA : 0) - (success ? 0 : GAMMA);
    newScore = Math.max(0, Math.min(1, newScore));

    const newTier = getTier(newScore);
    const challengesPassed = node.challengesPassed + (success ? 1 : 0);
    const challengesFailed = node.challengesFailed + (success ? 0 : 1);
    const failureRate =
      challengesFailed / Math.max(1, challengesPassed + challengesFailed);

    Object.assign(node, {
      challengeScore: newScore,
      trustTier: newTier,
      lastChallenge: Date.now(),
      challengesPassed,
      challengesFailed,
      failureRate,
    });

    if (success && node.status === "probation") {
      node.status = "active";
    }

    // Cold-start: need several failures before probation (2/2 is too harsh for new LAN nodes)
    const totalAttempts = challengesPassed + challengesFailed;
    if (
      !success &&
      totalAttempts >= 4 &&
      failureRate > 0.5
    ) {
      node.status = "probation";
    }

    this.emit("trustUpdated", {
      nodeId,
      prevScore,
      newScore,
      prevTier,
      newTier,
      success,
    });
    persistNode(node);
    return node;
  }

  updateHeartbeat(nodeId, data) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    Object.assign(node, {
      lastSeen: Date.now(),
      cpuUsage: data.cpuUsage,
      memoryUsage: data.memoryUsage,
      activeTasks: data.activeTasks,
      connected: true,
      status: node.status === "offline" ? "active" : node.status,
    });
    persistNode(node);
  }

  setConnected(nodeId, connected) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    node.connected = connected;
    if (connected) {
      if (node.status === "offline") node.status = "active";
    } else {
      node.status = "offline";
      this.emit("nodeDisconnected", { nodeId });
    }
    persistNode(node);
  }

  markDisconnected(nodeId) {
    this.setConnected(nodeId, false);
  }

  /**
   * Remove node from the pool (deregister). Idempotent.
   * @returns {Promise<boolean>} whether a row existed and was deleted
   */
  async remove(nodeId) {
    const existed = this.nodes.delete(nodeId);
    if (existed) {
      await removePersistedNode(nodeId);
      this.emit("nodeRemoved", { nodeId });
    }
    return existed;
  }

  incrementTaskCount(nodeId) {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.tasksCompleted++;
      persistNode(node);
    }
  }

  shouldChallenge(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) return true;
    if (node.status === "probation") return Math.random() < 0.85;
    const tier = TRUST_TIERS[node.trustTier] || TRUST_TIERS.COLD_START;
    const epsilon = 0.08;
    if (node.trustTier === "COLD_START") return Math.random() < 0.95;
    if (node.failureRate > 0.3) return Math.random() < 0.7;
    if (Math.random() < epsilon) return true;
    return Math.random() < tier.challengeFrequency;
  }

  getStats() {
    const all = this.getAll();
    return {
      total: all.length,
      connected: all.filter((n) => n.connected).length,
      tiers: {
        COLD_START: all.filter((n) => n.trustTier === "COLD_START").length,
        WARM: all.filter((n) => n.trustTier === "WARM").length,
        TRUSTED: all.filter((n) => n.trustTier === "TRUSTED").length,
        ELITE: all.filter((n) => n.trustTier === "ELITE").length,
      },
      avgScore: all.length
        ? all.reduce((s, n) => s + n.challengeScore, 0) / all.length
        : 0,
    };
  }
}

module.exports = { NodeStateStore, TRUST_TIERS, getTier };
