"use strict";

const chalk = require("chalk");
const fs = require("fs");
const { CONFIG_PATH } = require("./register");

async function displayStatus() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(
      chalk.yellow(
        "\n  No node registered. Run `resourcex-node register` first.\n",
      ),
    );
    return;
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

  console.log("\n" + chalk.bold("  Node Status"));
  console.log(chalk.gray("  ─────────────────────────────────────"));
  console.log(chalk.gray("  Node ID:     ") + chalk.white(config.nodeId));
  console.log(chalk.gray("  Backend:     ") + chalk.white(config.backend));
  console.log(
    chalk.gray("  Registered:  ") +
      chalk.white(new Date(config.registeredAt).toLocaleString()),
  );

  if (config.systemInfo) {
    const s = config.systemInfo;
    console.log(
      chalk.gray("  CPU:         ") +
        chalk.white(`${s.cpu.cores} cores (${s.cpu.brand})`),
    );
    console.log(
      chalk.gray("  Memory:      ") + chalk.white(`${s.memory.totalGB}GB`),
    );
    console.log(
      chalk.gray("  GPU:         ") +
        chalk.white(s.gpu ? chalk.green("Yes") : chalk.gray("No")),
    );
    console.log(
      chalk.gray("  OS:          ") +
        chalk.white(`${s.os.distro} (${s.os.arch})`),
    );
  }

  console.log(chalk.gray("  ─────────────────────────────────────\n"));
}

module.exports = { displayStatus };
