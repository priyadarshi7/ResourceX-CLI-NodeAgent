"use strict";

const bcrypt = require("bcryptjs");

/** @type {Map<string, { email: string, passwordHash: string, createdAt: number }>} */
const users = new Map();

async function ensureUser(email, password) {
  const existing = users.get(email);
  if (existing) return existing;
  const passwordHash = await bcrypt.hash(password, 10);
  const row = { email, passwordHash, createdAt: Date.now() };
  users.set(email, row);
  return row;
}

async function getUser(email) {
  return users.get(email) || null;
}

async function verifyPassword(email, password) {
  const row = users.get(email);
  if (!row) return false;
  return bcrypt.compare(password, row.passwordHash);
}

module.exports = { ensureUser, getUser, verifyPassword };
