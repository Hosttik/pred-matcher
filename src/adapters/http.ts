import { APP_VERSION } from "../core/version.js";

const USER_AGENT = `pred-matcher/${APP_VERSION}`;

async function requestJson<T>(url: URL, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        ...(init.headers ?? {})
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.origin}${url.pathname}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchJson<T>(url: URL, timeoutMs = 15_000): Promise<T> {
  return requestJson<T>(url, { method: "GET" }, timeoutMs);
}

export async function postJson<T>(url: URL, body: unknown, timeoutMs = 15_000): Promise<T> {
  return requestJson<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }, timeoutMs);
}
