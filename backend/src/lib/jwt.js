"use strict";

const { SignJWT, jwtVerify } = require("jose");

const JWT_ISSUER = "resourcex";
const JWT_AUDIENCE = "resourcex-api";

function getSecret() {
  const raw = process.env.JWT_SECRET || "dev-only-change-in-production";
  return new TextEncoder().encode(raw);
}

async function signNodeToken({ email, nodeId }) {
  return new SignJWT({ typ: "node", nodeId, email, sub: email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime("30d")
    .sign(getSecret());
}

async function signUserToken({ email }) {
  return new SignJWT({ typ: "user", email, sub: email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime("7d")
    .sign(getSecret());
}

async function verifyToken(token) {
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
  return payload;
}

module.exports = { signNodeToken, signUserToken, verifyToken };
