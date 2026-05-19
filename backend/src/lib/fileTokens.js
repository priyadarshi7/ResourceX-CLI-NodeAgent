"use strict";

const crypto = require("crypto");

function getSecret() {
  return process.env.JWT_SECRET || "resourcex-dev-secret";
}

function signFileAccess(fileId, ttlSec = 86400) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${fileId}.${exp}`;
  const sig = crypto
    .createHmac("sha256", getSecret())
    .update(payload)
    .digest("hex");
  return { exp, token: `${exp}.${sig}` };
}

function verifyFileAccess(fileId, token) {
  if (!token || typeof token !== "string") return false;
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!exp || Date.now() / 1000 > exp) return false;
  const payload = `${fileId}.${exp}`;
  const expected = crypto
    .createHmac("sha256", getSecret())
    .update(payload)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

module.exports = { signFileAccess, verifyFileAccess };
