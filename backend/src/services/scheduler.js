"use strict";

const { v4: uuidv4 } = require("uuid");

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
    const nodes = this.nodeStore
      .getActive()
      .filter(
        (n) =>
          n.challengeScore >= threshold &&
          n.status !== "probation",
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
    const nodeIds = this.selectNodes(job, tasks.length);
    if (!nodeIds.length) {
      const j = this.jobs.getJob(job.jobId);
      if (j) j.status = "waiting_nodes";
      this.ws.broadcastJob(job.jobId, {
        type: "JOB_UPDATE",
        jobId: job.jobId,
        status: "waiting_nodes",
        message: "No eligible nodes online. Will retry when nodes connect.",
      });
      return;
    }
    tasks.forEach((task, i) => {
      const nodeId = nodeIds[i];
      this.jobs.assignTask(task.taskId, nodeId);
      this.taskAssignments.set(task.taskId, nodeId);
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
      this.ws.sendToNode(nodeId, {
        type: "TASK_DISPATCH",
        taskId: task.taskId,
        workloadType: job.type,
        image: job.image,
        command: job.command,
        timeout: 600_000,
      });
      this.ws.broadcastJob(job.jobId, {
        type: "JOB_UPDATE",
        jobId: job.jobId,
        status: "running",
        progress: 0,
        activeNodes: new Set(nodeIds).size,
      });
    });
  }

  maybeDispatchWaitingJobs() {
    for (const job of this.jobs.jobs.values()) {
      if (job.status === "waiting_nodes") {
        this.dispatchJobTasks(job);
      }
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

  handleNodeMessage(nodeId, msg) {
    switch (msg.type) {
      case "NODE_HELLO":
        this.nodeStore.register(nodeId, {
          cpu: msg.cpu,
          memory: msg.memory,
          gpu: msg.gpu,
          network: msg.network,
        });
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
