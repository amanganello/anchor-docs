import { NextRequest } from "next/server";

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

const stubStream = (): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const event of STUB_EVENTS) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
        await new Promise((r) => setTimeout(r, 30));
      }
      controller.close();
    },
  });
};

export async function POST(req: NextRequest) {
  const fastapiUrl = process.env.FASTAPI_URL;

  if (!fastapiUrl) {
    return new Response(stubStream(), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  const upstream = await fetch(`${fastapiUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: req.body,
    // @ts-expect-error — Node 18+ fetch supports duplex
    duplex: "half",
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(
      `data: ${JSON.stringify({ type: "error", message: "Upstream error" })}\n\n`,
      {
        status: upstream.status,
        headers: { "Content-Type": "text/event-stream" },
      }
    );
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
