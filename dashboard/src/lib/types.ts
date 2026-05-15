export type TrustTier = "COLD_START" | "WARM" | "TRUSTED" | "ELITE" | string;

export type NodeRow = {
  nodeId: string;
  email?: string;
  trustTier: TrustTier;
  challengeScore: number;
  connected: boolean;
  status: string;
  cpu?: number;
  memory?: string;
  activeTasks?: number;
  lastSeen?: number;
};

export type AdminStats = {
  nodes: {
    total: number;
    connected: number;
    tiers: Record<string, number>;
    avgScore: number;
  };
  jobs: { total: number; active: number };
  challengesPending: number;
};

export type JobTask = {
  taskId: string;
  shardIndex: number;
  status: string;
  nodeId?: string | null;
  progress?: number;
  result?: unknown;
  error?: string;
};

export type JobStatus = {
  jobId: string;
  status: string;
  type: string;
  parallelism: number;
  completedTasks: number;
  confidenceScore?: number | null;
  validated?: string;
  error?: string | null;
  result?: unknown;
  tasks: JobTask[];
};

export type JobUpdateMsg =
  | {
      type: "JOB_UPDATE";
      jobId: string;
      status?: string;
      progress?: number;
      logs?: string;
      result?: unknown;
      confidenceScore?: number;
      validated?: string;
      error?: string;
      activeNodes?: number;
      message?: string;
    }
  | { type: "SUBSCRIBED"; jobId: string }
  | { type: string; [k: string]: unknown };

