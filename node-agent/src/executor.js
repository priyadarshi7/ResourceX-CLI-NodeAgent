"use strict";

const crypto = require("crypto");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const { prepareMlWorkspace, cleanupWorkspace } = require("./mlRunner");

const execFileAsync = promisify(execFile);

function runDockerWithLogs(args, timeoutMs, onProgress) {
  return new Promise((resolve, reject) => {
    const out = [];
    const err = [];
    const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Docker timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const flushLines = (chunk, isErr) => {
      const text = chunk.toString();
      (isErr ? err : out).push(text);
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t) onProgress?.(null, t);
      }
    };

    proc.stdout.on("data", (c) => flushLines(c, false));
    proc.stderr.on("data", (c) => flushLines(c, true));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        output: out.join("") + err.join(""),
        exitCode: code ?? 1,
      });
    });
  });
}

class TaskExecutor {
  constructor(opts = {}) {
    this.useDocker = opts.docker !== false;
    /** @type {Map<string, string>} */
    this.runningContainers = new Map();
  }

  async execute(task) {
    const {
      taskId,
      image,
      command,
      timeout = 300_000,
      onProgress,
      ml,
      workloadType,
    } = task;

    const isMl = workloadType === "ml_training" || !!ml;

    if (!this.useDocker) {
      return this._simulateExecution({ taskId, command, timeout, onProgress, ml });
    }

    if (isMl && ml) {
      return this._mlDockerExecution({
        taskId,
        image,
        command,
        timeout,
        onProgress,
        ml,
      });
    }

    return this._dockerExecution({
      taskId,
      image,
      command,
      timeout,
      onProgress,
    });
  }

  async _mlDockerExecution({ taskId, image, command, timeout, onProgress, ml }) {
    const resources = ml.resources || {};
    let workspace;
    try {
      onProgress?.(0.02, "Preparing ML workspace (download dataset + script)…");
      const prep = await prepareMlWorkspace({
        taskId,
        ml: { ...ml, shardIndex: ml.shardIndex },
        onProgress,
      });
      workspace = prep.workspace;

      onProgress?.(0.45, `Pulling Docker image ${image} (first time can take a few minutes)…`);
      try {
        await execFileAsync("docker", ["pull", image], { timeout: 600_000 });
      } catch {
        onProgress?.(0.48, `Using local image ${image}`);
      }

      onProgress?.(0.5, `Starting ML container (${image})…`);

      const cpus = String(resources.cpus || 2);
      const memory = resources.memory || "4g";
      const mount = `${workspace.replace(/\\/g, "/")}:/workspace`;
      const dataMount = `${prep.dataDir.replace(/\\/g, "/")}:/data`;

      const args = [
        "run",
        "--rm",
        "--name",
        `resourcex_ml_${taskId.replace(/-/g, "").slice(0, 12)}`,
        "--cpus",
        cpus,
        "--memory",
        memory,
        "-v",
        mount,
        "-v",
        dataMount,
        "-e",
        "RESOURCEX_DATA_DIR=/data",
        "-e",
        `RESOURCEX_SHARD_INDEX=${ml.shardIndex ?? 0}`,
        "-e",
        `RESOURCEX_SHARD_COUNT=${ml.shardCount ?? ml.dataset?.shardCount ?? 1}`,
        "-e",
        `RESOURCEX_JOB_ID=${ml.jobId || ""}`,
      ];

      const hp = ml.training?.hyperparameters || {};
      if (hp.epochs != null) args.push("-e", `RX_EPOCHS=${hp.epochs}`);

      args.push("-w", "/workspace");

      if (resources.network !== false) {
        args.push("--network", "bridge");
      } else {
        args.push("--network", "none");
      }

      if (resources.gpu) {
        args.push("--gpus", "all");
      }

      if (ml.dataset?.source === "huggingface") {
        const hf = ml.dataset.huggingface || ml.dataset.shard;
        args.push("-e", `HF_DATASET=${hf.dataset}`);
        if (hf.config) args.push("-e", `HF_CONFIG=${hf.config}`);
        args.push("-e", `HF_SPLIT=${hf.split || "train"}`);
      }

      args.push(image, "sh", "-c", command);

      const containerKey = taskId;
      this.runningContainers.set(containerKey, args[4]);

      let output = "";
      let exitCode = 0;
      try {
        const result = await runDockerWithLogs(args, timeout, onProgress);
        output = result.output || "";
        exitCode = result.exitCode;
        onProgress?.(
          0.95,
          exitCode === 0 ? "Training finished" : `Training exited with code ${exitCode}`,
        );
      } catch (err) {
        exitCode = 1;
        output = err.message || String(err);
        onProgress?.(0.95, `Training failed: ${output}`);
      }

      this.runningContainers.delete(containerKey);
      const checksum = crypto.createHash("sha256").update(output).digest("hex");
      return { output, checksum, exitCode };
    } finally {
      if (workspace) cleanupWorkspace(taskId);
    }
  }

  async _dockerExecution({ taskId, image, command, timeout, onProgress }) {
    try {
      await execFileAsync("docker", ["pull", image], { timeout: 120_000 });
    } catch {
      /* ignore */
    }

    onProgress?.(0.1, `Pulled image ${image}`);

    const containerId = `resourcex_${taskId.replace(/-/g, "").slice(0, 12)}`;
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

  async _simulateExecution({ taskId, command, timeout, onProgress, ml }) {
    const steps = [0.1, 0.25, 0.5, 0.75, 0.9];
    for (const progress of steps) {
      await sleep(300 + Math.random() * 500);
      onProgress?.(
        progress,
        ml ? `ML simulate shard ${ml.shardIndex ?? 0}` : `Step ${Math.round(progress * 10)}/9`,
      );
    }

    const output = JSON.stringify({
      taskId,
      command,
      simulatedResult: true,
      ml: !!ml,
      shardIndex: ml?.shardIndex ?? 0,
      metrics: { loss: 0.42, accuracy: 0.88 },
      timestamp: Date.now(),
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
