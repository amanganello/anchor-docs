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
                              │  Pinecone serverless      │
                              │  Hybrid search:           │
                              │  dense + sparse vectors   │
                              │  citation metadata        │
                              └───────────────────────────┘

Offline: Next.js docs (MDX) → clean → chunk by heading → embed → index
```

## Key design decisions

<!-- Fill these in as you build — each one is a paragraph, written for a technical reviewer skimming the repo. Placeholder summaries below. -->

- **Native hybrid retrieval (dense + sparse vectors).** One Pinecone query combines semantic similarity with exact-term sensitivity. `HYBRID_ALPHA` starts at `0.5` and is tuned with retrieval evals rather than guesswork.
- **The anchor rule.** If no retrieved chunk clears the relevance threshold, the assistant explicitly declines. Refusing is a feature, not a failure mode.
- **Hand-rolled agent loop.** Tool calling implemented directly against the provider SDK — max iterations, token budget caps, Pydantic-validated tool arguments with one retry-on-error. <!-- link to loop.py -->
- **Explicit provider boundaries.** Chat generation and dense embeddings use separate provider adapters. Sparse encoding deliberately uses Pinecone's hosted English sparse model to keep the hybrid pipeline operationally simple.
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
**Retrieval:** Pinecone serverless · dense + sparse hybrid vectors · citation metadata
**Models:** chat provider under evaluation · provider-neutral dense embeddings · Pinecone sparse encoding
**Infra:** Vercel · Cloud Run (Docker, scale-to-zero) · GitHub Actions <!-- if you add CI -->

The request-log and `/stats` persistence layer will be selected in Phase 6;
Pinecone is used only for documentation retrieval.

## Running locally

The frontend and the first ingestion stages are currently available. Backend
startup and full Pinecone ingestion commands will be added when those components
are scaffolded.

```bash
# Web (Node 24)
cd web
npm install
cp .env.example .env.local
npm run dev

# Fetch and clean the corpus (Python 3.14 with httpx installed)
cd ../ingest
python fetch_MDX.py
python clean_MDX.py
```

## Project structure

```
web/       Next.js app (chat UI, citations, stats page)
backend/   FastAPI service (agent loop, RAG, providers)
ingest/    Offline pipeline: fetch → clean → chunk → embed
evals/     Golden set + runner
```

## Roadmap

- [x] Repo + plan
- [ ] Phase 1 — Streaming skeleton, deployed
- [ ] Phase 2 — Ingestion pipeline (Next.js docs → Pinecone hybrid index)
- [ ] Phase 3 — Hybrid retrieval + grounded answers with citations
- [ ] Phase 4 — Agent loop + tools (search_docs, fetch_url)
- [ ] Phase 5 — Second provider behind one adapter
- [ ] Phase 6 — Request logging + /stats
- [ ] Phase 7 — Golden-set evals
- [ ] Phase 8 — Polish, demo GIF

---

*Built by [Alvaro Manganello](https://www.linkedin.com/in/YOUR-HANDLE) — Senior Full-Stack Engineer, TypeScript/React/Node + AI product engineering.*
