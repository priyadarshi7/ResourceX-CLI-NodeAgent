"use strict";

const WebSocket = require("ws");
const axios = require("axios");
const chalk = require("chalk");
const ora = require("ora");
const fs = require("fs");
const { CONFIG_PATH, gatherSystemInfo } = require("./register");
const { TaskExecutor } = require("./executor");

const HEARTBEAT_INTERVAL = 15_000; // 15s
const RECONNECT_DELAY = 5_000; // 5s
const MAX_RECONNECT = 10;

class NodeAgent {
  constructor(opts) {
    this.opts = opts;
    this.config = null;
    this.ws = null;
    this.running = false;
    this.reconnectAttempts = 0;
    this.heartbeatTimer = null;
    this.executor = new TaskExecutor(opts);
    this.activeTasks = new Map();
    this.stats = {
      tasksCompleted: 0,
      challengesPassed: 0,
      challengesFailed: 0,
    };
  }

  loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
      throw new Error(
        "No node config found. Run `resourcex-node register` first.",
      );
    }
    this.config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    // Allow CLI override
    if (this.opts.backend) this.config.backend = this.opts.backend;
    if (this.opts.token) this.config.token = this.opts.token;
  }

  async start() {
    try {
      this.loadConfig();
    } catch (err) {
      console.error(chalk.red(`\n  ✗ ${err.message}\n`));
      process.exit(1);
    }

    this.running = true;
    console.log(chalk.bold("\n  Starting node agent...\n"));
    console.log(chalk.gray("  Node ID:  ") + chalk.white(this.config.nodeId));
    console.log(chalk.gray("  Backend:  ") + chalk.white(this.config.backend));
    console.log("");

    await this.connect();

    // Handle graceful shutdown
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
  }

  async connect() {
    const wsUrl =
      this.config.backend.replace(/^http/, "ws").replace(/\/?$/, "") +
      `/ws/node?token=${this.config.token}`;

    const spinner = ora("  Connecting to network...").start();

    this.ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${this.config.token}` },
    });

    this.ws.on("open", async () => {
      spinner.succeed(chalk.green("  Connected to ResourceX network"));
      this.reconnectAttempts = 0;
      await this.sendRegistrationPing();
      this.startHeartbeat();
      console.log(chalk.cyan("\n  Node is active. Waiting for tasks...\n"));
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (e) {
        console.error(chalk.red("  [WS] Bad message:", e.message));
      }
    });

    this.ws.on("error", (err) => {
      if (!spinner.isSpinning) {
        console.error(chalk.red(`  [WS] Error: ${err.message}`));
      } else {
        spinner.fail(chalk.red(`  Connection error: ${err.message}`));
      }
    });

    this.ws.on("close", () => {
      this.stopHeartbeat();
      if (this.running) {
        console.log(chalk.yellow("\n  [WS] Disconnected. Reconnecting...\n"));
        this.scheduleReconnect();
      }
    });
  }

  async sendRegistrationPing() {
    const sysInfo = await gatherSystemInfo();
    this.send({
      type: "NODE_HELLO",
      nodeId: this.config.nodeId,
      cpu: sysInfo.cpu.cores,
      memory: `${sysInfo.memory.totalGB}GB`,
      gpu: sysInfo.gpu,
      network: sysInfo.network,
    });
  }

  handleMessage(msg) {
    switch (msg.type) {
      case "TASK_DISPATCH":
        this.handleTaskDispatch(msg);
        break;
      case "TASK_CANCEL":
        this.handleTaskCancel(msg);
        break;
      case "TRUST_UPDATE":
        this.displayTrustUpdate(msg);
        break;
      case "NODE_DEREGISTERED":
        console.log(
          chalk.yellow(
            `\n  [POOL] ${msg.message || "This node was deregistered. Stopping."}\n`,
          ),
        );
        setImmediate(() => {
          this.stop().catch(() => {});
        });
        break;
      case "PING":
        this.send({ type: "PONG", ts: Date.now() });
        break;
      default:
      // Unknown message type — silently ignored (stealth challenges arrive as TASK_DISPATCH)
    }
  }

  async handleTaskDispatch(msg) {
    const { taskId, image, command, timeout = 300_000 } = msg;

    // Duplicate TASK_DISPATCH for the same id can arrive before the first run
    // finishes (WS handler does not await). A second concurrent run would delete
    // activeTasks on first completion and break the second with "startTime" errors.
    if (this.activeTasks.has(taskId)) {
      console.log(
        chalk.yellow(
          `  [TASK] ${taskId.slice(0, 8)}… duplicate dispatch ignored (already running)`,
        ),
      );
      return;
    }

    // Tasks are intentionally indistinguishable (masked challenges vs real tasks)
    console.log(chalk.gray(`  [TASK] ${taskId.slice(0, 8)}… dispatched`));

    this.activeTasks.set(taskId, { startTime: Date.now(), status: "running" });

    // Stream progress back
    this.send({
      type: "TASK_PROGRESS",
      taskId,
      progress: 0,
      status: "starting",
    });

    try {
      const result = await this.executor.execute({
        taskId,
        image,
        command,
        timeout,
        onProgress: (progress, logs) => {
          this.send({
            type: "TASK_PROGRESS",
            taskId,
            progress,
            logs,
            status: "running",
          });
        },
      });

      const meta = this.activeTasks.get(taskId);
      if (!meta) {
        console.log(
          chalk.gray(
            `  [TASK] ${taskId.slice(0, 8)}… finished but state was cleared; skipping duplicate result`,
          ),
        );
        return;
      }
      const elapsed = Date.now() - meta.startTime;
      this.activeTasks.delete(taskId);

      this.send({
        type: "TASK_RESULT",
        taskId,
        result: result.output,
        checksum: result.checksum,
        executionTime: elapsed / 1000,
        exitCode: result.exitCode,
      });

      this.stats.tasksCompleted++;
      console.log(
        chalk.green(
          `  [TASK] ${taskId.slice(0, 8)}… completed (${(elapsed / 1000).toFixed(1)}s)`,
        ),
      );
    } catch (err) {
      if (this.activeTasks.has(taskId)) {
        this.activeTasks.delete(taskId);
      }
      console.error(
        chalk.red(`  [TASK] ${taskId.slice(0, 8)}… failed: ${err.message}`),
      );

      this.send({
        type: "TASK_ERROR",
        taskId,
        error: err.message,
      });
    }
  }

  handleTaskCancel(msg) {
    const { taskId } = msg;
    if (this.activeTasks.has(taskId)) {
      this.executor.cancel(taskId);
      this.activeTasks.delete(taskId);
      console.log(chalk.yellow(`  [TASK] ${taskId.slice(0, 8)}… cancelled`));
    }
  }

  displayTrustUpdate(msg) {
    const tierColors = {
      COLD_START: chalk.gray,
      WARM: chalk.yellow,
      TRUSTED: chalk.cyan,
      ELITE: chalk.green,
    };
    const color = tierColors[msg.trustTier] || chalk.white;
    console.log(
      color(
        `  [TRUST] Score: ${msg.challengeScore?.toFixed(2)} | Tier: ${msg.trustTier}`,
      ),
    );
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(async () => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;

      let cpuUsage = 0;
      let memUsage = 0;
      try {
        const [load, mem] = await Promise.all([
          require("systeminformation").currentLoad(),
          require("systeminformation").mem(),
        ]);
        cpuUsage = load.currentLoad / 100;
        memUsage = 1 - mem.available / mem.total;
      } catch {
        /* ignore */
      }

      this.send({
        type: "HEARTBEAT",
        nodeId: this.config.nodeId,
        cpuUsage,
        memoryUsage: memUsage,
        activeTasks: this.activeTasks.size,
        stats: this.stats,
        ts: Date.now(),
      });
    }, HEARTBEAT_INTERVAL);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= MAX_RECONNECT) {
      console.error(
        chalk.red(
          `  Max reconnect attempts (${MAX_RECONNECT}) reached. Exiting.`,
        ),
      );
      process.exit(1);
    }
    this.reconnectAttempts++;
    const delay = RECONNECT_DELAY * this.reconnectAttempts;
    console.log(
      chalk.gray(
        `  Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${MAX_RECONNECT})...`,
      ),
    );
    setTimeout(() => this.connect(), delay);
  }

  send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  async stop() {
    console.log(chalk.yellow("\n\n  Shutting down node agent..."));
    this.running = false;
    this.stopHeartbeat();
    if (this.ws) this.ws.close();
    await this.executor.cleanup();
    console.log(chalk.green("  Node stopped. Goodbye.\n"));
    process.exit(0);
  }
}

module.exports = { NodeAgent };
