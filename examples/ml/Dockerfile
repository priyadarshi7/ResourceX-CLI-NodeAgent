# Optional pre-built ML worker (faster starts than pip install every job).
# From repo root:
#   docker build -f examples/ml/Dockerfile -t resourcex/ml-worker:latest .
# Job JSON: "image": "resourcex/ml-worker:latest"
FROM python:3.11-slim

RUN pip install --no-cache-dir torch pandas pyarrow datasets scikit-learn

COPY node-agent/scripts/train.py /workspace/train.py
WORKDIR /workspace
