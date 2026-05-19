import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { jsonRequest, uploadFiles, HttpError } from "../lib/http";
import { wsUrl } from "../lib/config";
import type { JobStatus, JobUpdateMsg } from "../lib/types";

type Cell = { id: string; type: "code" | "markdown"; source: string };

type DatasetMeta = {
  datasetId: string;
  name: string;
  files: { fileId: string; name: string; size: number }[];
};

type AggregatedMlResult = {
  aggregated?: Record<string, unknown> | null;
  shards?: {
    shardIndex: number;
    metrics?: Record<string, unknown> | null;
    outputPreview?: string;
  }[];
};

type StudioSession = {
  jobId: string;
  log: string[];
};

const SESSION_KEY = "resourcex_studio_session";

const IRIS_NOTEBOOK_CODE = `print("[ResourceX] Iris training script starting (fast sklearn)", flush=True)

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
print("Data file:", path.name)

df = pd.read_parquet(path) if path.suffix.lower() == ".parquet" else pd.read_csv(path)
df = resourcex_shard_df(df)

for col in ("Id", "id"):
    if col in df.columns:
        df = df.drop(columns=[col])

label_names = ("species", "variety", "class", "label", "target")
label_col = next((c for c in df.columns if c.lower() in label_names), None)
if label_col is None:
    label_col = df.columns[-1]

feature_cols = [c for c in df.select_dtypes(include="number").columns if c != label_col]
if len(feature_cols) < 2:
    raise ValueError(f"Expected numeric features; got {feature_cols}")

print("Features:", feature_cols)
print("Label:", label_col)
print("Rows on this shard:", len(df))

X = df[feature_cols].values
if pd.api.types.is_numeric_dtype(df[label_col]):
    y = df[label_col].astype(int).values
    classes = sorted(df[label_col].unique().tolist())
else:
    labels = df[label_col].astype(str)
    classes = sorted(labels.unique())
    class_to_idx = {name: i for i, name in enumerate(classes)}
    y = labels.map(class_to_idx).values

model = LogisticRegression(max_iter=200)
model.fit(X, y)
acc = accuracy_score(y, model.predict(X))
print(f"Accuracy: {acc:.4f}")
print("Classes:", classes)

resourcex_shard_metrics({
    "accuracy": float(acc),
    "samples": len(df),
    "n_classes": len(classes),
    "dataset": "iris",
})
`;

const DEFAULT_CELLS: Cell[] = [
  {
    id: "md1",
    type: "markdown",
    source:
      "# Iris classifier (fast sklearn)\n\nUses **scikit-learn** only (no PyTorch) — typically finishes in **under a minute** on the node.\n\nSelect your Iris CSV, then **Run on ResourceX**.",
  },
  {
    id: "code1",
    type: "code",
    source: IRIS_NOTEBOOK_CODE,
  },
];

function loadSession(): StudioSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as StudioSession;
    return s.jobId ? s : null;
  } catch {
    return null;
  }
}

function saveSession(jobId: string, log: string[]) {
  if (!jobId) return;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ jobId, log }));
}

export function StudioView(props: { token: string; active?: boolean }) {
  const saved = useMemo(() => loadSession(), []);
  const [cells, setCells] = useState<Cell[]>(DEFAULT_CELLS);
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [epochs, setEpochs] = useState(5);
  const [parallelism, setParallelism] = useState(1);
  const [parallelismTouched, setParallelismTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [jobId, setJobId] = useState(saved?.jobId ?? "");
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [log, setLog] = useState<string[]>(saved?.log ?? []);
  const fileRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const shardCount = useMemo(() => {
    return datasets
      .filter((d) => selectedIds.includes(d.datasetId))
      .reduce((n, d) => n + d.files.length, 0);
  }, [datasets, selectedIds]);

  useEffect(() => {
    if (parallelismTouched) return;
    setParallelism(Math.max(1, shardCount || 1));
  }, [shardCount, parallelismTouched]);

  const pushLog = useCallback((line: string) => {
    setLog((prev) => {
      const next = [...prev.slice(-80), line];
      if (jobId) saveSession(jobId, next);
      return next;
    });
  }, [jobId]);

  const refreshJob = useCallback(
    async (id: string) => {
      try {
        const res = await jsonRequest<JobStatus>(`/api/jobs/${id}`, {
          token: props.token,
        });
        setStatus(res);
        if (res.status === "completed") {
          pushLog("[job] completed — results ready");
        } else if (res.status === "failed") {
          pushLog(`[job] failed: ${res.error ?? "unknown error"}`);
        } else if (res.status === "waiting_nodes") {
          pushLog("[job] waiting for eligible nodes (check Nodes tab: must be online + active)");
        }
        return res;
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) {
          const msg =
            (e.body as { error?: string })?.error ||
            "Job not found (backend may have restarted). Run training again.";
          setError(msg);
          pushLog(`[job] ${msg}`);
          setStatus(null);
        }
        throw e;
      }
    },
    [props.token, pushLog],
  );

  const connectWs = useCallback(
    (subscribeJobId: string) => {
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      const ws = new WebSocket(wsUrl("/ws/jobs", props.token));
      wsRef.current = ws;
      ws.onopen = () => {
        ws.send(
          JSON.stringify({ type: "SUBSCRIBE_JOB", jobId: subscribeJobId }),
        );
        pushLog("Live: subscribed to job updates");
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as JobUpdateMsg;
          if (msg.type === "JOB_UPDATE") {
            const pct =
              typeof msg.progress === "number"
                ? ` ${Math.round(msg.progress * 100)}%`
                : "";
            pushLog(`[job] ${msg.status ?? "update"}${pct}`);
            refreshJob(subscribeJobId).catch(() => {});
          }
        } catch {
          /* ignore */
        }
      };
    },
    [props.token, pushLog, refreshJob],
  );

  const loadDatasets = useCallback(async () => {
    const res = await jsonRequest<{ datasets: DatasetMeta[] }>(
      "/api/studio/datasets",
      { token: props.token },
    );
    setDatasets(res.datasets);
    if (res.datasets.length) {
      setSelectedIds((prev) =>
        prev.length ? prev : [res.datasets[0].datasetId],
      );
    }
  }, [props.token]);

  useEffect(() => {
    loadDatasets().catch((e) => setError(toMsg(e)));
  }, [loadDatasets]);

  // Restore last job on mount
  useEffect(() => {
    if (!saved?.jobId) return;
    refreshJob(saved.jobId).catch(() => {});
    connectWs(saved.jobId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while job is in-flight (works even when another tab is visible)
  useEffect(() => {
    if (!jobId) return;
    const terminal = status?.status === "completed" || status?.status === "failed";
    if (terminal) return;
    const id = setInterval(() => {
      refreshJob(jobId).catch(() => {});
    }, 3000);
    return () => clearInterval(id);
  }, [jobId, status?.status, refreshJob]);

  // Refresh when user returns to Studio tab
  useEffect(() => {
    if (props.active !== false && jobId) {
      refreshJob(jobId).catch(() => {});
    }
  }, [props.active, jobId, refreshJob]);

  useEffect(() => {
    if (jobId) saveSession(jobId, log);
  }, [jobId, log]);

  async function onUpload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError("");
    try {
      await uploadFiles("/api/studio/datasets", props.token, Array.from(files));
      await loadDatasets();
      pushLog(`Uploaded ${files.length} file(s)`);
    } catch (e) {
      setError(toMsg(e));
    } finally {
      setBusy(false);
    }
  }

  function updateCell(id: string, source: string) {
    setCells((prev) => prev.map((c) => (c.id === id ? { ...c, source } : c)));
  }

  function addCodeCell() {
    setCells((prev) => [
      ...prev,
      { id: `code_${Date.now()}`, type: "code", source: "# new cell\n" },
    ]);
  }

  async function runOnResourceX() {
    if (!selectedIds.length) {
      setError("Upload and select at least one dataset");
      return;
    }
    setBusy(true);
    setError("");
    setLog([]);
    try {
      const res = await jsonRequest<{
        jobId: string;
        status: string;
        message?: string;
        parallelism?: number;
        datasetShards?: number;
        framework?: string;
      }>("/api/studio/train", {
        token: props.token,
        body: {
          cells,
          datasetIds: selectedIds,
          hyperparameters: { epochs, batch_size: 32, lr: 0.01 },
          parallelism,
          resources: { cpus: 2, memory: "4g", network: true, timeout: 3600000 },
        },
      });
      setJobId(res.jobId);
      saveSession(res.jobId, []);
      pushLog(
        res.message ||
          `Job ${res.jobId} queued (${res.parallelism ?? parallelism} task(s), ${res.datasetShards ?? shardCount} shard(s), ${res.framework ?? "auto"} deps)`,
      );
      const warn = (res as { warning?: string }).warning;
      if (warn) {
        pushLog(`⚠ ${warn}`);
        setError(warn);
      }
      connectWs(res.jobId);
      await refreshJob(res.jobId);
    } catch (e) {
      setError(toMsg(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleDataset(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  const mlResult = parseMlResult(status?.result);

  return (
    <div className="rx-studio">
      <div className="rx-studio-toolbar">
        <button
          className="rx-btn rx-btn-primary"
          disabled={busy}
          onClick={runOnResourceX}
        >
          {busy ? "Dispatching…" : "▶ Run on ResourceX"}
        </button>
        <button className="rx-btn" type="button" onClick={addCodeCell}>
          + Code cell
        </button>
        <label className="rx-studio-field">
          Epochs
          <input
            type="number"
            min={1}
            max={500}
            value={epochs}
            onChange={(e) => setEpochs(Number(e.target.value))}
          />
        </label>
        <label
          className="rx-studio-field"
          title="Tasks dispatched to nodes. Defaults to file count; for one file, increase to split rows."
        >
          Parallelism
          <input
            type="number"
            min={1}
            max={32}
            value={parallelism}
            onChange={(e) => {
              setParallelismTouched(true);
              setParallelism(Number(e.target.value));
            }}
          />
        </label>
        <span className="rx-studio-hint" style={{ alignSelf: "center" }}>
          {shardCount} file shard(s)
        </span>
        {jobId ? (
          <span className="rx-studio-jobid">
            Job <code>{jobId}</code>
          </span>
        ) : null}
      </div>

      {error ? <div className="rx-studio-error">{error}</div> : null}

      <div className="rx-studio-grid">
        <aside className="rx-studio-sidebar">
          <h3>Datasets</h3>
          <p className="rx-studio-hint">
            Upload CSV / Parquet / ZIP. Each file becomes a shard on a separate
            node when parallelism matches file count.
          </p>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            accept=".csv,.parquet,.zip,.json,.txt"
            onChange={(e) => onUpload(e.target.files)}
          />
          <button
            className="rx-btn"
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            Upload files
          </button>
          <ul className="rx-studio-dataset-list">
            {datasets.map((d) => (
              <li key={d.datasetId}>
                <label>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(d.datasetId)}
                    onChange={() => toggleDataset(d.datasetId)}
                  />
                  <span className="rx-studio-ds-name">{d.name}</span>
                  <span className="rx-studio-ds-meta">
                    {d.files.length} file(s)
                  </span>
                </label>
              </li>
            ))}
            {!datasets.length ? (
              <li className="rx-studio-empty">No datasets yet</li>
            ) : null}
          </ul>
        </aside>

        <main className="rx-studio-editor">
          <h3>Notebook</h3>
          {cells.map((cell) =>
            cell.type === "markdown" ? (
              <div key={cell.id} className="rx-studio-cell md">
                <span className="rx-studio-cell-label">Markdown</span>
                <textarea
                  value={cell.source}
                  onChange={(e) => updateCell(cell.id, e.target.value)}
                  rows={4}
                />
              </div>
            ) : (
              <div key={cell.id} className="rx-studio-cell code">
                <span className="rx-studio-cell-label">Python</span>
                <textarea
                  className="rx-studio-code"
                  value={cell.source}
                  onChange={(e) => updateCell(cell.id, e.target.value)}
                  spellCheck={false}
                  rows={Math.min(
                    24,
                    Math.max(8, cell.source.split("\n").length + 1),
                  )}
                />
              </div>
            ),
          )}
        </main>

        <aside className="rx-studio-output">
          <h3>Training output</h3>
          {status ? (
            <div className="rx-studio-status">
              <div>
                Status: <strong>{status.status}</strong>
              </div>
              <div>
                Tasks: {status.completedTasks}/{status.parallelism}
              </div>
              {status.status === "waiting_nodes" ? (
                <p className="rx-studio-hint">
                  No eligible nodes. In Nodes tab the status must be{" "}
                  <strong>online · active</strong> (not offline). Restart the
                  node agent after updating the backend.
                </p>
              ) : null}
              {status.error ? (
                <p className="rx-studio-error">{status.error}</p>
              ) : null}
              {status.tasks?.length ? (
                <ul className="rx-studio-task-list">
                  {status.tasks.map((t) => (
                    <li key={t.taskId}>
                      Shard {t.shardIndex}: {t.status}
                      {t.nodeId ? ` @ ${t.nodeId.slice(0, 8)}…` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
              {mlResult?.aggregated ? (
                <div className="rx-studio-metrics">
                  <strong>Aggregated metrics</strong>
                  <pre>{JSON.stringify(mlResult.aggregated, null, 2)}</pre>
                </div>
              ) : null}
              {status.result != null ? (
                <pre className="rx-studio-result">
                  {formatJobResult(status.result, mlResult)}
                </pre>
              ) : status.status === "running" || status.status === "queued" ? (
                <p className="rx-studio-hint">
                  Training in progress… ML tasks show <code>[ML]</code> in the
                  node agent (trust challenges finish in ~3s without [ML]).
                </p>
              ) : null}
            </div>
          ) : (
            <p className="rx-studio-hint">Run a job to see status and metrics.</p>
          )}
          <pre className="rx-studio-log">{log.join("\n")}</pre>
        </aside>
      </div>
    </div>
  );
}

function parseMlResult(result: unknown): AggregatedMlResult | null {
  if (!result || typeof result !== "object") return null;
  const r = result as AggregatedMlResult;
  if (r.aggregated !== undefined || r.shards !== undefined) return r;
  return null;
}

function formatJobResult(
  result: unknown,
  mlResult: AggregatedMlResult | null,
): string {
  if (mlResult?.shards?.length) {
    const previews = mlResult.shards
      .filter((s) => s.outputPreview)
      .map(
        (s) =>
          `--- shard ${s.shardIndex} ---\n${s.outputPreview}`,
      );
    if (previews.length) return previews.join("\n\n");
  }
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

function toMsg(e: unknown) {
  if (e instanceof HttpError) {
    const b = e.body as { error?: string; errors?: unknown[] };
    if (b?.error) return b.error;
    if (b?.errors) return JSON.stringify(b.errors);
    return `HTTP ${e.status}`;
  }
  return e instanceof Error ? e.message : String(e);
}
