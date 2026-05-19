# ML training on ResourceX (large datasets)

ResourceX runs **real ML training** on compute nodes via Docker. Huge datasets are **never uploaded through the API** — you host shards on object storage (S3, GCS, HTTPS) and reference them by URL.

## Architecture

```text
Submitter                    Backend                         Node (any device)
   |                            |                                  |
   | POST /api/jobs             |                                  |
   | (dataset URLs only)        |                                  |
   |--------------------------->|  TASK_DISPATCH + ml payload      |
   |                            |--------------------------------->|
   |                            |                    download shard|
   |                            |                    docker train  |
   |                            |<--------- TASK_RESULT (metrics) --|
```

| Step | What happens |
|------|----------------|
| 1 | You define **N URL shards** (or HuggingFace dataset id). |
| 2 | `parallelism: N` assigns one shard per task (often one node per shard). |
| 3 | Node downloads only **its** shard into `~/.resourcex/cache/workspaces/<taskId>`. |
| 4 | Container runs PyTorch (or your script) with `/data` mounted and network for pip/HF. |
| 5 | Metrics JSON returned in task output; job aggregates all shards. |

## Job format (`type: "ml_training"`)

```json
{
  "jobId": "my_train_001",
  "type": "ml_training",
  "parallelism": 4,
  "dataset": {
    "source": "urls",
    "urls": [
      "https://your-bucket.s3.amazonaws.com/train/shard_0.parquet",
      "https://your-bucket.s3.amazonaws.com/train/shard_1.parquet",
      "https://your-bucket.s3.amazonaws.com/train/shard_2.parquet",
      "https://your-bucket.s3.amazonaws.com/train/shard_3.parquet"
    ],
    "format": "parquet"
  },
  "training": {
    "framework": "pytorch",
    "entrypoint": "pip install -q pandas pyarrow && python /workspace/train.py",
    "scriptUrl": "https://your-bucket.s3.amazonaws.com/code/train.py",
    "hyperparameters": {
      "epochs": 20,
      "batch_size": 128,
      "lr": 0.0001
    },
    "modelType": "mlp"
  },
  "resources": {
    "cpus": 8,
    "memory": "16g",
    "gpu": true,
    "requireGpu": true,
    "timeout": 86400000,
    "network": true
  }
}
```

### Dataset (`dataset`)

| Field | Purpose |
|-------|---------|
| `source: "urls"` | Download shards from HTTPS (S3 public, signed URLs, CDN). |
| `urls[]` | One URL per partition; length should be ≥ `parallelism`. |
| `source: "huggingface"` | Load inside container via `datasets` (needs `network: true`). |
| `huggingface.dataset` | e.g. `"mnist"`, `"imdb"` |

**Huge datasets:** split files offline (Spark, `split -l`, parquet partitions), upload to object storage, list URLs. Each node downloads **one shard** (tens of GB is feasible; plan disk under `RESOURCEX_DATA_CACHE`).

### Training (`training`)

| Field | Purpose |
|-------|---------|
| `entrypoint` | Shell command in container (install deps + run script). |
| `scriptUrl` | Optional custom `train.py` URL. |
| `scriptInline` | Optional Python source (small scripts only). |
| Default | Bundled `node-agent/scripts/train.py` if neither URL/inline set. |
| `hyperparameters` | Passed as `/workspace/hyperparameters.json` + env vars. |

### Resources (`resources`)

| Field | Default | Purpose |
|-------|---------|---------|
| `cpus` | 2 | Docker `--cpus` |
| `memory` | 4g | Docker `--memory` |
| `gpu` | false | `--gpus all` when true |
| `requireGpu` | false | Scheduler only picks nodes that reported a GPU |
| `timeout` | 3600000 | Max ms (1h default in ML jobs) |
| `network` | true | Required for downloads / HuggingFace / pip |

### Image

Default image: `python:3.11-slim` (PyTorch is installed via `pip` in the job `entrypoint`).

Override with `RESOURCEX_ML_IMAGE` or `"image"` in the job JSON. The tag `pytorch/pytorch:2.1.0-cpu` **does not exist** on Docker Hub.

For GPU training you can use `pytorch/pytorch:latest` (large) with `"gpu": true`, or build `examples/ml/Dockerfile`.

## Submit

```powershell
$env:RESOURCEX_BACKEND = "http://YOUR_BACKEND:4000"
$env:RESOURCEX_TOKEN = "<user_jwt>"
cd cli
node src/cli.js submit ..\examples\ml-training-job.json
node src/cli.js status ml_iris_001 --watch
```

## Node requirements

- **Docker** installed (`resourcex-node start` without `--no-docker`)
- Enough **disk** for shard downloads (`RESOURCEX_DATA_CACHE`, default `~/.resourcex/cache`)
- For GPU jobs: NVIDIA drivers + `nvidia-container-toolkit`
- **Network** to reach dataset URLs and backend

## Examples in repo

| File | Description |
|------|-------------|
| `examples/ml-training-job.json` | Single-node Iris CSV from HTTPS |
| `examples/ml-distributed-job.json` | `parallelism: 2`, two shards |
| `examples/ml-huggingface-job.json` | MNIST via HuggingFace |

## Custom training code

1. Put `train.py` on S3 and set `training.scriptUrl`.
2. Read data from `/data`, config from `/workspace/hyperparameters.json`.
3. Print metrics: `print("RESOURCEX_METRICS=" + json.dumps({...}))`
4. Use env: `RESOURCEX_SHARD_INDEX`, `RESOURCEX_SHARD_COUNT`, `RESOURCEX_JOB_ID`.

## Limits (current version)

- Job state is still **in-memory** on the backend (re-submit after restart).
- No automatic model artifact upload (add your own upload in `train.py` to S3).
- Default script is tabular/CSV/HF-friendly MLP; use custom script for CNNs, LLMs, etc.
- Challenge tasks still use the legacy sandbox; only `ml_training` jobs use the ML path.

## Building a dedicated ML image (optional)

From repo root:

```bash
docker build -f examples/ml/Dockerfile -t resourcex/ml-worker:latest .
```

Set `"image": "resourcex/ml-worker:latest"` and a short entrypoint: `"python /workspace/train.py"`.
