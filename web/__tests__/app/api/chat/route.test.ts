import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/chat/route";

const validBody = {
  messages: [{ role: "user", content: "What is ISR?" }],
};

function request(body: string, signal?: AbortSignal): NextRequest {
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal,
  });
}

describe("POST /api/chat", () => {
  afterEach(() => {
    delete process.env.FASTAPI_URL;
    vi.unstubAllGlobals();
  });

  it("rejects invalid JSON even when using the local stub", async () => {
    const response = await POST(request("{"));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid JSON body");
  });

  it("rejects UI-only fields at the proxy boundary", async () => {
    const response = await POST(
      request(
        JSON.stringify({
          messages: [{ ...validBody.messages[0], id: "ui-id" }],
        })
      )
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid chat request");
  });

  it("forwards the normalized payload and incoming abort signal", async () => {
    process.env.FASTAPI_URL = "https://backend.example";
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"done","usage":{"input_tokens":1,"output_tokens":1,"latency_ms":1}}\n\n'
          )
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(upstreamBody, {
        headers: { "Content-Type": "text/event-stream" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const req = request(JSON.stringify(validBody), controller.signal);

    const response = await POST(req);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://backend.example/chat",
      expect.objectContaining({
        body: JSON.stringify(validBody),
        signal: req.signal,
      })
    );
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("returns a sanitized error when the upstream rejects", async () => {
    process.env.FASTAPI_URL = "https://backend.example";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret detail")));

    const response = await POST(request(JSON.stringify(validBody)));
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).toContain("Upstream request failed");
    expect(body).not.toContain("secret detail");
  });

  it("preserves an upstream error status with a sanitized body", async () => {
    process.env.FASTAPI_URL = "https://backend.example";
    let bodyCancelled = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("provider secret"));
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(upstreamBody, { status: 503 }))
    );

    const response = await POST(request(JSON.stringify(validBody)));
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("Upstream error");
    expect(body).not.toContain("provider secret");
    expect(bodyCancelled).toBe(true);
  });

  it("maps an upstream 304 response to a valid 502 error response", async () => {
    process.env.FASTAPI_URL = "https://backend.example";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 304 }))
    );

    const response = await POST(request(JSON.stringify(validBody)));

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Upstream error");
  });

  it("maps a successful upstream response without a body to 502", async () => {
    process.env.FASTAPI_URL = "https://backend.example";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    );

    const response = await POST(request(JSON.stringify(validBody)));

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Upstream error");
  });

  it("stops the local stub when the incoming request is aborted", async () => {
    const controller = new AbortController();
    const response = await POST(
      request(JSON.stringify(validBody), controller.signal)
    );
    const reader = response.body!.getReader();

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"type":"token"');

    controller.abort();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it("forwards the upstream response incrementally", async () => {
    process.env.FASTAPI_URL = "https://backend.example";
    let releaseTerminal!: () => void;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"token","text":"first"}\n\n'
          )
        );
        new Promise<void>((resolve) => {
          releaseTerminal = resolve;
        }).then(() => {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"done","usage":{"input_tokens":1,"output_tokens":1,"latency_ms":1}}\n\n'
            )
          );
          controller.close();
        });
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(upstreamBody)));

    const response = await POST(request(JSON.stringify(validBody)));
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const first = await reader!.read();
    expect(new TextDecoder().decode(first.value)).toContain('"text":"first"');

    releaseTerminal();
    const terminal = await reader!.read();
    expect(new TextDecoder().decode(terminal.value)).toContain('"type":"done"');
    reader!.releaseLock();
  });
});
