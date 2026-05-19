import React, { useMemo, useState, useEffect, useRef } from "react";
import { BACKEND_URL } from "../lib/config";
import { useAuth } from "./auth";
import { NodesView } from "./NodesView";
import { JobsView } from "./JobsView";
import { StudioView } from "./StudioView";
import { LoginCard } from "./LoginCard";

type Tab = "nodes" | "jobs" | "studio";

// ─── CSS-in-JS styles ───────────────────────────────────────────────────────

const styles = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@300;400;500&display=swap');

  :root {
    --rx-bg:          #0c0e10;
    --rx-surface:     #131619;
    --rx-surface2:    #1a1e22;
    --rx-border:      #242a30;
    --rx-border2:     #2f3840;
    --rx-brand:       #7c3aed;
    --rx-brand-dim:   rgba(124,58,237,0.12);
    --rx-brand-glow:  rgba(124,58,237,0.35);
    --rx-text:        #e2e8f0;
    --rx-text-muted:  #64748b;
    --rx-text-faint:  #374151;
    --rx-accent:      #22d3ee;
    --rx-mono:        'IBM Plex Mono', monospace;
    --rx-sans:        'IBM Plex Sans', sans-serif;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body, #root {
    background: var(--rx-bg);
    color: var(--rx-text);
    font-family: var(--rx-sans);
    min-height: 100vh;
  }

  /* ── Scanline overlay ────────────────────────────────────────────────── */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background: repeating-linear-gradient(
      0deg,
      transparent,
      transparent 2px,
      rgba(0,0,0,0.07) 2px,
      rgba(0,0,0,0.07) 4px
    );
    pointer-events: none;
    z-index: 9999;
  }

  /* ── Shell ───────────────────────────────────────────────────────────── */
  .rx-shell {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    max-width: 1280px;
    margin: 0 auto;
    padding: 0 24px 48px;
  }

  /* ── Topbar ──────────────────────────────────────────────────────────── */
  .rx-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 0;
    border-bottom: 1px solid var(--rx-border);
    position: sticky;
    top: 0;
    background: var(--rx-bg);
    z-index: 50;
    gap: 16px;
  }

  .rx-brand {
    display: flex;
    align-items: center;
    gap: 12px;
    font-family: var(--rx-mono);
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0.04em;
    color: var(--rx-text);
    text-transform: uppercase;
  }

  .rx-brand-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--rx-brand);
    animation: rx-pulse 2.4s ease-in-out infinite;
    flex-shrink: 0;
  }

  @keyframes rx-pulse {
    0%, 100% { box-shadow: 0 0 0 0 var(--rx-brand-glow); }
    50%       { box-shadow: 0 0 0 6px transparent; }
  }

  .rx-slash {
    color: var(--rx-text-faint);
    font-weight: 300;
  }

  .rx-tab-badge {
    font-family: var(--rx-mono);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 3px 8px;
    border-radius: 3px;
    background: var(--rx-brand-dim);
    color: #a78bfa;
    border: 1px solid rgba(124,58,237,0.25);
  }

  .rx-topbar-right {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .rx-chip {
    font-family: var(--rx-mono);
    font-size: 11px;
    color: var(--rx-text-muted);
    background: var(--rx-surface);
    border: 1px solid var(--rx-border);
    border-radius: 3px;
    padding: 4px 10px;
    letter-spacing: 0.02em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
  }

  /* ── Buttons ─────────────────────────────────────────────────────────── */
  .rx-btn {
    font-family: var(--rx-mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 6px 14px;
    border-radius: 3px;
    border: 1px solid var(--rx-border2);
    background: var(--rx-surface);
    color: var(--rx-text-muted);
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
  }

  .rx-btn:hover {
    border-color: var(--rx-text-muted);
    color: var(--rx-text);
    background: var(--rx-surface2);
  }

  .rx-btn:active {
    transform: scale(0.97);
  }

  .rx-btn.danger {
    border-color: rgba(239,68,68,0.35);
    color: #f87171;
    background: rgba(239,68,68,0.06);
  }

  .rx-btn.danger:hover {
    border-color: #f87171;
    background: rgba(239,68,68,0.12);
    color: #fca5a5;
  }

  /* ── Status bar ──────────────────────────────────────────────────────── */
  .rx-statusbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    background: var(--rx-surface);
    border: 1px solid var(--rx-border);
    border-radius: 4px;
    margin-top: 20px;
    font-family: var(--rx-mono);
    font-size: 11px;
    color: var(--rx-text-muted);
  }

  .rx-statusbar-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #22c55e;
    box-shadow: 0 0 0 0 rgba(34,197,94,0.4);
    animation: rx-pulse-green 2s ease-in-out infinite;
    flex-shrink: 0;
  }

  @keyframes rx-pulse-green {
    0%, 100% { box-shadow: 0 0 0 0 rgba(34,197,94,0.4); }
    50%       { box-shadow: 0 0 0 4px transparent; }
  }

  .rx-statusbar-sep {
    color: var(--rx-text-faint);
  }

  /* ── Tab bar ─────────────────────────────────────────────────────────── */
  .rx-tabbar {
    display: flex;
    align-items: flex-end;
    gap: 0;
    margin-top: 28px;
    border-bottom: 1px solid var(--rx-border);
  }

  .rx-tab {
    font-family: var(--rx-mono);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 10px 20px;
    border: 1px solid transparent;
    border-bottom: none;
    background: transparent;
    color: var(--rx-text-muted);
    cursor: pointer;
    text-decoration: none;
    display: flex;
    align-items: center;
    gap: 8px;
    transition: all 0.15s ease;
    position: relative;
    top: 1px;
    border-radius: 4px 4px 0 0;
    user-select: none;
  }

  .rx-tab:hover {
    color: var(--rx-text);
    background: var(--rx-surface);
    border-color: var(--rx-border);
  }

  .rx-tab.active {
    color: var(--rx-text);
    background: var(--rx-surface);
    border-color: var(--rx-border);
    border-bottom-color: var(--rx-surface);
  }

  .rx-tab.active::after {
    content: '';
    position: absolute;
    top: -1px;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--rx-brand);
    border-radius: 2px 2px 0 0;
  }

  .rx-tab-count {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 2px;
    background: var(--rx-surface2);
    border: 1px solid var(--rx-border);
    color: var(--rx-text-muted);
    font-weight: 400;
  }

  .rx-tab.active .rx-tab-count {
    background: var(--rx-brand-dim);
    border-color: rgba(124,58,237,0.25);
    color: #a78bfa;
  }

  /* ── Content panel ───────────────────────────────────────────────────── */
  .rx-panel {
    background: var(--rx-surface);
    border: 1px solid var(--rx-border);
    border-top: none;
    border-radius: 0 0 4px 4px;
    padding: 24px;
    animation: rx-fadein 0.2s ease;
  }

  @keyframes rx-fadein {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* ── Login layout ────────────────────────────────────────────────────── */
  .rx-login-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: 80px 0;
  }

  .rx-login-inner {
    width: 100%;
    max-width: 400px;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .rx-login-header {
    text-align: center;
  }

  .rx-login-header h1 {
    font-family: var(--rx-mono);
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--rx-text);
    margin-bottom: 6px;
  }

  .rx-login-header p {
    font-size: 13px;
    color: var(--rx-text-muted);
  }

  /* ── Corner decoration ───────────────────────────────────────────────── */
  .rx-corner {
    position: absolute;
    width: 12px;
    height: 12px;
  }

  .rx-corner.tl { top: 0; left: 0; border-top: 1px solid var(--rx-brand); border-left: 1px solid var(--rx-brand); }
  .rx-corner.tr { top: 0; right: 0; border-top: 1px solid var(--rx-brand); border-right: 1px solid var(--rx-brand); }
  .rx-corner.bl { bottom: 0; left: 0; border-bottom: 1px solid var(--rx-brand); border-left: 1px solid var(--rx-brand); }
  .rx-corner.br { bottom: 0; right: 0; border-bottom: 1px solid var(--rx-brand); border-right: 1px solid var(--rx-brand); }

  .rx-login-card {
    position: relative;
    background: var(--rx-surface);
    border: 1px solid var(--rx-border);
    border-radius: 4px;
    padding: 28px;
  }

  /* ── Responsive ──────────────────────────────────────────────────────── */
  /* ── Studio (Colab-like) ───────────────────────────────────────────── */
  .rx-btn-primary {
    border-color: var(--rx-brand) !important;
    background: var(--rx-brand-dim) !important;
    color: #c4b5fd !important;
  }
  .rx-btn-primary:hover {
    background: rgba(124,58,237,0.25) !important;
    color: #fff !important;
  }
  .rx-studio-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--rx-border);
  }
  .rx-studio-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-family: var(--rx-mono);
    font-size: 10px;
    text-transform: uppercase;
    color: var(--rx-text-muted);
  }
  .rx-studio-field input {
    width: 72px;
    padding: 6px 8px;
    background: var(--rx-surface2);
    border: 1px solid var(--rx-border);
    border-radius: 3px;
    color: var(--rx-text);
    font-family: var(--rx-mono);
    font-size: 12px;
  }
  .rx-studio-jobid code {
    font-family: var(--rx-mono);
    font-size: 11px;
    color: var(--rx-accent);
  }
  .rx-studio-error {
    padding: 10px 14px;
    margin-bottom: 12px;
    border-radius: 4px;
    background: rgba(239,68,68,0.1);
    border: 1px solid rgba(239,68,68,0.35);
    color: #fca5a5;
    font-size: 13px;
  }
  .rx-studio-grid {
    display: grid;
    grid-template-columns: 220px 1fr 280px;
    gap: 16px;
    min-height: 520px;
  }
  @media (max-width: 960px) {
    .rx-studio-grid { grid-template-columns: 1fr; }
  }
  .rx-studio-sidebar, .rx-studio-editor, .rx-studio-output {
    background: var(--rx-surface2);
    border: 1px solid var(--rx-border);
    border-radius: 4px;
    padding: 14px;
    overflow: auto;
  }
  .rx-studio-sidebar h3, .rx-studio-editor h3, .rx-studio-output h3 {
    font-family: var(--rx-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--rx-text-muted);
    margin-bottom: 10px;
  }
  .rx-studio-hint {
    font-size: 12px;
    color: var(--rx-text-muted);
    margin-bottom: 12px;
    line-height: 1.5;
  }
  .rx-studio-dataset-list {
    list-style: none;
    margin-top: 12px;
  }
  .rx-studio-dataset-list li {
    padding: 8px 0;
    border-bottom: 1px solid var(--rx-border);
  }
  .rx-studio-dataset-list label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    cursor: pointer;
    font-size: 13px;
  }
  .rx-studio-ds-meta {
    font-size: 11px;
    color: var(--rx-text-muted);
    font-family: var(--rx-mono);
  }
  .rx-studio-empty {
    color: var(--rx-text-faint);
    font-size: 12px;
  }
  .rx-studio-cell {
    margin-bottom: 12px;
  }
  .rx-studio-cell-label {
    display: block;
    font-family: var(--rx-mono);
    font-size: 10px;
    color: var(--rx-text-muted);
    margin-bottom: 6px;
    text-transform: uppercase;
  }
  .rx-studio-cell textarea {
    width: 100%;
    background: var(--rx-bg);
    border: 1px solid var(--rx-border);
    border-radius: 4px;
    color: var(--rx-text);
    font-size: 13px;
    padding: 10px;
    resize: vertical;
    line-height: 1.5;
  }
  .rx-studio-code {
    font-family: var(--rx-mono) !important;
    font-size: 12px !important;
    tab-size: 2;
  }
  .rx-studio-log, .rx-studio-result {
    font-family: var(--rx-mono);
    font-size: 11px;
    background: var(--rx-bg);
    border: 1px solid var(--rx-border);
    border-radius: 4px;
    padding: 10px;
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
    margin-top: 10px;
    color: var(--rx-text-muted);
  }
  .rx-studio-status {
    font-size: 13px;
    margin-bottom: 8px;
  }
  .rx-studio-metrics {
    margin-top: 10px;
  }
  .rx-studio-metrics pre {
    font-family: var(--rx-mono);
    font-size: 11px;
    background: var(--rx-bg);
    border: 1px solid var(--rx-border);
    border-radius: 4px;
    padding: 8px;
    margin-top: 6px;
    max-height: 160px;
    overflow: auto;
  }
  .rx-studio-task-list {
    list-style: none;
    font-family: var(--rx-mono);
    font-size: 11px;
    color: var(--rx-text-muted);
    margin: 8px 0;
  }
  .rx-studio-task-list li {
    padding: 2px 0;
  }
  [hidden] {
    display: none !important;
  }

  @media (max-width: 600px) {
    .rx-shell { padding: 0 16px 32px; }
    .rx-chip { display: none; }
    .rx-tabbar { overflow-x: auto; }
    .rx-panel { padding: 16px; }
  }
`;

// ─── Inject styles ───────────────────────────────────────────────────────────

function StyleInjector() {
  useEffect(() => {
    const id = "rx-styles";
    if (!document.getElementById(id)) {
      const el = document.createElement("style");
      el.id = id;
      el.textContent = styles;
      document.head.appendChild(el);
    }
    return () => {
      document.getElementById(id)?.remove();
    };
  }, []);
  return null;
}

// ─── Animated clock ──────────────────────────────────────────────────────────

function LiveClock() {
  const [time, setTime] = useState(() =>
    new Date().toISOString().replace("T", " ").slice(0, 19),
  );
  useEffect(() => {
    const id = setInterval(() => {
      setTime(new Date().toISOString().replace("T", " ").slice(0, 19));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return <>{time} UTC</>;
}

// ─── App ─────────────────────────────────────────────────────────────────────

export function App() {
  const auth = useAuth();
  const [tab, setTab] = useState<Tab>("nodes");

  const title = useMemo(() => {
    if (tab === "nodes") return "NODES";
    if (tab === "studio") return "STUDIO";
    return "JOBS";
  }, [tab]);

  return (
    <>
      <StyleInjector />
      <div className="rx-shell">
        {/* ── Topbar ──────────────────────────────────────────────────── */}
        <header className="rx-topbar">
          <div className="rx-brand">
            <span className="rx-brand-dot" />
            ResourceX
            <span className="rx-slash">/</span>
            Dashboard
            <span className="rx-tab-badge">{title}</span>
          </div>

          <div className="rx-topbar-right">
            <span className="rx-chip">⬡ {BACKEND_URL}</span>
            {auth.authed && (
              <button className="rx-btn danger" onClick={auth.logout}>
                Disconnect
              </button>
            )}
          </div>
        </header>

        {!auth.authed ? (
          /* ── Login ─────────────────────────────────────────────────── */
          <div className="rx-login-wrap">
            <div className="rx-login-inner">
              <div className="rx-login-header">
                <h1>ResourceX Access</h1>
                <p>Authenticate to enter the dashboard</p>
              </div>
              <div className="rx-login-card">
                <span className="rx-corner tl" />
                <span className="rx-corner tr" />
                <span className="rx-corner bl" />
                <span className="rx-corner br" />
                <LoginCard onLogin={auth.login} onRegister={auth.register} />
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* ── Status bar ──────────────────────────────────────────── */}
            <div className="rx-statusbar">
              <span className="rx-statusbar-dot" />
              CONNECTED
              <span className="rx-statusbar-sep">·</span>
              <LiveClock />
              <span className="rx-statusbar-sep">·</span>
              SYS NOMINAL
            </div>

            {/* ── Tabs ────────────────────────────────────────────────── */}
            <nav className="rx-tabbar" role="tablist">
              <a
                role="tab"
                aria-selected={tab === "nodes"}
                className={`rx-tab ${tab === "nodes" ? "active" : ""}`}
                href="#nodes"
                onClick={(e) => {
                  e.preventDefault();
                  setTab("nodes");
                }}
              >
                Nodes
                <span className="rx-tab-count">N</span>
              </a>
              <a
                role="tab"
                aria-selected={tab === "studio"}
                className={`rx-tab ${tab === "studio" ? "active" : ""}`}
                href="#studio"
                onClick={(e) => {
                  e.preventDefault();
                  setTab("studio");
                }}
              >
                Studio
                <span className="rx-tab-count">⌘</span>
              </a>
              <a
                role="tab"
                aria-selected={tab === "jobs"}
                className={`rx-tab ${tab === "jobs" ? "active" : ""}`}
                href="#jobs"
                onClick={(e) => {
                  e.preventDefault();
                  setTab("jobs");
                }}
              >
                Jobs
                <span className="rx-tab-count">J</span>
              </a>
            </nav>

            {/* ── Panel (keep mounted so Studio job state survives tab switches) */}
            <div className="rx-panel" role="tabpanel">
              <div hidden={tab !== "nodes"}>
                <NodesView token={auth.token} />
              </div>
              <div hidden={tab !== "studio"}>
                <StudioView token={auth.token} active={tab === "studio"} />
              </div>
              <div hidden={tab !== "jobs"}>
                <JobsView token={auth.token} />
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
