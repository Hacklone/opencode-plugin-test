import { afterEach, describe, expect, it, vi } from "vitest";
import { basicAuthHeader, fetchJson } from "../src/util/fetcher.js";

describe("basicAuthHeader", () => {
  it("encodes username:password", () => {
    expect(basicAuthHeader("opencode", "pw")).toBe(
      `Basic ${Buffer.from("opencode:pw").toString("base64")}`,
    );
  });
});

describe("fetchJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses JSON bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ a: 1 }), { status: 200 })),
    );
    const outcome = await fetchJson({
      url: "http://x",
      username: "u",
      password: "p",
      timeoutMs: 1000,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ a: 1 });
  });

  it("returns null body for non-JSON text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>hi</html>", { status: 200 })),
    );
    const outcome = await fetchJson({
      url: "http://x",
      username: "u",
      password: "p",
      timeoutMs: 1000,
    });
    expect(outcome.body).toBeNull();
  });

  it("returns null body for empty text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const outcome = await fetchJson({
      url: "http://x",
      username: "u",
      password: "p",
      timeoutMs: 1000,
    });
    expect(outcome.body).toBeNull();
    expect(outcome.status).toBe(204);
  });

  it("throws API001 on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(
      fetchJson({ url: "http://x", username: "u", password: "p", timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      code: "API001",
    });
  });

  it("aborts after timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    await expect(
      fetchJson({ url: "http://x", username: "u", password: "p", timeoutMs: 50 }),
    ).rejects.toMatchObject({
      code: "API001",
    });
  });

  it("uses the GET method by default and passes custom methods", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await fetchJson({
      url: "http://x",
      username: "u",
      password: "p",
      timeoutMs: 1000,
      method: "POST",
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });
});
