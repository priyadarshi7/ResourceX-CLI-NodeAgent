"use strict";

const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { getDb } = require("./db");

const UPLOAD_ROOT =
  process.env.STUDIO_UPLOAD_DIR ||
  path.resolve(process.cwd(), "data", "studio-uploads");

function datasetsCol() {
  return getDb().collection("studio_datasets");
}

function notebooksCol() {
  return getDb().collection("studio_notebooks");
}

function ensureUploadRoot() {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

async function saveDataset({ email, name, files }) {
  ensureUploadRoot();
  const datasetId = uuidv4();
  const dir = path.join(UPLOAD_ROOT, email.replace(/[^a-zA-Z0-9@._-]/g, "_"), datasetId);
  fs.mkdirSync(dir, { recursive: true });

  const stored = [];
  for (const f of files) {
    const fileId = uuidv4();
    const safeName = path.basename(f.originalname || "data.csv");
    const dest = path.join(dir, safeName);
    fs.writeFileSync(dest, f.buffer);
    stored.push({
      fileId,
      name: safeName,
      size: f.size,
      path: dest,
    });
  }

  const doc = {
    datasetId,
    email,
    name: name || stored[0]?.name || "dataset",
    files: stored.map(({ fileId, name, size }) => ({ fileId, name, size })),
    createdAt: Date.now(),
  };
  await datasetsCol().insertOne(doc);
  return { ...doc, paths: stored };
}

async function listDatasets(email) {
  return datasetsCol()
    .find({ email }, { projection: { _id: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
}

async function getDataset(datasetId, email) {
  const q = { datasetId };
  if (email) q.email = email;
  return datasetsCol().findOne(q, { projection: { _id: 0 } });
}

async function resolveFilePath(fileId) {
  const all = await datasetsCol().find({ "files.fileId": fileId }).toArray();
  for (const ds of all) {
    const meta = ds.files.find((f) => f.fileId === fileId);
    if (!meta) continue;
    const dir = path.join(
      UPLOAD_ROOT,
      ds.email.replace(/[^a-zA-Z0-9@._-]/g, "_"),
      ds.datasetId,
    );
    const p = path.join(dir, meta.name);
    if (fs.existsSync(p)) return { path: p, name: meta.name, dataset: ds };
  }
  return null;
}

async function saveNotebook({ email, notebookId, title, cells }) {
  const id = notebookId || uuidv4();
  await notebooksCol().updateOne(
    { notebookId: id, email },
    {
      $set: {
        notebookId: id,
        email,
        title: title || "Untitled notebook",
        cells,
        updatedAt: Date.now(),
      },
      $setOnInsert: { createdAt: Date.now() },
    },
    { upsert: true },
  );
  return notebooksCol().findOne({ notebookId: id, email }, { projection: { _id: 0 } });
}

async function getNotebook(notebookId, email) {
  return notebooksCol().findOne({ notebookId, email }, { projection: { _id: 0 } });
}

async function listNotebooks(email) {
  return notebooksCol()
    .find({ email }, { projection: { _id: 0 } })
    .sort({ updatedAt: -1 })
    .toArray();
}

module.exports = {
  UPLOAD_ROOT,
  saveDataset,
  listDatasets,
  getDataset,
  resolveFilePath,
  saveNotebook,
  getNotebook,
  listNotebooks,
};
