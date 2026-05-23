import path from "node:path"
try { process.loadEnvFile(path.resolve(import.meta.dirname, ".env")) } catch {}

import http from "node:http"
import { Type } from "@sinclair/typebox"
import {
  createEntityRegistry,
  createRuntimeHandler,
} from "@electric-ax/agents-runtime"
import { createBashTool, createFetchUrlTool } from "@electric-ax/agents-runtime/tools"

const ELECTRIC_AGENTS_URL =
  process.env.ELECTRIC_AGENTS_URL ?? "http://localhost:4437"
const PORT = Number(process.env.PORT ?? 3000)
const SERVE_URL = process.env.SERVE_URL ?? `http://localhost:${PORT}`
const GRAPHITI_URL = process.env.GRAPHITI_URL ?? "http://localhost:7001"

const registry = createEntityRegistry()

const WORK_DIR = process.env.WORK_DIR ?? process.cwd()

const bashTool = createBashTool(WORK_DIR)
const fetchTool = createFetchUrlTool()

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY is not set")
  process.exit(1)
}

registry.define("assistant", {
  description: "Electric Graphiti assistant — durable stream + temporal memory",
  async handler(ctx) {
    console.log(`[handler] wake for ${ctx.entityUrl}, apiKey present: ${!!ANTHROPIC_API_KEY}`)
    ctx.useAgent({
      systemPrompt: "You are a helpful assistant with access to bash and web fetch. Keep responses concise.",
      model: "claude-sonnet-4-5-20250929",
      getApiKey: async (provider) => {
        console.log(`[getApiKey] called for provider: ${provider}, key present: ${!!ANTHROPIC_API_KEY}`)
        return ANTHROPIC_API_KEY
      },
      tools: [...ctx.electricTools, bashTool, fetchTool],
    })
    await ctx.agent.run()
  },
})

const runtime = createRuntimeHandler({
  baseUrl: ELECTRIC_AGENTS_URL,
  serveEndpoint: `${SERVE_URL}/webhook`,
  registry,
  async createElectricTools({ entityUrl, entityType }) {
    return [{
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
