import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { sendMessage } from "@/lib/api";
import type { ChatEvent, Message } from "@/lib/types";
import { server } from "../mocks/server";

const userMessage: Message = {
  id: "1",
  role: "user",
  content: "What is ISR?",
};

const collect = async (gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> => {
  const out: ChatEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

describe("sendMessage", () => {
  it("yields all events from the /api/chat SSE stream", async () => {
    const ac = new AbortController();
    const events = await collect(sendMessage([userMessage], ac.signal));

    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({ type: "token", text: "Hello" });
    expect(events[1]).toEqual({ type: "token", text: " world" });
    expect(events[2]?.type).toBe("sources");
    expect(events[3]?.type).toBe("done");
  });

  it("sends only role and content to the transport boundary", async () => {
    let requestBody: unknown;
    server.use(
      http.post("/api/chat", async ({ request }) => {
        requestBody = await request.json();
        return new HttpResponse(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"done","usage":{"input_tokens":1,"output_tokens":0,"latency_ms":1}}\n\n'
                )
              );
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } }
        );
      })
    );

    await collect(
      sendMessage(
        [
          {
            ...userMessage,
            sources: [
              {
                title: "Docs",
                url: "https://nextjs.org/docs",
                heading: "Intro",
              },
            ],
          },
          {
            id: "completed-assistant",
            role: "assistant",
            content: "ISR is a rendering strategy.",
            status: "complete",
          },
          {
            id: "streaming-assistant",
            role: "assistant",
            content: "unfinished answer",
            status: "streaming",
          },
          {
            id: "stopped-assistant",
            role: "assistant",
            content: "partial answer",
            status: "stopped",
          },
          {
            id: "failed-assistant",
            role: "assistant",
            content: "Error: Unable to complete the response.",
            status: "error",
          },
          {
            id: "statusless-assistant",
            role: "assistant",
            content: "unknown delivery state",
          },
        ],
        new AbortController().signal
      )
    );

    expect(requestBody).toEqual({
      messages: [
        { role: "user", content: "What is ISR?" },
        { role: "assistant", content: "ISR is a rendering strategy." },
      ],
    });
  });

  it("stops yielding when signal is aborted", async () => {
    const ac = new AbortController();
    const gen = sendMessage([userMessage], ac.signal);

    const first = await gen.next();
    expect(first.value).toEqual({ type: "token", text: "Hello" });

    ac.abort();
    const second = await gen.next();
    expect(second.done).toBe(true);
  });

  it("emits a sanitized error when the stream ends without a terminal event", async () => {
    server.use(
      http.post("/api/chat", () =>
        new HttpResponse("data: {\"type\":\"token\",\"text\":\"partial\"}\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        })
      )
    );

    const events = await collect(
      sendMessage([userMessage], new AbortController().signal)
    );

    expect(events).toEqual([
      { type: "token", text: "partial" },
      { type: "error", message: "The response stream ended unexpectedly." },
    ]);
  });

  it("emits a sanitized error when the response body rejects with null", async () => {
    server.use(
      http.post(
        "/api/chat",
        () =>
          new HttpResponse(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(null);
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } }
          )
      )
    );

    const events = await collect(
      sendMessage([userMessage], new AbortController().signal)
    );

    expect(events).toEqual([
      { type: "error", message: "Unable to continue the response stream." },
    ]);
  });

  it("does not treat an external AbortError as a user cancellation", async () => {
    server.use(
      http.post(
        "/api/chat",
        () =>
          new HttpResponse(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error({ name: "AbortError" });
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } }
          )
      )
    );

    const ac = new AbortController();
    const events = await collect(sendMessage([userMessage], ac.signal));

    expect(ac.signal.aborted).toBe(false);
    expect(events).toEqual([
      { type: "error", message: "Unable to continue the response stream." },
    ]);
  });

  it("ignores events after the first terminal event", async () => {
    server.use(
      http.post("/api/chat", () =>
        new HttpResponse(
          [
            'data: {"type":"done","usage":{"input_tokens":1,"output_tokens":1,"latency_ms":1}}',
            "",
            'data: {"type":"token","text":"late"}',
            "",
          ].join("\n"),
          { headers: { "Content-Type": "text/event-stream" } }
        )
      )
    );

    const events = await collect(
      sendMessage([userMessage], new AbortController().signal)
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("done");
  });
});
