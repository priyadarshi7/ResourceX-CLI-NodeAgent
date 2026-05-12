"use strict";

const express = require("express");
const { body, validationResult } = require("express-validator");
const { ensureUser, getUser, verifyPassword } = require("../lib/users");
const { signUserToken } = require("../lib/jwt");

function createAuthRouter() {
  const r = express.Router();

  r.post(
    "/login",
    body("email").isEmail(),
    body("password").isString().isLength({ min: 1 }),
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }
      const { email, password } = req.body;
      const ok = await verifyPassword(email, password);
      if (!ok) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }
      const token = await signUserToken({ email });
      res.json({ token, email });
    },
  );

  r.post(
    "/register",
    body("email").isEmail(),
    body("password").isString().isLength({ min: 6 }),
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }
      const { email, password } = req.body;
      if (await getUser(email)) {
        res.status(409).json({ error: "User already exists" });
        return;
      }
      await ensureUser(email, password);
      const token = await signUserToken({ email });
      res.json({ token, email });
    },
  );

  return r;
}

module.exports = { createAuthRouter };
