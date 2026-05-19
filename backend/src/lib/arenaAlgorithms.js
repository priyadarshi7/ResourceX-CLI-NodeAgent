"use strict";

const SHARD_BOOTSTRAP = `# --- ResourceX multi-node helpers (auto-injected) ---
import os as _rx_os

def resourcex_shard_df(df):
    shard = int(_rx_os.environ.get("RESOURCEX_SHARD_INDEX", "0"))
    shard_count = int(_rx_os.environ.get("RESOURCEX_SHARD_COUNT", "1"))
    if shard_count <= 1:
        return df
    n = len(df)
    chunk = max(1, n // shard_count)
    start = shard * chunk
    end = n if shard == shard_count - 1 else (shard + 1) * chunk
    return df.iloc[start:end].copy()

def resourcex_shard_metrics(extra=None):
    import json as _rx_json
    import os as _rx_os2
    m = dict(extra or {})
    m.setdefault("shardIndex", int(_rx_os2.environ.get("RESOURCEX_SHARD_INDEX", "0")))
    m.setdefault("source", "studio")
    print("RESOURCEX_METRICS=" + _rx_json.dumps(m), flush=True)
    return m

def _load_xy():
    from pathlib import Path
    import pandas as pd
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
        raise ValueError(f"Need numeric features; got {feature_cols}")
    print("Features:", feature_cols)
    print("Label:", label_col)
    print("Rows:", len(df))
    X = df[feature_cols].values
    if pd.api.types.is_numeric_dtype(df[label_col]):
        y = df[label_col].astype(int).values
        classes = sorted(df[label_col].unique().tolist())
    else:
        labels = df[label_col].astype(str)
        classes = sorted(labels.unique())
        class_to_idx = {n: i for i, n in enumerate(classes)}
        y = labels.map(class_to_idx).values
    return X, y, classes, len(df)
`;

const MODEL_SNIPPETS = {
  logistic_regression: `
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score
print("[Arena] Algorithm: Logistic Regression", flush=True)
X, y, classes, n = _load_xy()
model = LogisticRegression(max_iter=300)
model.fit(X, y)
pred = model.predict(X)
acc = accuracy_score(y, pred)
print(f"Accuracy: {acc:.4f}")
resourcex_shard_metrics({"accuracy": float(acc), "samples": n, "n_classes": len(classes), "algorithm": "logistic_regression", "algorithmName": "Logistic Regression"})
`,
  random_forest: `
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score
print("[Arena] Algorithm: Random Forest", flush=True)
X, y, classes, n = _load_xy()
model = RandomForestClassifier(n_estimators=80, random_state=42)
model.fit(X, y)
pred = model.predict(X)
acc = accuracy_score(y, pred)
print(f"Accuracy: {acc:.4f}")
resourcex_shard_metrics({"accuracy": float(acc), "samples": n, "n_classes": len(classes), "algorithm": "random_forest", "algorithmName": "Random Forest"})
`,
  gradient_boosting: `
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import accuracy_score
print("[Arena] Algorithm: Gradient Boosting", flush=True)
X, y, classes, n = _load_xy()
model = GradientBoostingClassifier(random_state=42)
model.fit(X, y)
pred = model.predict(X)
acc = accuracy_score(y, pred)
print(f"Accuracy: {acc:.4f}")
resourcex_shard_metrics({"accuracy": float(acc), "samples": n, "n_classes": len(classes), "algorithm": "gradient_boosting", "algorithmName": "Gradient Boosting"})
`,
  svc: `
from sklearn.svm import SVC
from sklearn.metrics import accuracy_score
print("[Arena] Algorithm: SVM (RBF)", flush=True)
X, y, classes, n = _load_xy()
model = SVC(kernel="rbf", gamma="scale")
model.fit(X, y)
pred = model.predict(X)
acc = accuracy_score(y, pred)
print(f"Accuracy: {acc:.4f}")
resourcex_shard_metrics({"accuracy": float(acc), "samples": n, "n_classes": len(classes), "algorithm": "svc", "algorithmName": "SVM (RBF)"})
`,
  knn: `
from sklearn.neighbors import KNeighborsClassifier
from sklearn.metrics import accuracy_score
print("[Arena] Algorithm: K-Nearest Neighbors", flush=True)
X, y, classes, n = _load_xy()
model = KNeighborsClassifier(n_neighbors=5)
model.fit(X, y)
pred = model.predict(X)
acc = accuracy_score(y, pred)
print(f"Accuracy: {acc:.4f}")
resourcex_shard_metrics({"accuracy": float(acc), "samples": n, "n_classes": len(classes), "algorithm": "knn", "algorithmName": "K-Nearest Neighbors"})
`,
  decision_tree: `
from sklearn.tree import DecisionTreeClassifier
from sklearn.metrics import accuracy_score
print("[Arena] Algorithm: Decision Tree", flush=True)
X, y, classes, n = _load_xy()
model = DecisionTreeClassifier(random_state=42)
model.fit(X, y)
pred = model.predict(X)
acc = accuracy_score(y, pred)
print(f"Accuracy: {acc:.4f}")
resourcex_shard_metrics({"accuracy": float(acc), "samples": n, "n_classes": len(classes), "algorithm": "decision_tree", "algorithmName": "Decision Tree"})
`,
};

const ARENA_CATALOG = [
  { id: "logistic_regression", name: "Logistic Regression", description: "Fast linear classifier" },
  { id: "random_forest", name: "Random Forest", description: "Ensemble of decision trees" },
  { id: "gradient_boosting", name: "Gradient Boosting", description: "Boosted trees (slower)" },
  { id: "svc", name: "SVM (RBF)", description: "Support vector machine" },
  { id: "knn", name: "K-Nearest Neighbors", description: "Instance-based" },
  { id: "decision_tree", name: "Decision Tree", description: "Single tree baseline" },
];

function listArenaAlgorithms() {
  return ARENA_CATALOG.map(({ id, name, description }) => ({ id, name, description }));
}

function getArenaAlgorithm(id) {
  return ARENA_CATALOG.find((a) => a.id === id) || null;
}

function buildArenaScript(algorithmId) {
  const snippet = MODEL_SNIPPETS[algorithmId];
  if (!snippet) throw new Error(`Unknown arena algorithm: ${algorithmId}`);
  return `print("[ResourceX] Algorithm Arena", flush=True)
import os
${SHARD_BOOTSTRAP}
${snippet}`;
}

function resolveArenaAlgorithms(requestedIds) {
  if (!Array.isArray(requestedIds) || !requestedIds.length) {
    return ARENA_CATALOG.map((a) => a.id);
  }
  const ids = requestedIds.filter((id) => MODEL_SNIPPETS[id]);
  if (!ids.length) throw new Error("No valid algorithm ids selected");
  return ids;
}

module.exports = {
  listArenaAlgorithms,
  getArenaAlgorithm,
  buildArenaScript,
  resolveArenaAlgorithms,
  ARENA_CATALOG,
};
