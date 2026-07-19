# Anchor Docs — Implementation Plan

*A grounded docs assistant — every answer anchored to its source.*

This is the build plan for the project defined in your 3-week pivot plan. It's organized in phases with explicit acceptance criteria ("done means") so you always know if you're on track or gold-plating. Each phase produces something demoable.

---

## 0. Architecture Overview

```
┌─────────────────────┐         ┌──────────────────────────┐
│  Next.js (Vercel)   │  SSE    │  FastAPI (Cloud Run)   │
│                     │◄────────│                          │
│  - Chat UI          │  HTTP   │  - /chat (streaming)     │
│  - Source citations │────────►│  - Agent loop            │
│  - Stop generation  │         │  - Provider adapter      │
│  - /stats page      │         │  - RAG retrieval         │
└─────────────────────┘         └───────────┬──────────────┘
                                            │
                              ┌─────────────┴─────────────┐
                              │  Postgres + pgvector      │
                              │  (Supabase free tier)     │
                              │  - chunks + embeddings    │
                              │  - full-text search (fts) │
                              │  - request logs           │
                              └───────────────────────────┘

Offline pipeline (run manually):
  Next.js docs (MDX from GitHub) → clean → chunk → embed → insert
```

**Stack decisions (already made, don't reopen):**
- Frontend: Next.js 16 + TypeScript, deployed on Vercel
- Backend: Python 3.14 + FastAPI + Pydantic, deployed on Cloud Run (GCP)
- DB: Postgres + pgvector on Supabase free tier (gives you hosted PG + connection string, zero ops)
- LLM: Gemini free tier as primary; provider adapter interface from day one, Claude/OpenAI added in Phase 5
- Embeddings: Gemini embedding endpoint (free tier)
- Corpus: Next.js docs (`vercel/next.js` repo, `docs/` folder, MDX)
- Python tooling: `uv` for env/deps (feels like pnpm), `ruff` for lint/format, type hints everywhere

---

## 1. Repo Structure

Monorepo, one GitHub repo (`anchor-docs`):

```
anchor-docs/
├── README.md              # pitch, architecture diagram, demo GIF, stack
├── web/                   # Next.js app
│   ├── app/
│   │   ├── page.tsx       # chat UI
│   │   ├── stats/page.tsx # observability page (phase 6)
│   │   └── api/chat/route.ts  # thin proxy to FastAPI (keeps keys server-side)
│   └── ...
├── api/                   # FastAPI service
│   ├── pyproject.toml
│   ├── src/
│   │   ├── main.py        # app + routes
│   │   ├── providers/     # base.py, gemini.py, (anthropic.py later)
│   │   ├── rag/           # retrieval.py, hybrid.py
│   │   ├── agent/         # loop.py, tools.py
│   │   ├── models.py      # Pydantic schemas (shared vocabulary)
│   │   └── logging.py     # request logging (phase 6)
│   └── tests/
├── ingest/                # offline pipeline (Python scripts)
│   ├── fetch.py           # sparse-clone / pull docs
│   ├── clean.py           # strip MDX/JSX noise
│   ├── chunk.py           # heading-based chunking
│   └── embed.py           # embed + insert into pgvector
├── evals/                 # golden set + runner (phase 7)
│   ├── golden.yaml
│   └── run.py
└── db/
    └── schema.sql         # tables + indexes, versioned
```

---

## 2. Data Model (db/schema.sql)

```sql
-- pgvector extension (enabled by default on Supabase)
create extension if not exists vector;

create table documents (
  id serial primary key,
  path text not null,          -- e.g. "01-app/02-guides/caching.mdx"
  title text not null,         -- from frontmatter
  url text not null            -- reconstructed nextjs.org docs URL for citations
);

create table chunks (
  id serial primary key,
  document_id int references documents(id),
  heading text,                -- section heading this chunk came from
  content text not null,
  token_count int not null,
  embedding vector(768),       -- match your embedding model's dimensions
  fts tsvector generated always as (to_tsvector('english', content)) stored
);

create index on chunks using hnsw (embedding vector_cosine_ops);
create index on chunks using gin (fts);

create table request_logs (      -- phase 6
  id serial primary key,
  created_at timestamptz default now(),
  question text,
  model text,
  latency_ms int,
  input_tokens int,
  output_tokens int,
  est_cost_usd numeric(10,6),
  retrieved_chunk_ids int[],
  tool_calls jsonb
);
```

---

## 3. API Contract (Pydantic models first — write these before any logic)

```
POST /chat
  body: { messages: [{role, content}], stream: true }
  response: SSE stream of events:
    {type: "token", text: "..."}
    {type: "sources", items: [{title, url, heading}]}
    {type: "tool_call", name: "...", args: {...}}   # shown as activity in UI
    {type: "done", usage: {input_tokens, output_tokens, latency_ms}}
    {type: "error", message: "..."}

POST /search          # debug endpoint, also used by evals
  body: { query: str, k: int }
  response: [{chunk_id, content, heading, url, score, match_type: "vector"|"fts"|"both"}]

GET /stats            # phase 6
  response: aggregates from request_logs
```

Defining the event vocabulary up front means frontend and backend can be built in parallel and the streaming contract never drifts.

---

## 4. Phased Build

### Phase 1 — Walking Skeleton (days 4-5)
Streaming path working end-to-end with a real model, no RAG yet.

- [ ] Scaffold both apps; `uv init` the API, get FastAPI hello-world running locally
- [ ] Provider interface: `class LLMProvider(Protocol)` with `stream_chat(messages, tools) -> AsyncIterator[Event]`; implement `GeminiProvider`
- [ ] `/chat` endpoint streams model tokens via `StreamingResponse` (SSE format from the contract above)
- [ ] Next.js chat UI: input, streamed response rendering, Stop button wired to `AbortController`
- [ ] Deploy both (Vercel + CLoud Run); env vars for keys; CORS configured

**Done means:** you can type a question on the deployed URL and watch a Gemini answer stream in, and Stop actually aborts. *(This alone is more than many candidates have.)*

### Phase 2 — Ingestion Pipeline (days 6-7)
- [ ] `fetch.py`: sparse-clone `vercel/next.js` docs folder
- [ ] `clean.py`: strip JSX components/imports, keep code blocks, extract frontmatter (title) and reconstruct public URL per file
- [ ] `chunk.py`: split by headings; merge tiny sections; cap chunk size (~500-800 tokens); keep heading context with each chunk
- [ ] `embed.py`: batch-embed via Gemini, insert documents + chunks into Supabase
- [ ] Sanity script: pick 5 known questions, eyeball whether the right chunks exist

**Done means:** `select count(*) from chunks` returns a few thousand rows and spot-checks look sane.

### Phase 3 — Retrieval + Grounded Answers (days 8-10)
- [ ] `/search`: vector similarity (pgvector cosine) — verify quality manually
- [ ] Add full-text search leg; merge/rerank the two result lists (reciprocal rank fusion is simple and effective — ~15 lines)
- [ ] Wire retrieval into `/chat`: retrieve → build grounded prompt ("answer ONLY from these sources; if they don't cover it, say so") → stream answer
- [ ] Emit `sources` event; render citations in the UI as links to nextjs.org
- [ ] The anchor rule: if retrieval returns nothing above a score threshold, the assistant explicitly says the docs don't cover it — no freestyle answers

**Done means:** "how does ISR revalidation work?" gets a correct answer with 2-3 clickable source links; "what's the capital of France?" gets a polite refusal. Test both.

### Phase 4 — Agent Loop + Tools (days 11-13)
- [ ] Refactor `/chat` into an agent loop: model can either answer or call a tool; loop feeds tool results back; hard caps (max 5 iterations, max token budget per request)
- [ ] Tool 1: `search_docs(query)` — retrieval exposed as a tool the model chooses to call (replaces always-retrieve; the model decides when it needs sources)
- [ ] Tool 2: `fetch_url(url)` — fetch a page from an allowlist (nextjs.org, github.com/vercel only — this is your least-privilege story)
- [ ] Pydantic validation on all tool args; on invalid model output, one retry with the validation error included; then graceful failure
- [ ] Emit `tool_call` events; UI shows "Searching docs…" activity states
- [ ] Log every loop iteration (structured) — you will need this for debugging, guaranteed

**Done means:** a question requiring lookup triggers a visible `search_docs` call; a malformed tool call gets auto-repaired via the retry; loop never exceeds caps.

### Phase 5 — Second Provider (day 14, timeboxed)
- [ ] `AnthropicProvider` (or OpenAI) behind the same interface — the $5 balance move
- [ ] Provider selected by env var or a UI toggle; normalize tool-call format differences inside each adapter
- [ ] Optional stretch, only if smooth: LangGraph re-implementation of the loop in a separate branch/folder for the "raw vs framework" interview talking point

**Done means:** flipping one setting switches the whole app between providers with zero other changes. This is the "typed multi-provider wrapper" interview answer, running in prod.

### Phase 6 — Observability (days 15... shared with evals)
- [ ] Middleware writes a `request_logs` row per chat: latency, tokens, est. cost, chunks used, tool calls
- [ ] `/stats` + minimal stats page: total requests, avg latency, total est. cost, cost per request over time

**Done means:** after a day of testing you can state your project's avg latency and total spend from the page, not from guessing.

### Phase 7 — Evals (days 15-16, the differentiator)
- [ ] `golden.yaml`: ~20 cases across four types — direct factual, multi-hop, off-topic (must refuse), and ambiguous (must ask or qualify). Each case: question + checks (`must_contain`, `must_cite` (bool), `must_refuse` (bool), optionally `must_cite_url`)
- [ ] `run.py`: runs all cases against the live `/chat` (non-streaming variant or collect the stream), evaluates checks, prints pass/fail table + pass rate
- [ ] Run it once, save the report; change something in the prompt, run again, keep the diff — that pair of reports is your "how do you catch regressions" story
- [ ] Retrieval-only eval bonus: for 10 cases, check the right chunk is in top-5 from `/search` — separates retrieval failures from generation failures

**Done means:** one command prints a pass rate, and you have two dated reports proving you caught (or verified) a prompt change's impact.

### Phase 8 — Polish + README (days 17-18, one day max on UI)
- [ ] README: one-paragraph pitch, architecture diagram (the ASCII above is fine, or a simple image), stack list, demo GIF, "design decisions" section (hybrid search why, anchor rule why, provider abstraction why), eval results table
- [ ] UI pass: clean layout, loading states, mobile-not-broken. Ugly-but-clean, remember.
- [ ] Record a 60-90s demo video/GIF (screen capture of a real question → streamed grounded answer → citations)

**Done means:** someone landing on the repo understands what it is in 30 seconds and can watch it work without cloning anything.

---

## 5. Order of Risk (why the phases are sequenced this way)

1. **Streaming deployed first** — deployment friction and SSE-through-proxies issues are the most annoying surprises; hit them in week 1 with a tiny surface area.
2. **Ingestion before retrieval** — you can't tune search against an empty table.
3. **Always-retrieve before agent** — get grounded answers working with forced retrieval, *then* hand the decision to the model. Debugging both at once is misery.
4. **Evals near the end but never cut** — they need a stable pipeline to test against, and they're your top interview differentiator.

## 6. Cut List (if you fall behind, cut in this exact order)

1. LangGraph branch (Phase 5 stretch)
2. `fetch_url` second tool (keep `search_docs` only)
3. Stats *page* (keep the logging — logs without UI still give you the numbers)
4. Demo video (keep the GIF)

**Never cut:** streaming + Stop, citations + anchor rule, hybrid search, evals. Those four are the interview.

## 7. Definition of Done (whole project)

- Deployed URL answers Next.js questions with streamed, cited, grounded answers
- Refuses off-topic questions explicitly
- Visible tool-calling with validation + retry
- Two providers behind one interface
- Eval suite with a documented pass rate and one before/after diff
- README that sells it in 30 seconds
- A resume bullet that is 100% true