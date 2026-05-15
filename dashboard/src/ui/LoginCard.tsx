import React, { useState } from "react";
import { HttpError } from "../lib/http";

export function LoginCard(props: {
  onLogin: (email: string, password: string) => Promise<unknown>;
  onRegister: (email: string, password: string) => Promise<unknown>;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("submitter@example.com");
  const [password, setPassword] = useState("yourpassword12");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (mode === "login") await props.onLogin(email, password);
      else await props.onRegister(email, password);
    } catch (e) {
      setError(toMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="cardHeader">
        <h2 className="h2">Sign in</h2>
        <div className="row">
          <button
            className={`btn ${mode === "login" ? "primary" : ""}`}
            onClick={() => setMode("login")}
            disabled={busy}
          >
            Login
          </button>
          <button
            className={`btn ${mode === "register" ? "primary" : ""}`}
            onClick={() => setMode("register")}
            disabled={busy}
          >
            Register
          </button>
        </div>
      </div>

      <div className="grid cols2">
        <div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Email
          </div>
          <input
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="username"
          />
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Password
          </div>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </div>
      </div>

      {error ? (
        <div style={{ marginTop: 12 }} className="pill">
          {error}
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={submit} disabled={busy}>
          {busy ? "Working..." : mode === "login" ? "Login" : "Create account"}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          Uses `/api/auth/{mode}` and stores JWT in localStorage.
        </span>
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

