import { useEffect, useMemo, useState } from "react";
import { jsonRequest } from "../lib/http";

const KEY = "resourcex.userToken";

export function getStoredToken() {
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
}

export function setStoredToken(token: string) {
  try {
    if (!token) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, token);
  } catch {
    // ignore
  }
}

export function useAuth() {
  const [token, setToken] = useState<string>(() => getStoredToken());
  const authed = !!token;

  useEffect(() => {
    setStoredToken(token);
  }, [token]);

  const api = useMemo(() => {
    return {
      async register(email: string, password: string) {
        const res = await jsonRequest<{ token: string; email: string }>(
          "/api/auth/register",
          { body: { email, password } },
        );
        setToken(res.token);
        return res;
      },
      async login(email: string, password: string) {
        const res = await jsonRequest<{ token: string; email: string }>(
          "/api/auth/login",
          { body: { email, password } },
        );
        setToken(res.token);
        return res;
      },
      logout() {
        setToken("");
      },
    };
  }, []);

  return { token, authed, ...api };
}

