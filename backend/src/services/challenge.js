"use strict";

const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

const CHALLENGE_LIBRARY = [
  {
    type: "compute",
    name: "sha256_batch",
    image: "python:3.10-alpine",
    command:
      'python -c "import hashlib,json; data=[hashlib.sha256(str(i).encode()).hexdigest() for i in range(100)]; print(json.dumps(data))"',
    groundTruth: () => {
      const results = [];
      for (let i = 0; i < 100; i++) {
        results.push(
          crypto.createHash("sha256").update(String(i)).digest("hex"),
        );
      }
      return JSON.stringify(results);
    },
    verify: (output, groundTruth) => {
      try {
        const parsed = JSON.parse(output.trim());
        const expected = JSON.parse(groundTruth);
        return JSON.stringify(parsed) === JSON.stringify(expected);
      } catch {
        return false;
      }
    },
  },
  {
    type: "compute",
    name: "triangular_sum",
    image: "python:3.10-alpine",
    command: 'python -c "print(sum(range(1,1001)))"',
    groundTruth: () => String((1000 * 1001) / 2),
    verify: (output, groundTruth) => output.trim() === groundTruth,
  },
  {
    type: "sort",
    name: "sort_verify",
    image: "node:18-alpine",
    command:
      'node -e "const a=[5,3,1,9,2,8,4,7,6,0];console.log(JSON.stringify(a.sort((x,y)=>x-y)))"',
    groundTruth: () => "[0,1,2,3,4,5,6,7,8,9]",
    verify: (output, groundTruth) => output.trim() === groundTruth,
  },
  {
    type: "checksum",
    name: "md5_sequence",
    image: "python:3.10-alpine",
    command:
      'python -c "import hashlib; print(hashlib.md5(b\'resourcex_challenge_seed\').hexdigest())"',
    groundTruth: () =>
      crypto.createHash("md5").update("resourcex_challenge_seed").digest("hex"),
    verify: (output, groundTruth) => output.trim() === groundTruth,
  },
];

class ChallengeEngine {
  constructor() {
    /** @type {Map<string, object>} */
    this.pendingChallenges = new Map();
  }

  createChallenge(nodeId) {
    const template =
      CHALLENGE_LIBRARY[Math.floor(Math.random() * CHALLENGE_LIBRARY.length)];
    const taskId = uuidv4();
    const groundTruth = template.groundTruth();

    const challenge = {
      taskId,
      nodeId,
      type: "masked",
      name: template.name,
      image: template.image,
      command: template.command,
      isChallenge: true,
      createdAt: Date.now(),
      groundTruth,
      verify: template.verify,
    };

    this.pendingChallenges.set(taskId, challenge);
    return challenge;
  }

  evaluate(taskId, result, executionTime) {
    const challenge = this.pendingChallenges.get(taskId);
    if (!challenge) return null;

    this.pendingChallenges.delete(taskId);

    const output = typeof result === "string" ? result : JSON.stringify(result);
    const passed = challenge.verify(output, challenge.groundTruth);

    if (!passed) {
      console.warn(
        `[challenge] FAIL node=${challenge.nodeId.slice(0, 8)}… name=${challenge.name} ` +
          `output=${JSON.stringify(output.trim().slice(0, 120))}`,
      );
    } else {
      console.log(
        `[challenge] PASS node=${challenge.nodeId.slice(0, 8)}… name=${challenge.name}`,
      );
    }

    const latencyDeviation = executionTime
      ? Math.abs(executionTime - 2.0) / 2.0
      : 0;

    return {
      taskId,
      nodeId: challenge.nodeId,
      passed,
      latencyDeviation,
      executionTime,
      challengeName: challenge.name,
    };
  }

  isPendingChallenge(taskId) {
    return this.pendingChallenges.has(taskId);
  }

  /** Drop pending masked challenges targeted at a deregistering node. */
  cancelPendingForNode(nodeId) {
    for (const [taskId, ch] of this.pendingChallenges) {
      if (ch.nodeId === nodeId) {
        this.pendingChallenges.delete(taskId);
      }
    }
  }
}

module.exports = { ChallengeEngine };
