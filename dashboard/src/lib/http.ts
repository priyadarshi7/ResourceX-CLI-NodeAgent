import { BACKEND_URL } from "./config";

export class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function jsonRequest<T>(
  path: string,
  opts: {
    method?: string;
    token?: string;
    body?: unknown;
  } = {},
): Promise<T> {
  const res = await fetch(`${BACKEND_URL.replace(/\/$/, "")}${path}`, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  const data = text ? (safeJsonParse(text) as unknown) : null;
  if (!res.ok) throw new HttpError(res.status, data);
  return data as T;
}

function safeJsonParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

