# electric-graphiti

**What if multi-agent memory was a temporal knowledge graph — addressable from anywhere, persistent across sessions, and queryable by graph traversal instead of vector search?**

This project combines [Electric Agents](https://electric.ax/agents) (durable agent streams) with [Graphiti](https://github.com/getzep/graphiti) (temporal knowledge graph memory). Electric solves session addressability — every agent is a durable stream that survives restarts and can be resumed from any machine. Graphiti solves what to do with the stream history — it extracts entities, relationships, and facts into a Neo4j graph that persists across sessions and stays queryable over time.

## The problem

Most agent frameworks give you ephemeral memory. When the session ends, the agent forgets. Solutions in the space either:

- **Use vector search** — similarity retrieval, but no entity resolution, no temporal tracking, no relationship traversal
- **Use raw session history** — full fidelity, but hits token limits; no compression; can't query
- **Use managed agents** (e.g. Anthropic's) — good session primitives, but no cross-session memory and sessions aren't pluggable

## The combination

```
Electric Durable Stream (per agent)
    ↓ conversation episodes
Graphiti ingest pipeline
    → entity extraction + resolution
    → temporal fact tracking
    ↓
Neo4j graph
    ↑ graph traversal at query time
Agent context window (filtered projection)
```

- **Electric** provides the durable, addressable, replayable event substrate. The stream IS the canonical record.
- **Graphiti** is the compression layer. Old turns graduate out of the live context window into the knowledge graph. The agent retrieves them when needed via `graphiti_search`.
- **Result**: agents that remember across sessions, machines, and restarts — with structured, queryable memory instead of a flat embedding store.

## What's confirmed working

- Full pipeline: conversation → `add_episode()` → Neo4j entity + relationship extraction
- Cross-session memory: cold session recalls facts from previous sessions via `graphiti_search`
- `graphiti_search` tool auto-registered on all entity types — scoped by `group_id`
- All OpenAI dependencies removed: claude-haiku for LLM, fastembed/ONNX for embeddings (no API key)
- Offset persistence so memory processor restarts resume without re-ingesting
- Ink TUI: session picker, live SSE stream, send via POST

### Cross-session memory demo

Session `session-2` (cold start, no shared chat history) was asked about facts from `session-3`. It recalled Cedar Pine Consulting, PostgreSQL/RDS, and personal details — all extracted from `session-3`'s conversation and stored in Neo4j, retrieved via graph traversal.

## Architecture decisions

**Why Electric over managed agents?**  
Electric sessions are first-class addressable resources — resumable from any client, any machine, replayable from offset 0. Managed agent sessions are opaque; there's no pluggable session provider, no stream you can tail, no cross-session memory layer.

**Why Graphiti over vector store?**  
Graphiti does entity resolution — "Nigel" and "the user" and "he" merge into one node. It tracks temporal validity — facts that change over time don't overwrite each other. And it supports graph traversal for retrieval, not just similarity search. A vector store would give you approximate nearest neighbors; Graphiti gives you a structured world model.

**Why Neo4j?**  
Graphiti uses it natively. Property graph model matches the domain — entities, typed directed relationships, JSON properties on both. Cypher queries work directly if you need to go past what Graphiti's `search()` exposes.

**Graphiti IS the compaction layer**  
Context window management and memory are the same problem. As sessions grow, verbatim history hits token limits. Graphiti is already extracting facts from old turns into the KG — that extraction *is* compaction. The model: directives (always injected) → recent N turns verbatim → `graphiti_search` for anything older.

## Stack

| Component | Role |
|-----------|------|
| [Electric Agents](https://electric.ax/agents) | Durable agent runtime, entity registry, webhook dispatch |
| [Graphiti](https://github.com/getzep/graphiti) | Temporal KG — entity extraction, fact tracking, graph search |
| [Neo4j](https://neo4j.com) | Graph database backing Graphiti |
| Claude (haiku / sonnet) | LLM for entity extraction + agent responses |
| fastembed | Local ONNX embeddings — no OpenAI dependency |
| Ink (React) | Terminal UI — current default UI for session management |

## Running locally

**Prerequisites:** Docker, Node.js 22+, an Anthropic API key.

```bash
git clone https://github.com/nharsch/electric-graphiti
cd electric-graphiti
cp .env.example .env  # add your ANTHROPIC_API_KEY
docker compose up -d
npm install
```

Everything runs in Docker (`docker compose up -d`): Electric Agents runtime, Neo4j, the memory processor, and the agent server (server.ts). The server uses `network_mode: host` so it can reach the Electric Agents runtime and receive webhook callbacks.

Open the TUI (the current UI — web UI coming):

```bash
npx tsx tui.tsx
```

Create a session, start chatting. Memory is persisted to Neo4j automatically. Open a second session — the agent will recall facts from the first.

**Ports:**
- `4437` — Electric Agents runtime
- `7001` — Graphiti search HTTP API (memory processor)
- `7474` / `7687` — Neo4j browser / Bolt
- `3000` — Agent webhook server

## Repo layout

```
server.ts          — Electric Agents entity registry + graphiti_search tool
tui.tsx            — Ink TUI (session picker, live stream, send)
memory_processor.py — SSE watcher → Graphiti ingest + search HTTP server
docker-compose.yml  — Electric Agents + Neo4j + memory processor
Dockerfile          — memory-processor image
Dockerfile.server   — server.ts image (optional)
```

## What's next

- [ ] VPS deploy — proves "addressable from anywhere"; session pickup across machines
- [ ] Web UI — session picker + chat; monorepo refactor (packages/core, packages/tui, packages/web)
- [ ] `#remember` directives — operational memory via `directive` stream events; injected into system prompt preamble every turn
- [ ] Context window policy — max-N recent turns; trust Graphiti has extracted what matters before dropping

## Related

- [Electric Agents docs](https://electric.ax/agents)
- [Deep Survey demo](https://electric.ax/agents/demos/deep-survey) — multi-agent knowledge graph that dies on session end; this is the layer that makes it persist
- [Graphiti repo](https://github.com/getzep/graphiti)
- [Zep Graphiti paper](https://arxiv.org/abs/2501.13956)
- [ActiveGraph paper](https://arxiv.org/abs/2605.21997) — closest prior work; log-primary reactive graph agent; we add cross-session memory and multi-surface addressability
