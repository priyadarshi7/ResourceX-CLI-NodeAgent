"use strict";

const { EventEmitter } = require("events");
const { v4: uuidv4 } = require("uuid");

/**
 * In-memory job + task graph for scheduling, aggregation, and user WS fan-out.
 */
class JobRegistry extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, object>} */
    this.jobs = new Map();
    /** @type {Map<string, object>} */
    this.tasks = new Map();
  }

  createJob(spec) {
    const jobId = spec.jobId || uuidv4();
    const parallelism = Math.max(1, Number(spec.parallelism) || 1);
    const job = {
      jobId,
      type: spec.type || "generic",
      image: spec.image,
      command: spec.command,
      constraints: spec.constraints || {},
      status: "queued",
      parallelism,
      submittedAt: Date.now(),
      completedTasks: 0,
      taskIds: [],
      results: [],
      error: null,
      confidenceScore: null,
    };

    const taskIds = [];
    for (let i = 0; i < parallelism; i++) {
      const taskId = uuidv4();
      taskIds.push(taskId);
      this.tasks.set(taskId, {
        taskId,
        jobId,
        shardIndex: i,
        status: "queued",
        nodeId: null,
        logs: "",
        progress: 0,
        startedAt: null,
        finishedAt: null,
        result: null,
      });
    }
    job.taskIds = taskIds;
    this.jobs.set(jobId, job);
    this.emit("jobCreated", job);
    return job;
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  assignTask(taskId, nodeId) {
    const t = this.tasks.get(taskId);
    if (!t) return null;
    t.nodeId = nodeId;
    t.status = "dispatched";
    t.startedAt = Date.now();
    const j = this.jobs.get(t.jobId);
    if (j && (j.status === "queued" || j.status === "waiting_nodes")) {
      j.status = "running";
    }
    this.emit("taskAssigned", { taskId, nodeId, jobId: t.jobId });
    return t;
  }

  updateTaskProgress(taskId, { progress, logs }) {
    const t = this.tasks.get(taskId);
    if (!t) return;
    if (typeof progress === "number") t.progress = progress;
    if (logs) t.logs = (t.logs + logs).slice(-4000);
    const job = this.jobs.get(t.jobId);
    this.emit("jobProgress", { jobId: t.jobId, job, taskId, progress: t.progress });
  }

  completeTask(taskId, { result, validated }) {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.status = "completed";
    t.finishedAt = Date.now();
    t.result = result;
    t.validated = validated;
    const job = this.jobs.get(t.jobId);
    if (!job) return;
    job.completedTasks++;
    job.results.push({ shardIndex: t.shardIndex, result });
    if (job.completedTasks >= job.parallelism) {
      job.status = "completed";
      job.completedAt = Date.now();
      job.confidenceScore = validated ? 0.95 : 0.75;
      this.emit("jobCompleted", job);
    } else {
      this.emit("jobProgress", {
        jobId: job.jobId,
        job,
        taskId,
        progress:
          job.taskIds.reduce((acc, id) => {
            const x = this.tasks.get(id);
            return acc + (x?.status === "completed" ? 1 : x?.progress || 0);
          }, 0) / job.parallelism,
      });
    }
  }

  failTask(taskId, error) {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.status = "failed";
    t.error = error;
    const job = this.jobs.get(t.jobId);
    if (job) {
      job.status = "failed";
      job.error = error;
      this.emit("jobFailed", { job, taskId, error });
    }
  }

  listJobTasks(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return [];
    return job.taskIds.map((id) => this.tasks.get(id)).filter(Boolean);
  }
}

module.exports = { JobRegistry };
