"use strict";

const { getDb } = require("./db");

function jobsCol() {
  return getDb().collection("jobs");
}

function snapshotJob(registry, jobId) {
  const job = registry.getJob(jobId);
  if (!job) return null;
  const tasks = registry.listJobTasks(jobId);
  return {
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    parallelism: job.parallelism,
    ml: !!job.ml,
    arena: job.arena || null,
    completedTasks: job.completedTasks,
    results: job.results || [],
    error: job.error,
    confidenceScore: job.confidenceScore,
    submittedBy: job.submittedBy,
    submittedAt: job.submittedAt,
    completedAt: job.completedAt || null,
    dataset: job.dataset
      ? { source: job.dataset.source, shardCount: job.dataset.shards?.length }
      : null,
    training: job.training
      ? {
          framework: job.training.framework,
          modelType: job.training.modelType,
          hyperparameters: job.training.hyperparameters,
        }
      : null,
    tasks: tasks.map((t) => ({
      taskId: t.taskId,
      shardIndex: t.shardIndex,
      algorithmId: t.algorithmId || null,
      status: t.status,
      nodeId: t.nodeId,
      progress: t.progress,
      error: t.error || null,
      result: t.status === "completed" ? t.result : undefined,
    })),
    updatedAt: Date.now(),
  };
}

function schedulePersistJob(registry, jobId) {
  setImmediate(() => {
    persistJob(registry, jobId).catch((err) =>
      console.error("[jobs] persist", jobId, err.message),
    );
  });
}

async function persistJob(registry, jobId) {
  const snap = snapshotJob(registry, jobId);
  if (!snap) return;
  await jobsCol().updateOne({ jobId }, { $set: snap }, { upsert: true });
}

async function loadPersistedJob(jobId) {
  return jobsCol().findOne({ jobId }, { projection: { _id: 0 } });
}

module.exports = {
  schedulePersistJob,
  persistJob,
  loadPersistedJob,
  snapshotJob,
};
