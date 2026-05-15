import React, { useEffect, useMemo, useRef, useState } from "react";
import { wsUrl } from "../lib/config";
import { jsonRequest, HttpError } from "../lib/http";
import type { JobStatus, JobUpdateMsg } from "../lib/types";

export function JobsView(props: { token: string }) {
  const [spec, setSpec] = useState(
    JSON.stringify(
      {
        jobId: "demo_ml_001",
        type: "ml_training",
        image: "python:3.10-alpine",
        command: 'python -c "print(\'hello from shard\')"',
        parallelism: 1,
        constraints: { latency: "low", reliability: "high" },
      },
      null,
      2,
    ),
  );
  const [jobId, setJobId] = useState("demo_ml_001");
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [events, setEvents] = useState<JobUpdateMsg[]>([]);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const parsed = JSON.parse(spec);
      const res = await jsonRequest<{
        jobId: string;
        status: string;
        parallelism: number;
      }>("/api/jobs", { token: props.token, body: parsed });
      setJobId(res.jobId);
      await refresh(res.jobId);
      connectWs(res.jobId);
    } catch (e) {
      setError(toMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function refresh(id = jobId) {
    setError("");
    try {
      const res = await jsonRequest<JobStatus>(`/api/jobs/${id}`, {
        token: props.token,
      });
      setStatus(res);
    } catch (e) {
      setError(toMsg(e));
    }
  }

  function connectWs(subscribeJobId: string) {
    try {
      wsRef.current?.close();
    } catch {
      // ignore
    }
    const ws = new WebSocket(wsUrl("/ws/jobs", props.token));
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "SUBSCRIBE_JOB", jobId: subscribeJobId }));
      pushEvent({ type: "SUBSCRIBED", jobId: subscribeJobId });
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as JobUpdateMsg;
        pushEvent(msg);
        if (msg.type === "JOB_UPDATE" && msg.jobId === subscribeJobId) {
          // Keep the canonical server view too:
          refresh(subscribeJobId).catch(() => {});
        }
      } catch {
        // ignore
      }
    };
    ws.onclose = () => {
      // noop
    };
  }

  function pushEvent(m: JobUpdateMsg) {
    setEvents((prev) => [m, ...prev].slice(0, 50));
  }

  useEffect(() => {
    refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const completed = status?.status === "completed";
  const failed = status?.status === "failed";
  const headline = useMemo(() => {
    if (!status) return "No job loaded";
    if (completed) return "Completed";
    if (failed) return "Failed";
    return status.status;
  }, [status, completed, failed]);

  return (
    <div className="grid cols2">
      <div className="card">
        <div className="cardHeader">
          <h2 className="h2">Submit job</h2>
          <div className="row">
            <button className="btn primary" onClick={submit} disabled={busy}>
              {busy ? "Submitting…" : "Submit"}
            </button>
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          Paste a job JSON (same as `resourcex submit`). Uses `POST /api/jobs`.
        </div>
        <textarea
          className="textarea"
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
        />
        {error ? (
          <div style={{ marginTop: 12 }} className="pill">
            {error}
          </div>
        ) : null}
      </div>

      <div className="card">
        <div className="cardHeader">
          <h2 className="h2">Job monitor</h2>
          <div className="row">
            <input
              className="input"
              style={{ width: 220 }}
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              placeholder="jobId"
            />
            <button className="btn" onClick={() => refresh()}>
              Refresh
            </button>
            <button
              className="btn"
              onClick={() => connectWs(jobId)}
              disabled={!jobId}
            >
              Live WS
            </button>
          </div>
        </div>

        <div className="row" style={{ marginBottom: 10 }}>
          <span className="pill">Status: {headline}</span>
          {status ? (
            <>
              <span className="pill">
                Tasks: {status.completedTasks}/{status.parallelism}
              </span>
              {status.confidenceScore != null ? (
                <span className="pill">
                  Confidence: {Number(status.confidenceScore).toFixed(2)}
                </span>
              ) : null}
              {status.validated ? (
                <span className="pill">Validated: {status.validated}</span>
              ) : null}
            </>
          ) : null}
        </div>

        {status ? (
          <>
            <div className="card" style={{ background: "var(--panel2)" }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                Result
              </div>
              <div className="code">
                {completed
                  ? JSON.stringify(status.result ?? null, null, 2)
                  : failed
                    ? String(status.error || "Job failed")
                    : "— (waiting for completion)"}
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                Shards
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Shard</th>
                    <th>Task</th>
                    <th>Node</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {status.tasks.map((t) => (
                    <tr key={t.taskId}>
                      <td>{t.shardIndex}</td>
                      <td style={{ fontWeight: 700 }}>{t.taskId.slice(0, 8)}…</td>
                      <td className="muted">{t.nodeId || "—"}</td>
                      <td>
                        <span
                          className={`statusDot ${
                            t.status === "completed"
                              ? "good"
                              : t.status === "failed"
                                ? "bad"
                                : "warn"
                          }`}
                        />
                        {t.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="muted">Enter a jobId and click Refresh.</div>
        )}
      </div>

      <div className="card" style={{ gridColumn: "1 / -1" }}>
        <div className="cardHeader">
          <h2 className="h2">Live events (WS)</h2>
          <span className="pill">Last 50</span>
        </div>
        <div className="code">{JSON.stringify(events, null, 2)}</div>
      </div>
    </div>
  );
}

function toMsg(e: unknown) {
  if (e instanceof HttpError) {
    if (typeof e.body === "string") return e.body;
    if (e.body && typeof e.body === "object") {
      const any = e.body as any;
      return any.error || JSON.stringify(any);
    }
    return `HTTP ${e.status}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

