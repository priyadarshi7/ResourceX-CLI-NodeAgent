"use strict";

const bcrypt = require("bcryptjs");
const { getDb } = require("./db");

function usersCol() {
  return getDb().collection("users");
}

async function ensureUser(email, password) {
  const existing = await getUser(email);
  if (existing) return existing;
  const passwordHash = await bcrypt.hash(password, 10);
  const createdAt = Date.now();
  await usersCol().insertOne({ email, passwordHash, createdAt });
  return { email, passwordHash, createdAt };
}

async function getUser(email) {
  const doc = await usersCol().findOne(
    { email },
    { projection: { _id: 0, email: 1, passwordHash: 1, createdAt: 1 } },
  );
  return doc || null;
}

async function verifyPassword(email, password) {
  const row = await getUser(email);
  if (!row) return false;
  return bcrypt.compare(password, row.passwordHash);
}

module.exports = { ensureUser, getUser, verifyPassword };
