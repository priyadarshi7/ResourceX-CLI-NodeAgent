"use strict";

const { getDb } = require("./db");

function nodesCol() {
  return getDb().collection("nodes");
}

function docToState(doc) {
  if (!doc) return null;
  return {
    nodeId: doc.nodeId,
    email: doc.email,
    cpu: doc.cpu,
    memory: doc.memory,
    gpu: !!doc.gpu,
    gpuInfo: doc.gpuInfo ?? null,
    os: doc.os || {},
    network: doc.network || {},
    challengeScore: doc.challengeScore ?? 0.5,
    trustTier: doc.trustTier ?? "COLD_START",
    failureRate: doc.failureRate ?? 0,
    tasksCompleted: doc.tasksCompleted ?? 0,
    challengesPassed: doc.challengesPassed ?? 0,
    challengesFailed: doc.challengesFailed ?? 0,
    status: doc.status || "active",
    registeredAt: doc.registeredAt ?? Date.now(),
  };
}

function stateToDoc(node) {
  return {
    nodeId: node.nodeId,
    email: node.email,
    cpu: node.cpu ?? null,
    memory: node.memory ?? null,
    gpu: !!node.gpu,
    gpuInfo: node.gpuInfo ?? null,
    os: node.os || {},
    network: node.network || {},
    challengeScore: node.challengeScore ?? 0.5,
    trustTier: node.trustTier ?? "COLD_START",
    failureRate: node.failureRate ?? 0,
    tasksCompleted: node.tasksCompleted ?? 0,
    challengesPassed: node.challengesPassed ?? 0,
    challengesFailed: node.challengesFailed ?? 0,
    status: node.status || "active",
    registeredAt: node.registeredAt ?? Date.now(),
  };
}

async function loadPersistedNode(nodeId) {
  const doc = await nodesCol().findOne({ nodeId });
  return docToState(doc);
}

async function saveNodeState(node) {
  const doc = stateToDoc(node);
  await nodesCol().updateOne(
    { nodeId: node.nodeId },
    { $set: doc },
    { upsert: true },
  );
}

async function removePersistedNode(nodeId) {
  await nodesCol().deleteOne({ nodeId });
}

module.exports = {
  loadPersistedNode,
  saveNodeState,
  removePersistedNode,
};
