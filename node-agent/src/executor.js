"use strict";

const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

class TaskExecutor {
  constructor(opts = {}) {
    this.useDocker = opts.docker !== false;
    this.runningContainers = new Map(); // taskId -> containerId
  }

  /**
   * Execute a task. Returns { output, checksum, exitCode }.
   * In dev mode (no Docker), simulates execution.
   */
  async execute({ taskId, image, command, timeout = 300_000, onProgress }) {
    if (!this.useDocker) {
      return this._simulateExecution({ taskId, command, timeout, onProgress });
    }
    return this._dockerExecution({
      taskId,
      image,
      command,
      timeout,
      onProgress,
    });
  }

  async _dockerExecution({ taskId, image, command, timeout, onProgress }) {
    // Pull image if needed
    try {
      await execFileAsync("docker", ["pull", image], { timeout: 120_000 });
    } catch {
      // Image may already exist locally
    }

    onProgress?.(0.1, `Pulled image ${image}`);

    const containerId = `resourcex_${taskId.replace(/-/g, "").slice(0, 12)}`;

    // Run container with resource limits
    const args = [
      "run",
      "--rm",
      "--name",
      containerId,
      "--cpus",
      "1",
      "--memory",
      "512m",
      "--network",
      "none",
      "--read-only",
      "--security-opt",
      "no-new-privileges",
      image,
      "sh",
      "-c",
      command,
    ];

    this.runningContainers.set(taskId, containerId);
    onProgress?.(0.3, "Container started");

    let output = "";
    let exitCode = 0;

    try {
      const result = await execFileAsync("docker", args, {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });
      output = result.stdout;
      onProgress?.(0.9, "Execution complete");
    } catch (err) {
      exitCode = err.code || 1;
      output = err.stdout || err.stderr || err.message;
    }

    this.runningContainers.delete(taskId);

    const checksum = crypto.createHash("sha256").update(output).digest("hex");
    return { output, checksum, exitCode };
  }

  async _simulateExecution({ taskId, command, timeout, onProgress }) {
    // Simulated execution for dev/demo environments without Docker
    const steps = [0.1, 0.3, 0.5, 0.7, 0.9];
    for (const progress of steps) {
      await sleep(200 + Math.random() * 400);
      onProgress?.(progress, `Step ${Math.round(progress * 10)}/9`);
    }

    const output = JSON.stringify({
      taskId,
      command,
      simulatedResult: true,
      timestamp: Date.now(),
      value: Math.random().toFixed(6),
    });

    const checksum = crypto.createHash("sha256").update(output).digest("hex");
    return { output, checksum, exitCode: 0 };
  }

  cancel(taskId) {
    const containerId = this.runningContainers.get(taskId);
    if (containerId) {
      execFile("docker", ["kill", containerId], () => {});
      this.runningContainers.delete(taskId);
    }
  }

  async cleanup() {
    for (const [taskId, containerId] of this.runningContainers) {
      try {
        await execFileAsync("docker", ["kill", containerId]);
      } catch {
        /* ignore */
      }
    }
    this.runningContainers.clear();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { TaskExecutor };
