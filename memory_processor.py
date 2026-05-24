#!/usr/bin/env python3
"""
Knowledge processor: tails the Episodes entity stream, ingests into Graphiti KG.

Episodes are written by source agents via the add_episode tool.
Each inbox event on /episodes/main/main -> graphiti.add_episode()
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
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
OFFSETS_FILE = Path(os.environ.get("OFFSETS_FILE", "/data/offsets.json"))
SEARCH_PORT = int(os.environ.get("SEARCH_PORT", "7001"))
EPISODES_STREAM = os.environ.get("EPISODES_STREAM", "/episodes/main/main")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

VALID_SOURCES = {e.value for e in EpisodeType}
MAX_EPISODE_CHARS = 2000


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
# Episode ingestion
# ---------------------------------------------------------------------------

def _chunk_text(text: str, max_chars: int) -> list[str]:
    chunks: list[str] = []
    while text:
        if len(text) <= max_chars:
            chunks.append(text)
            break
        split_at = text.rfind("\n\n", 0, max_chars)
        if split_at == -1:
            split_at = text.rfind(". ", 0, max_chars)
        if split_at == -1:
            split_at = max_chars
        else:
            split_at += 2
        chunks.append(text[:split_at].strip())
        text = text[split_at:].strip()
    return [c for c in chunks if c]


async def ingest_episode(graphiti: Graphiti, payload: dict) -> None:
    ref_time = datetime.now(timezone.utc)
    name = payload.get("name") or f"episode-{int(ref_time.timestamp())}"
    episode_body = payload.get("episode_body", "")
    source_str = payload.get("source", "message")
    source_description = payload.get("source_description", "agent episode")
    group_id = payload.get("group_id") or "default"
    custom_instructions = payload.get("custom_extraction_instructions")

    source = EpisodeType(source_str) if source_str in VALID_SOURCES else EpisodeType.message

    if not episode_body:
        log.warning("Skipping episode with empty body: %s", name)
        return

    chunks = _chunk_text(episode_body, MAX_EPISODE_CHARS)
    for i, chunk in enumerate(chunks):
        chunk_name = name if len(chunks) == 1 else f"{name}-part{i + 1}"
        try:
            await graphiti.add_episode(
                name=chunk_name,
                episode_body=chunk,
                source_description=source_description,
                reference_time=ref_time,
                source=source,
                group_id=group_id,
                custom_extraction_instructions=custom_instructions,
            )
            log.info("[%s] ingested %s (group=%s)", source_str, chunk_name, group_id)
        except Exception as exc:
            log.error("Ingest failed for %s: %s", chunk_name, exc)


# ---------------------------------------------------------------------------
# Episodes stream watcher
# ---------------------------------------------------------------------------

async def watch_episodes_stream(graphiti: Graphiti, offsets: dict, http: httpx.AsyncClient) -> None:
    stream_url = f"{ELECTRIC_URL}{EPISODES_STREAM}"
    log.info("Watching episodes stream: %s", stream_url)

    start_offset = offsets.get("episodes", "-1")
    log.info("Starting from offset %s", start_offset)

    # Batch-load history up to current tip
    try:
        r = await http.get(f"{stream_url}?offset={start_offset}", timeout=30)
        if r.is_success:
            for e in r.json():
                if e.get("type") == "inbox" and e["headers"].get("operation") == "insert":
                    payload = (e.get("value") or {}).get("payload") or {}
                    if payload:
                        await ingest_episode(graphiti, payload)
            tip = r.headers.get("stream-next-offset")
            if tip:
                offsets["episodes"] = tip
                save_offsets(offsets)
    except Exception as exc:
        log.warning("History load failed: %s", exc)

    # Live SSE tail
    current_offset = offsets.get("episodes", "-1")
    while True:
        try:
            async with http.stream(
                "GET",
                f"{stream_url}?offset={current_offset}&live=sse",
                timeout=None,
            ) as resp:
                if resp.status_code != 200:
                    log.warning("SSE returned %s, retrying in 5s", resp.status_code)
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
                            offsets["episodes"] = current_offset
                            save_offsets(offsets)

                        elif event_type == "data":
                            for e in json.loads(data_str):
                                if e.get("type") == "inbox" and e["headers"].get("operation") == "insert":
                                    payload = (e.get("value") or {}).get("payload") or {}
                                    if payload:
                                        await ingest_episode(graphiti, payload)

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("SSE error: %s — reconnecting in 5s", exc)
            await asyncio.sleep(5)


# ---------------------------------------------------------------------------
# Search HTTP server
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main() -> None:
    if not ANTHROPIC_API_KEY:
        raise SystemExit("ANTHROPIC_API_KEY is not set")

    log.info("Knowledge processor starting")
    log.info("  Electric:        %s", ELECTRIC_URL)
    log.info("  Neo4j:           %s", NEO4J_URI)
    log.info("  Episodes stream: %s", EPISODES_STREAM)

    llm = AnthropicLLMClient(ANTHROPIC_API_KEY)
    embedder = FastEmbedder()

    graphiti = Graphiti(
        NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD,
        llm_client=llm, embedder=embedder, cross_encoder=NoOpCrossEncoder(),
    )
    await graphiti.build_indices_and_constraints()
    log.info("Graphiti ready")

    search_app = create_search_app(graphiti)
    runner = web.AppRunner(search_app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", SEARCH_PORT)
    await site.start()
    log.info("Search server listening on port %d", SEARCH_PORT)

    offsets = load_offsets()
    async with httpx.AsyncClient() as http:
        await watch_episodes_stream(graphiti, offsets, http)


if __name__ == "__main__":
    asyncio.run(main())
