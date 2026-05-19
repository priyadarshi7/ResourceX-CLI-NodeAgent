"use strict";

const express = require("express");
const { body, validationResult } = require("express-validator");
const { requireUserAuth } = require("../middleware/auth");
const { isMlTrainingJob, normalizeMlTrainingJob } = require("../lib/mlJobs");
const { aggregateMlResults, aggregateArenaResults } = require("../lib/mlAggregate");
const { loadPersistedJob } = require("../lib/jobPersistence");

function createJobsRouter(rt) {
  const r = express.Router();
  const auth = requireUserAuth(rt);

  const skipForMl = (_value, { req }) => !isMlTrainingJob(req.body);

  r.post(
    "/",
    auth,
    body("jobId").optional().isString(),
    body("type").optional().isString(),
    body("parallelism").optional().isInt({ min: 1, max: 64 }),
    body("image").if(skipForMl).isString().isLength({ min: 1 }),
    body("command").if(skipForMl).isString().isLength({ min: 1 }),
    body("dataset").if((v, { req }) => isMlTrainingJob(req.body)).isObject(),
    body("training").if((v, { req }) => isMlTrainingJob(req.body)).isObject(),
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      let spec;
      try {
        if (isMlTrainingJob(req.body)) {
          spec = normalizeMlTrainingJob({
            ...req.body,
            submittedBy: req.user.email,
          });
        } else {
          if (!req.body.image || !req.body.command) {
            res.status(400).json({
              error:
                'Generic jobs need "image" and "command". ML jobs need type "ml_training" with "dataset" and "training" blocks.',
            });
            return;
          }
          spec = { ...req.body, submittedBy: req.user.email };
        }
      } catch (e) {
        res.status(400).json({ error: e.message });
        return;
      }

      const job = rt.jobRegistry.createJob(spec);

      await rt.queue.add(
        "dispatchJob",
        { jobId: job.jobId },
        { jobId: job.jobId, removeOnComplete: true, removeOnFail: false },
      );

      rt.scheduler.dispatchJobTasks(rt.jobRegistry.getJob(job.jobId) || job);

      const host = req.get("host") || `localhost:${process.env.PORT || 4000}`;
      const proto = req.secure ? "wss" : "ws";
      res.status(202).json({
        jobId: job.jobId,
        status: job.status,
        type: job.type,
        parallelism: job.parallelism,
        ml: job.ml || false,
        ws: `${proto}://${host}/ws/jobs?token=<user_jwt>`,
        hint: "Connect with a user JWT, then send { type: 'SUBSCRIBE_JOB', jobId }",
      });
    },
  );

  r.get("/:jobId", auth, async (req, res) => {
    const jobId = req.params.jobId;
    let job = rt.jobRegistry.getJob(jobId);
    let tasks = job ? rt.jobRegistry.listJobTasks(jobId) : [];

    if (!job) {
      const persisted = await loadPersistedJob(jobId);
      if (!persisted) {
        res.status(404).json({
          error:
            "Job not found. It may have expired if the backend restarted before results were saved.",
        });
        return;
      }
      if (
        persisted.submittedBy &&
        persisted.submittedBy !== req.user.email
      ) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      job = persisted;
      tasks = persisted.tasks || [];
    } else if (job.submittedBy && job.submittedBy !== req.user.email) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    let result = null;
    const results = job.results || [];
    if (job.status === "completed" && results.length > 0) {
      const parts = [...results].sort((a, b) => a.shardIndex - b.shardIndex);
      if (job.arena?.enabled) {
        result = aggregateArenaResults(parts);
      } else {
        result = job.ml ? aggregateMlResults(parts) : parts[0].result;
      }
    }

    res.json({
      jobId: job.jobId,
      status: job.status,
      type: job.type,
      parallelism: job.parallelism,
      ml: job.ml || false,
      arena: job.arena || undefined,
      dataset: job.dataset || undefined,
      training: job.training || undefined,
      completedTasks: job.completedTasks,
      confidenceScore: job.confidenceScore,
      validated: job.status === "completed" ? "ACRS" : undefined,
      error: job.error,
      result,
      tasks: tasks.map((t) => ({
        taskId: t.taskId,
        shardIndex: t.shardIndex,
        algorithmId: t.algorithmId,
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
