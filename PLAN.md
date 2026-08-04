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
                              │  Pinecone serverless      │
                              │  - dense vectors          │
                              │  - sparse vectors         │
                              │  - citation metadata      │
                              └───────────────────────────┘

Offline pipeline (run manually):
  Next.js docs (MDX from GitHub) → clean → chunk → dense + sparse encode → upsert
```

**Stack decisions (already made, don't reopen):**
- Frontend: Next.js 16 + TypeScript, deployed on Vercel
- Backend: Python 3.14 + FastAPI + Pydantic, deployed on Cloud Run (GCP)
- Retrieval: one Pinecone serverless index with dense + sparse vectors, `dotproduct`, and explicit hybrid weighting
- LLM: provider adapter interface from day one; **Gemini selected for Phase 1 chat generation** (`gemini-3.6-flash` via a pinned `google-genai` Python SDK); chat generation remains separate from dense embeddings
- Dense embeddings: `gemini-embedding-2` through the provider-neutral `EmbeddingProvider`, with `output_dimensionality=768`
- Sparse encoding: standalone Pinecone inference with `pinecone-sparse-english-v0`
- Telemetry: persistence choice deferred until Phase 6; Pinecone is not a request-log store
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
├── backend/               # FastAPI service
│   ├── pyproject.toml
│   ├── src/
│   │   ├── main.py        # app + routes
│   │   ├── providers/     # chat + dense-embedding adapters
│   │   ├── rag/           # retrieval.py, hybrid.py
│   │   ├── agent/         # loop.py, tools.py
│   │   ├── models.py      # Pydantic schemas (shared vocabulary)
│   │   └── logging.py     # request logging (phase 6)
│   └── tests/
├── ingest/                # offline pipeline (Python scripts)
│   ├── fetch_MDX.py       # sparse-clone / pull docs (exists)
│   ├── clean_MDX.py       # strip MDX/JSX noise (exists)
│   ├── chunk.py           # heading-based chunking (Phase 2 — not yet written)
│   └── embed.py           # dense + sparse encode and upsert to Pinecone (Phase 2 — not yet written)
├── evals/                 # golden set + runner (phase 7)
│   ├── golden.yaml
│   └── run.py
└── ...
```

---

## 2. Retrieval Model

One Pinecone record represents one documentation chunk:

```json
{
  "id": "<stable chunk id>",
  "values": [0.012, -0.034],
  "sparse_values": {
    "indices": [822745112, 1009084850],
    "values": [1.7959, 0.4158]
  },
  "metadata": {
    "document_path": "01-app/02-guides/caching.mdx",
    "title": "Caching",
    "url": "https://nextjs.org/docs/app/guides/caching",
    "heading": "Overview",
    "content": "...",
    "token_count": 420,
    "corpus_version": "<source revision>"
  }
}
```

The two dense values above are abbreviated for readability; production records
contain exactly 768 dense values.

Use deterministic chunk IDs and a namespace per corpus version. Create the
index only after selecting the dense embedding model and matching its dimension.
Use the `dotproduct` metric because the same index carries dense and sparse
vectors.

Dense embeddings come from `gemini-embedding-2` through `EmbeddingProvider`,
with `output_dimensionality=768`. Format documents as
`title: {title} | text: {content}` and queries as
`task: question answering | query: {content}`. The model, dimension, task
format, and encoding version define the dense embedding space and belong in the
corpus manifest. Changing any of them requires regenerating and upserting all
dense vectors. Record `max_input_tokens=8192` and `truncation_policy="error"`
in the manifest. Count or estimate tokens before inference and reject an
oversized chunk before the provider can silently truncate it.

Dense batch encoding must return exactly one 768-value vector for each input
chunk. Do not send multiple plain strings directly as `contents=[...]`, because
`gemini-embedding-2` may aggregate them into one embedding. Wrap each chunk as
a separate Gemini `Content` object or use the Batch API, keep an explicit
chunk-ID mapping, and fail on missing, malformed, reordered, or count-mismatched
results.

Sparse vectors come through a narrow `SparseEncoder` backed by standalone
`pinecone-sparse-english-v0` inference: `input_type="passage"` for chunks and
`input_type="query"` for queries. This is an intentional Pinecone dependency;
changing sparse models requires regenerating and upserting sparse vectors for
the whole corpus.

Start hybrid search with `HYBRID_ALPHA=0.5`, scaling the dense query vector by
alpha and sparse weights by `1 - alpha`. Treat `1.0` as a dense-only diagnostic
and tune the production value with retrieval evals.

The sparse model is designed for English retrieval. Record its name, input
type, token limit, truncation policy, and encoding version in the manifest.
Before full ingestion, estimate tokens and verify the current inference
allowance. Configure 512 or 2048 tokens per sequence explicitly, limit batches
to 96 sequences and request-size limits, retry transient failures with bounded
backoff, and fail actionably on exhausted monthly quota.

Request logs and `/stats` still arrive in Phase 6, but their persistence layer
will be chosen then and must not be Pinecone.

---

## 3. API Contract (Pydantic models first — write these before any logic)

```
POST /chat
  body: { messages: [{role, content}] }
  response: SSE stream of events (endpoint always streams; no stream field in body):
    {type: "token", text: "..."}
    {type: "sources", items: [{title, url, heading}]}
    {type: "tool_call", name: "...", args: {...}}   # shown as activity in UI
    {type: "done", usage: {input_tokens, output_tokens, latency_ms}}
    {type: "error", message: "..."}

POST /search          # debug endpoint, also used by evals
  body: { query: str, k: int }
  response: [{chunk_id, content, heading, url, score}]

GET /stats            # phase 6
  response: aggregates from the Phase 6 telemetry store
```

Defining the event vocabulary up front means frontend and backend can be built in parallel and the streaming contract never drifts.

---

## 4. Phased Build

### Phase 1 — Walking Skeleton (days 4-5)
Streaming path working end-to-end with a real model, no RAG yet.

- [ ] Scaffold both apps; `uv init` the backend, get FastAPI hello-world running locally
- [ ] Provider interface: `class LLMProvider(Protocol)` with `stream_chat(messages) -> AsyncIterator[Event]`; implement the selected initial provider. Tool definitions enter the contract in Phase 4.
- [ ] `/chat` endpoint streams model tokens via `StreamingResponse` (SSE format from the contract above)
- [ ] Next.js chat UI: input, streamed response rendering, Stop button wired to `AbortController`
- [ ] Deploy both (Vercel + CLoud Run); env vars for keys; CORS configured

**Done means:** you can type a question on the deployed URL and watch the selected provider's answer stream in, and Stop actually aborts. *(This alone is more than many candidates have.)*

### Phase 2 — Ingestion Pipeline (days 6-7)
- [ ] `fetch_MDX.py`: sparse-clone `vercel/next.js` docs folder (file already exists in `ingest/`)
- [ ] `clean_MDX.py`: strip JSX components/imports, keep code blocks, extract frontmatter (title) and reconstruct public URL per file (file already exists in `ingest/`)
- [ ] `chunk.py`: split by headings; merge tiny sections; cap chunk size (~500-800 tokens); keep heading context with each chunk
- [ ] `embed.py`: generate dense vectors through `EmbeddingProvider`, generate sparse passage vectors through `SparseEncoder`, and batch-upsert both with citation metadata into a versioned Pinecone namespace
- [ ] Record the dense model, 768 dimension, task format, 8,192-token limit, no-truncation policy, sparse model configuration, and encoding versions in the corpus manifest; fail visibly on truncation, dimension mismatch, or exhausted inference quota
- [ ] Test dense document/query formatting, exact 768-value output, two-or-more-input cardinality and chunk-ID mapping, malformed/missing/reordered/count-mismatched vectors, the token boundary, pre-inference rejection of oversized chunks, and bounded retries for transient provider failures
- [ ] Add a credential-gated `gemini-embedding-2` smoke test; changing the dense model, dimension, task format, or encoding version requires a before/after retrieval evaluation or focused manual retrieval checks until the eval runner exists
- [ ] Sanity script: pick 5 known questions, eyeball whether the right chunks exist

**Done means:** Pinecone index stats report a few thousand records in the target namespace, every sampled record has both vector types and complete citation metadata, and spot-checks look sane.

### Phase 3 — Retrieval + Grounded Answers (days 8-10)
- [ ] `/search`: encode the query as dense + sparse, apply `HYBRID_ALPHA`, and issue one hybrid Pinecone query
- [ ] Validate alpha and the relevance threshold against semantic, exact-term, and off-topic retrieval cases
- [ ] Wire retrieval into `/chat`: retrieve → build grounded prompt ("answer ONLY from these sources; if they don't cover it, say so") → stream answer
- [ ] Emit `sources` event; render citations in the UI as links to nextjs.org
- [ ] The anchor rule: if retrieval returns nothing above a score threshold, the assistant explicitly says the docs don't cover it — no freestyle answers

**Done means:** "how does ISR revalidation work?" gets a correct answer with 2-3 clickable source links; "what's the capital of France?" gets a polite refusal. Test both.

### Phase 4 — Agent Loop + Tools (days 11-13)
- [ ] Refactor `/chat` into an agent loop above the provider: the model can either answer or request a tool; the loop alone resolves the registry entry, validates and dispatches it, feeds the result back, and enforces hard caps (max 5 iterations and max token budget per request). Providers translate tool definitions and normalize tool calls but never execute tools.
- [ ] Extend `LLMProvider.stream_chat` with keyword-only `tools: Sequence[ToolDefinition] = ()`. `ToolDefinition` is provider-neutral (`name`, `description`, `parameters_json_schema`) and is derived from the registered tool's authoritative Pydantic input model. Adapters must reject unsupported schema keywords rather than silently dropping constraints.
- [ ] Normalize provider output to an internal `ToolCallRequest(call_id, name, arguments)`. Keep it separate from the public SSE `tool_call` event; emit that UI event only after the agent loop accepts the tool name, arguments, and applicable policy checks.
- [ ] Gemini uses native function declarations in `tools=[Tool(...)]` with SDK automatic function execution explicitly disabled and function-calling mode `AUTO`. Do not use JSON mode for tool routing. Phase 5 adapters translate the same provider-neutral definitions to their SDKs.
- [ ] Tool 1: `search_docs(query)` — retrieval exposed as a tool the model chooses to call (replaces always-retrieve; the model decides when it needs sources)
- [ ] Tool 2: `fetch_url(url)` — fetch a page from an allowlist (nextjs.org, github.com/vercel only — this is your least-privilege story)
- [ ] Treat native function schemas as model guidance. Pydantic is authoritative for deterministic argument validation (`extra="forbid"`, required fields, types, trimming, bounds, and cross-field rules); the dispatcher/tool layer separately enforces authorization, enabled-tool policy, host and redirect allowlists, rate limits, and remaining budgets.
- [ ] Allow one repair attempt for repairable model-output failures: unknown tool name, malformed call envelope, invalid Pydantic arguments, or multiple calls when the initial loop supports one call per turn. Feed back a sanitized structured issue list, never raw `ValidationError` text or rejected inputs; count the repair against the normal iteration and token caps. A second invalid call ends gracefully without executing a tool.
- [ ] Tool execution failures do not consume the model-output repair retry. After any bounded transient retry owned by the tool/client adapter, authorization failures, cancellation, exhausted budgets or quotas, and operational failures terminate the loop with one sanitized error.
- [ ] Test neutral-schema translation, explicit disabling of SDK automatic execution, stable call IDs, no dispatch before validation and policy acceptance, each repairable failure category, second-failure termination, operational failures bypassing model repair, and iteration/token-cap accounting.
- [ ] Emit `tool_call` events; UI shows "Searching docs…" activity states
- [ ] Log every loop iteration (structured) — you will need this for debugging, guaranteed

**Done means:** a question requiring lookup triggers a visible `search_docs` call; a malformed tool call gets auto-repaired via the retry; loop never exceeds caps.

### Phase 5 — Second Provider (day 14, timeboxed)
- [ ] Add a second chat provider behind the same interface after evaluating the available candidates
- [ ] Provider selected by env var or a UI toggle; normalize tool-call format differences inside each adapter
- [ ] Optional stretch, only if smooth: LangGraph re-implementation of the loop in a separate branch/folder for the "raw vs framework" interview talking point

**Done means:** flipping one setting switches the whole app between providers with zero other changes. This is the "typed multi-provider wrapper" interview answer, running in prod.

### Phase 6 — Observability (days 15... shared with evals)
- [ ] Select and document a telemetry store that supports aggregate queries; do not use Pinecone for request logs
- [ ] Middleware writes one request record per chat: latency, tokens, est. cost, chunks used, tool calls
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
