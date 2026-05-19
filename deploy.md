# ResourceX deployment (inter-device)

ResourceX is **one central backend** plus **many compute nodes** and **submitters** (CLI, dashboard, CI). Inter-device only works when every machine talks to the **same** backend URL—not separate `localhost` instances on each laptop.

| What | Where it lives |
|------|----------------|
| **Users** (login/register) | **MongoDB** (`MONGODB_URI`) — survives backend restarts |
| **Node trust / registration** | **MongoDB** — trust scores persist; live connection state is in memory |
| **Active jobs / tasks** | **In memory** in the backend process (lost on restart; Redis may still hold queue keys) |
| **Job queue** | **Redis** (required) |

---

## Quick mental model

```text
  [Laptop A: node]  ──WebSocket──┐
  [Laptop B: node]  ──WebSocket──┼──►  [ ONE Backend :4000 ]  ◄── Redis
  [Phone/PC: CLI]   ──HTTP/WS───┘         ▲
  [Dashboard]       ──HTTP/WS─────────────┘
```

1. Deploy or run **one** backend reachable from all devices (LAN IP, Tailscale, or cloud URL).
2. Point every node and submitter at that URL (`RESOURCEX_BACKEND` or `--backend`).
3. Register once per machine with `resourcex-node register` (each gets its own `nodeId` in `~/.resourcex/config.json`).

---

## Option A — Same Wi‑Fi / LAN (fastest for two laptops)

### 1. On the machine that hosts the backend

From the repo root:

```bash
npm install
npm run redis:up
npm run mongo:up
```

Create `backend/.env` (copy from `backend/.env.example`):

```env
PORT=4000
HOST=0.0.0.0
JWT_SECRET=your-long-random-secret
MONGODB_URI=mongodb://127.0.0.1:27017/resourcex
REDIS_URL=redis://127.0.0.1:6379
```

Start the backend:

```bash
npm run dev:backend
```

Find this PC’s LAN IP (Windows PowerShell):

```powershell
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'Loopback' }).IPAddress
```

Example: `192.168.1.10`.

**Firewall (Windows):** allow inbound TCP on port `4000`:

```powershell
New-NetFirewallRule -DisplayName "ResourceX Backend" -Direction Inbound -Protocol TCP -LocalPort 4000 -Action Allow
```

Health check from another device: `http://192.168.1.10:4000/health`

### 2. On each compute node (other laptops)

Use the **LAN URL**, not `localhost`:

```bash
cd node-agent
npx resourcex-node register --backend http://192.168.1.10:4000
npx resourcex-node start --backend http://192.168.1.10:4000
```

### 3. Job submitter (any device on the LAN)

**PowerShell:**

```powershell
$env:RESOURCEX_BACKEND = "http://192.168.1.10:4000"
# Register once, save token:
$r = Invoke-RestMethod -Method Post -Uri "$env:RESOURCEX_BACKEND/api/auth/register" `
  -ContentType "application/json" `
  -Body '{"email":"you@example.com","password":"yourpassword12"}'
$env:RESOURCEX_TOKEN = $r.token

cd cli
node src/cli.js submit ..\examples\demo-job.json
```

Set `"parallelism": 2` (or more) in the job JSON to spread shards across multiple connected nodes.

### 4. Dashboard (optional)

```bash
cd dashboard
# Point Vite at the LAN backend:
$env:VITE_BACKEND_URL = "http://192.168.1.10:4000"
npm run dev
```

Open the dashboard URL shown by Vite; register/login uses the shared backend.

---

## Option B — Docker Compose (backend + Redis on one host)

Best for a home server, NUC, or VM that other devices can reach.

### 1. Set secrets

In the repo root, create `.env` (used by Compose):

```env
JWT_SECRET=replace-with-openssl-rand-hex-32
CORS_ORIGIN=*
```

Generate a secret (PowerShell):

```powershell
-join ((48..57) + (97..102) | Get-Random -Count 64 | ForEach-Object { [char]$_ })
```

### 2. Start stack

```bash
docker compose up -d --build
```

- API: `http://<HOST_IP>:4000`
- MongoDB: `mongodb://mongo:27017/resourcex` (data in `mongo-data` volume)
- Redis: internal only (`redis://redis:6379`)

Logs:

```bash
docker compose logs -f backend
```

Stop:

```bash
docker compose down
```

### 3. Point nodes and CLI at the host

```bash
npx resourcex-node register --backend http://<HOST_IP>:4000
npx resourcex-node start --backend http://<HOST_IP>:4000
```

---

## Option C — Cloud (public URL for nodes anywhere)

You need:

1. **HTTPS/WSS** in production (reverse proxy or platform TLS).
2. **Managed Redis** (e.g. [Upstash](https://upstash.com)) — set `REDIS_URL=rediss://...`
3. **Managed MongoDB** (e.g. [MongoDB Atlas](https://www.mongodb.com/atlas)) — set `MONGODB_URI=mongodb+srv://...`

### Render / Railway / Fly (pattern)

1. Deploy the **backend** service from `backend/` (Dockerfile provided).
2. Add a **MongoDB** service or Atlas cluster; set `MONGODB_URI`.
3. Add env vars:

   | Variable | Value |
   |----------|--------|
   | `JWT_SECRET` | Strong random string |
   | `REDIS_URL` | Upstash / managed Redis URL |
   | `MONGODB_URI` | `mongodb+srv://...` or internal URL |
   | `HOST` | `0.0.0.0` |
   | `PORT` | Platform port (often injected as `PORT`) |
   | `CORS_ORIGIN` | Your dashboard origin, e.g. `https://app.example.com` |

4. Expose port `4000` (or whatever the platform maps).
5. Use the public URL everywhere:

   ```bash
   export RESOURCEX_BACKEND=https://api.yourdomain.com
   npx resourcex-node register --backend $RESOURCEX_BACKEND
   npx resourcex-node start --backend $RESOURCEX_BACKEND
   ```

**WebSockets:** use `wss://` when the API is `https://`. Nodes and the dashboard build WS URLs from the same base URL.

### Dashboard static hosting

Build with the production API URL baked in:

```bash
cd dashboard
VITE_BACKEND_URL=https://api.yourdomain.com npm run build
```

Serve `dashboard/dist` with Netlify, Vercel, S3, or nginx.

---

## Option D — Tailscale / VPN (no public internet)

1. Install [Tailscale](https://tailscale.com) on the backend host and each node.
2. Run backend with `HOST=0.0.0.0` on the Tailscale IP (e.g. `100.x.y.z`).
3. Use `http://100.x.y.z:4000` as `RESOURCEX_BACKEND` on all machines.

Same steps as LAN; no port forwarding on your router.

---

## Checklist: inter-device working

| Step | Done? |
|------|--------|
| One backend process running and reachable (`/health` returns OK from another device) | |
| Redis connected (backend starts without queue errors) | |
| MongoDB connected (`MONGODB_URI` set; backend logs DB name on start) | |
| `JWT_SECRET` set (not default) if exposed beyond localhost | |
| Each node: `register` + `start` with **same** `--backend` URL | |
| Submitter: user JWT from **that** backend’s `/api/auth/register` | |
| Firewall / security group allows TCP **4000** (or your `PORT`) | |
| Job JSON `parallelism` > 1 to use multiple nodes | |

Verify mesh:

```bash
curl http://<BACKEND>/api/admin/nodes
curl http://<BACKEND>/api/admin/stats
```

(Admin routes are unauthenticated in this demo—lock them down before a public deploy.)

---

## Environment reference

### Backend

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4000` | HTTP + WebSocket |
| `HOST` | `0.0.0.0` | Bind address (`0.0.0.0` = all interfaces, required for LAN) |
| `JWT_SECRET` | dev fallback | **Required in production** |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/resourcex` | MongoDB connection string |
| `MONGODB_DB` | (from URI) | Optional database name override |
| `REDIS_URL` | — | BullMQ (required) |
| `CORS_ORIGIN` | `*` | Dashboard / browser clients |

### Node agent

| Variable | Purpose |
|----------|---------|
| `RESOURCEX_BACKEND` | Base URL of the **shared** backend |
| Config file | `%USERPROFILE%\.resourcex\config.json` (Windows) or `~/.resourcex/config.json` |

### CLI / submitter

| Variable | Purpose |
|----------|---------|
| `RESOURCEX_BACKEND` | Same shared backend URL |
| `RESOURCEX_TOKEN` | User JWT from `/api/auth/login` or `register` |

---

## Limitations after deploy

- **Jobs** still live in memory: a backend restart clears in-flight job state (users and node trust remain in MongoDB).
- **Connected** flag is runtime-only: after restart, nodes must run `resourcex-node start` again to reconnect.
- **Admin** routes (`/api/admin/*`) have no auth—disable or protect before exposing to the internet.
- **One config per OS user:** two nodes on the same Windows account share `~/.resourcex/config.json`; use separate machines, VMs, or OS users.

For local development details and trust/challenge behavior, see [setup.md](./setup.md).
