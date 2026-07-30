import { http, HttpResponse } from "msw";
import type { ChatEvent } from "@/lib/types";

const sseBody = (events: ChatEvent[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
      }
      controller.close();
    },
  });
};

export const defaultChatEvents: ChatEvent[] = [
  { type: "token", text: "Hello" },
  { type: "token", text: " world" },
  {
    type: "sources",
    items: [{ title: "Intro", url: "https://nextjs.org/docs", heading: "Intro" }],
  },
  { type: "done", usage: { input_tokens: 5, output_tokens: 2, latency_ms: 50 } },
];

export const handlers = [
  http.post("/api/chat", () => {
    return new HttpResponse(sseBody(defaultChatEvents), {
      headers: { "Content-Type": "text/event-stream" },
    });
  }),
];
