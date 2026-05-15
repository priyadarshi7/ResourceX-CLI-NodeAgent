import React, { useEffect, useMemo, useState } from "react";
import { jsonRequest, HttpError } from "../lib/http";
import type { AdminStats, NodeRow } from "../lib/types";
import { useInterval } from "./useInterval";

// ─── Styles ──────────────────────────────────────────────────────────────────

const nodesStyles = `
  /* ── NodesView layout ──────────────────────────────────────────────── */
  .nv-grid {
    display: grid;
    grid-template-columns: 340px 1fr;
    gap: 16px;
    align-items: start;
  }

  @media (max-width: 900px) {
    .nv-grid { grid-template-columns: 1fr; }
  }

  /* ── Section card ──────────────────────────────────────────────────── */
  .nv-card {
    background: var(--rx-surface2);
    border: 1px solid var(--rx-border);
    border-radius: 4px;
  }

  .nv-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    border-bottom: 1px solid var(--rx-border);
    gap: 12px;
    flex-wrap: wrap;
  }

  .nv-card-title {
    font-family: var(--rx-mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--rx-text);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .nv-card-title-icon {
    width: 6px;
    height: 6px;
    border-radius: 1px;
    background: var(--rx-brand);
    flex-shrink: 0;
  }

  .nv-card-body {
    padding: 16px 18px;
  }

  /* ── Controls ──────────────────────────────────────────────────────── */
  .nv-controls {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .nv-btn {
    font-family: var(--rx-mono);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: .06em;
    text-transform: uppercase;
    padding: 5px 12px;
    border-radius: 3px;
    border: 1px solid var(--rx-border2);
    background: var(--rx-surface);
    color: var(--rx-text-muted);
    cursor: pointer;
    transition: all .15s ease;
    white-space: nowrap;
  }

  .nv-btn:hover {
    border-color: var(--rx-text-muted);
    color: var(--rx-text);
  }

  .nv-btn:active { transform: scale(0.97); }

  .nv-btn.poll-on {
    border-color: rgba(124,58,237,.4);
    color: #a78bfa;
    background: rgba(124,58,237,.08);
  }

  /* ── Stat rows ─────────────────────────────────────────────────────── */
  .nv-stat-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 9px 0;
    border-bottom: 1px solid var(--rx-border);
  }

  .nv-stat-row:last-child { border-bottom: none; }

  .nv-stat-label {
    font-family: var(--rx-mono);
    font-size: 11px;
    color: var(--rx-text-muted);
    letter-spacing: .02em;
  }

  .nv-stat-value {
    font-family: var(--rx-mono);
    font-size: 12px;
    font-weight: 500;
    color: var(--rx-text);
    text-align: right;
  }

  .nv-stat-value.accent { color: #a78bfa; }
  .nv-stat-value.green  { color: #4ade80; }
  .nv-stat-value.amber  { color: #fbbf24; }

  /* ── Tiers block ───────────────────────────────────────────────────── */
  .nv-tiers {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding-top: 14px;
    margin-top: 14px;
    border-top: 1px solid var(--rx-border);
  }

  .nv-tier-chip {
    font-family: var(--rx-mono);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: .04em;
    padding: 3px 9px;
    border-radius: 3px;
    background: var(--rx-surface);
    border: 1px solid var(--rx-border);
    color: var(--rx-text-muted);
    text-transform: uppercase;
  }

  .nv-tier-chip span {
    color: var(--rx-text);
    margin-left: 5px;
  }

  /* ── Error banner ──────────────────────────────────────────────────── */
  .nv-error {
    margin-top: 12px;
    padding: 8px 12px;
    border-radius: 3px;
    border: 1px solid rgba(239,68,68,.25);
    background: rgba(239,68,68,.07);
    font-family: var(--rx-mono);
    font-size: 11px;
    color: #f87171;
  }

  /* ── Node table ────────────────────────────────────────────────────── */
  .nv-table-wrap {
    overflow-x: auto;
  }

  .nv-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--rx-mono);
    font-size: 11px;
  }

  .nv-table th {
    text-align: left;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--rx-text-muted);
    padding: 8px 12px;
    border-bottom: 1px solid var(--rx-border);
    white-space: nowrap;
  }

  .nv-table td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--rx-border);
    vertical-align: middle;
    color: var(--rx-text);
  }

  .nv-table tbody tr:last-child td { border-bottom: none; }

  .nv-table tbody tr {
    transition: background .12s ease;
  }

  .nv-table tbody tr:hover {
    background: rgba(255,255,255,.02);
  }

  /* ── Node ID cell ──────────────────────────────────────────────────── */
  .nv-node-id {
    font-size: 12px;
    font-weight: 500;
    color: var(--rx-text);
    letter-spacing: .02em;
  }

  .nv-node-email {
    font-size: 10px;
    color: var(--rx-text-muted);
    margin-top: 2px;
  }

  /* ── Status cell ───────────────────────────────────────────────────── */
  .nv-status {
    display: flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;
  }

  .nv-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .nv-dot.good {
    background: #22c55e;
    box-shadow: 0 0 0 0 rgba(34,197,94,.4);
    animation: rx-pulse-green 2s ease-in-out infinite;
  }

  .nv-dot.warn {
    background: #f59e0b;
    box-shadow: 0 0 0 0 rgba(245,158,11,.4);
    animation: rx-pulse-amber 2s ease-in-out infinite;
  }

  .nv-dot.bad { background: var(--rx-text-faint); }

  @keyframes rx-pulse-green {
    0%, 100% { box-shadow: 0 0 0 0 rgba(34,197,94,.4); }
    50%       { box-shadow: 0 0 0 4px transparent; }
  }

  @keyframes rx-pulse-amber {
    0%, 100% { box-shadow: 0 0 0 0 rgba(245,158,11,.35); }
    50%       { box-shadow: 0 0 0 4px transparent; }
  }

  .nv-status-text {
    color: var(--rx-text-muted);
    font-size: 11px;
  }

  .nv-status-text strong {
    color: var(--rx-text);
    font-weight: 500;
  }

  /* ── Trust cell ────────────────────────────────────────────────────── */
  .nv-trust-tier {
    font-size: 11px;
    font-weight: 500;
    color: var(--rx-text);
    text-transform: uppercase;
    letter-spacing: .04em;
  }

  .nv-trust-score {
    font-size: 10px;
    color: var(--rx-text-muted);
    margin-top: 2px;
  }

  /* ── Load cell ─────────────────────────────────────────────────────── */
  .nv-load-row {
    font-size: 10px;
    color: var(--rx-text-muted);
    line-height: 1.8;
  }

  .nv-load-row span {
    color: var(--rx-text);
    margin-left: 4px;
  }

  /* ── Connected badge in header ─────────────────────────────────────── */
  .nv-conn-badge {
    font-family: var(--rx-mono);
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 3px;
    background: rgba(34,197,94,.08);
    border: 1px solid rgba(34,197,94,.2);
    color: #4ade80;
    white-space: nowrap;
  }

  /* ── Loading state ─────────────────────────────────────────────────── */
  .nv-loading {
    font-family: var(--rx-mono);
    font-size: 11px;
    color: var(--rx-text-muted);
    padding: 12px 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .nv-spinner {
    width: 12px;
    height: 12px;
    border: 1px solid var(--rx-border2);
    border-top-color: var(--rx-brand);
    border-radius: 50%;
    animation: nv-spin .8s linear infinite;
    flex-shrink: 0;
  }

  @keyframes nv-spin { to { transform: rotate(360deg); } }
`;

function useNodesStyles() {
  useEffect(() => {
    const id = "rx-nodes-styles";
    if (!document.getElementById(id)) {
      const el = document.createElement("style");
      el.id = id;
      el.textContent = nodesStyles;
      document.head.appendChild(el);
    }
    return () => {
      document.getElementById(id)?.remove();
    };
  }, []);
}

// ─── Component ────────────────────────────────────────────────────────────────

export function NodesView(props: { token: string }) {
  useNodesStyles();

  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string>("");
  const [poll, setPoll] = useState(true);

  async function refresh() {
    setError("");
    try {
      const [s, n] = await Promise.all([
        jsonRequest<AdminStats>("/api/admin/stats", { token: props.token }),
        jsonRequest<NodeRow[]>("/api/admin/nodes", { token: props.token }),
      ]);
      setStats(s);
      setNodes(n);
    } catch (e) {
      setError(toMsg(e));
    }
  }

  useEffect(() => {
    refresh();
  }, []); // eslint-disable-line
  useInterval(() => refresh(), poll ? 2500 : null);

  const connected = useMemo(
    () => nodes.filter((n) => n.connected).length,
    [nodes],
  );

  return (
    <div className="nv-grid">
      {/* ── Left: Cluster stats ─────────────────────────────────────── */}
      <div className="nv-card">
        <div className="nv-card-head">
          <div className="nv-card-title">
            <span className="nv-card-title-icon" />
            Cluster Stats
          </div>
          <div className="nv-controls">
            <button className="nv-btn" onClick={refresh}>
              ↻ Refresh
            </button>
            <button
              className={`nv-btn ${poll ? "poll-on" : ""}`}
              onClick={() => setPoll((p) => !p)}
            >
              {poll ? "● Live" : "○ Paused"}
            </button>
          </div>
        </div>

        <div className="nv-card-body">
          {stats ? (
            <>
              <div className="nv-stat-row">
                <span className="nv-stat-label">Total nodes</span>
                <span className="nv-stat-value">{stats.nodes.total}</span>
              </div>
              <div className="nv-stat-row">
                <span className="nv-stat-label">Connected</span>
                <span className="nv-stat-value green">
                  {stats.nodes.connected}
                </span>
              </div>
              <div className="nv-stat-row">
                <span className="nv-stat-label">Avg score</span>
                <span className="nv-stat-value accent">
                  {stats.nodes.avgScore.toFixed(2)}
                </span>
              </div>
              <div className="nv-stat-row">
                <span className="nv-stat-label">Total jobs</span>
                <span className="nv-stat-value">{stats.jobs.total}</span>
              </div>
              <div className="nv-stat-row">
                <span className="nv-stat-label">Active jobs</span>
                <span className="nv-stat-value amber">{stats.jobs.active}</span>
              </div>
              <div className="nv-stat-row">
                <span className="nv-stat-label">Pending challenges</span>
                <span className="nv-stat-value">{stats.challengesPending}</span>
              </div>

              {Object.keys(stats.nodes.tiers).length > 0 && (
                <div className="nv-tiers">
                  {Object.entries(stats.nodes.tiers).map(([tier, count]) => (
                    <span key={tier} className="nv-tier-chip">
                      {tier}
                      <span>{count}</span>
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="nv-loading">
              <span className="nv-spinner" />
              Fetching cluster data…
            </div>
          )}

          {error && <div className="nv-error">⚠ {error}</div>}
        </div>
      </div>

      {/* ── Right: Node table ────────────────────────────────────────── */}
      <div className="nv-card">
        <div className="nv-card-head">
          <div className="nv-card-title">
            <span className="nv-card-title-icon" />
            Registered Nodes
          </div>
          <span className="nv-conn-badge">
            {connected} / {nodes.length} online
          </span>
        </div>

        <div className="nv-table-wrap">
          <table className="nv-table">
            <thead>
              <tr>
                <th>Node ID</th>
                <th>Status</th>
                <th>Trust</th>
                <th>Load</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => {
                const dot = n.connected
                  ? n.status === "probation"
                    ? "warn"
                    : "good"
                  : "bad";
                return (
                  <tr key={n.nodeId}>
                    <td>
                      <div className="nv-node-id">{shortId(n.nodeId)}</div>
                      <div className="nv-node-email">{n.email || "—"}</div>
                    </td>
                    <td>
                      <div className="nv-status">
                        <span className={`nv-dot ${dot}`} />
                        <span className="nv-status-text">
                          <strong>
                            {n.connected ? "connected" : "offline"}
                          </strong>
                          {" · "}
                          {n.status}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="nv-trust-tier">{n.trustTier}</div>
                      <div className="nv-trust-score">
                        score {Number(n.challengeScore || 0).toFixed(2)}
                      </div>
                    </td>
                    <td>
                      <div className="nv-load-row">
                        tasks <span>{n.activeTasks ?? 0}</span>
                      </div>
                      <div className="nv-load-row">
                        cpu <span>{n.cpu ?? "—"}</span>
                        {" · "}mem <span>{n.memory ?? "—"}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {nodes.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <div className="nv-loading">
                      <span className="nv-spinner" />
                      Awaiting node data…
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
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
