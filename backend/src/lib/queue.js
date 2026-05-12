"use strict";

const { Queue } = require("bullmq");

/**
 * BullMQ uses ioredis. Upstash and other providers often require TLS (`rediss://`).
 * `maxRetriesPerRequest: null` is required by BullMQ for blocking commands.
 */
function getRedisConnection() {
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const u = new URL(url);
      const useTls = u.protocol === "rediss:";
      const conn = {
        host: u.hostname,
        port: Number(u.port || 6379),
        password: u.password ? decodeURIComponent(u.password) : undefined,
        username: u.username ? decodeURIComponent(u.username) : undefined,
        maxRetriesPerRequest: null,
      };
      if (useTls) {
        conn.tls = {};
      }
      return conn;
    } catch {
      return {
        url,
        maxRetriesPerRequest: null,
      };
    }
  }
  const conn = {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  };
  if (process.env.REDIS_TLS === "1" || process.env.REDIS_TLS === "true") {
    conn.tls = {};
  }
  return conn;
}

function createJobQueue() {
  const connection = getRedisConnection();
  const queue = new Queue("resourcex-jobs", { connection });
  return { queue, connection };
}

module.exports = { createJobQueue, getRedisConnection };
