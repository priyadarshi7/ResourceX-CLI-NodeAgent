"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const { pipeline } = require("stream/promises");
const { createWriteStream } = require("fs");

const CACHE_ROOT =
  process.env.RESOURCEX_DATA_CACHE ||
  path.join(os.homedir(), ".resourcex", "cache");

const BUNDLED_TRAIN = path.join(__dirname, "..", "scripts", "train.py");

function workspaceDir(taskId) {
  const dir = path.join(CACHE_ROOT, "workspaces", taskId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const fromQuery = u.searchParams.get("filename");
    if (fromQuery) return path.basename(fromQuery);
    const base = path.basename(u.pathname);
    if (base && base !== "files" && !/^[0-9a-f-]{36}$/i.test(base)) return base;
  } catch {
    /* ignore */
  }
  return null;
}

function isLocalhostUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

async function downloadFile(url, dest, onProgress) {
  if (isLocalhostUrl(url)) {
    onProgress?.(
      0,
      "Downloading from localhost (only works if the node agent runs on the same machine as the backend)",
    );
  }

  const proto = url.startsWith("https") ? https : http;
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });

  return new Promise((resolve, reject) => {
    let req;
    const timer = setTimeout(() => {
      req?.destroy();
      reject(
        new Error(
          `Dataset download timed out after 120s. If the backend is on another PC, set PUBLIC_URL to its LAN IP. URL: ${url}`,
        ),
      );
    }, 120_000);

    req = proto.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          downloadFile(res.headers.location, dest, onProgress).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          clearTimeout(timer);
          reject(
            new Error(
              `Download failed HTTP ${res.statusCode}. Set PUBLIC_URL=http://<backend-ip>:4000 if the node is not on the same machine. URL: ${url}`,
            ),
          );
          return;
        }
        const total = Number(res.headers["content-length"]) || 0;
        let received = 0;
        const file = createWriteStream(dest);
        res.on("data", (chunk) => {
          received += chunk.length;
          if (total > 0) onProgress?.(received / total);
        });
        pipeline(res, file)
          .then(() => {
            clearTimeout(timer);
            resolve();
          })
          .catch((e) => {
            clearTimeout(timer);
            reject(e);
          });
      })
      .on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

async function materializeDataset(workspace, ml, onProgress) {
  const dataDir = path.join(workspace, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const { dataset } = ml;
  const shard = dataset.shard;
  const shardIndex = ml.shardIndex ?? 0;

  if (dataset.source === "huggingface" || shard?.kind === "huggingface") {
    const hf = dataset.huggingface || shard;
    const metaPath = path.join(dataDir, "hf.json");
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        dataset: hf.dataset,
        config: hf.config,
        split: hf.split,
        streaming: !!hf.streaming,
      }),
    );
    onProgress?.(0.15, `HuggingFace dataset ${hf.dataset} (loaded in container)`);
    return { dataDir, mode: "huggingface", metaPath };
  }

  const url = shard?.url || shard;
  if (!url || typeof url !== "string") {
    throw new Error("ML shard missing download URL");
  }

  let base =
    shard?.filename ||
    filenameFromUrl(url) ||
    `shard_${shardIndex}.csv`;
  if (!path.extname(base)) {
    base = `${base}.csv`;
  }
  const dest = path.join(dataDir, base);
  onProgress?.(0.05, `Downloading dataset from ${new URL(url).host}…`);
  await downloadFile(url, dest, (frac) => {
    onProgress?.(0.05 + frac * 0.35, `Downloading ${(frac * 100).toFixed(0)}%`);
  });
  onProgress?.(0.42, `Shard saved to ${base}`);
  return { dataDir, mode: "file", dataFile: dest };
}

async function materializeTrainingScript(workspace, ml, onProgress) {
  const scriptPath = path.join(workspace, "train.py");
  const { training } = ml;

  if (training.scriptUrl) {
    onProgress?.(0.45, "Downloading training script…");
    await downloadFile(training.scriptUrl, scriptPath);
    return scriptPath;
  }

  if (training.scriptInline) {
    fs.writeFileSync(scriptPath, training.scriptInline, "utf8");
    return scriptPath;
  }

  if (fs.existsSync(BUNDLED_TRAIN)) {
    fs.copyFileSync(BUNDLED_TRAIN, scriptPath);
    return scriptPath;
  }

  throw new Error(
    "No training script: set training.scriptUrl, training.scriptInline, or ship examples/ml/train.py",
  );
}

function writeHyperparameters(workspace, ml) {
  const hpPath = path.join(workspace, "hyperparameters.json");
  fs.writeFileSync(
    hpPath,
    JSON.stringify(
      {
        ...ml.training.hyperparameters,
        framework: ml.training.framework,
        modelType: ml.training.modelType,
        shardIndex: ml.shardIndex ?? 0,
        shardCount: ml.shardCount ?? ml.dataset?.shardCount ?? 1,
        jobId: ml.jobId,
      },
      null,
      2,
    ),
  );
  return hpPath;
}

/**
 * Prepare workspace: download shard + script, write config.
 */
async function prepareMlWorkspace({ taskId, ml, onProgress }) {
  const workspace = workspaceDir(taskId);
  const data = await materializeDataset(workspace, ml, onProgress);
  const scriptPath = await materializeTrainingScript(workspace, ml, onProgress);
  writeHyperparameters(workspace, ml);
  onProgress?.(0.5, "Workspace ready");
  return { workspace, dataDir: data.dataDir, scriptPath };
}

function cleanupWorkspace(taskId) {
  const dir = path.join(CACHE_ROOT, "workspaces", taskId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

module.exports = {
  prepareMlWorkspace,
  cleanupWorkspace,
  CACHE_ROOT,
};
