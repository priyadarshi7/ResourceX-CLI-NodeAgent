"use strict";

const axios = require("axios");
const ora = require("ora");
const chalk = require("chalk");
const fs = require("fs");
const inquirer = require("inquirer");
const { CONFIG_PATH } = require("./register");

async function deregister(opts) {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(
      chalk.yellow("\n  No registration found at " + CONFIG_PATH + "\n"),
    );
    return;
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const backend = opts.backend || config.backend;

  if (!opts.yes) {
    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: chalk.yellow(
          "Remove this machine from the pool and delete local credentials?",
        ),
        default: false,
      },
    ]);
    if (!confirm) {
      console.log(chalk.gray("  Cancelled."));
      return;
    }
  }

  const spinner = ora("  Deregistering with backend...").start();
  try {
    const res = await axios.delete(`${backend.replace(/\/$/, "")}/api/nodes/me`, {
      headers: { Authorization: `Bearer ${config.token}` },
      validateStatus: () => true,
    });
    if (res.status === 200) {
      spinner.succeed("  Backend removed this node");
    } else if (res.status === 401) {
      spinner.warn("  Token rejected (backend); removing local config only");
    } else {
      spinner.warn(`  Unexpected HTTP ${res.status}; removing local config anyway`);
    }
  } catch (err) {
    spinner.warn("  Backend request failed; removing local config anyway");
    const msg = err.response?.data?.error || err.message;
    console.log(chalk.gray(`  (${msg})`));
  }

  try {
    fs.unlinkSync(CONFIG_PATH);
  } catch {
    /* ignore */
  }

  console.log(
    chalk.green("\n  ✓ Local registration removed. Stop the agent if it is still running.\n"),
  );
}

module.exports = { deregister };
