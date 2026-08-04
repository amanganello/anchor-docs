import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { ChatInterface } from "@/components/ChatInterface";
import type { ChatEvent } from "@/lib/types";

function sseResponse(events: ChatEvent[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(e)}\n\n`)
        );
      }
      controller.close();
    },
  });
  return new HttpResponse(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("ChatInterface", () => {
  it("renders the input and an empty message list on mount", () => {
    render(<ChatInterface />);
    expect(
      screen.getByRole("textbox", { name: "Message input" })
    ).toBeInTheDocument();
    expect(screen.getByTestId("message-list")).toBeInTheDocument();
  });

  it("shows user message immediately after submit", async () => {
    const user = userEvent.setup();
    render(<ChatInterface />);

    await user.type(
      screen.getByRole("textbox", { name: "Message input" }),
      "What is ISR?"
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByTestId("bubble-user")).toHaveTextContent("What is ISR?");
  });

  it("streams tokens into the assistant bubble", async () => {
    server.use(
      http.post("/api/chat", () =>
        sseResponse([
          { type: "token", text: "ISR " },
          { type: "token", text: "stands for Incremental Static Regeneration." },
          { type: "done", usage: { input_tokens: 5, output_tokens: 8, latency_ms: 90 } },
        ])
      )
    );

    const user = userEvent.setup();
    render(<ChatInterface />);

    await user.type(
      screen.getByRole("textbox", { name: "Message input" }),
      "What is ISR?"
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(screen.getByTestId("bubble-assistant")).toHaveTextContent(
        "ISR stands for Incremental Static Regeneration."
      )
    );
  });

  it("renders sources as links after the sources event", async () => {
    server.use(
      http.post("/api/chat", () =>
        sseResponse([
          { type: "token", text: "Cached." },
          {
            type: "sources",
            items: [{ title: "Caching", url: "https://nextjs.org/docs/caching", heading: "Overview" }],
          },
          { type: "done", usage: { input_tokens: 4, output_tokens: 1, latency_ms: 60 } },
        ])
      )
    );

    const user = userEvent.setup();
    render(<ChatInterface />);

    await user.type(
      screen.getByRole("textbox", { name: "Message input" }),
      "Caching?"
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Caching" })).toHaveAttribute(
        "href",
        "https://nextjs.org/docs/caching"
      )
    );
  });

  it("renders an error, restores Send, and excludes it from the next request", async () => {
    const requestBodies: unknown[] = [];
    server.use(
      http.post("/api/chat", async ({ request }) => {
        requestBodies.push(await request.json());
        if (requestBodies.length === 1) {
          return sseResponse([
            { type: "error", message: "The provider is temporarily unavailable." },
          ]);
        }
        return sseResponse([
          {
            type: "done",
            usage: { input_tokens: 2, output_tokens: 0, latency_ms: 5 },
          },
        ]);
      })
    );

    const user = userEvent.setup();
    render(<ChatInterface />);

    const input = screen.getByRole("textbox", { name: "Message input" });
    await user.type(input, "First question");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText(
      "Error: The provider is temporarily unavailable."
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();

    await user.type(input, "Second question");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(requestBodies).toHaveLength(2));
    expect(requestBodies[1]).toEqual({
      messages: [
        { role: "user", content: "First question" },
        { role: "user", content: "Second question" },
      ],
    });
  });

  it("shows Stop button while streaming and hides it after done", async () => {
    // Use a slow stream so we can assert the intermediate state
    let resolveStream!: () => void;
    server.use(
      http.post("/api/chat", () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "token", text: "Hi" })}\n\n`
              )
            );
            void new Promise<void>((res) => { resolveStream = res; }).then(() => {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "done", usage: { input_tokens: 1, output_tokens: 1, latency_ms: 10 } })}\n\n`
                )
              );
              controller.close();
            });
          },
        });
        return new HttpResponse(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      })
    );

    const user = userEvent.setup();
    render(<ChatInterface />);

    await user.type(
      screen.getByRole("textbox", { name: "Message input" }),
      "Hi"
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Stop generation" })
      ).toBeInTheDocument()
    );

    resolveStream();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send" })
      ).toBeInTheDocument()
    );
  });

  it("stops the stream when Stop is clicked", async () => {
    server.use(
      http.post("/api/chat", ({ request }) => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "token", text: "..." })}\n\n`
              )
            );
            // Close the stream when the request is aborted so reader.read() unblocks
            request.signal.addEventListener("abort", () => controller.close());
          },
        });
        return new HttpResponse(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      })
    );

    const user = userEvent.setup();
    render(<ChatInterface />);

    await user.type(
      screen.getByRole("textbox", { name: "Message input" }),
      "Long answer please"
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Stop generation" })
      ).toBeInTheDocument()
    );

    await user.click(screen.getByRole("button", { name: "Stop generation" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument()
    );

  });

  it("keeps Send visible after terminal cleanup", async () => {
    // Use a slow stream to verify the intermediate and terminal UI states.
    let resolveStream!: () => void;
    server.use(
      http.post("/api/chat", () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "token", text: "Hello" })}\n\n`
              )
            );
            new Promise<void>((res) => {
              resolveStream = res;
            })
              .then(() => {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "done", usage: { input_tokens: 1, output_tokens: 1, latency_ms: 5 } })}\n\n`
                  )
                );
                controller.close();
              })
              .catch((error: unknown) => controller.error(error));
          },
        });
        return new HttpResponse(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      })
    );

    const user = userEvent.setup();
    render(<ChatInterface />);

    await user.type(
      screen.getByRole("textbox", { name: "Message input" }),
      "Hello"
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    // While streaming, Stop button must be visible
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Stop generation" })
      ).toBeInTheDocument()
    );

    // Resolve the stream (done event fires)
    resolveStream();

    // Send button must appear and stay visible (no transition back to Stop)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument()
    );

    // Give React a moment to settle any extra state updates
    await new Promise((r) => setTimeout(r, 50));

    // Send button must still be there — isStreaming did not flip back
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop generation" })
    ).not.toBeInTheDocument();
  });

  it("Stop click does not leave isStreaming stuck — Send button appears via finally block", async () => {
    server.use(
      http.post("/api/chat", ({ request }) => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "token", text: "..." })}\n\n`
              )
            );
            // Close the stream when the request is aborted so reader.read() unblocks
            request.signal.addEventListener("abort", () => controller.close());
          },
        });
        return new HttpResponse(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      })
    );

    const user = userEvent.setup();
    render(<ChatInterface />);

    await user.type(
      screen.getByRole("textbox", { name: "Message input" }),
      "Infinite stream"
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Stop generation" })
      ).toBeInTheDocument()
    );

    // Click stop — handleStop only aborts; finally block must clean up
    await user.click(screen.getByRole("button", { name: "Stop generation" }));

    // Send button must appear without any further stream events
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument()
    );
  });

  it("aborts the active request when unmounted", async () => {
    let wasAborted = false;
    server.use(
      http.post("/api/chat", ({ request }) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"token","text":"working"}\n\n'
              )
            );
            request.signal.addEventListener("abort", () => {
              wasAborted = true;
              controller.close();
            });
          },
        });
        return new HttpResponse(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      })
    );

    const user = userEvent.setup();
    const view = render(<ChatInterface />);
    await user.type(
      screen.getByRole("textbox", { name: "Message input" }),
      "Keep working"
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Stop generation" });

    view.unmount();

    await waitFor(() => expect(wasAborted).toBe(true));
  });
});
