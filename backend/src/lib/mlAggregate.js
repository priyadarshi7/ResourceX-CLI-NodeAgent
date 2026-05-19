"use strict";

const METRICS_PREFIX = "RESOURCEX_METRICS=";

/**
 * Parse the last RESOURCEX_METRICS= JSON line from task stdout.
 * @param {string} output
 * @returns {object|null}
 */
function parseMetricsFromOutput(output) {
  if (!output || typeof output !== "string") return null;
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    const idx = line.indexOf(METRICS_PREFIX);
    if (idx === -1) continue;
    try {
      return JSON.parse(line.slice(idx + METRICS_PREFIX.length));
    } catch {
      /* try earlier line */
    }
  }
  return null;
}

function sampleWeight(metrics) {
  if (!metrics || typeof metrics !== "object") return 1;
  const w =
    metrics.samples ??
    metrics.n_samples ??
    metrics.rows ??
    metrics.num_samples;
  const n = Number(w);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Merge numeric metrics from all shards (weighted by sample count when available).
 * @param {Array<{ shardIndex: number, metrics: object }>} parts
 */
function mergeMetrics(parts) {
  let totalWeight = 0;
  const sums = {};
  const counts = {};

  for (const { metrics } of parts) {
    if (!metrics) continue;
    const w = sampleWeight(metrics);
    totalWeight += w;
    for (const [key, val] of Object.entries(metrics)) {
      if (typeof val !== "number" || !Number.isFinite(val)) continue;
      if (key === "shardIndex" || key === "shardCount") continue;
      sums[key] = (sums[key] || 0) + val * w;
      counts[key] = (counts[key] || 0) + w;
    }
  }

  const aggregated = {
    shardCount: parts.length,
    tasksWithMetrics: parts.filter((p) => p.metrics).length,
    totalSamples: totalWeight,
  };

  for (const key of Object.keys(sums)) {
    aggregated[key] = sums[key] / (counts[key] || 1);
  }

  return aggregated;
}

/**
 * Build a structured multi-node result from per-task stdout.
 * @param {Array<{ shardIndex: number, result: string }>} parts
 * @returns {string|object}
 */
function aggregateMlResults(parts) {
  const sorted = [...parts].sort((a, b) => a.shardIndex - b.shardIndex);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) {
    const metrics = parseMetricsFromOutput(sorted[0].result);
    if (metrics) {
      return {
        aggregated: metrics,
        shards: [
          {
            shardIndex: sorted[0].shardIndex,
            metrics,
          },
        ],
      };
    }
    return sorted[0].result;
  }

  const shards = sorted.map((p) => ({
    shardIndex: p.shardIndex,
    metrics: parseMetricsFromOutput(p.result),
    outputPreview: truncateOutput(p.result, 2000),
  }));

  const withMetrics = shards.filter((s) => s.metrics);
  if (!withMetrics.length) {
    return {
      aggregated: null,
      shards: sorted.map((p) => ({
        shardIndex: p.shardIndex,
        outputPreview: truncateOutput(p.result, 2000),
      })),
    };
  }

  return {
    aggregated: mergeMetrics(withMetrics),
    shards: shards.map(({ shardIndex, metrics, outputPreview }) => ({
      shardIndex,
      metrics,
      outputPreview,
    })),
  };
}

function truncateOutput(text, maxLen) {
  if (!text || typeof text !== "string") return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n…(truncated)";
}

/**
 * Compare arena runs on the same dataset; pick highest accuracy.
 * @param {Array<{ shardIndex: number, result: string, nodeId?: string, algorithmId?: string }>} parts
 */
function pickArenaWinner(parts) {
  const entries = parts
    .map((p) => {
      const metrics = parseMetricsFromOutput(p.result);
      if (!metrics) return null;
      return {
        shardIndex: p.shardIndex,
        nodeId: p.nodeId ?? null,
        algorithmId: metrics.algorithm || p.algorithmId || `shard_${p.shardIndex}`,
        algorithmName:
          metrics.algorithmName || metrics.algorithm || p.algorithmId || "unknown",
        metrics,
        outputPreview: truncateOutput(p.result, 3000),
      };
    })
    .filter(Boolean);

  entries.sort((a, b) => {
    const accA = Number(a.metrics.accuracy ?? -1);
    const accB = Number(b.metrics.accuracy ?? -1);
    if (accB !== accA) return accB - accA;
    const lossA = Number(a.metrics.loss ?? Infinity);
    const lossB = Number(b.metrics.loss ?? Infinity);
    return lossA - lossB;
  });

  const leaderboard = entries.map((e, rank) => ({
    rank: rank + 1,
    algorithmId: e.algorithmId,
    algorithmName: e.algorithmName,
    shardIndex: e.shardIndex,
    nodeId: e.nodeId,
    metrics: e.metrics,
    outputPreview: e.outputPreview,
  }));

  const winner = leaderboard[0] || null;
  return { winner, leaderboard };
}

function aggregateArenaResults(parts) {
  const { winner, leaderboard } = pickArenaWinner(parts);
  const shards = leaderboard.map((row) => ({
    shardIndex: row.shardIndex,
    metrics: row.metrics,
    algorithmId: row.algorithmId,
    algorithmName: row.algorithmName,
    nodeId: row.nodeId,
    outputPreview: row.outputPreview,
  }));

  return {
    mode: "arena",
    winner: winner
      ? {
          algorithmId: winner.algorithmId,
          algorithmName: winner.algorithmName,
          shardIndex: winner.shardIndex,
          nodeId: winner.nodeId,
          metrics: winner.metrics,
        }
      : null,
    leaderboard,
    shards,
    aggregated: winner?.metrics ?? null,
  };
}

module.exports = {
  parseMetricsFromOutput,
  aggregateMlResults,
  aggregateArenaResults,
  pickArenaWinner,
  METRICS_PREFIX,
};
