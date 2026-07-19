# Anchor Docs

> A grounded docs assistant — every answer anchored to its source.

Ask questions about the Next.js documentation and get streamed answers with citations. If the docs don't cover it, Anchor Docs says so instead of making something up.

**Live demo:** _coming soon_ <!-- Vercel URL once Phase 1 ships -->

<!-- Demo GIF goes here in Phase 8 — a 10-second capture of question → streamed answer → clickable citations is worth more than everything below it -->

---

## Why this exists

LLMs answer confidently whether or not they know. Anchor Docs is built around one constraint: **no claim without a source.** Every answer must trace back to retrieved documentation chunks, cited inline — and when retrieval comes up empty, the assistant refuses rather than improvises.

## Architecture

```
┌─────────────────────┐         ┌──────────────────────────┐
│  Next.js (Vercel)   │  SSE    │  FastAPI (Cloud Run)     │
│  Chat UI, citations,│◄────────│  Agent loop, RAG,        │
│  stop generation    │────────►│  provider adapter        │
└─────────────────────┘         └───────────┬──────────────┘
                                            │
                              ┌─────────────┴─────────────┐
                              │  Postgres + pgvector      │
                              │  (Supabase)               │
                              │  Hybrid search:           │
                              │  vector + full-text       │
                              └───────────────────────────┘

Offline: Next.js docs (MDX) → clean → chunk by heading → embed → index
```

## Key design decisions

<!-- Fill these in as you build — each one is a paragraph, written for a technical reviewer skimming the repo. Placeholder summaries below. -->

- **Hybrid retrieval (vector + full-text, reciprocal rank fusion).** Pure vector search misses exact terms like API names and config keys; pure keyword search misses paraphrased questions. Merging both legs fixes each one's blind spot.
- **The anchor rule.** If no retrieved chunk clears the relevance threshold, the assistant explicitly declines. Refusing is a feature, not a failure mode.
- **Hand-rolled agent loop.** Tool calling implemented directly against the provider SDK — max iterations, token budget caps, Pydantic-validated tool arguments with one retry-on-error. <!-- link to loop.py -->
- **Provider-agnostic adapter.** Gemini and Claude behind one interface; switching providers is one env var. <!-- Phase 5 -->
- **Evals as a first-class citizen.** A golden set of ~20 cases (factual, multi-hop, off-topic-must-refuse, ambiguous) runs against the live pipeline; every prompt change ships with a before/after pass-rate diff. <!-- link to evals/ + results table below -->

## Eval results

<!-- Phase 7: paste the pass-rate table here, with dates. Example format:

| Date       | Prompt version | Pass rate | Notes                          |
|------------|----------------|-----------|--------------------------------|
| 2026-08-02 | v1             | 14/20     | baseline                       |
| 2026-08-03 | v2             | 18/20     | tightened grounding instruction|
-->

_Coming in Phase 7._

## Stack

**Frontend:** Next.js 16 · TypeScript · SSE streaming with AbortController
**Backend:** Python 3.14 · FastAPI · Pydantic v2 · uv
**Data:** Postgres + pgvector (Supabase) · HNSW index · Postgres FTS
**Models:** Gemini (chat + embeddings) · Claude <!-- confirm once Phase 5 lands -->
**Infra:** Vercel · Cloud Run (Docker, scale-to-zero) · GitHub Actions <!-- if you add CI -->

## Running locally

<!-- Fill in once the skeleton works. Keep it to the minimum honest steps: -->

```bash
# 1. Prereqs: Python 3.14, uv, Node 24, a Gemini API key, a Postgres/pgvector database

# 2. API
cd api
uv sync
cp .env.example .env   # add GEMINI_API_KEY, DATABASE_URL
uv run uvicorn src.main:app --reload

# 3. Web
cd web
npm install
cp .env.example .env.local
npm run dev

# 4. Ingest the corpus (one-time)
cd ingest
uv run python fetch.py && uv run python clean.py && uv run python chunk.py && uv run python embed.py
```

## Project structure

```
web/       Next.js app (chat UI, citations, stats page)
api/       FastAPI service (agent loop, RAG, providers)
ingest/    Offline pipeline: fetch → clean → chunk → embed
evals/     Golden set + runner
db/        Schema (pgvector, FTS, request logs)
```

## Roadmap

- [x] Repo + plan
- [ ] Phase 1 — Streaming skeleton, deployed
- [ ] Phase 2 — Ingestion pipeline (Next.js docs → pgvector)
- [ ] Phase 3 — Hybrid retrieval + grounded answers with citations
- [ ] Phase 4 — Agent loop + tools (search_docs, fetch_url)
- [ ] Phase 5 — Second provider behind one adapter
- [ ] Phase 6 — Request logging + /stats
- [ ] Phase 7 — Golden-set evals
- [ ] Phase 8 — Polish, demo GIF

---

*Built by [Alvaro Manganello](https://www.linkedin.com/in/YOUR-HANDLE) — Senior Full-Stack Engineer, TypeScript/React/Node + AI product engineering.*