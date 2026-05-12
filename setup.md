# ResourceX setup (backend, job submitter, compute nodes)

This document covers **one central backend**, **any number of compute nodes** (laptops, desktops, servers), and **job submitters** (humans or CI using the API / CLI).

---

## What is happening when the node prints tasks and `[TRUST]`?

Your node connects over **WebSocket** to the backend. The backend then:

1. **Cold-start probing** — Right after `NODE_HELLO`, the scheduler may send one or more **masked challenge** tasks (Docker workloads with a known correct answer). They look like normal tasks to the agent.
2. **Periodic challenges** — About every **20 seconds**, the scheduler can inject more challenges on connected nodes (rate depends on trust tier; **COLD_START** is probed heavily).
3. **Real jobs** — If someone submitted a job with `parallelism > 1` or multiple jobs are queued, you will see additional `TASK_DISPATCH` lines for **real** shards.

When a challenge finishes, the backend **compares the output** to ground truth and updates trust using  
\(C_{t+1} = \alpha C_t + \beta\) on success or subtracts \(\gamma\) on failure. That is why you see lines like:

```text
[TRUST] Score: 0.57 | Tier: WARM
```

**Tiers** in this codebase: `COLD_START` → `WARM` → `TRUSTED` → `ELITE` (derived from the numeric score). Rising scores after successful challenges is expected.

---

## Architecture (no MongoDB)

| Piece | Role |
|--------|------|
| **Redis** | **Required.** BullMQ queue (`resourcex-jobs`) so job dispatch runs reliably. |
| **MongoDB** | **Not used.** Users, nodes, and active jobs live **in memory** in the backend process (lost on restart). |
| **Backend** | REST + JWT; WebSocket to nodes (`/ws/node`) and submitters (`/ws/jobs`); scheduler + ACRS challenge engine. |
| **Compute node** | `resourcex-node` — executes tasks (Docker by default), streams progress/results. |
| **Submitter** | Registers/logs in, obtains a **user JWT**, `POST /api/jobs` or `resourcex submit`. |

---

## Prerequisites

- **Node.js** 18+ recommended  
- **Redis** reachable by the backend (local Docker, cloud, or **Upstash**)  
- **Docker** on each compute node if you want real container execution (omit `--no-docker` only when Docker is installed)

---

## Environment variables

### Backend (`backend/.env` or shell)

| Variable | Default | Notes |
|----------|---------|--------|
| `PORT` | `4000` | HTTP and WebSocket on the same server. |
| `JWT_SECRET` | dev fallback in code | **Set in production.** |
| `CORS_ORIGIN` | `*` | Optional tighten for browser clients. |
| `REDIS_URL` | — | **Preferred** single URL (see Redis section). |
| `REDIS_HOST` | `127.0.0.1` | If not using `REDIS_URL`. |
| `REDIS_PORT` | `6379` | |
| `REDIS_PASSWORD` | — | Optional. |
| `REDIS_TLS` | — | Set `1` or `true` if the server requires TLS but you are **not** using a `rediss://` URL. |

### Job submitter (CLI or scripts)

| Variable | Purpose |
|----------|---------|
| `RESOURCEX_BACKEND` | API base URL, e.g. `http://192.168.1.10:4000` or your deployed URL. |
| `RESOURCEX_TOKEN` | **User** JWT from `/api/auth/register` or `/api/auth/login`. |

### Compute node (`resourcex-node` or shell)

| Variable | Purpose |
|----------|---------|
| `RESOURCEX_BACKEND` | Same as backend URL; **must be reachable from that machine** (not `localhost` unless the backend runs on the same PC). |
| `RESOURCEX_TOKEN` | Not used for `start` (token is in `~/.resourcex/config.json` after `register`). |

---

## Redis

### Local Docker (repo root)

```bash
npm run redis:up
```

Stops with:

```bash
npm run redis:down
```

### Upstash (cloud)

Yes — use the **Redis URL** from the Upstash console.

- Prefer **`rediss://`** (TLS). The backend sets `tls: {}` automatically when the scheme is `rediss:`.
- Example shape:  
  `REDIS_URL=rediss://default:YOUR_TOKEN@YOUR-ENDPOINT.upstash.io:6379`

Put that in `backend/.env`. BullMQ is chatty; pick an Upstash plan that allows your command volume.

### Plain URL fallback

If `REDIS_URL` cannot be parsed as a URL, it is passed through as `{ url: REDIS_URL, maxRetriesPerRequest: null }` for ioredis/BullMQ.

---

## 1. Install dependencies

From the repository root:

```bash
npm install
```

---

## 2. Start the backend

```bash
cd backend
npm run dev
```

Health check: open or curl `http://localhost:4000/health` (replace host if remote).

---

## 3. Job submitter (full flow)

Submitter identity is an **email + password**; the API returns a **user JWT** (`typ: user`) used for job APIs.

### 3a. Register (first time)

**PowerShell**

```powershell
$r = Invoke-RestMethod -Method Post -Uri "http://localhost:4000/api/auth/register" `
  -ContentType "application/json" `
  -Body '{"email":"submitter@example.com","password":"yourpassword12"}'
$r.token
```

**cmd.exe** (single line)

```bat
curl -X POST http://localhost:4000/api/auth/register -H "Content-Type: application/json" -d "{\"email\":\"submitter@example.com\",\"password\":\"yourpassword12\"}"
```

Save `token` securely.

### 3b. Login (returning submitter)

**PowerShell**

```powershell
$r = Invoke-RestMethod -Method Post -Uri "http://localhost:4000/api/auth/login" `
  -ContentType "application/json" `
  -Body '{"email":"submitter@example.com","password":"yourpassword12"}'
$r.token
```

### 3c. Submit a job (CLI)

From repo root after `npm install` (workspace installs `cli` deps):

**PowerShell**

```powershell
cd cli
$env:RESOURCEX_BACKEND = "http://localhost:4000"
$env:RESOURCEX_TOKEN = "<paste_user_jwt>"
node src/cli.js submit ..\examples\demo-job.json
```

**cmd.exe**

```bat
cd cli
set RESOURCEX_BACKEND=http://localhost:4000
set RESOURCEX_TOKEN=your_user_jwt_here
node src/cli.js submit ..\examples\demo-job.json
```

The API responds with `jobId`, `status`, and a **WebSocket hint** for live updates.

### 3d. Submit a job (REST only)

**PowerShell**

```powershell
$headers = @{ Authorization = "Bearer $env:RESOURCEX_TOKEN" }
Invoke-RestMethod -Method Post -Uri "http://localhost:4000/api/jobs" `
  -Headers $headers -ContentType "application/json" `
  -Body (Get-Content ..\examples\demo-job.json -Raw)
```

### 3e. Get job output (poll REST)

When `status` is **`completed`**, `GET /api/jobs/:jobId` includes:

- **`result`** — combined output: a single string if `parallelism` is 1, otherwise an **array** of per-shard outputs (same order as `shardIndex`).
- **`tasks[].result`** — each finished shard’s stdout (or container output) when that task is `completed`.

**PowerShell**

```powershell
Invoke-RestMethod -Uri "http://localhost:4000/api/jobs/demo_ml_001" -Headers @{ Authorization = "Bearer $env:RESOURCEX_TOKEN" }
```

**CLI (same folder as submit)**

```powershell
node src/cli.js status demo_ml_001
# Poll every 2s until completed or failed:
node src/cli.js status demo_ml_001 --watch
```

### 3f. Live monitoring (WebSocket)

1. Connect to:  
   `ws://<BACKEND_HOST>:4000/ws/jobs?token=<user_jwt>`  
   (use `wss://` behind HTTPS.)
2. After the socket opens, send:

```json
{"type":"SUBSCRIBE_JOB","jobId":"<jobId_from_submit_response>"}
```

You will receive **`JOB_UPDATE`** messages (`progress`, `status`). When the job finishes, an update with `status: "completed"` also includes **`result`**, **`confidenceScore`**, and **`validated`** (same shape as the REST `result` field).

### 3g. Multiple submitters

Each person (or API client) uses a **different email** at `/api/auth/register`. Tokens are independent; jobs are attributed in memory to `submittedBy` for newly created jobs.

---

## 4. Compute node (full flow)

### 4a. Register this machine once

```bash
cd node-agent
npx resourcex-node register
```

You will be prompted for email/password (same user model as the API; can match your submitter account or a dedicated ops account). Config is saved to:

- **Windows:** `%USERPROFILE%\.resourcex\config.json`  
- **macOS / Linux:** `~/.resourcex/config.json`

### 4b. Start the agent

```bash
npx resourcex-node start
```

Development without Docker:

```bash
npx resourcex-node start --no-docker
```

### 4c. Deregister (leave the pool)

Stops using this machine as a node: the backend drops the node record, closes its WebSocket, clears pending challenges for that node, and **deletes** local `config.json` so the next `register` creates a fresh identity.

```bash
npx resourcex-node deregister
```

Non-interactive:

```bash
npx resourcex-node deregister --yes
```

**REST (same as the CLI):** `DELETE /api/nodes/me` with header `Authorization: Bearer <node_jwt>`.

If the backend is unreachable, the CLI still removes the **local** config so you are not stuck with a dead token.

**Manual only:** stop the agent, then delete `%USERPROFILE%\.resourcex\config.json` (Windows) or `~/.resourcex/config.json`. Until the backend restarts, an in-memory node row may still exist unless you call `DELETE /api/nodes/me`.

### 4d. Pointing at a backend on another machine

On the **node** PC, the backend URL **must not** be `http://localhost:4000` unless the backend really runs on that same PC. Use the LAN IP or hostname of the machine running the backend, for example:

```bash
npx resourcex-node register --backend http://192.168.1.10:4000
npx resourcex-node start --backend http://192.168.1.10:4000
```

Or set `RESOURCEX_BACKEND` before `start` / `register`.

**Firewall:** allow inbound **TCP 4000** (or your `PORT`) on the backend host so other devices can reach HTTP and WebSocket.

---

## 5. Multiple devices (two or more compute nodes)

This codebase is designed for **one backend** and **many nodes**.

| Scenario | What to do |
|----------|------------|
| **Two laptops as compute nodes** | On **each** laptop: clone repo (or install CLI), run `resourcex-node register` once (each gets its own `nodeId`), then `resourcex-node start` with the **same** `RESOURCEX_BACKEND` pointing at the shared backend. |
| **Same Wi‑Fi** | Backend PC: bind is default `0.0.0.0` via Express `listen(PORT)` — other PCs use `http://<BACKEND_LAN_IP>:4000`. |
| **Spreading a single job across nodes** | Set `"parallelism": N` in your job JSON (see `examples/demo-job.json`). The scheduler picks up to **N** eligible connected nodes (round‑robin by load among nodes that pass the trust threshold). |
| **One physical PC, two “nodes”** | Not supported out of the box: both agents would fight over the **same** `~/.resourcex/config.json`. Use **separate OS users**, separate VMs, or separate machines. |

After nodes connect, check the mesh from the backend:

```text
GET http://localhost:4000/api/admin/nodes
GET http://localhost:4000/api/admin/stats
```

(Admin routes are **unauthenticated** in this demo—protect or remove them in production.)

---

## 6. Example job file

See `examples/demo-job.json`. Important fields:

| Field | Meaning |
|-------|---------|
| `jobId` | Optional; server can accept client-supplied id. |
| `type` | Logical job type label (e.g. `ml_training`). |
| `image` / `command` | Passed to the node (Docker by default). |
| `parallelism` | Number of shards; **each shard can go to a different node** when enough nodes are online and trusted enough. |
| `constraints.reliability` | Minimum **challenge score** for a node to receive that job: **`high` ≥ 0.5**, **`medium` ≥ 0.35**, **`low` ≥ 0.2** (default `medium`). New nodes start at **0.5**, so they qualify for `high` once connected and above noise; use `medium`/`low` if you want to include weaker tiers. |

---

## 7. Useful endpoints (default port 4000)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | No | Liveness. |
| POST | `/api/auth/register` | No | Create user + return user JWT. |
| POST | `/api/auth/login` | No | Return user JWT. |
| POST | `/api/jobs` | User JWT | Create job + enqueue dispatch. |
| GET | `/api/jobs/:jobId` | User JWT | Job + shard status. |
| POST | `/api/nodes/register` | No | Register hardware + return **node** JWT (used by CLI `register`). |
| DELETE | `/api/nodes/me` | **Node** JWT | Deregister this node (remove from pool, close WS). |
| GET | `/api/admin/stats` | No | Demo stats. |
| GET | `/api/admin/nodes` | No | List nodes. |

WebSockets:

- **Nodes:** `ws://<host>:4000/ws/node?token=<node_jwt>`
- **Submitters:** `ws://<host>:4000/ws/jobs?token=<user_jwt>`

---

## 8. Limitations (demo / single backend)

- Backend restart **clears** users, nodes, and jobs in memory; **Redis** may still hold old BullMQ keys until TTL/cleanup.
- **Admin** routes are open; add auth before any public deployment.
- For **production**, plan a real database for users/jobs and hardened auth.

---

## 9. Monorepo scripts (root `package.json`)

| Script | Purpose |
|--------|---------|
| `npm run redis:up` | Start local Redis (Docker Compose). |
| `npm run redis:down` | Stop local Redis stack. |
| `npm run dev:backend` | Run backend with nodemon. |
| `npm run dev` | Backend + dashboard placeholder (if configured). |
