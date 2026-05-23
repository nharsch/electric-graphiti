#!/usr/bin/env python3
"""
Memory processor: tails Electric Agent streams, ingests message-pair episodes into Graphiti.

For each live entity:
  - Loads history from last saved offset (or full history on first run)
  - Pairs user inbox messages with completed assistant text events
  - Calls graphiti.add_episode() per pair
  - Saves offset after each ingestion so restarts resume without re-ingesting
"""

import asyncio
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from aiohttp import web
from anthropic import AsyncAnthropic
from graphiti_core import Graphiti
from graphiti_core.cross_encoder.client import CrossEncoderClient
from graphiti_core.embedder.client import EmbedderClient
from graphiti_core.llm_client.client import LLMClient, LLMConfig, Message, ModelSize
from graphiti_core.nodes import EpisodeType

ELECTRIC_URL = os.environ.get("ELECTRIC_AGENTS_URL", "http://host.docker.internal:4437")
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://neo4j:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")
ENTITY_TYPE = os.environ.get("ENTITY_TYPE", "assistant")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
OFFSETS_FILE = Path(os.environ.get("OFFSETS_FILE", "/data/offsets.json"))
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "30"))
SEARCH_PORT = int(os.environ.get("SEARCH_PORT", "7001"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# LLM client — Anthropic SDK
# ---------------------------------------------------------------------------

class AnthropicLLMClient(LLMClient):
    """graphiti LLMClient backed by the Anthropic SDK."""

    def __init__(self, api_key: str, model: str = "claude-haiku-4-5-20251001"):
        config = LLMConfig(api_key=api_key, model=model, small_model=model)
        super().__init__(config)
        self._anthro = AsyncAnthropic(api_key=api_key)

    def _get_provider_type(self) -> str:
        return "anthropic"

    async def _generate_response(
        self,
        messages: list[Message],
        response_model=None,
        max_tokens: int = 8192,
        model_size: ModelSize = ModelSize.medium,
    ) -> dict[str, Any]:
        model = self.model if model_size == ModelSize.medium else self.small_model

        system_parts: list[str] = []
        anthropic_messages: list[dict] = []
        for msg in messages:
            if msg.role == "system":
                system_parts.append(msg.content)
            else:
                anthropic_messages.append({"role": msg.role, "content": msg.content})

        if not anthropic_messages:
            anthropic_messages = [{"role": "user", "content": "Continue."}]

        system = "\n\n".join(system_parts) if system_parts else "You are a helpful assistant."

        resp = await self._anthro.messages.create(
            model=model,
            max_tokens=min(max_tokens, 8096),
            system=system,
            messages=anthropic_messages,
        )

        text = resp.content[0].text if resp.content else "{}"
        return _extract_json(text)


def _extract_json(text: str) -> dict[str, Any]:
    """Pull the first JSON object out of a text response."""
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError:
        pass
    match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass
    log.warning("Could not parse JSON from LLM response: %.200s", text)
    return {}


# ---------------------------------------------------------------------------
# Embedder — fastembed (local ONNX, no API key)
# ---------------------------------------------------------------------------

class FastEmbedder(EmbedderClient):
    """Local embedder using fastembed (BAAI/bge-small-en-v1.5, ~67 MB)."""

    def __init__(self, model_name: str = "BAAI/bge-small-en-v1.5"):
        from fastembed import TextEmbedding
        self._model = TextEmbedding(model_name=model_name)
        log.info("Embedder ready: %s", model_name)

    async def create(self, input_data) -> list[float]:
        text = input_data if isinstance(input_data, str) else str(input_data)
        return next(self._model.embed([text])).tolist()

    async def create_batch(self, input_data_list: list[str]) -> list[list[float]]:
        return [e.tolist() for e in self._model.embed(input_data_list)]


# ---------------------------------------------------------------------------
# Cross encoder — no-op (avoids OpenAI dependency; disables reranking)
# ---------------------------------------------------------------------------

class NoOpCrossEncoder(CrossEncoderClient):
    async def rank(self, query: str, passages: list[str]) -> list[tuple[str, float]]:
        return [(p, 1.0) for p in passages]


# ---------------------------------------------------------------------------
# Offset persistence
# ---------------------------------------------------------------------------

def load_offsets() -> dict:
    if OFFSETS_FILE.exists():
        return json.loads(OFFSETS_FILE.read_text())
    return {}


def save_offsets(offsets: dict) -> None:
    OFFSETS_FILE.parent.mkdir(parents=True, exist_ok=True)
    OFFSETS_FILE.write_text(json.dumps(offsets, indent=2))


# ---------------------------------------------------------------------------
# Stream processing
# ---------------------------------------------------------------------------

def process_batch(
    events: list,
    pending_user: dict[str, str],
    text_buffers: dict[str, list[str]],
) -> tuple[list[tuple[str, str, datetime]], str | None]:
    """
    Walk a batch of stream events, pair user+assistant turns.
    Returns (pairs_to_ingest, last_seen_offset).
    Mutates pending_user and text_buffers in place.
    """
    pairs: list[tuple[str, str, datetime]] = []
    last_offset: str | None = None

    for e in events:
        last_offset = e["headers"]["offset"]
        v = e.get("value", {})
        etype = e.get("type")
        op = e["headers"].get("operation")

        if etype == "inbox" and op == "insert":
            payload = v.get("payload")
            text = payload if isinstance(payload, str) else (payload or {}).get("text")
            if text:
                pending_user[e["key"]] = text

        elif etype == "text_delta":
            tid = v.get("text_id")
            if tid:
                text_buffers.setdefault(tid, []).append(v.get("delta", ""))

        elif etype == "text" and op == "update" and v.get("status") == "completed":
            buf = text_buffers.pop(e["key"], None)
            if buf and pending_user:
                assistant_text = "".join(buf)
                inbox_key = next(iter(pending_user))
                user_text = pending_user.pop(inbox_key)
                pairs.append((user_text, assistant_text, datetime.now(timezone.utc)))

    return pairs, last_offset


async def ingest_episode(
    graphiti: Graphiti,
    entity_id: str,
    user_text: str,
    assistant_text: str,
    ref_time: datetime,
) -> None:
    body = f"User: {user_text}\nAssistant: {assistant_text}"
    name = f"exchange-{entity_id}-{int(ref_time.timestamp())}"
    try:
        await graphiti.add_episode(
            name=name,
            episode_body=body,
            source_description=f"Electric Agents session {entity_id}",
            reference_time=ref_time,
            source=EpisodeType.message,
            group_id=entity_id,
        )
        log.info("[%s] ingested episode %s", entity_id, name)
    except Exception as exc:
        log.error("[%s] ingest failed: %s", entity_id, exc)


# ---------------------------------------------------------------------------
# Per-entity stream watcher
# ---------------------------------------------------------------------------

async def watch_entity(
    entity_id: str,
    graphiti: Graphiti,
    offsets: dict,
    http: httpx.AsyncClient,
) -> None:
    stream_url = f"{ELECTRIC_URL}/{ENTITY_TYPE}/{entity_id}/main"
    pending_user: dict[str, str] = {}
    text_buffers: dict[str, list[str]] = {}

    # Resume from saved offset, or load full history on first run
    start_offset = offsets.get(entity_id, "-1")
    log.info("[%s] starting from offset %s", entity_id, start_offset)

    # Batch-load history up to current tip
    try:
        r = await http.get(f"{stream_url}?offset={start_offset}", timeout=30)
        if r.is_success:
            events = r.json()
            pairs, last_offset = process_batch(events, pending_user, text_buffers)
            for pair in pairs:
                await ingest_episode(graphiti, entity_id, *pair)
            # Use last event offset, falling back to stream-next-offset header
            tip = last_offset or r.headers.get("stream-next-offset")
            if tip:
                offsets[entity_id] = tip
                save_offsets(offsets)
    except Exception as exc:
        log.warning("[%s] history load failed: %s", entity_id, exc)

    # Live SSE tail — offset must be a valid stream offset string, not "0"
    current_offset = offsets.get(entity_id, "-1")
    while True:
        try:
            async with http.stream(
                "GET",
                f"{stream_url}?offset={current_offset}&live=sse",
                timeout=None,
            ) as resp:
                if resp.status_code != 200:
                    log.warning("[%s] SSE returned %s, retrying in 5s", entity_id, resp.status_code)
                    await asyncio.sleep(5)
                    continue
                buf = ""
                async for chunk in resp.aiter_text():
                    buf += chunk
                    while "\n\n" in buf:
                        part, buf = buf.split("\n\n", 1)
                        lines = part.strip().split("\n")
                        event_type = next(
                            (l[6:].strip() for l in lines if l.startswith("event:")), None
                        )
                        data_str = next(
                            (l[5:].strip() for l in lines if l.startswith("data:")), None
                        )
                        if not event_type or not data_str:
                            continue

                        if event_type == "control":
                            ctrl = json.loads(data_str)
                            current_offset = ctrl.get("streamNextOffset", current_offset)
                            offsets[entity_id] = current_offset
                            save_offsets(offsets)

                        elif event_type == "data":
                            events = json.loads(data_str)
                            pairs, _ = process_batch(events, pending_user, text_buffers)
                            for pair in pairs:
                                await ingest_episode(graphiti, entity_id, *pair)

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("[%s] SSE error: %s — reconnecting in 5s", entity_id, exc)
            await asyncio.sleep(5)


# ---------------------------------------------------------------------------
# Main loop — discovers entities and spawns watchers
# ---------------------------------------------------------------------------

async def get_entities(http: httpx.AsyncClient) -> list[str]:
    try:
        r = await http.get(f"{ELECTRIC_URL}/_electric/entities?type={ENTITY_TYPE}", timeout=10)
        return [
            e["url"].split("/")[-1]
            for e in r.json()
            if e.get("status") != "killed"
        ]
    except Exception as exc:
        log.warning("Entity list failed: %s", exc)
        return []


def _serialize(obj: Any) -> Any:
    if hasattr(obj, "model_dump"):
        return _serialize(obj.model_dump())
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {k: _serialize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_serialize(i) for i in obj]
    return obj


def create_search_app(graphiti: Graphiti) -> web.Application:
    async def handle_search(request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)

        query = body.get("query", "").strip()
        if not query:
            return web.json_response({"error": "query is required"}, status=400)

        group_id = body.get("group_id")
        group_ids = [group_id] if group_id else None

        try:
            results = await graphiti.search(query, group_ids=group_ids)
            return web.json_response({"results": _serialize(results)})
        except Exception as exc:
            log.error("Search failed: %s", exc)
            return web.json_response({"error": str(exc)}, status=500)

    app = web.Application()
    app.router.add_post("/search", handle_search)
    return app


async def main() -> None:
    if not ANTHROPIC_API_KEY:
        raise SystemExit("ANTHROPIC_API_KEY is not set")

    log.info("Memory processor starting")
    log.info("  Electric: %s", ELECTRIC_URL)
    log.info("  Neo4j:    %s", NEO4J_URI)

    llm = AnthropicLLMClient(ANTHROPIC_API_KEY)
    embedder = FastEmbedder()

    graphiti = Graphiti(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, llm_client=llm, embedder=embedder, cross_encoder=NoOpCrossEncoder())
    await graphiti.build_indices_and_constraints()
    log.info("Graphiti ready")

    search_app = create_search_app(graphiti)
    runner = web.AppRunner(search_app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", SEARCH_PORT)
    await site.start()
    log.info("Search server listening on port %d", SEARCH_PORT)

    offsets = load_offsets()
    watchers: dict[str, asyncio.Task] = {}

    async with httpx.AsyncClient() as http:
        while True:
            entity_ids = await get_entities(http)
            for eid in entity_ids:
                if eid not in watchers or watchers[eid].done():
                    log.info("Spawning watcher for %s", eid)
                    watchers[eid] = asyncio.create_task(
                        watch_entity(eid, graphiti, offsets, http)
                    )
            await asyncio.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    asyncio.run(main())
