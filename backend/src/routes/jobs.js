"use strict";

const express = require("express");
const { body, validationResult } = require("express-validator");
const { requireUserAuth } = require("../middleware/auth");

function createJobsRouter(rt) {
  const r = express.Router();
  const auth = requireUserAuth(rt);

  r.post(
    "/",
    auth,
    body("image").isString().isLength({ min: 1 }),
    body("command").isString().isLength({ min: 1 }),
    body("jobId").optional().isString(),
    body("type").optional().isString(),
    body("parallelism").optional().isInt({ min: 1, max: 64 }),
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }
      const job = rt.jobRegistry.createJob({
        ...req.body,
        submittedBy: req.user.email,
      });

      await rt.queue.add(
        "dispatchJob",
        { jobId: job.jobId },
        { jobId: job.jobId, removeOnComplete: true, removeOnFail: false },
      );

      // Try immediately so a connected node gets work even if the worker is slow;
      // BullMQ worker may call again — dispatch only tasks still in `queued` state.
      rt.scheduler.dispatchJobTasks(rt.jobRegistry.getJob(job.jobId) || job);

      const host = req.get("host") || `localhost:${process.env.PORT || 4000}`;
      const proto = req.secure ? "wss" : "ws";
      res.status(202).json({
        jobId: job.jobId,
        status: job.status,
        parallelism: job.parallelism,
        ws: `${proto}://${host}/ws/jobs?token=<user_jwt>`,
        hint: "Connect with a user JWT, then send { type: 'SUBSCRIBE_JOB', jobId }",
      });
    },
  );

  r.get("/:jobId", auth, (req, res) => {
    const job = rt.jobRegistry.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    const tasks = rt.jobRegistry.listJobTasks(job.jobId);

    let result = null;
    if (job.status === "completed" && job.results && job.results.length > 0) {
      const parts = [...job.results].sort((a, b) => a.shardIndex - b.shardIndex);
      result =
        parts.length === 1
          ? parts[0].result
          : parts.map((p) => p.result);
    }

    res.json({
      jobId: job.jobId,
      status: job.status,
      type: job.type,
      parallelism: job.parallelism,
      completedTasks: job.completedTasks,
      confidenceScore: job.confidenceScore,
      validated: job.status === "completed" ? "ACRS" : undefined,
      error: job.error,
      result,
      tasks: tasks.map((t) => ({
        taskId: t.taskId,
        shardIndex: t.shardIndex,
        status: t.status,
        nodeId: t.nodeId,
        progress: t.progress,
        result: t.status === "completed" ? t.result : undefined,
        error: t.status === "failed" ? t.error : undefined,
      })),
    });
  });

  return r;
}

module.exports = { createJobsRouter };
