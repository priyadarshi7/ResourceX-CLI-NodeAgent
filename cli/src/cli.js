#!/usr/bin/env node
"use strict";

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { program } = require("commander");
const axios = require("axios");
const chalk = require("chalk");

const DEFAULT_BACKEND =
  process.env.RESOURCEX_BACKEND || "http://localhost:4000";

async function readJsonFile(filePath) {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
  const raw = fs.readFileSync(abs, "utf8");
  return JSON.parse(raw);
}

program
  .name("resourcex")
  .description("ResourceX compute submitter CLI")
  .version("1.0.0");

program
  .command("submit")
  .description("Submit a job from a JSON file")
  .argument("<jobFile>", "Path to job.json")
  .option("-b, --backend <url>", "API base URL", DEFAULT_BACKEND)
  .option(
    "-t, --token <jwt>",
    "User JWT (or RESOURCEX_TOKEN env)",
    process.env.RESOURCEX_TOKEN,
  )
  .action(async (jobFile, opts) => {
    if (!opts.token) {
      console.error(
        chalk.red("Missing token: set RESOURCEX_TOKEN or pass --token"),
      );
      process.exit(1);
    }
    const spec = await readJsonFile(jobFile);
    const url = `${opts.backend.replace(/\/$/, "")}/api/jobs`;
    const res = await axios.post(url, spec, {
      headers: { Authorization: `Bearer ${opts.token}` },
    });
    console.log(chalk.green("\n  Job accepted\n"));
    console.log(chalk.gray(JSON.stringify(res.data, null, 2)));
    console.log("");
  });

program
  .command("status")
  .description("Fetch job status and output (GET /api/jobs/:jobId)")
  .argument("<jobId>", "Job id, e.g. from submit response or job JSON")
  .option("-b, --backend <url>", "API base URL", DEFAULT_BACKEND)
  .option(
    "-t, --token <jwt>",
    "User JWT (or RESOURCEX_TOKEN env)",
    process.env.RESOURCEX_TOKEN,
  )
  .option("-w, --watch", "Re-poll every 2s until completed or failed", false)
  .action(async (jobId, opts) => {
    if (!opts.token) {
      console.error(
        chalk.red("Missing token: set RESOURCEX_TOKEN or pass --token"),
      );
      process.exit(1);
    }
    const base = opts.backend.replace(/\/$/, "");
    const url = `${base}/api/jobs/${encodeURIComponent(jobId)}`;
    const headers = { Authorization: `Bearer ${opts.token}` };

    async function once() {
      const res = await axios.get(url, { headers });
      return res.data;
    }

    for (;;) {
      const data = await once();
      console.log(JSON.stringify(data, null, 2));
      if (
        !opts.watch ||
        data.status === "completed" ||
        data.status === "failed"
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  });

program.parse();
