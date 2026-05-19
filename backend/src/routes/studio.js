"use strict";

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const { requireUserAuth } = require("../middleware/auth");
const { getPublicBaseUrl, isLocalhostUrl } = require("../lib/publicUrl");
const { signFileAccess, verifyFileAccess } = require("../lib/fileTokens");
const {
  saveDataset,
  listDatasets,
  getDataset,
  resolveFilePath,
  saveNotebook,
  getNotebook,
  listNotebooks,
} = require("../lib/studioStore");
const {
  normalizeMlTrainingJob,
  detectTrainingFramework,
  buildStudioEntrypoint,
} = require("../lib/mlJobs");
const {
  listArenaAlgorithms,
  resolveArenaAlgorithms,
} = require("../lib/arenaAlgorithms");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.STUDIO_MAX_UPLOAD_MB || 512) * 1024 * 1024 },
});

function createStudioRouter(rt) {
  const r = express.Router();
  const auth = requireUserAuth(rt);

  r.get("/files/:fileId", async (req, res) => {
    const { fileId } = req.params;
    const { access } = req.query;
    if (!verifyFileAccess(fileId, access)) {
      res.status(403).json({ error: "Invalid or expired file access token" });
      return;
    }
    const resolved = await resolveFilePath(fileId);
    if (!resolved) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.download(resolved.path, resolved.name);
  });

  r.use(auth);

  r.get("/datasets", async (req, res) => {
    const items = await listDatasets(req.user.email);
    res.json({ datasets: items });
  });

  r.post("/datasets", upload.array("files", 20), async (req, res) => {
    if (!req.files?.length) {
      res.status(400).json({ error: "Upload at least one file (csv, parquet, zip)" });
      return;
    }
    const doc = await saveDataset({
      email: req.user.email,
      name: req.body.name || req.files[0].originalname,
      files: req.files,
    });
    res.status(201).json({
      datasetId: doc.datasetId,
      name: doc.name,
      files: doc.files,
    });
  });

  r.get("/notebooks", async (req, res) => {
    res.json({ notebooks: await listNotebooks(req.user.email) });
  });

  r.get("/notebooks/:notebookId", async (req, res) => {
    const nb = await getNotebook(req.params.notebookId, req.user.email);
    if (!nb) {
      res.status(404).json({ error: "Notebook not found" });
      return;
    }
    res.json(nb);
  });

  r.put("/notebooks/:notebookId", async (req, res) => {
    const { title, cells } = req.body;
    if (!Array.isArray(cells)) {
      res.status(400).json({ error: "cells array required" });
      return;
    }
    const nb = await saveNotebook({
      email: req.user.email,
      notebookId: req.params.notebookId,
      title,
      cells,
    });
    res.json(nb);
  });

  r.post("/notebooks", async (req, res) => {
    const { title, cells } = req.body;
    const nb = await saveNotebook({
      email: req.user.email,
      notebookId: null,
      title: title || "Untitled notebook",
      cells: cells || defaultCells(),
    });
    res.status(201).json(nb);
  });

  r.get("/arena/algorithms", (_req, res) => {
    res.json({ algorithms: listArenaAlgorithms() });
  });

  r.post("/train", async (req, res) => {
    const mode = req.body.mode === "arena" ? "arena" : "standard";
    if (mode === "arena") {
      await handleArenaTrain(req, res, rt);
      return;
    }

    const {
      code,
      cells,
      datasetIds,
      jobId,
      title,
      hyperparameters,
      parallelism,
      resources,
      notebookId,
    } = req.body;

    const userCode = buildCodeFromRequest(code, cells);
    if (!userCode.trim()) {
      res.status(400).json({ error: "No training code provided" });
      return;
    }

    const ids = Array.isArray(datasetIds) ? datasetIds : [];
    if (!ids.length) {
      res.status(400).json({ error: "Select or upload at least one dataset" });
      return;
    }

    const baseUrl = getPublicBaseUrl(req);
    const urls = [];
    for (const datasetId of ids) {
      const ds = await getDataset(datasetId, req.user.email);
      if (!ds) {
        res.status(400).json({ error: `Dataset not found: ${datasetId}` });
        return;
      }
      for (const f of ds.files) {
        const { token } = signFileAccess(f.fileId, 86400);
        const name = f.name || "data.csv";
        urls.push({
          url: `${baseUrl}/api/studio/files/${f.fileId}?access=${token}`,
          filename: name,
        });
      }
    }

    if (notebookId && Array.isArray(cells)) {
      await saveNotebook({
        email: req.user.email,
        notebookId,
        title,
        cells,
      });
    }

    const shardCount = urls.length;
    const effectiveParallelism = resolveStudioParallelism(
      parallelism,
      shardCount,
    );

    const wrappedCode = wrapUserTrainingCode(userCode);
    const framework = detectTrainingFramework(userCode);

    let spec;
    try {
      spec = normalizeMlTrainingJob({
        jobId: jobId || `studio_${Date.now()}`,
        type: "ml_training",
        parallelism: effectiveParallelism,
        dataset: { source: "urls", urls },
        training: {
          framework,
          scriptInline: wrappedCode,
          entrypoint: buildStudioEntrypoint(framework),
          hyperparameters: hyperparameters || { epochs: 5, batch_size: 32, lr: 0.01 },
        },
        resources: {
          cpus: 2,
          memory: "4g",
          timeout: 3600000,
          network: true,
          ...(resources || {}),
        },
        constraints: { reliability: "medium" },
        submittedBy: req.user.email,
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
      return;
    }

    const job = rt.jobRegistry.createJob(spec);
    await rt.queue.add(
      "dispatchJob",
      { jobId: job.jobId },
      { jobId: job.jobId, removeOnComplete: true, removeOnFail: false },
    );
    rt.scheduler.dispatchJobTasks(rt.jobRegistry.getJob(job.jobId) || job);

    const host = req.get("host") || `localhost:${process.env.PORT || 4000}`;
    const proto = req.secure ? "wss" : "ws";

    const datasetUrlWarning = urls.some((u) =>
      isLocalhostUrl(typeof u === "string" ? u : u.url),
    )
      ? "Dataset URLs use localhost — nodes on another machine cannot download files. Set PUBLIC_URL=http://<your-lan-ip>:4000 in backend .env and restart."
      : undefined;

    res.status(202).json({
      jobId: job.jobId,
      status: job.status,
      type: job.type,
      ml: true,
      parallelism: job.parallelism,
      datasetShards: shardCount,
      effectiveParallelism,
      ws: `${proto}://${host}/ws/jobs?token=<user_jwt>`,
      message: "Training dispatched to ResourceX compute nodes",
      framework,
      warning: datasetUrlWarning,
    });
  });

  return r;
}

async function handleArenaTrain(req, res, rt) {
  const { datasetIds, algorithmIds, jobId, resources } = req.body;
  const ids = Array.isArray(datasetIds) ? datasetIds : [];
  if (!ids.length) {
    res.status(400).json({ error: "Select or upload at least one dataset" });
    return;
  }

  let algorithmList;
  try {
    algorithmList = resolveArenaAlgorithms(algorithmIds);
  } catch (e) {
    res.status(400).json({ error: e.message });
    return;
  }

  const baseUrl = getPublicBaseUrl(req);
  const urls = [];
  for (const datasetId of ids) {
    const ds = await getDataset(datasetId, req.user.email);
    if (!ds) {
      res.status(400).json({ error: `Dataset not found: ${datasetId}` });
      return;
    }
    for (const f of ds.files) {
      const { token } = signFileAccess(f.fileId, 86400);
      const name = f.name || "data.csv";
      urls.push({
        url: `${baseUrl}/api/studio/files/${f.fileId}?access=${token}`,
        filename: name,
      });
    }
  }

  const arenaUrls = urls.length > 1 ? [urls[0]] : urls;
  const multiFileNote =
    urls.length > 1
      ? "Arena uses the first dataset file only so every algorithm trains on the same data."
      : undefined;

  let spec;
  try {
    spec = normalizeMlTrainingJob({
      jobId: jobId || `arena_${Date.now()}`,
      type: "ml_training",
      parallelism: algorithmList.length,
      dataset: { source: "urls", urls: arenaUrls },
      training: {
        framework: "sklearn",
        scriptInline: "# per-task script injected by arena",
        entrypoint: buildStudioEntrypoint("sklearn"),
        hyperparameters: { epochs: 1 },
      },
      resources: {
        cpus: 2,
        memory: "4g",
        timeout: 3600000,
        network: true,
        ...(resources || {}),
      },
      constraints: { reliability: "medium" },
      submittedBy: req.user.email,
      arena: { enabled: true, algorithmIds: algorithmList },
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
    return;
  }

  const job = rt.jobRegistry.createJob(spec);
  await rt.queue.add(
    "dispatchJob",
    { jobId: job.jobId },
    { jobId: job.jobId, removeOnComplete: true, removeOnFail: false },
  );
  rt.scheduler.dispatchJobTasks(rt.jobRegistry.getJob(job.jobId) || job);

  const host = req.get("host") || `localhost:${process.env.PORT || 4000}`;
  const proto = req.secure ? "wss" : "ws";

  const datasetUrlWarning = arenaUrls.some((u) =>
    isLocalhostUrl(typeof u === "string" ? u : u.url),
  )
    ? "Dataset URLs use localhost — nodes on another machine cannot download files. Set PUBLIC_URL=http://<your-lan-ip>:4000 in backend .env and restart."
    : undefined;

  res.status(202).json({
    jobId: job.jobId,
    status: job.status,
    type: job.type,
    ml: true,
    mode: "arena",
    parallelism: job.parallelism,
    algorithms: algorithmList,
    ws: `${proto}://${host}/ws/jobs?token=<user_jwt>`,
    message: "Algorithm Arena dispatched — one algorithm per node",
    framework: "sklearn",
    warning: datasetUrlWarning,
    note: multiFileNote,
  });
}

const IRIS_NOTEBOOK_CODE = `print("[ResourceX] Iris training (sklearn)", flush=True)
import os
from pathlib import Path
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score

data_dir = Path(os.environ.get("RESOURCEX_DATA_DIR", "/data"))
all_files = sorted(p for p in data_dir.iterdir() if p.is_file())
typed = [p for p in all_files if p.suffix.lower() in (".csv", ".parquet", ".txt")]
path = typed[0] if typed else (all_files[0] if all_files else None)
if path is None:
    raise FileNotFoundError(f"No data files in {data_dir}")
df = pd.read_parquet(path) if path.suffix.lower() == ".parquet" else pd.read_csv(path)
df = resourcex_shard_df(df)
for col in ("Id", "id"):
    if col in df.columns:
        df = df.drop(columns=[col])
label_col = next((c for c in df.columns if c.lower() in ("species", "variety", "class", "label")), df.columns[-1])
feature_cols = [c for c in df.select_dtypes(include="number").columns if c != label_col]
X = df[feature_cols].values
labels = df[label_col].astype(str)
classes = sorted(labels.unique())
y = labels.map({n: i for i, n in enumerate(classes)}).values
model = LogisticRegression(max_iter=200).fit(X, y)
acc = accuracy_score(y, model.predict(X))
print(f"Accuracy: {acc:.4f}")
resourcex_shard_metrics({"accuracy": float(acc), "samples": len(df), "dataset": "iris"})
`;

function defaultCells() {
  return [
    {
      id: "cell_1",
      type: "markdown",
      source:
        "# Iris classifier (ResourceX Studio)\n\n4 measurement columns → **Species** / **variety**. Select your uploaded Iris CSV, then **Run on ResourceX**.",
    },
    {
      id: "cell_2",
      type: "code",
      source: IRIS_NOTEBOOK_CODE,
    },
  ];
}

function buildCodeFromRequest(code, cells) {
  if (typeof code === "string" && code.trim()) return code;
  if (!Array.isArray(cells)) return "";
  return cells
    .filter((c) => c.type === "code")
    .map((c) => c.source || "")
    .join("\n\n");
}

const SHARD_BOOTSTRAP = `# --- ResourceX multi-node shard helpers (auto-injected) ---
import os as _rx_os

def resourcex_shard_df(df):
    """Row slice for this task when multiple nodes share one file."""
    shard = int(_rx_os.environ.get("RESOURCEX_SHARD_INDEX", "0"))
    shard_count = int(_rx_os.environ.get("RESOURCEX_SHARD_COUNT", "1"))
    if shard_count <= 1:
        return df
    n = len(df)
    chunk = max(1, n // shard_count)
    start = shard * chunk
    end = n if shard == shard_count - 1 else (shard + 1) * chunk
    return df.iloc[start:end].copy()

def resourcex_shard_metrics(extra=None):
    """Build metrics dict with shard index and row count for aggregation."""
    import json as _rx_json
    import os as _rx_os2
    m = dict(extra or {})
    m.setdefault("shardIndex", int(_rx_os2.environ.get("RESOURCEX_SHARD_INDEX", "0")))
    m.setdefault("source", "studio")
    print("RESOURCEX_METRICS=" + _rx_json.dumps(m), flush=True)
    return m
`;

function resolveStudioParallelism(requested, shardCount) {
  const n = Math.max(1, shardCount);
  if (requested == null || requested === "") {
    return n;
  }
  const p = Math.max(1, Number(requested) || 1);
  if (n > 1) return Math.min(p, n);
  return p;
}

function wrapUserTrainingCode(userCode) {
  return `${SHARD_BOOTSTRAP}

${userCode}
`;
}

module.exports = { createStudioRouter };
