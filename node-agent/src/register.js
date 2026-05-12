"use strict";

const axios = require("axios");
const ora = require("ora");
const chalk = require("chalk");
const si = require("systeminformation");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const inquirer = require("inquirer");

const CONFIG_PATH = path.join(
  require("os").homedir(),
  ".resourcex",
  "config.json",
);

async function gatherSystemInfo() {
  const [cpu, mem, osInfo, networkInterfaces, graphics] = await Promise.all([
    si.cpu(),
    si.mem(),
    si.osInfo(),
    si.networkInterfaces(),
    si.graphics(),
  ]);

  const iface = Array.isArray(networkInterfaces)
    ? networkInterfaces.find((n) => !n.internal && n.ip4) ||
      networkInterfaces[0]
    : networkInterfaces;

  return {
    cpu: {
      cores: cpu.cores,
      physicalCores: cpu.physicalCores,
      brand: cpu.brand,
      speed: cpu.speed,
    },
    memory: {
      total: mem.total,
      totalGB: Math.round(mem.total / 1024 / 1024 / 1024),
    },
    gpu: graphics.controllers.length > 0 && graphics.controllers[0].vram > 0,
    gpuInfo: graphics.controllers[0] || null,
    os: {
      platform: osInfo.platform,
      distro: osInfo.distro,
      arch: osInfo.arch,
    },
    network: {
      ip: iface ? iface.ip4 : "0.0.0.0",
      bandwidth: "1Gbps", // placeholder; real impl would benchmark
    },
  };
}

async function register({ backend }) {
  console.log(chalk.bold("\n  Node Registration\n"));

  // Check for existing config
  if (fs.existsSync(CONFIG_PATH)) {
    const { overwrite } = await inquirer.prompt([
      {
        type: "confirm",
        name: "overwrite",
        message: chalk.yellow(
          "A registered node config already exists. Re-register?",
        ),
        default: false,
      },
    ]);
    if (!overwrite) {
      console.log(chalk.gray("  Registration cancelled."));
      return;
    }
  }

  const { email, password } = await inquirer.prompt([
    { type: "input", name: "email", message: "  Email:" },
    { type: "password", name: "password", message: "  Password:", mask: "*" },
  ]);

  const spinner = ora("  Gathering system information...").start();
  const sysInfo = await gatherSystemInfo();
  spinner.succeed("  System info collected");

  const nodeId = uuidv4();

  spinner.start("  Registering node with backend...");

  try {
    const res = await axios.post(`${backend}/api/nodes/register`, {
      nodeId,
      email,
      password,
      cpu: sysInfo.cpu.cores,
      memory: `${sysInfo.memory.totalGB}GB`,
      gpu: sysInfo.gpu,
      gpuInfo: sysInfo.gpuInfo,
      os: sysInfo.os,
      network: sysInfo.network,
    });

    const { token, node } = res.data;

    // Save config
    const configDir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          nodeId,
          token,
          backend,
          registeredAt: new Date().toISOString(),
          systemInfo: sysInfo,
        },
        null,
        2,
      ),
    );

    spinner.succeed("  Node registered successfully!");

    console.log("\n" + chalk.green("  ✓ Registration complete\n"));
    console.log(chalk.gray("  Node ID:    ") + chalk.white(nodeId));
    console.log(
      chalk.gray("  Trust Tier: ") +
        chalk.yellow(node.trustTier || "COLD_START"),
    );
    console.log(chalk.gray("  Config:     ") + chalk.white(CONFIG_PATH));
    console.log(
      "\n" + chalk.cyan("  Run `resourcex-node start` to join the network.\n"),
    );
  } catch (err) {
    spinner.fail("  Registration failed");
    const msg = err.response?.data?.error || err.message;
    console.error(chalk.red(`\n  Error: ${msg}\n`));
    process.exit(1);
  }
}

module.exports = { register, gatherSystemInfo, CONFIG_PATH };
