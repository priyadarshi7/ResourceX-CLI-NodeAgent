#!/usr/bin/env python3
"""
ResourceX default training script.
Reads data from RESOURCEX_DATA_DIR (/data), hyperparameters from /workspace/hyperparameters.json.
Prints a single JSON metrics line to stdout (parsed by the platform).
"""
import json
import os
import sys
from pathlib import Path

WORKSPACE = Path("/workspace")
DATA_DIR = Path(os.environ.get("RESOURCEX_DATA_DIR", "/data"))
HP_PATH = WORKSPACE / "hyperparameters.json"


def load_hyperparameters():
    if HP_PATH.exists():
        with open(HP_PATH) as f:
            return json.load(f)
    return {"epochs": 3, "lr": 0.01, "batch_size": 32, "modelType": "mlp"}


def load_huggingface(hp):
    from datasets import load_dataset

    hf_meta = DATA_DIR / "hf.json"
    if hf_meta.exists():
        meta = json.loads(hf_meta.read_text())
    else:
        meta = {
            "dataset": os.environ.get("HF_DATASET", "mnist"),
            "config": os.environ.get("HF_CONFIG"),
            "split": os.environ.get("HF_SPLIT", "train"),
        }
    name = meta["dataset"]
    config = meta.get("config")
    split = meta.get("split", "train")
    if config:
        ds = load_dataset(name, config, split=split)
    else:
        ds = load_dataset(name, split=split)
    return ds


def load_csv_files():
    import pandas as pd

    files = list(DATA_DIR.glob("*.csv")) + list(DATA_DIR.glob("*.parquet"))
    if not files:
        raise FileNotFoundError(f"No CSV/parquet under {DATA_DIR}")
    frames = []
    for f in files:
        if f.suffix == ".parquet":
            frames.append(pd.read_parquet(f))
        else:
            frames.append(pd.read_csv(f))
    df = pd.concat(frames, ignore_index=True)
    return df


def train_pytorch_tabular(df, hp):
    import torch
    import torch.nn as nn
    from torch.utils.data import DataLoader, TensorDataset

    numeric = df.select_dtypes(include=["number"])
    if numeric.shape[1] < 2:
        raise ValueError("Need at least 2 numeric columns (features + label)")
    X = numeric.iloc[:, :-1].values.astype("float32")
    y = numeric.iloc[:, -1].values.astype("int64")

    shard = int(os.environ.get("RESOURCEX_SHARD_INDEX", "0"))
    shard_count = int(os.environ.get("RESOURCEX_SHARD_COUNT", "1"))
    n = len(X)
    chunk = max(1, n // shard_count)
    start = shard * chunk
    end = n if shard == shard_count - 1 else (shard + 1) * chunk
    X, y = X[start:end], y[start:end]

    X_t = torch.tensor(X)
    y_t = torch.tensor(y)
    loader = DataLoader(
        TensorDataset(X_t, y_t),
        batch_size=int(hp.get("batch_size", 32)),
        shuffle=True,
    )

    in_dim = X.shape[1]
    classes = int(y.max()) + 1
    model = nn.Sequential(
        nn.Linear(in_dim, 64),
        nn.ReLU(),
        nn.Linear(64, classes),
    )
    opt = torch.optim.Adam(model.parameters(), lr=float(hp.get("lr", 0.01)))
    loss_fn = nn.CrossEntropyLoss()

    epochs = int(hp.get("epochs", 3))
    for epoch in range(epochs):
        total_loss = 0.0
        correct = 0
        total = 0
        for xb, yb in loader:
            opt.zero_grad()
            logits = model(xb)
            loss = loss_fn(logits, yb)
            loss.backward()
            opt.step()
            total_loss += loss.item() * len(xb)
            correct += (logits.argmax(1) == yb).sum().item()
            total += len(xb)
        acc = correct / max(1, total)
        print(f"epoch={epoch+1} loss={total_loss/max(1,total):.4f} acc={acc:.4f}", flush=True)

    return {"loss": total_loss / max(1, total), "accuracy": acc, "samples": int(total)}


def main():
    hp = load_hyperparameters()
    framework = hp.get("framework", "pytorch")

    if (DATA_DIR / "hf.json").exists() or os.environ.get("HF_DATASET"):
        ds = load_huggingface(hp)
        import pandas as pd

        df = ds.to_pandas() if hasattr(ds, "to_pandas") else pd.DataFrame(ds)
    else:
        df = load_csv_files()

    if framework != "pytorch":
        print(json.dumps({"error": f"framework {framework} not supported in default script"}))
        sys.exit(1)

    metrics = train_pytorch_tabular(df, hp)
    metrics["shardIndex"] = int(os.environ.get("RESOURCEX_SHARD_INDEX", "0"))
    metrics["jobId"] = os.environ.get("RESOURCEX_JOB_ID", "")
    print("RESOURCEX_METRICS=" + json.dumps(metrics), flush=True)


if __name__ == "__main__":
    main()
