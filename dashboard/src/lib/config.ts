export const BACKEND_URL =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ||
  "http://localhost:4000";

export function wsUrl(path: string, token: string) {
  const http = new URL(BACKEND_URL);
  const proto = http.protocol === "https:" ? "wss:" : "ws:";
  const ws = new URL(path, `${proto}//${http.host}`);
  ws.searchParams.set("token", token);
  return ws.toString();
}

