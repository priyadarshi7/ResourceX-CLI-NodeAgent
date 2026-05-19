"use strict";

const { MongoClient } = require("mongodb");

let client;
let db;

function getMongoUri() {
  return (
    process.env.MONGODB_URI ||
    process.env.MONGO_URL ||
    "mongodb://127.0.0.1:27017/resourcex"
  );
}

function getDbName() {
  if (process.env.MONGODB_DB) return process.env.MONGODB_DB;
  try {
    const path = new URL(getMongoUri()).pathname.replace(/^\//, "");
    return path || "resourcex";
  } catch {
    return "resourcex";
  }
}

function isAtlasUri(uri) {
  return uri.includes("mongodb.net") || uri.startsWith("mongodb+srv:");
}

async function connectDb() {
  if (db) return db;

  const uri = getMongoUri();
  const dbName = getDbName();
  const options = isAtlasUri(uri) ? { serverSelectionTimeoutMS: 15000 } : {};

  client = new MongoClient(uri, options);
  await client.connect();
  db = client.db(dbName);

  await db.command({ ping: 1 });
  await db.collection("users").createIndex({ email: 1 }, { unique: true });
  await db.collection("nodes").createIndex({ nodeId: 1 }, { unique: true });
  await db.collection("studio_datasets").createIndex({ datasetId: 1 }, { unique: true });
  await db.collection("studio_notebooks").createIndex({ notebookId: 1, email: 1 }, { unique: true });

  return db;
}

function getDb() {
  if (!db) throw new Error("Database not connected; call connectDb() first");
  return db;
}

async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

module.exports = { connectDb, getDb, closeDb, getMongoUri, getDbName };
