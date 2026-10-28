import { type Diagnostic, diag } from "../domain/diagnostics.js";

export interface FetchOutcome {
  status: number;
  body: unknown;
  text: string;
}

export interface FetchSpec {
  url: string;
  username: string;
  password: string;
  timeoutMs: number;
  method?: string;
}

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/**
 * Authenticated JSON fetch against the OpenCode server. Network-level failures
 * throw API001; a 401 response is returned with status 401 (callers map it to
 * API002) so readiness polling can distinguish "not up yet" from "bad auth".
 */
export async function fetchJson(
  spec: FetchSpec,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<FetchOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
  try {
    const response = await fetchImpl(spec.url, {
      method: spec.method ?? "GET",
      headers: { Authorization: basicAuthHeader(spec.username, spec.password) },
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body, text };
  } catch (e) {
    throw apiRequestFailed(spec.url, e as Error);
  } finally {
    clearTimeout(timer);
  }
}

export function apiRequestFailed(url: string, cause: Error): Diagnostic {
  return diag(
    "API",
    "001",
    `request to ${url} failed: ${cause.message}`,
    "is the OpenCode host still running?",
  );
}
