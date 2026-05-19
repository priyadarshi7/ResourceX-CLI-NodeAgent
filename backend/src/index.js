"use strict";

require("dotenv").config();
const http = require("http");
const { createApp } = require("./app");
const { initWebSocket } = require("./services/websocket");
const { initWorkers } = require("./workers");
const { NodeStateStore } = require("./services/nodeState");
const { Scheduler } = require("./services/scheduler");
const { ChallengeEngine } = require("./services/challenge");
const { JobRegistry } = require("./services/jobRegistry");
const { createJobQueue } = require("./lib/queue");
const { connectDb, closeDb, getMongoUri, getDbName } = require("./lib/db");

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "0.0.0.0";

async function main() {
  await connectDb();
  const { queue, connection } = createJobQueue();
  const nodeStore = new NodeStateStore();
  const jobRegistry = new JobRegistry();
  const challengeEngine = new ChallengeEngine();

  const wsRef = {};
  const scheduler = new Scheduler({
    nodeStore,
    wsManager: wsRef,
    challengeEngine,
    jobRegistry,
  });

  const rt = {
    nodeStore,
    jobRegistry,
    challengeEngine,
    scheduler,
    queue,
    connection,
  };

  const app = createApp(rt);
  const server = http.createServer(app);

  const wsManager = initWebSocket(server, {
    scheduler,
    nodeStore,
    jobRegistry,
  });
  Object.assign(wsRef, wsManager);
  rt.disconnectNode = wsManager.disconnectNode;

  scheduler.start();
  const worker = await initWorkers(rt);
  rt.worker = worker;

  server.listen(PORT, HOST, () => {
    console.log(`\n  ResourceX Backend`);
    console.log(`     Listen  → ${HOST}:${PORT}`);
    const uri = getMongoUri();
    const atlas = uri.includes("mongodb.net") || uri.startsWith("mongodb+srv:");
    console.log(
      `     MongoDB → database "${getDbName()}" (${atlas ? "Atlas" : "local"})`,
    );
    console.log(`     Users   → collection "users" in that database`);
    console.log(`     HTTP    → http://localhost:${PORT}`);
    console.log(`     Node WS → ws://localhost:${PORT}/ws/node?token=<jwt>`);
    console.log(`     Jobs WS → ws://localhost:${PORT}/ws/jobs?token=<jwt>\n`);
  });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n  Shutting down...");
    scheduler.stop();
    try {
      await worker.close();
    } catch (e) {
      console.error(e);
    }
    try {
      await queue.close();
    } catch (e) {
      console.error(e);
    }
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
  }

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
