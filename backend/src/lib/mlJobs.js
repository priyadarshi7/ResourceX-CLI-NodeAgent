"use strict";

const { buildArenaScript, getArenaAlgorithm } = require("./arenaAlgorithms");

/** Public image that always exists on Docker Hub (PyTorch installed via pip in entrypoint). */
const DEFAULT_ML_IMAGE =
  process.env.RESOURCEX_ML_IMAGE || "python:3.11-slim";

const DEFAULT_ML_ENTRYPOINT =
  "pip install -q torch pandas && python /workspace/train.py";

/**
 * Normalize and validate an ml_training job body.
 * Huge datasets must be referenced by URL shards — never embedded in the API payload.
 *
 * @param {object} body
 * @returns {object} fields merged into createJob()
 */
function normalizeMlTrainingJob(body) {
  if (body.type !== "ml_training") {
    throw new Error('ML jobs must set type to "ml_training"');
  }
  if (!body.training || typeof body.training !== "object") {
    throw new Error("ML jobs require a training object");
  }
  if (!body.dataset || typeof body.dataset !== "object") {
    throw new Error("ML jobs require a dataset object (URL shards, not inline data)");
  }

  const dataset = normalizeDataset(body.dataset);
  const training = normalizeTraining(body.training);
  const resources = normalizeResources(body.resources);
  const parallelism = Math.max(
    1,
    Number(body.parallelism) || dataset.shards.length || 1,
  );

  const arena = body.arena?.enabled ? body.arena : null;
  if (
    !arena &&
    dataset.shards.length > 1 &&
    parallelism > dataset.shards.length
  ) {
    throw new Error(
      `parallelism (${parallelism}) cannot exceed dataset shard count (${dataset.shards.length})`,
    );
  }

  return {
    jobId: body.jobId,
    type: "ml_training",
    image: body.image || DEFAULT_ML_IMAGE,
    command: body.command || buildDefaultMlCommand(training),
    parallelism,
    constraints: body.constraints || { reliability: "medium" },
    resources,
    dataset,
    training,
    ml: true,
    arena,
    submittedBy: body.submittedBy,
  };
}

function normalizeDataset(dataset) {
  const mountPath = dataset.mountPath || "/data";
  const format = dataset.format || "auto";

  if (dataset.source === "huggingface") {
    const hf = dataset.huggingface || {};
    if (!hf.dataset) throw new Error("dataset.huggingface.dataset is required");
    return {
      source: "huggingface",
      mountPath,
      format,
      huggingface: {
        dataset: hf.dataset,
        config: hf.config || null,
        split: hf.split || "train",
        streaming: !!hf.streaming,
      },
      shards: [{ kind: "huggingface", ...hf }],
    };
  }

  const urls = dataset.urls || dataset.shards || [];
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error(
      "dataset.urls (or dataset.shards) must list at least one download URL per partition",
    );
  }

  const shards = urls.map((entry, i) => {
    if (typeof entry === "string") {
      return { kind: "url", url: entry, index: i };
    }
    if (entry && entry.url) {
      return {
        kind: "url",
        url: entry.url,
        filename: entry.filename || entry.name || null,
        index: entry.index ?? i,
        checksum: entry.checksum,
      };
    }
    throw new Error(`Invalid dataset shard at index ${i}`);
  });

  return { source: "urls", mountPath, format, shards };
}

function normalizeTraining(training) {
  const framework = training.framework || "pytorch";
  const hyperparameters = training.hyperparameters || {};
  const epochs = Number(hyperparameters.epochs ?? training.epochs ?? 3);

  return {
    framework,
    scriptUrl: training.scriptUrl || null,
    scriptInline: training.scriptInline || null,
    entrypoint: training.entrypoint || DEFAULT_ML_ENTRYPOINT,
    hyperparameters: { ...hyperparameters, epochs },
    modelType: training.modelType || "mlp",
  };
}

function normalizeResources(resources = {}) {
  return {
    cpus: Number(resources.cpus) || 2,
    memory: resources.memory || "4g",
    gpu: !!resources.gpu,
    requireGpu: !!resources.requireGpu,
    timeout: Number(resources.timeout) || 3_600_000,
    network: resources.network !== false,
  };
}

function buildDefaultMlCommand(training) {
  return training.entrypoint || DEFAULT_ML_ENTRYPOINT;
}

/** Pick deps from notebook code — avoid pip install torch for sklearn-only scripts. */
function detectTrainingFramework(code) {
  const src = String(code || "");
  if (/\b(import|from)\s+torch\b/i.test(src)) return "pytorch";
  if (
    /\b(sklearn|scikit-learn)\b/i.test(src) ||
    /LogisticRegression|RandomForest|sklearn\./i.test(src)
  ) {
    return "sklearn";
  }
  if (/\bimport\s+pandas\b/i.test(src) && !/\btorch\b/i.test(src)) {
    return "sklearn";
  }
  return "pytorch";
}

function buildStudioEntrypoint(framework) {
  if (framework === "sklearn") {
    return (
      'echo "[ResourceX] installing pandas + scikit-learn (fast)..." && ' +
      "pip install -q pandas scikit-learn && " +
      'echo "[ResourceX] starting training..." && python -u /workspace/train.py'
    );
  }
  return (
    'echo "[ResourceX] installing ML deps (PyTorch — first run may take 10+ min)..." && ' +
    "pip install -q torch pandas pyarrow scikit-learn && " +
    'echo "[ResourceX] starting training..." && python -u /workspace/train.py'
  );
}

function isMlTrainingJob(body) {
  if (!body || typeof body !== "object") return false;
  if (body.type === "ml_training") return true;
  return !!(body.dataset && body.training);
}

/**
 * File-level sharding: one URL per task, process the full file (no row split).
 * Row-level sharding: same data on each node, slice rows by task index.
 */
function resolveShardAssignment(job, task) {
  if (job.arena?.enabled) {
    const urlShards = job.dataset.shards;
    return {
      shard: urlShards[0],
      shardIndex: 0,
      shardCount: 1,
    };
  }

  const urlShards = job.dataset.shards;
  const parallelism = job.parallelism;
  const taskIndex = task.shardIndex;

  if (urlShards.length > 1 && parallelism === urlShards.length) {
    return {
      shard: urlShards[taskIndex],
      shardIndex: 0,
      shardCount: 1,
    };
  }

  if (urlShards.length === 1 && parallelism > 1) {
    return {
      shard: urlShards[0],
      shardIndex: taskIndex,
      shardCount: parallelism,
    };
  }

  return {
    shard: urlShards[taskIndex % urlShards.length],
    shardIndex: taskIndex,
    shardCount: parallelism,
  };
}

/**
 * Payload sent to a compute node for one task shard.
 */
function buildMlTaskPayload(job, task) {
  const { shard, shardIndex, shardCount } = resolveShardAssignment(job, task);
  const training = { ...job.training };
  if (job.arena?.enabled && task.algorithmId) {
    training.scriptInline = buildArenaScript(task.algorithmId);
    const meta = getArenaAlgorithm(task.algorithmId);
    if (meta) training.algorithmName = meta.name;
  }

  return {
    workloadType: "ml_training",
    image: job.image,
    command: job.command,
    timeout: job.resources.timeout,
    shardIndex: task.shardIndex,
    jobId: job.jobId,
    algorithmId: task.algorithmId || null,
    ml: {
      jobId: job.jobId,
      shardIndex,
      shardCount,
      training,
      dataset: {
        ...job.dataset,
        shard,
        shardCount: urlShardsLength(job),
      },
      resources: job.resources,
    },
  };
}

function urlShardsLength(job) {
  return job.dataset?.shards?.length ?? 1;
}

module.exports = {
  normalizeMlTrainingJob,
  isMlTrainingJob,
  buildMlTaskPayload,
  resolveShardAssignment,
  detectTrainingFramework,
  buildStudioEntrypoint,
  DEFAULT_ML_IMAGE,
};
