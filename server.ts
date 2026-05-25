import path from "node:path"
try { process.loadEnvFile(path.resolve(import.meta.dirname, ".env")) } catch {}

import http from "node:http"
import { Type } from "@sinclair/typebox"
import {
  createEntityRegistry,
  createRuntimeHandler,
} from "@electric-ax/agents-runtime"
import Anthropic from "@anthropic-ai/sdk"
import { createBashTool, createFetchUrlTool } from "@electric-ax/agents-runtime/tools"

const ELECTRIC_AGENTS_URL =
  process.env.ELECTRIC_AGENTS_URL ?? "http://localhost:4437"
const PORT = Number(process.env.PORT ?? 3000)
const SERVE_URL = process.env.SERVE_URL ?? `http://localhost:${PORT}`
const GRAPHITI_URL = process.env.GRAPHITI_URL ?? "http://localhost:7001"

const registry = createEntityRegistry()

const WORK_DIR = process.env.WORK_DIR ?? process.cwd()

const bashTool = createBashTool(WORK_DIR)

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY is not set")
  process.exit(1)
}

function parseDdgHtml(html: string): string {
  // Extract result titles, URLs, and snippets from DDG HTML response
  const results: string[] = []
  const resultRegex = /<a class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  let match
  while ((match = resultRegex.exec(html)) !== null && results.length < 8) {
    const url = match[1]
    const title = match[2].replace(/<[^>]+>/g, '').trim()
    const snippet = match[3].replace(/<[^>]+>/g, '').trim()
    results.push(`**${title}**\n${url}\n${snippet}`)
  }
  if (results.length === 0) {
    // Fallback: just strip all tags and return trimmed text
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000)
  }
  return results.join('\n\n')
}

const webSearchTool = {
  name: "web_search",
  label: "Web Search",
  description: "Search the web using DuckDuckGo. Returns titles, URLs, and snippets for the top results.",
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
  }),
  async execute(_id: string, { query }: { query: string }) {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; electric-graphiti/1.0)",
          "Accept": "text/html",
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const html = await res.text()
      const text = parseDdgHtml(html)
      return { content: [{ type: "text" as const, text }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: "text" as const, text: `Search failed: ${msg}` }] }
    }
  },
}

import { execFile } from "node:child_process"
import { promisify } from "node:util"
const execFileAsync = promisify(execFile)

async function htmlToText(html: string, prompt: string, anthropic: Anthropic): Promise<string> {
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: "Extract the requested information from the page content. Return only the extracted content, without commentary.",
    messages: [{ role: "user", content: `${prompt}\n\n<page_content>\n${html.slice(0, 50000)}\n</page_content>` }],
  })
  const block = msg.content[0]
  return block.type === "text" ? block.text : ""
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY })
const fetchTool = createFetchUrlTool({
  extractWithLLM: (text, prompt) => htmlToText(text, prompt, anthropic),
})

const fetchJsTool = {
  name: "fetch_url_js",
  label: "Fetch URL (JS)",
  description: "Fetch a JS-rendered web page using headless Chromium. Use when fetch_url returns empty or incomplete content due to JavaScript rendering. Slower than fetch_url — only use when needed.",
  parameters: Type.Object({
    url: Type.String({ description: "The URL to fetch" }),
    prompt: Type.String({ description: "What to extract from the page" }),
  }),
  async execute(_id: string, { url, prompt }: { url: string; prompt: string }) {
    try {
      const { stdout } = await execFileAsync("chromium", [
        "--headless", "--disable-gpu", "--no-sandbox", "--dump-dom",
        "--virtual-time-budget=5000", url,
      ], { timeout: 20_000 })
      const text = await htmlToText(stdout, prompt, anthropic)
      return { content: [{ type: "text" as const, text }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: "text" as const, text: `JS fetch failed: ${msg}` }] }
    }
  },
}

registry.define("assistant", {
  description: "Electric Graphiti assistant — durable stream + temporal memory",
  async handler(ctx) {
    console.log(`[handler] wake for ${ctx.entityUrl}, apiKey present: ${!!ANTHROPIC_API_KEY}`)
    ctx.useAgent({
      systemPrompt: `You are a helpful assistant with access to bash, web search, web fetch, and persistent memory. For JS-rendered sites where fetch_url returns empty content, use fetch_url_js (headless Chromium).

When you identify something worth remembering — a factual claim, user preference, or receive a document for ingestion — call add_episode:
- fact_triple: an explicit factual assertion ("user prefers X", "project uses Y", "X is defined as Y")
- text: a document, article, or unstructured corpus handed to you
- json: structured data

Conversational exchanges don't need explicit episodes. Search your memory with graphiti_search when context from past sessions may be relevant.

Keep responses concise.`,
      model: "claude-sonnet-4-5-20250929",
      getApiKey: async (provider) => {
        console.log(`[getApiKey] called for provider: ${provider}, key present: ${!!ANTHROPIC_API_KEY}`)
        return ANTHROPIC_API_KEY
      },
      tools: [...ctx.electricTools, bashTool, fetchTool, fetchJsTool, webSearchTool],
    })
    await ctx.agent.run()
  },
})

registry.define("episodes", {
  description: "Durable episode stream — write target for knowledge graph ingestion",
  async handler(_ctx) {
    // No-op: this entity is a write target only; the knowledge processor tails the stream
  },
})

const runtime = createRuntimeHandler({
  baseUrl: ELECTRIC_AGENTS_URL,
  serveEndpoint: `${SERVE_URL}/webhook`,
  registry,
  async createElectricTools({ entityUrl, entityType }) {
    return [{
      name: "add_episode",
      label: "Write Episode",
      description: "Write a knowledge episode to long-term memory. Use for factual claims, user preferences, or documents for ingestion.",
      parameters: Type.Object({
        name: Type.String({ description: "Short label for this episode" }),
        episode_body: Type.String({ description: "Content to store" }),
        source: Type.Union([
          Type.Literal("fact_triple"),
          Type.Literal("text"),
          Type.Literal("json"),
        ], { description: "fact_triple: explicit assertion. text: document/corpus. json: structured data." }),
        source_description: Type.String({ description: "Where this came from, e.g. 'user stated', 'uploaded document'" }),
        custom_extraction_instructions: Type.Optional(Type.String({ description: "Hint to Graphiti about what to extract" })),
      }),
      async execute(_id: string, params: {
        name: string
        episode_body: string
        source: "fact_triple" | "text" | "json"
        source_description: string
        custom_extraction_instructions?: string
      }) {
        try {
          const res = await fetch(`${ELECTRIC_AGENTS_URL}/_electric/entities/episodes/main/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              payload: {
                name: params.name,
                episode_body: params.episode_body,
                source: params.source,
                source_description: params.source_description,
                group_id: entityType,
                custom_extraction_instructions: params.custom_extraction_instructions,
              },
            }),
            signal: AbortSignal.timeout(10_000),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return { content: [{ type: "text" as const, text: `Episode written: ${params.name}` }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: [{ type: "text" as const, text: `Failed to write episode: ${msg}` }] }
        }
      },
    }, {
      name: "graphiti_search",
      label: "Memory Search",
      description: "Search the temporal knowledge graph for facts, entities, and context from past conversations with this agent.",
      parameters: Type.Object({
        query: Type.String({ description: "Natural language query — what to recall or look up" }),
      }),
      async execute(_id: string, { query }: { query: string }) {
        try {
          const res = await fetch(`${GRAPHITI_URL}/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, group_id: entityType }),
            signal: AbortSignal.timeout(15_000),
          })
          const data = await res.json() as { results?: unknown; error?: string }
          if (data.error) throw new Error(data.error)
          const text = JSON.stringify(data.results, null, 2)
          return {
            content: [{ type: "text" as const, text }],
            details: { entityType },
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return {
            content: [{ type: "text" as const, text: `Search failed: ${msg}` }],
            details: { entityType },
          }
        }
      },
    }]
  },
})

const server = http.createServer(async (req, res) => {
  if (req.url === "/webhook" && req.method === "POST") {
    await runtime.onEnter(req, res)
    return
  }
  res.writeHead(404)
  res.end()
})

server.listen(PORT, async () => {
  await runtime.registerTypes()
  console.log(`electric-graphiti server ready on port ${PORT}`)
  console.log(`runtime: ${ELECTRIC_AGENTS_URL}`)
})
