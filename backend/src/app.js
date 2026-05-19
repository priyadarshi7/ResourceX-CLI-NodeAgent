"use strict";

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const { createAuthRouter } = require("./routes/auth");
const { createNodesRouter } = require("./routes/nodes");
const { createJobsRouter } = require("./routes/jobs");
const { createAdminRouter } = require("./routes/admin");
const { createStudioRouter } = require("./routes/studio");
const { getDbName } = require("./lib/db");

/**
 * @param {object} rt runtime deps from bootstrap
 */
function createApp(rt) {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
  app.use(express.json({ limit: "10mb" }));
  app.use(morgan("dev"));

  app.get("/health", (req, res) =>
    res.json({
      status: "ok",
      ts: Date.now(),
      mongoDatabase: getDbName(),
      mongoCollections: ["users", "nodes"],
    }),
  );

  app.use("/api/auth", createAuthRouter());
  app.use("/api/nodes", createNodesRouter(rt));
  app.use("/api/jobs", createJobsRouter(rt));
  app.use("/api/admin", createAdminRouter(rt));
  app.use("/api/studio", createStudioRouter(rt));

  app.use((req, res) => res.status(404).json({ error: "Not found" }));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || "Internal error" });
  });

  return app;
}

module.exports = { createApp };
