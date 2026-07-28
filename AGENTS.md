# AGENTS.md

This file is the repository-wide working agreement for coding agents. More
specific `AGENTS.md` files override it within their own directory.

## Project purpose

Anchor Docs is a grounded assistant for the Next.js documentation. It streams
answers to the web client, cites the documentation used, and refuses to invent
an answer when retrieval does not provide adequate support.

The non-negotiable product behaviors are:

- streamed answers that the user can stop;
- claims grounded in retrieved Next.js documentation;
- clickable source citations;
- explicit refusal for unsupported or off-topic questions;
- hybrid retrieval and a repeatable evaluation suite.

`PLAN.md` describes the intended architecture and phased roadmap. Treat it as
direction, not proof that a component already exists. Inspect the current tree
before relying on a path or command from the plan.

## Repository map

- `web/`: Next.js 16, React 19, and TypeScript frontend.
- `backend/`: backend work in progress. The plan may still call this service
  `api/`; use `backend/` unless the repository is deliberately reorganized.
- `ingest/`: offline Python pipeline for fetching and cleaning Next.js MDX.
- `docs/superpowers/plans/`: implementation notes for scoped phases.
- `PLAN.md`: architecture, delivery phases, and acceptance criteria.
- `Readme.md`: public project overview. The filename currently has this exact
  capitalization.

Generated or downloaded content such as `web/.next/`, `web/node_modules/`, and
`ingest/corpus/` is not source code. Do not edit or commit it.

## Start every task

1. Read this file and any nearer `AGENTS.md` in the target directory.
2. Check `git status --short`; preserve unrelated user changes.
3. Inspect the relevant implementation, tests, and package configuration.
4. Check the applicable phase and acceptance criteria in `PLAN.md`.
5. Make the smallest coherent change that completes the requested behavior.

Do not implement later roadmap phases opportunistically. Do not rename
`backend/` to `api/` or reopen the Pinecone retrieval decision unless the task
explicitly requires it. The chat-generation and dense-embedding providers are
not yet chosen; do not couple them accidentally.

## Git workflow

Every new feature or task must be developed on its own branch — never commit
feature work directly to `main` or to a phase integration branch.

Before writing any code for a new task or feature:

1. Identify the current integration branch (e.g. `feat/phase1-frontend`) or
   use `main` if no phase branch exists.
2. Create a task branch off that integration branch:
   `git checkout -b feat/task-N-<short-description>`
3. Commit all work to the task branch.
4. The controller or reviewer merges the task branch into the integration
   branch after review passes — do not self-merge.

Branch naming: `feat/task-N-<short-description>` for planned tasks,
`fix/<short-description>` for bug fixes, `chore/<short-description>` for
non-feature changes.

## Commands

Run frontend commands from `web/`:

```bash
npm install
npm run dev
npm test
npm run lint
npm run build
```

Prefer `npm ci` in a clean or CI environment when `package-lock.json` is
authoritative. For a normal code change, run the narrowest relevant test first,
then `npm test` and `npm run lint`. Run `npm run build` when changing routing,
configuration, server/client boundaries, environment handling, or other
build-sensitive behavior.

The Python service is not yet fully scaffolded. Do not invent a backend test or
run command from `PLAN.md`; use the checked-in `pyproject.toml`/lockfile and its
documented commands once they exist.

Run the current ingestion scripts from `ingest/`:

```bash
python fetch_MDX.py
python clean_MDX.py
```

These scripts perform network access and replace their destination directories.
Do not run them merely to validate an unrelated edit. Use temporary
destinations for focused checks where practical:

```bash
python fetch_MDX.py --dest /tmp/anchor-docs-corpus
python clean_MDX.py --src /tmp/anchor-docs-corpus --dest /tmp/anchor-docs-cleaned
```

## Architecture contracts

### Retrieval

Pinecone native hybrid retrieval is the source of truth. Use one Pinecone
serverless index containing both a dense and a sparse vector for every chunk,
with the `dotproduct` metric. Do not introduce Supabase, Postgres, pgvector, a
separate Postgres FTS leg, or client-side RRF for document retrieval.

Keep the concerns and provider boundaries explicit:

- chat generation uses its own provider adapter;
- dense embeddings use an `EmbeddingProvider` adapter;
- sparse encoding uses a narrow `SparseEncoder` interface backed by Pinecone
  standalone inference;
- Pinecone stores and searches document chunk vectors;
- telemetry persistence is deferred until Phase 6 and must not use Pinecone as
  a request-log store.

The chat-generation provider, dense-embedding provider, and dense-vector
dimension remain undecided. Select the dense model before creating the
production index, validate that the index dimension matches it, and require a
deliberate migration when changing dimensions.

Use `pinecone-sparse-english-v0` through standalone inference calls, not
integrated-index auto-embedding:

- use `input_type="passage"` when encoding corpus chunks;
- use `input_type="query"` when encoding retrieval queries;
- record the sparse model name, input type, `max_tokens_per_sequence`,
  truncation policy, and encoding version in the corpus manifest;
- treat the model as designed for English retrieval and reconsider it before
  ingesting a non-English corpus.

This Pinecone-specific sparse encoding is an intentional simplicity tradeoff,
not a portable configuration choice. Keep `SparseEncoder` narrow for
deterministic tests and a future migration seam, but changing sparse models
requires complete sparse-vector regeneration and corpus upsert.

Hybrid queries must scale the dense and sparse query vectors explicitly. Start
with `HYBRID_ALPHA=0.5`; `1.0` is a dense-only diagnostic, not the production
hybrid default. Validate alpha in the inclusive range `[0.0, 1.0]` and select
the production value using retrieval evals rather than intuition.

Pinecone inference and ingestion guardrails:

- estimate corpus tokens and verify the current inference allowance before a
  full ingestion;
- set `max_tokens_per_sequence` explicitly to either `512` or `2048`;
- set truncation behavior explicitly, preferring a visible failure over silent
  truncation when content integrity matters;
- limit sparse-inference batches to 96 sequences and also respect request-size
  limits;
- retry transient rate-limit and server failures with bounded exponential
  backoff;
- treat an exhausted monthly inference quota as a non-retryable, actionable
  failure;
- never create, delete, or rebuild a remote index during routine tests.

Changes to the dense model, sparse encoding, alpha, relevance thresholds,
metadata, namespaces, or index configuration require retrieval tests. Record
the before/after eval result when an eval runner exists; until then, document
the focused manual retrieval checks.

### Streaming

Keep the SSE event vocabulary aligned across the frontend and backend:

- `token`: `{ type, text }`
- `sources`: `{ type, items: [{ title, url, heading }] }`
- `tool_call`: `{ type, name, args }`
- `done`: `{ type, usage: { input_tokens, output_tokens, latency_ms } }`
- `error`: `{ type, message }`

The frontend definitions currently live in `web/lib/types.ts`. If a backend
schema changes, update the frontend type, parser behavior, mocks, and contract
tests in the same change.

Preserve streaming semantics:

- parse chunk boundaries incrementally rather than assuming one event per
  network chunk;
- tolerate SSE comments/keep-alives and malformed individual events;
- release stream readers and propagate cancellation;
- keep Stop wired to `AbortController`, not a cosmetic state change;
- do not buffer the complete model response before rendering it.

Preserve grounding semantics:

- citations must come from retrieved documents, never model-invented URLs;
- no retrieval result above the relevance threshold means refusal;
- keep retrieved chunk identity through generation, citations, and logging;
- changes to prompts, ranking, thresholds, chunking, or provider normalization
  require relevant eval coverage or a documented manual check until the eval
  runner exists.

## Code conventions

### TypeScript and React

- Keep TypeScript strict; do not weaken `strict` or
  `noUncheckedIndexedAccess`.
- Prefer explicit discriminated unions for protocol and state-machine events.
- Use the `@/` alias for imports from the `web/` root.
- Default to Server Components. Add `"use client"` only where browser APIs,
  event handlers, or client state require it.
- Keep transport parsing and domain logic outside presentation components.
- Make interactive controls keyboard accessible and give loading, error, empty,
  and cancellation states visible UI.
- Follow the additional Next.js rules in `web/AGENTS.md`.

### Python

- Use modern type hints on public functions and data structures.
- Use Pydantic models at API and tool boundaries; do not pass unchecked model
  output into tools.
- Keep provider-specific request/response normalization inside provider
  adapters.
- Keep filesystem paths configurable with `pathlib.Path`.
- Network calls need explicit timeouts and actionable failure messages.
- Destructive refresh behavior must target the resolved, caller-supplied
  corpus/output directory only.

### Tests

- Add or update tests for behavior changes and bug fixes.
- Prefer observable behavior over implementation-detail assertions.
- Keep tests deterministic: mock model, network, clock, and database boundaries.
- For streaming, cover split chunks, multiple events per chunk, cancellation,
  malformed events, errors, and final-buffer handling as applicable.
- For ingestion, use small temporary fixtures; never depend on the downloaded
  corpus for unit tests.

## Security and data handling

- Never commit `.env` files, credentials, database URLs, model keys, or request
  transcripts containing sensitive data.
- Add only variable names and safe placeholders to `.env.example`.
- Keep provider credentials server-side; the web app should call a server route
  or backend service, not expose keys to browser code.
- `fetch_url` must remain allowlisted to the approved documentation sources.
- Validate tool arguments, URLs, request sizes, and iteration/token caps at
  trust boundaries.
- Do not log secrets, authorization headers, raw provider payloads, or more user
  content than the observability requirement needs.

## Documentation and handoff

Keep documentation honest. If a change makes a README command, repository path,
environment variable, API event, or architecture statement inaccurate, update
the relevant document in the same change. Do not mark a roadmap item complete
until its stated “Done means” criteria are met.

Before handing off:

- review `git diff` and confirm only intended files changed;
- report the behavior delivered, not just the files touched;
- list the checks run and their results;
- call out checks not run and the concrete reason;
- mention migrations, new environment variables, or follow-up deployment steps.

Use the repository's existing commit style when commits are requested, for
example `feat(web): ...`, `fix(ingest): ...`, or `docs: ...`.
