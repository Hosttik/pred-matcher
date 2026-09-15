export async function fetchJson<T>(url: URL, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "pred-matcher/0.1.0" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.origin}${url.pathname}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}
