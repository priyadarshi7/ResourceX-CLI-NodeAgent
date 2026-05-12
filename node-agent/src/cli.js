#!/usr/bin/env node
"use strict";

require("dotenv").config();
const { program } = require("commander");
const chalk = require("chalk");
const { NodeAgent } = require("./agent");
const { register } = require("./register");
const { deregister } = require("./deregister");
const { displayStatus } = require("./status");

const LOGO = `
${chalk.cyan("╦═╗╔═╗╔═╗╔═╗╦ ╦╦═╗╔═╗╔═╗")}${chalk.white("═╗  ╦ ╦╔═╗╔╦╗╔═╗")}
${chalk.cyan("╠╦╝║╣ ╚═╗║ ║║ ║╠╦╝║  ║╣ ")}${chalk.white("╔╝  ║║║║ ║ ║║║╣ ")}
${chalk.cyan("╩╚═╚═╝╚═╝╚═╝╚═╝╩╚═╚═╝╚═╝")}${chalk.white("╚   ╚╩╝╚═╝═╩╝╚═╝")}
${chalk.gray("  Decentralized Compute Network — Node Agent v1.0.0")}
`;

program
  .name("resourcex-node")
  .description("ResourceX Compute Node Agent")
  .version("1.0.0");

program
  .command("start")
  .description("Start the node agent and join the compute network")
  .option(
    "-b, --backend <url>",
    "Backend URL",
    process.env.RESOURCEX_BACKEND || "http://localhost:4000",
  )
  .option(
    "-t, --token <token>",
    "Auth token (or set RESOURCEX_TOKEN env var)",
    process.env.RESOURCEX_TOKEN,
  )
  .option("--no-docker", "Disable Docker sandboxing (dev mode)")
  .action(async (opts) => {
    console.log(LOGO);
    const agent = new NodeAgent({
      backend: opts.backend,
      token: opts.token,
      docker: !opts.noDocker,
    });
    await agent.start();
  });

program
  .command("register")
  .description("Register this machine as a compute node")
  .option(
    "-b, --backend <url>",
    "Backend URL",
    process.env.RESOURCEX_BACKEND || "http://localhost:4000",
  )
  .action(async (opts) => {
    console.log(LOGO);
    await register(opts);
  });

program
  .command("deregister")
  .description("Leave the pool: remove node on server and delete local ~/.resourcex/config.json")
  .option(
    "-b, --backend <url>",
    "Backend URL (defaults to value stored in config)",
    process.env.RESOURCEX_BACKEND,
  )
  .option("-y, --yes", "Skip confirmation prompt", false)
  .action(async (opts) => {
    console.log(LOGO);
    await deregister({ backend: opts.backend, yes: opts.yes });
  });

program
  .command("status")
  .description("Show current node status")
  .action(async () => {
    await displayStatus();
  });

program
  .command("stop")
  .description("Gracefully stop the node agent")
  .action(async () => {
    const agent = new NodeAgent({});
    await agent.stop();
  });

program.parse();
