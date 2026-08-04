import { NextRequest } from "next/server";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

interface ChatPayload {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseChatPayload(value: unknown): ChatPayload | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "messages")) {
    return null;
  }

  if (!Array.isArray(value.messages) || value.messages.length === 0) return null;

  const messages: ChatPayload["messages"] = [];
  for (const message of value.messages) {
    if (
      !isRecord(message) ||
      Object.keys(message).some((key) => key !== "role" && key !== "content") ||
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.content !== "string" ||
      message.content.trim() === "" ||
      message.content.length > 8_000
    ) {
      return null;
    }
    messages.push({ role: message.role, content: message.content });
  }

  if (messages.length > 50) return null;
  return { messages };
}

function errorResponse(message: string, status: number): Response {
  return new Response(
    `data: ${JSON.stringify({ type: "error", message })}\n\n`,
    { status, headers: SSE_HEADERS }
  );
}

function normalizeUpstreamErrorStatus(status: number): number {
  return status >= 400 && status <= 599 ? status : 502;
}

function cancelDiscardedBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body) return;
  void body.cancel().catch(() => {});
}

const STUB_EVENTS = [
  { type: "token", text: "This " },
  { type: "token", text: "is " },
  { type: "token", text: "a " },
  { type: "token", text: "stub " },
  { type: "token", text: "response." },
  {
    type: "sources",
    items: [
      {
        title: "Getting Started",
        url: "https://nextjs.org/docs",
        heading: "Introduction",
      },
    ],
  },
  {
    type: "done",
    usage: { input_tokens: 12, output_tokens: 5, latency_ms: 80 },
  },
] as const;

const stubStream = (signal: AbortSignal): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let stopped = signal.aborted;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;

  const stop = () => {
    stopped = true;
    try {
      streamController?.close();
    } catch {
      // The consumer may already have cancelled or closed the stream.
    }
  };

  return new ReadableStream({
    async start(controller) {
      streamController = controller;
      signal.addEventListener("abort", stop, { once: true });

      try {
        if (stopped) {
          stop();
          return;
        }

        for (const event of STUB_EVENTS) {
          if (stopped) return;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
          await new Promise((resolve) => setTimeout(resolve, 30));
        }

        if (!stopped) controller.close();
      } finally {
        signal.removeEventListener("abort", stop);
        streamController = null;
      }
    },
    cancel() {
      stopped = true;
    },
  });
};

export async function POST(req: NextRequest) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const chatPayload = parseChatPayload(payload);
  if (!chatPayload) {
    return errorResponse("Invalid chat request", 400);
  }

  const fastapiUrl = process.env.FASTAPI_URL;
  if (!fastapiUrl) {
    return new Response(stubStream(req.signal), { headers: SSE_HEADERS });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${fastapiUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatPayload),
      signal: req.signal,
    });
  } catch {
    return errorResponse("Upstream request failed", 502);
  }

  if (!upstream.ok || !upstream.body) {
    if (!upstream.ok) cancelDiscardedBody(upstream.body);
    return errorResponse(
      "Upstream error",
      normalizeUpstreamErrorStatus(upstream.status)
    );
  }

  return new Response(upstream.body, {
    headers: SSE_HEADERS,
  });
}
