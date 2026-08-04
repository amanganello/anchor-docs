import { describe, it, expect } from "vitest";
import { parseSSEStream } from "@/lib/stream";
import type { ChatEvent } from "@/lib/types";

function makeStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + "\n"));
      }
      controller.close();
    },
  });
}

function makeChunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(
  stream: ReadableStream<Uint8Array>
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of parseSSEStream(stream)) {
    events.push(event);
  }
  return events;
}

describe("parseSSEStream", () => {
  it("parses a single token event", async () => {
    const stream = makeStream([
      'data: {"type":"token","text":"Hello"}',
      "",
    ]);
    const events = await collect(stream);
    expect(events).toEqual([{ type: "token", text: "Hello" }]);
  });

  it("parses multiple token events", async () => {
    const stream = makeStream([
      'data: {"type":"token","text":"Hello"}',
      "",
      'data: {"type":"token","text":" world"}',
      "",
    ]);
    const events = await collect(stream);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "token", text: "Hello" });
    expect(events[1]).toEqual({ type: "token", text: " world" });
  });

  it("parses a sources event", async () => {
    const stream = makeStream([
      'data: {"type":"sources","items":[{"title":"Caching","url":"https://nextjs.org/docs/caching","heading":"Overview"}]}',
      "",
    ]);
    const events = await collect(stream);
    expect(events).toEqual([
      {
        type: "sources",
        items: [
          {
            title: "Caching",
            url: "https://nextjs.org/docs/caching",
            heading: "Overview",
          },
        ],
      },
    ]);
  });

  it("parses a done event", async () => {
    const stream = makeStream([
      'data: {"type":"done","usage":{"input_tokens":10,"output_tokens":5,"latency_ms":120}}',
      "",
    ]);
    const events = await collect(stream);
    expect(events).toEqual([
      {
        type: "done",
        usage: { input_tokens: 10, output_tokens: 5, latency_ms: 120 },
      },
    ]);
  });

  it("parses an error event", async () => {
    const stream = makeStream([
      'data: {"type":"error","message":"Upstream failure"}',
      "",
    ]);
    const events = await collect(stream);
    expect(events).toEqual([
      { type: "error", message: "Upstream failure" },
    ]);
  });

  it("skips comment lines and blank lines", async () => {
    const stream = makeStream([
      ": keep-alive",
      "",
      'data: {"type":"token","text":"Hi"}',
      "",
    ]);
    const events = await collect(stream);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "token", text: "Hi" });
  });

  it("skips lines with malformed JSON without throwing", async () => {
    const stream = makeStream([
      "data: not-valid-json",
      "",
      'data: {"type":"token","text":"Ok"}',
      "",
    ]);
    const events = await collect(stream);
    expect(events).toEqual([{ type: "token", text: "Ok" }]);
  });

  it("skips well-formed JSON with an invalid event shape", async () => {
    const stream = makeStream([
      'data: {"type":"token"}',
      "",
      'data: {"type":"sources","items":"invalid"}',
      "",
      'data: {"type":"unknown"}',
      "",
      'data: {"type":"token","text":"Ok"}',
      "",
    ]);

    expect(await collect(stream)).toEqual([{ type: "token", text: "Ok" }]);
  });

  it("parses an event split across network chunks", async () => {
    const stream = makeChunkedStream([
      'data: {"type":"token",',
      '"text":"split"}\n\n',
    ]);

    expect(await collect(stream)).toEqual([{ type: "token", text: "split" }]);
  });

  it("parses multiple events delivered in one network chunk", async () => {
    const stream = makeChunkedStream([
      'data: {"type":"token","text":"one"}\n\ndata: {"type":"token","text":"two"}\n\n',
    ]);

    expect(await collect(stream)).toEqual([
      { type: "token", text: "one" },
      { type: "token", text: "two" },
    ]);
  });

  it("parses a valid final line without a newline terminator", async () => {
    const stream = makeChunkedStream([
      'data: {"type":"token","text":"final"}',
    ]);

    expect(await collect(stream)).toEqual([{ type: "token", text: "final" }]);
  });

  it("cancels the response body when the consumer stops early", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"type":"token","text":"first"}\n\n')
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const events = parseSSEStream(stream);

    expect((await events.next()).value).toEqual({ type: "token", text: "first" });
    await events.return(undefined);

    expect(cancelled).toBe(true);
  });
});
