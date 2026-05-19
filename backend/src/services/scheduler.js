"use strict";

const { v4: uuidv4 } = require("uuid");
const { buildMlTaskPayload } = require("../lib/mlJobs");
const { aggregateMlResults, aggregateArenaResults } = require("../lib/mlAggregate");

/**
 * ACRS scheduling: trust-aware dispatch, challenge injection, task tracking.
 */
class Scheduler {
  /**
   * @param {{ nodeStore: object, wsManager: object, challengeEngine: object, jobRegistry: object }} deps
   */
  constructor({ nodeStore, wsManager, challengeEngine, jobRegistry }) {
    this.nodeStore = nodeStore;
    this.ws = wsManager;
    this.challenges = challengeEngine;
    this.jobs = jobRegistry;
    this.timer = null;
    /** @type {Map<string, string>} taskId -> nodeId */
    this.taskAssignments = new Map();
    /** @type {Set<string>} */
    this.coldStartSent = new Set();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 20_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  forgetNode(nodeId) {
    this.coldStartSent.delete(nodeId);
    for (const [taskId, nid] of this.taskAssignments) {
      if (nid === nodeId) {
        this.taskAssignments.delete(taskId);
      }
    }
  }

  tick() {
    this.maybeDispatchWaitingJobs();
    const active = this.nodeStore.getActive();
    for (const node of active) {
      if (!this.nodeStore.shouldChallenge(node.nodeId)) continue;
      if (this.challenges.pendingChallenges.size > 50) break;
      const ch = this.challenges.createChallenge(node.nodeId);
      const sent = this.ws.sendToNode(node.nodeId, {
        type: "TASK_DISPATCH",
        taskId: ch.taskId,
        workloadType: ch.type,
        image: ch.image,
        command: ch.command,
        timeout: 300_000,
      });
      if (sent) this.taskAssignments.set(ch.taskId, node.nodeId);
    }
  }

  trustThreshold(job) {
    const rel = (job.constraints && job.constraints.reliability) || "medium";
    // Default cold-start score is 0.5; keep "high" at 0.5 so new honest nodes can take jobs
    // after registration without getting stuck behind an impossible bar.
    if (rel === "high") return 0.5;
    if (rel === "low") return 0.2;
    return 0.35;
  }

  selectNodes(job, count) {
    const threshold = this.trustThreshold(job);
    const needGpu = job.ml && job.resources?.requireGpu;
    const nodes = this.nodeStore
      .getActive()
      .filter(
        (n) =>
          n.challengeScore >= threshold &&
          n.status !== "probation" &&
          (!needGpu || n.gpu),
      )
      .sort((a, b) => {
        const loadA = (a.activeTasks || 0) + (a.cpuUsage || 0);
        const loadB = (b.activeTasks || 0) + (b.cpuUsage || 0);
        return loadA - loadB;
      });
    if (!nodes.length) return [];
    const out = [];
    for (let i = 0; i < count; i++) out.push(nodes[i % nodes.length].nodeId);
    return out;
  }

  dispatchJobTasks(job) {
    const tasks = this.jobs.listJobTasks(job.jobId);
    const pending = tasks.filter((t) => t.status === "queued");
    if (!pending.length) return;

    const nodeIds = this.selectNodes(job, pending.length);
    if (!nodeIds.length) {
      const j = this.jobs.getJob(job.jobId);
      if (j && j.status !== "running") j.status = "waiting_nodes";
      this.ws.broadcastJob(job.jobId, {
        type: "JOB_UPDATE",
        jobId: job.jobId,
        status: "waiting_nodes",
        message:
          "No compute node connected via WebSocket. Start the node agent (node-resourcex start) and wait for 'Connected' before training.",
      });
      console.warn(
        `[scheduler] job ${job.jobId} waiting: 0 WS-connected nodes (${this.nodeStore.getActive().length} active in pool)`,
      );
      return;
    }

    let sentCount = 0;
    pending.forEach((task, i) => {
      const nodeId = nodeIds[i];
      const timeout = job.resources?.timeout || 600_000;
      const isMl = !!(job.ml && job.dataset);
      const dispatch = isMl
        ? {
            type: "TASK_DISPATCH",
            taskId: task.taskId,
            ...buildMlTaskPayload(job, task),
          }
        : {
            type: "TASK_DISPATCH",
            taskId: task.taskId,
            workloadType: job.type,
            image: job.image,
            command: job.command,
            timeout,
          };

      const sent = this.ws.sendToNode(nodeId, dispatch);
      if (!sent) {
        console.warn(
          `[scheduler] WS send failed job=${job.jobId} task=${task.taskId.slice(0, 8)} node=${nodeId.slice(0, 8)}`,
        );
        return;
      }

      this.jobs.assignTask(task.taskId, nodeId);
      this.taskAssignments.set(task.taskId, nodeId);
      sentCount++;

      if (isMl) {
        console.log(
          `[scheduler] ML dispatch job=${job.jobId} task=${task.taskId.slice(0, 8)} -> node=${nodeId.slice(0, 8)} shard=${task.shardIndex}`,
        );
      }

      // Do not inject trust challenges alongside ML work (confusing ~4s tasks without [ML])
      if (!isMl) {
        const injectChallenge =
          this.nodeStore.shouldChallenge(nodeId) && Math.random() < 0.35;
        if (injectChallenge) {
          const ch = this.challenges.createChallenge(nodeId);
          this.ws.sendToNode(nodeId, {
            type: "TASK_DISPATCH",
            taskId: ch.taskId,
            workloadType: ch.type,
            image: ch.image,
            command: ch.command,
            timeout: 300_000,
          });
        }
      }
    });

    if (sentCount > 0) {
      const j = this.jobs.getJob(job.jobId);
      if (j && j.status === "waiting_nodes") j.status = "running";
      this.ws.broadcastJob(job.jobId, {
        type: "JOB_UPDATE",
        jobId: job.jobId,
        status: "running",
        progress: 0,
        activeNodes: sentCount,
        message: job.ml ? "ML training dispatched to compute node(s)" : undefined,
      });
    }
  }

  maybeDispatchWaitingJobs() {
    for (const job of this.jobs.jobs.values()) {
      if (job.status !== "waiting_nodes") continue;
      for (const taskId of job.taskIds) {
        const t = this.jobs.getTask(taskId);
        if (t?.status === "dispatched") {
          t.status = "queued";
          t.nodeId = null;
          t.startedAt = null;
          this.taskAssignments.delete(taskId);
        }
      }
      this.dispatchJobTasks(job);
    }
  }

  sendColdStartChallenge(nodeId) {
    if (this.coldStartSent.has(nodeId)) return;
    this.coldStartSent.add(nodeId);
    const ch = this.challenges.createChallenge(nodeId);
    const ok = this.ws.sendToNode(nodeId, {
      type: "TASK_DISPATCH",
      taskId: ch.taskId,
      workloadType: ch.type,
      image: ch.image,
      command: ch.command,
      timeout: 300_000,
    });
    if (ok) this.taskAssignments.set(ch.taskId, nodeId);
  }

  async handleNodeMessage(nodeId, msg) {
    switch (msg.type) {
      case "NODE_HELLO":
        await this.nodeStore.register(nodeId, {
          cpu: msg.cpu,
          memory: msg.memory,
          gpu: msg.gpu,
          network: msg.network,
          connected: true,
        });
        this.nodeStore.setConnected(nodeId, true);
        const helloNode = this.nodeStore.get(nodeId);
        if (helloNode && helloNode.status === "offline") {
          helloNode.status = "active";
        }
        this.nodeStore.updateHeartbeat(nodeId, {
          cpuUsage: 0,
          memoryUsage: 0,
          activeTasks: 0,
        });
        this.sendColdStartChallenge(nodeId);
        this.maybeDispatchWaitingJobs();
        break;
      case "HEARTBEAT":
        this.nodeStore.updateHeartbeat(nodeId, {
          cpuUsage: msg.cpuUsage,
          memoryUsage: msg.memoryUsage,
          activeTasks: msg.activeTasks,
        });
        this.maybeDispatchWaitingJobs();
        break;
      case "TASK_PROGRESS": {
        const task = this.jobs.getTask(msg.taskId);
        if (task) {
          this.jobs.updateTaskProgress(msg.taskId, {
            progress: msg.progress,
            logs: msg.logs,
          });
          this.ws.broadcastJob(task.jobId, {
            type: "JOB_UPDATE",
            jobId: task.jobId,
            progress: msg.progress,
            status: "running",
            logs: msg.logs,
          });
        }
        break;
      }
      case "TASK_RESULT":
        this.handleTaskResult(nodeId, msg);
        break;
      case "TASK_ERROR":
        this.handleTaskError(nodeId, msg);
        break;
      default:
        break;
    }
  }

  handleTaskResult(nodeId, msg) {
    const { taskId, result, checksum, executionTime } = msg;
    if (this.challenges.isPendingChallenge(taskId)) {
      const evalRes = this.challenges.evaluate(
        taskId,
        result,
        executionTime,
      );
      if (evalRes) {
        const node = this.nodeStore.updateTrust(evalRes.nodeId, {
          success: evalRes.passed,
        });
        if (node) {
          this.ws.sendToNode(nodeId, {
            type: "TRUST_UPDATE",
            challengeScore: node.challengeScore,
            trustTier: node.trustTier,
          });
        }
        this.maybeDispatchWaitingJobs();
      }
      return;
    }

    const task = this.jobs.getTask(taskId);
    if (!task) return;
    if (this.taskAssignments.get(taskId) !== nodeId) {
      console.warn("[scheduler] result from unexpected node", nodeId, taskId);
    }
    this.nodeStore.incrementTaskCount(nodeId);
    this.jobs.completeTask(taskId, {
      result,
      checksum,
      validated: "ACRS",
    });
    const job = this.jobs.getJob(task.jobId);
    this.ws.broadcastJob(task.jobId, {
      type: "JOB_UPDATE",
      jobId: task.jobId,
      progress: job
        ? job.completedTasks / Math.max(1, job.parallelism)
        : 1,
      status: job?.status || "running",
      result: job?.status === "completed" ? this.aggregate(job) : undefined,
      confidenceScore: job?.confidenceScore,
      validated: job?.status === "completed" ? "ACRS" : undefined,
    });
  }

  aggregate(job) {
    const parts = job.results.sort((a, b) => a.shardIndex - b.shardIndex);
    if (job.arena?.enabled) return aggregateArenaResults(parts);
    if (job.ml) return aggregateMlResults(parts);
    if (parts.length === 1) return parts[0].result;
    return JSON.stringify(parts.map((p) => p.result));
  }

  handleTaskError(nodeId, msg) {
    const { taskId, error } = msg;
    if (this.challenges.isPendingChallenge(taskId)) {
      this.challenges.evaluate(taskId, "", 0);
      this.nodeStore.updateTrust(nodeId, { success: false });
      this.ws.sendToNode(nodeId, {
        type: "TRUST_UPDATE",
        challengeScore: this.nodeStore.get(nodeId)?.challengeScore,
        trustTier: this.nodeStore.get(nodeId)?.trustTier,
      });
      this.maybeDispatchWaitingJobs();
      return;
    }
    this.jobs.failTask(taskId, error);
    const task = this.jobs.getTask(taskId);
    if (task) {
      this.ws.broadcastJob(task.jobId, {
        type: "JOB_UPDATE",
        jobId: task.jobId,
        status: "failed",
        error,
      });
    }
  }
}

module.exports = { Scheduler };
