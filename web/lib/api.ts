import { parseSSEStream } from "./stream";
import type { ChatEvent, Message } from "./types";

export async function* sendMessage(
  messages: Message[],
  signal: AbortSignal
): AsyncGenerator<ChatEvent> {
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: messages
          .filter(
            ({ role, content, status }) =>
              content.trim() !== "" &&
              (role === "user" || status === "complete")
          )
          .map(({ role, content }) => ({ role, content })),
      }),
      signal,
    });

    if (!res.ok || !res.body) {
      yield {
        type: "error",
        message: `Request failed with HTTP ${res.status}.`,
      };
      return;
    }

    for await (const event of parseSSEStream(res.body)) {
      if (signal.aborted) return;
      yield event;
      if (event.type === "done" || event.type === "error") return;
    }

    if (!signal.aborted) {
      yield {
        type: "error",
        message: "The response stream ended unexpectedly.",
      };
    }
  } catch {
    if (signal.aborted) return;
    yield {
      type: "error",
      message: "Unable to continue the response stream.",
    };
  }
}
