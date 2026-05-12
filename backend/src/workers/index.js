"use strict";

const { Worker } = require("bullmq");

/**
 * @param {object} rt
 */
async function initWorkers(rt) {
  const worker = new Worker(
    "resourcex-jobs",
    async (job) => {
      if (job.name === "dispatchJob") {
        const regJob = rt.jobRegistry.getJob(job.data.jobId);
        if (regJob) rt.scheduler.dispatchJobTasks(regJob);
      }
    },
    { connection: rt.connection },
  );

  worker.on("failed", (j, err) => {
    console.error("[worker] job failed", j?.id, err?.message);
  });

  return worker;
}

module.exports = { initWorkers };
