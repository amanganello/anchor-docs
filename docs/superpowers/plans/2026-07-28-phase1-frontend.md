# Phase 1 — Walking Skeleton: Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a Next.js 16 chat UI that streams tokens from an SSE endpoint, renders them in real-time, and exposes a Stop button that aborts the stream — with the FastAPI backend stubbed locally so the frontend can be built and tested independently.

**Architecture:** The chat page owns all state (messages, streaming flag, abort controller). A thin `lib/stream.ts` module parses the raw SSE byte stream into typed `ChatEvent` objects; `lib/api.ts` calls the Next.js API proxy route which either forwards to the real FastAPI service (when `FASTAPI_URL` is set) or replays a hardcoded stub stream. Every component is tested in isolation; the integration test drives the full submit → stream → done path through MSW.

**Tech Stack:** Next.js 16 · TypeScript (strict) · Tailwind CSS · Vitest · @testing-library/react · MSW v2 · Vercel

## Global Constraints

- Next.js version: `^16.0.0` (pin in package.json; use `next@16` when installing)
- TypeScript: `strict: true`, `noUncheckedIndexedAccess: true`
- Tailwind CSS: v3 (do not use v4 alpha)
- Test runner: Vitest (not Jest)
- Component tests: `@testing-library/react` — assert on rendered text and ARIA attributes, never on CSS class names
- API mocking in tests: MSW v2 (`msw@^2`) — no manual fetch mocks, no jest.mock on fetch
- App Router only — no `pages/` directory
- The FastAPI backend does not exist yet — the API route must fall back to a stub when `FASTAPI_URL` env var is absent
- SSE event format is fixed (defined in the Types task below) — do not invent a different schema
- No third-party UI component libraries — Tailwind only
- Ugly-but-clean: ship working, accessible markup; skip animations and hover polish
- Every task ends with `git commit` — commit after each task, not at the end

---

## File Map

Files created in this plan, in dependency order:

```
web/
├── package.json                          # deps + scripts
├── next.config.ts                        # FASTAPI_URL passthrough, headers
├── tsconfig.json                         # strict TS
├── tailwind.config.ts                    # minimal config
├── vitest.config.ts                      # vitest + jsdom + path aliases
├── vitest.setup.ts                       # MSW server lifecycle
├── .env.example                          # documents required env vars
├── .env.local                            # gitignored; agent creates from example
├── app/
│   ├── layout.tsx                        # root layout, viewport meta, Inter font
│   ├── globals.css                       # CSS reset + CSS vars
│   └── page.tsx                          # mounts <ChatInterface />
│   └── api/
│       └── chat/
│           └── route.ts                  # POST proxy → FASTAPI_URL or stub SSE
├── lib/
│   ├── types.ts                          # Message, ChatEvent union, Source
│   ├── stream.ts                         # parseSSEStream(body): AsyncGenerator<ChatEvent>
│   └── api.ts                            # sendMessage(messages, signal): AsyncGenerator<ChatEvent>
├── components/
│   ├── ChatInterface.tsx                 # state owner; composes all sub-components
│   ├── MessageList.tsx                   # renders Message[], auto-scrolls
│   ├── MessageBubble.tsx                 # single message bubble (user | assistant)
│   ├── ChatInput.tsx                     # textarea + Submit + Stop
│   └── SourceList.tsx                    # citation chips from sources event
└── __tests__/
    ├── lib/
    │   ├── stream.test.ts                # unit: SSE parser
    │   └── api.test.ts                   # unit: sendMessage via MSW
    └── components/
        ├── ChatInterface.test.tsx        # integration: full submit → stream → done
        ├── ChatInput.test.tsx            # unit: renders, submit, stop, disabled states
        ├── MessageBubble.test.tsx        # unit: user/assistant rendering
        ├── MessageList.test.tsx          # unit: list rendering + scroll
        └── SourceList.test.tsx           # unit: citation rendering
```

---

## Task 1: Scaffold the Next.js 16 project

**Files:**
- Create: `web/package.json`
- Create: `web/next.config.ts`
- Create: `web/tsconfig.json`
- Create: `web/tailwind.config.ts`
- Create: `web/vitest.config.ts`
- Create: `web/vitest.setup.ts`
- Create: `web/.env.example`
- Create: `web/app/layout.tsx`
- Create: `web/app/globals.css`
- Create: `web/app/page.tsx` (placeholder)

**Interfaces:**
- Produces: runnable dev server at `localhost:3000`; `npm test` runs vitest; `npm run build` produces a Vercel-compatible build

- [ ] **Step 1: Initialise the project**

From the repo root:

```bash
npx create-next-app@16 web \
  --typescript \
  --tailwind \
  --app \
  --no-src-dir \
  --no-import-alias \
  --eslint
```

If `create-next-app@16` is not yet available, run:

```bash
npx create-next-app@latest web \
  --typescript \
  --tailwind \
  --app \
  --no-src-dir \
  --no-import-alias \
  --eslint
```

then open `web/package.json` and verify `"next"` is `^16.x.x`. If it installed an older version, run:

```bash
cd web && npm install next@16
```

- [ ] **Step 2: Install test dependencies**

```bash
cd web
npm install --save-dev \
  vitest \
  @vitejs/plugin-react \
  @testing-library/react \
  @testing-library/user-event \
  @testing-library/jest-dom \
  jsdom \
  msw@^2
```

- [ ] **Step 3: Write `web/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
```

- [ ] **Step 4: Write `web/vitest.setup.ts`**

```typescript
import "@testing-library/jest-dom";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./__tests__/mocks/server";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

- [ ] **Step 5: Add test script to `web/package.json`**

Open `web/package.json`. In the `"scripts"` section, add:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 6: Write `web/tsconfig.json`**

Replace the generated `tsconfig.json` with:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 7: Write `web/next.config.ts`**

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
```

- [ ] **Step 8: Write `web/.env.example`**

```bash
# URL of the FastAPI backend (leave blank to use the built-in stub)
FASTAPI_URL=
```

- [ ] **Step 9: Write `web/app/globals.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --bg: #ffffff;
  --fg: #111111;
}

body {
  background-color: var(--bg);
  color: var(--fg);
}
```

- [ ] **Step 10: Write `web/app/layout.tsx`**

```typescript
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Anchor Docs",
  description: "Next.js docs assistant — every answer anchored to its source.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} min-h-screen flex flex-col`}>
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 11: Write placeholder `web/app/page.tsx`**

```typescript
export default function Home() {
  return (
    <main className="flex-1 flex flex-col items-center justify-center p-4">
      <p>Chat UI coming soon.</p>
    </main>
  );
}
```

- [ ] **Step 12: Create MSW mock server stub** (needed by `vitest.setup.ts`)

```bash
mkdir -p web/__tests__/mocks
```

Write `web/__tests__/mocks/server.ts`:

```typescript
import { setupServer } from "msw/node";

export const server = setupServer();
```

- [ ] **Step 13: Verify dev server starts**

```bash
cd web && npm run dev
```

Expected: server starts at `http://localhost:3000`, browser shows "Chat UI coming soon."

- [ ] **Step 14: Verify test runner works**

```bash
cd web && npm test
```

Expected: `0 tests passed` (no tests yet) — no errors.

- [ ] **Step 15: Commit**

```bash
cd web && git add -A && git commit -m "feat(web): scaffold Next.js 16 app with Vitest + MSW"
```

---

## Task 2: Define shared types and SSE event parser

**Files:**
- Create: `web/lib/types.ts`
- Create: `web/lib/stream.ts`
- Create: `web/__tests__/lib/stream.test.ts`

**Interfaces:**
- Produces:
  - `parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatEvent>`
  - Types: `ChatEvent`, `TokenEvent`, `SourcesEvent`, `ToolCallEvent`, `DoneEvent`, `ErrorEvent`, `Source`, `Message`, `ChatRole`

- [ ] **Step 1: Write `web/lib/types.ts`**

```typescript
export type ChatRole = "user" | "assistant";

export interface Source {
  title: string;
  url: string;
  heading: string;
}

export interface Message {
  id: string;
  role: ChatRole;
  content: string;
  sources?: Source[];
  isStreaming?: boolean;
}

export interface TokenEvent {
  type: "token";
  text: string;
}

export interface SourcesEvent {
  type: "sources";
  items: Source[];
}

export interface ToolCallEvent {
  type: "tool_call";
  name: string;
  args: Record<string, unknown>;
}

export interface DoneEvent {
  type: "done";
  usage: {
    input_tokens: number;
    output_tokens: number;
    latency_ms: number;
  };
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export type ChatEvent =
  | TokenEvent
  | SourcesEvent
  | ToolCallEvent
  | DoneEvent
  | ErrorEvent;
```

- [ ] **Step 2: Write the failing tests for `parseSSEStream`**

Create `web/__tests__/lib/stream.test.ts`:

```typescript
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
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd web && npm test __tests__/lib/stream.test.ts
```

Expected: FAIL — "Cannot find module '@/lib/stream'"

- [ ] **Step 4: Write `web/lib/stream.ts`**

```typescript
import type { ChatEvent } from "./types";

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<ChatEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed === "" || trimmed.startsWith(":")) continue;

        if (trimmed.startsWith("data: ")) {
          const raw = trimmed.slice(6);
          try {
            const event = JSON.parse(raw) as ChatEvent;
            yield event;
          } catch {
            // malformed line — skip
          }
        }
      }
    }

    // flush remaining buffer
    if (buffer.startsWith("data: ")) {
      try {
        const event = JSON.parse(buffer.slice(6)) as ChatEvent;
        yield event;
      } catch {
        // ignore
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd web && npm test __tests__/lib/stream.test.ts
```

Expected: 7 tests PASS

- [ ] **Step 6: Commit**

```bash
git add web/lib/types.ts web/lib/stream.ts web/__tests__/lib/stream.test.ts
git commit -m "feat(web): add shared types and SSE stream parser"
```

---

## Task 3: API route — chat proxy with stub

**Files:**
- Create: `web/app/api/chat/route.ts`
- Create: `web/__tests__/mocks/handlers.ts` (updates the MSW server)

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime (standalone Next.js route)
- Produces:
  - `POST /api/chat` — accepts `{ messages: {role, content}[] }`, returns an SSE stream of `ChatEvent` objects
  - When `FASTAPI_URL` env var is set: proxies request to `${FASTAPI_URL}/chat`
  - When `FASTAPI_URL` is absent: replays the hardcoded stub stream below

The stub stream emits (in order):
```
data: {"type":"token","text":"This "}
data: {"type":"token","text":"is "}
data: {"type":"token","text":"a "}
data: {"type":"token","text":"stub "}
data: {"type":"token","text":"response."}
data: {"type":"sources","items":[{"title":"Getting Started","url":"https://nextjs.org/docs","heading":"Introduction"}]}
data: {"type":"done","usage":{"input_tokens":12,"output_tokens":5,"latency_ms":80}}
```

- [ ] **Step 1: Write `web/app/api/chat/route.ts`**

```typescript
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

function stubStream(): ReadableStream<Uint8Array> {
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
}

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
```

- [ ] **Step 2: Smoke-test the stub in the browser**

```bash
cd web && npm run dev
```

In a second terminal:

```bash
curl -N -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
```

Expected output (with ~30ms between lines):

```
data: {"type":"token","text":"This "}

data: {"type":"token","text":"is "}

data: {"type":"token","text":"a "}

data: {"type":"token","text":"stub "}

data: {"type":"token","text":"response."}

data: {"type":"sources","items":[{"title":"Getting Started","url":"https://nextjs.org/docs","heading":"Introduction"}]}

data: {"type":"done","usage":{"input_tokens":12,"output_tokens":5,"latency_ms":80}}
```

- [ ] **Step 3: Commit**

```bash
git add web/app/api/chat/route.ts
git commit -m "feat(web): add /api/chat route with stub SSE fallback"
```

---

## Task 4: `sendMessage` client helper

**Files:**
- Create: `web/lib/api.ts`
- Create: `web/__tests__/mocks/handlers.ts`
- Create: `web/__tests__/lib/api.test.ts`

**Interfaces:**
- Consumes: `parseSSEStream` from `@/lib/stream`; `ChatEvent`, `Message` from `@/lib/types`
- Produces: `sendMessage(messages: Message[], signal: AbortSignal): AsyncGenerator<ChatEvent>`

- [ ] **Step 1: Write the MSW handler for `/api/chat`**

Create `web/__tests__/mocks/handlers.ts`:

```typescript
import { http, HttpResponse } from "msw";
import type { ChatEvent } from "@/lib/types";

function sseBody(events: ChatEvent[]): ReadableStream<Uint8Array> {
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
}

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
```

Update `web/__tests__/mocks/server.ts`:

```typescript
import { setupServer } from "msw/node";
import { handlers } from "./handlers";

export const server = setupServer(...handlers);
```

- [ ] **Step 2: Write the failing test for `sendMessage`**

Create `web/__tests__/lib/api.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { sendMessage } from "@/lib/api";
import type { ChatEvent, Message } from "@/lib/types";

const userMessage: Message = {
  id: "1",
  role: "user",
  content: "What is ISR?",
};

async function collect(
  gen: AsyncGenerator<ChatEvent>
): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

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

  it("stops yielding when signal is aborted", async () => {
    const ac = new AbortController();
    const gen = sendMessage([userMessage], ac.signal);

    const first = await gen.next();
    expect(first.value).toEqual({ type: "token", text: "Hello" });

    ac.abort();
    const second = await gen.next();
    expect(second.done).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd web && npm test __tests__/lib/api.test.ts
```

Expected: FAIL — "Cannot find module '@/lib/api'"

- [ ] **Step 4: Write `web/lib/api.ts`**

```typescript
import { parseSSEStream } from "./stream";
import type { ChatEvent, Message } from "./types";

export async function* sendMessage(
  messages: Message[],
  signal: AbortSignal
): AsyncGenerator<ChatEvent> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (!res.ok || !res.body) {
    yield {
      type: "error",
      message: `HTTP ${res.status}: ${res.statusText}`,
    };
    return;
  }

  try {
    for await (const event of parseSSEStream(res.body)) {
      if (signal.aborted) return;
      yield event;
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    yield { type: "error", message: String(err) };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd web && npm test __tests__/lib/api.test.ts
```

Expected: 2 tests PASS

- [ ] **Step 6: Commit**

```bash
git add web/lib/api.ts web/__tests__/mocks/handlers.ts web/__tests__/mocks/server.ts web/__tests__/lib/api.test.ts
git commit -m "feat(web): add sendMessage client helper with MSW tests"
```

---

## Task 5: `ChatInput` component

**Files:**
- Create: `web/components/ChatInput.tsx`
- Create: `web/__tests__/components/ChatInput.test.tsx`

**Interfaces:**
- Produces:
  ```typescript
  interface ChatInputProps {
    onSubmit: (value: string) => void;
    onStop: () => void;
    isStreaming: boolean;
    disabled?: boolean;
  }
  ```
- The textarea is identified by `aria-label="Message input"`.
- The submit button has text "Send" and `type="submit"`.
- The stop button has text "Stop" and `aria-label="Stop generation"`.
- When `isStreaming` is true: Stop button is visible; Send button is hidden.
- When `isStreaming` is false: Send button is visible; Stop button is hidden.
- Pressing Enter (without Shift) in the textarea submits the form.
- Submitting clears the textarea.

- [ ] **Step 1: Write the failing tests**

Create `web/__tests__/components/ChatInput.test.tsx`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatInput } from "@/components/ChatInput";

describe("ChatInput", () => {
  it("renders the textarea and Send button when not streaming", () => {
    render(
      <ChatInput onSubmit={vi.fn()} onStop={vi.fn()} isStreaming={false} />
    );
    expect(
      screen.getByRole("textbox", { name: "Message input" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop generation" })
    ).not.toBeInTheDocument();
  });

  it("renders the Stop button and hides Send when streaming", () => {
    render(
      <ChatInput onSubmit={vi.fn()} onStop={vi.fn()} isStreaming={true} />
    );
    expect(
      screen.getByRole("button", { name: "Stop generation" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Send" })
    ).not.toBeInTheDocument();
  });

  it("calls onSubmit with the typed value and clears the input", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ChatInput onSubmit={onSubmit} onStop={vi.fn()} isStreaming={false} />
    );

    const textarea = screen.getByRole("textbox", { name: "Message input" });
    await user.type(textarea, "Hello there");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).toHaveBeenCalledWith("Hello there");
    expect(textarea).toHaveValue("");
  });

  it("submits on Enter key (without Shift)", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ChatInput onSubmit={onSubmit} onStop={vi.fn()} isStreaming={false} />
    );

    const textarea = screen.getByRole("textbox", { name: "Message input" });
    await user.type(textarea, "Hi{Enter}");

    expect(onSubmit).toHaveBeenCalledWith("Hi");
  });

  it("does not submit on Shift+Enter", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ChatInput onSubmit={onSubmit} onStop={vi.fn()} isStreaming={false} />
    );

    const textarea = screen.getByRole("textbox", { name: "Message input" });
    await user.type(textarea, "line one{Shift>}{Enter}{/Shift}line two");

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit empty input", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ChatInput onSubmit={onSubmit} onStop={vi.fn()} isStreaming={false} />
    );

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onStop when Stop button is clicked", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(
      <ChatInput onSubmit={vi.fn()} onStop={onStop} isStreaming={true} />
    );

    await user.click(screen.getByRole("button", { name: "Stop generation" }));
    expect(onStop).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd web && npm test __tests__/components/ChatInput.test.tsx
```

Expected: FAIL — "Cannot find module '@/components/ChatInput'"

- [ ] **Step 3: Write `web/components/ChatInput.tsx`**

```typescript
"use client";

import { useRef, type FormEvent, type KeyboardEvent } from "react";

interface ChatInputProps {
  onSubmit: (value: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

export function ChatInput({
  onSubmit,
  onStop,
  isStreaming,
  disabled = false,
}: ChatInputProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function handleSubmit(e?: FormEvent) {
    e?.preventDefault();
    const value = ref.current?.value.trim() ?? "";
    if (!value) return;
    onSubmit(value);
    if (ref.current) ref.current.value = "";
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex gap-2 items-end border-t border-gray-200 pt-3"
    >
      <textarea
        ref={ref}
        aria-label="Message input"
        rows={3}
        className="flex-1 resize-none rounded border border-gray-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        placeholder="Ask about Next.js…"
        onKeyDown={handleKeyDown}
        disabled={disabled || isStreaming}
      />
      {isStreaming ? (
        <button
          type="button"
          aria-label="Stop generation"
          onClick={onStop}
          className="rounded bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
        >
          Stop
        </button>
      ) : (
        <button
          type="submit"
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          disabled={disabled}
        >
          Send
        </button>
      )}
    </form>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd web && npm test __tests__/components/ChatInput.test.tsx
```

Expected: 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/components/ChatInput.tsx web/__tests__/components/ChatInput.test.tsx
git commit -m "feat(web): add ChatInput component with submit/stop tests"
```

---

## Task 6: `MessageBubble` and `SourceList` components

**Files:**
- Create: `web/components/MessageBubble.tsx`
- Create: `web/components/SourceList.tsx`
- Create: `web/__tests__/components/MessageBubble.test.tsx`
- Create: `web/__tests__/components/SourceList.test.tsx`

**Interfaces:**
- Produces:
  ```typescript
  // MessageBubble
  interface MessageBubbleProps {
    message: Message; // from @/lib/types
  }
  // SourceList
  interface SourceListProps {
    sources: Source[]; // from @/lib/types
  }
  ```
- A user message has `data-testid="bubble-user"`.
- An assistant message has `data-testid="bubble-assistant"`.
- When `message.isStreaming` is true, the bubble renders a `<span aria-label="Streaming indicator">` after the content.
- Each source renders as an `<a>` with the source's `title` as text and `href` equal to `source.url`.

- [ ] **Step 1: Write the failing tests for `MessageBubble`**

Create `web/__tests__/components/MessageBubble.test.tsx`:

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageBubble } from "@/components/MessageBubble";
import type { Message } from "@/lib/types";

describe("MessageBubble", () => {
  it("renders user message content", () => {
    const msg: Message = { id: "1", role: "user", content: "Hello" };
    render(<MessageBubble message={msg} />);
    expect(screen.getByTestId("bubble-user")).toHaveTextContent("Hello");
  });

  it("renders assistant message content", () => {
    const msg: Message = { id: "2", role: "assistant", content: "World" };
    render(<MessageBubble message={msg} />);
    expect(screen.getByTestId("bubble-assistant")).toHaveTextContent("World");
  });

  it("shows streaming indicator when isStreaming is true", () => {
    const msg: Message = {
      id: "3",
      role: "assistant",
      content: "Thinking",
      isStreaming: true,
    };
    render(<MessageBubble message={msg} />);
    expect(
      screen.getByLabelText("Streaming indicator")
    ).toBeInTheDocument();
  });

  it("does not show streaming indicator when isStreaming is false", () => {
    const msg: Message = {
      id: "4",
      role: "assistant",
      content: "Done",
      isStreaming: false,
    };
    render(<MessageBubble message={msg} />);
    expect(
      screen.queryByLabelText("Streaming indicator")
    ).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Write the failing tests for `SourceList`**

Create `web/__tests__/components/SourceList.test.tsx`:

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SourceList } from "@/components/SourceList";
import type { Source } from "@/lib/types";

describe("SourceList", () => {
  it("renders nothing when sources array is empty", () => {
    const { container } = render(<SourceList sources={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a link for each source", () => {
    const sources: Source[] = [
      { title: "Caching", url: "https://nextjs.org/docs/caching", heading: "Overview" },
      { title: "Routing", url: "https://nextjs.org/docs/routing", heading: "Intro" },
    ];
    render(<SourceList sources={sources} />);

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveTextContent("Caching");
    expect(links[0]).toHaveAttribute("href", "https://nextjs.org/docs/caching");
    expect(links[1]).toHaveTextContent("Routing");
  });

  it("opens links in a new tab", () => {
    const sources: Source[] = [
      { title: "ISR", url: "https://nextjs.org/docs/isr", heading: "ISR" },
    ];
    render(<SourceList sources={sources} />);
    expect(screen.getByRole("link")).toHaveAttribute("target", "_blank");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd web && npm test __tests__/components/MessageBubble.test.tsx __tests__/components/SourceList.test.tsx
```

Expected: FAIL — modules not found

- [ ] **Step 4: Write `web/components/MessageBubble.tsx`**

```typescript
import type { Message } from "@/lib/types";
import { SourceList } from "./SourceList";

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div
      data-testid={isUser ? "bubble-user" : "bubble-assistant"}
      className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
        isUser
          ? "ml-auto bg-blue-600 text-white"
          : "mr-auto bg-gray-100 text-gray-900"
      }`}
    >
      <p className="whitespace-pre-wrap">
        {message.content}
        {message.isStreaming && (
          <span
            aria-label="Streaming indicator"
            className="ml-1 inline-block h-3 w-1 animate-pulse bg-current"
          />
        )}
      </p>
      {message.sources && message.sources.length > 0 && (
        <SourceList sources={message.sources} />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Write `web/components/SourceList.tsx`**

```typescript
import type { Source } from "@/lib/types";

interface SourceListProps {
  sources: Source[];
}

export function SourceList({ sources }: SourceListProps) {
  if (sources.length === 0) return null;

  return (
    <ul className="mt-2 flex flex-wrap gap-1">
      {sources.map((source) => (
        <li key={source.url}>
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block rounded bg-white px-2 py-0.5 text-xs text-blue-700 ring-1 ring-blue-200 hover:ring-blue-400"
          >
            {source.title}
          </a>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd web && npm test __tests__/components/MessageBubble.test.tsx __tests__/components/SourceList.test.tsx
```

Expected: 7 tests PASS

- [ ] **Step 7: Commit**

```bash
git add web/components/MessageBubble.tsx web/components/SourceList.tsx \
  web/__tests__/components/MessageBubble.test.tsx \
  web/__tests__/components/SourceList.test.tsx
git commit -m "feat(web): add MessageBubble and SourceList components"
```

---

## Task 7: `MessageList` component

**Files:**
- Create: `web/components/MessageList.tsx`
- Create: `web/__tests__/components/MessageList.test.tsx`

**Interfaces:**
- Consumes: `MessageBubble` from `@/components/MessageBubble`; `Message` from `@/lib/types`
- Produces:
  ```typescript
  interface MessageListProps {
    messages: Message[];
  }
  ```
- Renders an empty `<div>` with `data-testid="message-list"` when messages is empty.
- Renders one `MessageBubble` per message.
- The list container has `role="log"` and `aria-live="polite"` for screen-reader announcements.
- Auto-scrolls to the bottom when `messages` changes (via `scrollIntoView` on a sentinel element).

- [ ] **Step 1: Write the failing tests**

Create `web/__tests__/components/MessageList.test.tsx`:

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageList } from "@/components/MessageList";
import type { Message } from "@/lib/types";

describe("MessageList", () => {
  it("renders empty state without errors", () => {
    render(<MessageList messages={[]} />);
    expect(screen.getByTestId("message-list")).toBeInTheDocument();
  });

  it("renders a bubble for each message", () => {
    const messages: Message[] = [
      { id: "1", role: "user", content: "Hi" },
      { id: "2", role: "assistant", content: "Hello" },
    ];
    render(<MessageList messages={messages} />);
    expect(screen.getByTestId("bubble-user")).toBeInTheDocument();
    expect(screen.getByTestId("bubble-assistant")).toBeInTheDocument();
  });

  it("has role=log and aria-live=polite", () => {
    render(<MessageList messages={[]} />);
    const list = screen.getByRole("log");
    expect(list).toHaveAttribute("aria-live", "polite");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd web && npm test __tests__/components/MessageList.test.tsx
```

Expected: FAIL — "Cannot find module '@/components/MessageList'"

- [ ] **Step 3: Write `web/components/MessageList.tsx`**

```typescript
"use client";

import { useEffect, useRef } from "react";
import type { Message } from "@/lib/types";
import { MessageBubble } from "./MessageBubble";

interface MessageListProps {
  messages: Message[];
}

export function MessageList({ messages }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div
      role="log"
      aria-live="polite"
      data-testid="message-list"
      className="flex flex-1 flex-col gap-3 overflow-y-auto px-2 py-4"
    >
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd web && npm test __tests__/components/MessageList.test.tsx
```

Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/components/MessageList.tsx web/__tests__/components/MessageList.test.tsx
git commit -m "feat(web): add MessageList component"
```

---

## Task 8: `ChatInterface` — wire everything together

**Files:**
- Create: `web/components/ChatInterface.tsx`
- Modify: `web/app/page.tsx`
- Create: `web/__tests__/components/ChatInterface.test.tsx`

**Interfaces:**
- Consumes: `MessageList`, `ChatInput`, `sendMessage`, `Message`, `ChatEvent` from prior tasks
- Produces: `<ChatInterface />` (no props — self-contained state owner)

State owned by `ChatInterface`:
- `messages: Message[]`
- `isStreaming: boolean`
- `abortControllerRef: React.MutableRefObject<AbortController | null>`

Submit flow:
1. Append user message to `messages` (id = `crypto.randomUUID()`)
2. Create a new `AbortController`; store in `abortControllerRef`
3. Set `isStreaming = true`
4. Append a blank assistant message with `isStreaming: true`
5. For each `ChatEvent` from `sendMessage`:
   - `token`: append `event.text` to the last assistant message's `content`
   - `sources`: set `sources` on the last assistant message
   - `tool_call`: no UI change in Phase 1 — log to console only
   - `done`: mark last assistant message `isStreaming: false`; set `isStreaming = false`
   - `error`: set last assistant message content to `"Error: " + event.message`; set `isStreaming = false`
6. On abort: mark last assistant message `isStreaming: false`; set `isStreaming = false`

Stop flow:
- Call `abortControllerRef.current?.abort()`

- [ ] **Step 1: Write the failing integration test**

Create `web/__tests__/components/ChatInterface.test.tsx`:

```typescript
import { describe, it, expect, vi } from "vitest";
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
            new Promise<void>((res) => { resolveStream = res; }).then(() => {
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
    let didAbort = false;
    server.use(
      http.post("/api/chat", ({ request }) => {
        request.signal.addEventListener("abort", () => { didAbort = true; });
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "token", text: "..." })}\n\n`
              )
            );
            // never closes — waits for abort
          },
        });
        return new HttpResponse(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      })
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

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

    consoleSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd web && npm test __tests__/components/ChatInterface.test.tsx
```

Expected: FAIL — "Cannot find module '@/components/ChatInterface'"

- [ ] **Step 3: Write `web/components/ChatInterface.tsx`**

```typescript
"use client";

import { useCallback, useRef, useState } from "react";
import type { Message, Source, ChatEvent } from "@/lib/types";
import { sendMessage } from "@/lib/api";
import { ChatInput } from "./ChatInput";
import { MessageList } from "./MessageList";

export function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  function appendToken(id: string, text: string) {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id ? { ...m, content: m.content + text } : m
      )
    );
  }

  function setSources(id: string, sources: Source[]) {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, sources } : m))
    );
  }

  function finalise(id: string, errorMsg?: string) {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id
          ? {
              ...m,
              isStreaming: false,
              content: errorMsg ? `Error: ${errorMsg}` : m.content,
            }
          : m
      )
    );
    setIsStreaming(false);
  }

  const handleSubmit = useCallback(
    async (value: string) => {
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: value,
      };
      const assistantId = crypto.randomUUID();
      const assistantMsg: Message = {
        id: assistantId,
        role: "assistant",
        content: "",
        isStreaming: true,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);

      const ac = new AbortController();
      abortRef.current = ac;

      try {
        for await (const event of sendMessage(
          [...messages, userMsg],
          ac.signal
        )) {
          if (ac.signal.aborted) break;
          handleEvent(assistantId, event);
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          finalise(assistantId, String(err));
          return;
        }
      }

      finalise(assistantId);
    },
    [messages]
  );

  function handleEvent(assistantId: string, event: ChatEvent) {
    switch (event.type) {
      case "token":
        appendToken(assistantId, event.text);
        break;
      case "sources":
        setSources(assistantId, event.items);
        break;
      case "tool_call":
        console.log("tool_call", event.name, event.args);
        break;
      case "done":
        finalise(assistantId);
        break;
      case "error":
        finalise(assistantId, event.message);
        break;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    setIsStreaming(false);
    setMessages((prev) =>
      prev.map((m) =>
        m.isStreaming ? { ...m, isStreaming: false } : m
      )
    );
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-2xl flex-col px-4 py-6">
      <h1 className="mb-4 text-lg font-semibold text-gray-800">Anchor Docs</h1>
      <MessageList messages={messages} />
      <ChatInput
        onSubmit={handleSubmit}
        onStop={handleStop}
        isStreaming={isStreaming}
      />
    </div>
  );
}
```

- [ ] **Step 4: Update `web/app/page.tsx`**

```typescript
import { ChatInterface } from "@/components/ChatInterface";

export default function Home() {
  return (
    <main className="flex-1">
      <ChatInterface />
    </main>
  );
}
```

- [ ] **Step 5: Run all tests**

```bash
cd web && npm test
```

Expected: all tests PASS (≥ 27 tests across all files)

- [ ] **Step 6: Smoke-test in the browser**

```bash
cd web && npm run dev
```

Open `http://localhost:3000`. Type a message, click Send. You should see:
- Your message appears immediately as a blue bubble on the right
- "This is a stub response." streams in word by word on the left
- A "Getting Started" citation link appears below the assistant bubble
- The Stop button appears while streaming, disappears when done

Click Stop mid-stream — the bubble freezes, the Send button returns.

- [ ] **Step 7: Run type-check**

```bash
cd web && npx tsc --noEmit
```

Expected: no type errors.

- [ ] **Step 8: Commit**

```bash
git add web/components/ChatInterface.tsx web/app/page.tsx \
  web/__tests__/components/ChatInterface.test.tsx
git commit -m "feat(web): add ChatInterface — streaming chat with stop support"
```

---

## Task 9: Vercel deployment

**Files:**
- Create: `web/vercel.json`

**Interfaces:**
- Produces: a deployed URL where the chat UI is live; all `/api/*` routes work; the stub stream is active (no `FASTAPI_URL` set yet)

- [ ] **Step 1: Write `web/vercel.json`**

```json
{
  "framework": "nextjs",
  "buildCommand": "npm run build",
  "devCommand": "npm run dev",
  "installCommand": "npm install",
  "outputDirectory": ".next"
}
```

- [ ] **Step 2: Verify production build passes locally**

```bash
cd web && npm run build
```

Expected: build completes with no errors. Note any warnings — fix type errors, ignore image optimisation warnings.

- [ ] **Step 3: Deploy to Vercel**

If the Vercel CLI is available:

```bash
cd web && npx vercel --prod
```

If not, push to GitHub and connect the `web/` directory as the Vercel project root from the Vercel dashboard (`Project Settings → Root Directory → web`).

Environment variables to set in Vercel dashboard (leave `FASTAPI_URL` blank for now — stub is used):
- `FASTAPI_URL` — leave empty (stub active)

- [ ] **Step 4: Verify the deployed URL**

Open the Vercel deployment URL. Repeat the smoke-test from Task 8 Step 6 on the live URL. Confirm:
- Page loads without a white screen
- Submitting a message shows the stub stream
- Stop button works

- [ ] **Step 5: Commit and update README**

Open `web/../Readme.md`. Replace the `<!-- Vercel URL once Phase 1 ships -->` comment with the actual Vercel URL.

```bash
git add web/vercel.json Readme.md
git commit -m "feat(web): add Vercel config and update README with live URL"
```

---

## Self-Review

**Spec coverage check against PLAN.md Phase 1:**

| Requirement | Covered by |
|---|---|
| Scaffold both apps (web only in this plan) | Task 1 |
| Provider interface / GeminiProvider | Backend plan — not in scope |
| `/chat` endpoint streams tokens | Task 3 (stub), Task 8 (integration) |
| Next.js chat UI: input, streamed response, Stop button | Tasks 5, 6, 7, 8 |
| Deploy to Vercel | Task 9 |
| Stop aborts the stream | Task 5 (unit), Task 8 (integration) |
| CORS | Backend concern — not in scope |
| SSE event format: token, sources, tool_call, done, error | Task 2 types + Task 3 stub |

**Placeholder scan:** No TBD/TODO in any code block. All commands include expected output.

**Type consistency:**
- `Message` uses `id: string` throughout (Tasks 2, 5, 6, 7, 8).
- `sendMessage` accepts `Message[]` and `AbortSignal` in Task 4 definition and Task 8 usage — consistent.
- `parseSSEStream` returns `AsyncGenerator<ChatEvent>` in Task 2 and is consumed as such in Task 4 — consistent.
- `Source` has `{ title, url, heading }` in Task 2 and is rendered with those exact fields in Task 6 — consistent.
