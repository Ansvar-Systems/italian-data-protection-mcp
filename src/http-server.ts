#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchGuidelines,
  getGuideline,
  listTopics,
  getDataAge,
} from "./db.js";
import { buildCitation } from "./utils/citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "italian-data-protection-mcp";
const GARANTE_URL = "https://www.garanteprivacy.it/";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- Tool definitions (shared with index.ts) ---------------------------------

const TOOLS = [
  {
    name: "it_dp_search_decisions",
    description:
      "Full-text search across Garante decisions (provvedimenti, sanzioni, ordinanze). Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited. Search in Italian for best results.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query in Italian (e.g., 'consenso cookie', 'videosorveglianza')" },
        type: {
          type: "string",
          enum: ["sanzione", "provvedimento", "ordinanza", "parere"],
          description: "Filter by decision type. Optional.",
        },
        topic: { type: "string", description: "Filter by topic ID. Optional." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "it_dp_get_decision",
    description: "Get a specific Garante decision by reference number.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: { type: "string", description: "Garante decision reference number" },
      },
      required: ["reference"],
    },
  },
  {
    name: "it_dp_search_guidelines",
    description:
      "Search Garante guidance documents: linee guida, provvedimenti generali, and FAQ.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query in Italian" },
        type: {
          type: "string",
          enum: ["linee_guida", "provvedimento_generale", "FAQ", "parere"],
          description: "Filter by guidance type. Optional.",
        },
        topic: { type: "string", description: "Filter by topic ID. Optional." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "it_dp_get_guideline",
    description: "Get a specific Garante guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Guideline database ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "it_dp_list_topics",
    description: "List all covered data protection topics with Italian and English names.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "it_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "it_dp_list_sources",
    description: "List the data sources covered by this MCP server, including authority names, official URLs, and coverage details.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "it_dp_check_data_freshness",
    description: "Check when the data in this MCP was last updated. Returns the most recent decision and guideline dates in the database.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["sanzione", "provvedimento", "ordinanza", "parere"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  reference: z.string().min(1),
});

const SearchGuidelinesArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["linee_guida", "provvedimento_generale", "FAQ", "parere"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetGuidelineArgs = z.object({
  id: z.number().int().positive(),
});

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function buildMeta() {
      return {
        disclaimer:
          "Data sourced from Garante per la protezione dei dati personali. For informational purposes only. Not legal advice.",
        data_age: getDataAge(),
        copyright: "© Garante per la protezione dei dati personali",
        source_url: GARANTE_URL,
      };
    }

    function textContent(data: unknown) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }

    function errorContent(message: string, errorType?: string) {
      const body: Record<string, string> = { error: message };
      if (errorType) body["_error_type"] = errorType;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "it_dp_search_decisions": {
          const parsed = SearchDecisionsArgs.parse(args);
          const results = searchDecisions({
            query: parsed.query,
            type: parsed.type,
            topic: parsed.topic,
            limit: parsed.limit,
          });
          const resultsWithCitation = results.map((d) => ({
            ...d,
            _citation: buildCitation(
              d.reference,
              d.title,
              "it_dp_get_decision",
              { reference: d.reference },
              GARANTE_URL,
            ),
          }));
          return textContent({ results: resultsWithCitation, count: results.length, _meta: buildMeta() });
        }

        case "it_dp_get_decision": {
          const parsed = GetDecisionArgs.parse(args);
          const decision = getDecision(parsed.reference);
          if (!decision) {
            return errorContent(`Decision not found: ${parsed.reference}`, "not_found");
          }
          const dec = decision as Record<string, unknown>;
          return textContent({
            ...decision,
            _citation: buildCitation(
              String(dec.reference ?? parsed.reference),
              String(dec.title ?? dec.reference ?? parsed.reference),
              "it_dp_get_decision",
              { reference: parsed.reference },
              GARANTE_URL,
            ),
            _meta: buildMeta(),
          });
        }

        case "it_dp_search_guidelines": {
          const parsed = SearchGuidelinesArgs.parse(args);
          const results = searchGuidelines({
            query: parsed.query,
            type: parsed.type,
            topic: parsed.topic,
            limit: parsed.limit,
          });
          const resultsWithCitation = results.map((g) => ({
            ...g,
            _citation: buildCitation(
              String(g.reference ?? g.id),
              g.title,
              "it_dp_get_guideline",
              { id: String(g.id) },
              GARANTE_URL,
            ),
          }));
          return textContent({ results: resultsWithCitation, count: results.length, _meta: buildMeta() });
        }

        case "it_dp_get_guideline": {
          const parsed = GetGuidelineArgs.parse(args);
          const guideline = getGuideline(parsed.id);
          if (!guideline) {
            return errorContent(`Guideline not found: id=${parsed.id}`, "not_found");
          }
          const gl = guideline as Record<string, unknown>;
          return textContent({
            ...guideline,
            _citation: buildCitation(
              String(gl.reference ?? gl.id ?? parsed.id),
              String(gl.title ?? gl.reference ?? `Guideline ${parsed.id}`),
              "it_dp_get_guideline",
              { id: String(parsed.id) },
              GARANTE_URL,
            ),
            _meta: buildMeta(),
          });
        }

        case "it_dp_list_topics": {
          const topics = listTopics();
          return textContent({ topics, count: topics.length, _meta: buildMeta() });
        }

        case "it_dp_about": {
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description:
              "Garante per la protezione dei dati personali MCP server. Provides access to Italian data protection authority decisions, sanctions, and official guidance documents.",
            data_source: `Garante per la protezione dei dati personali (${GARANTE_URL})`,
            coverage: {
              decisions: "Garante sanzioni, provvedimenti, and ordinanze-ingiunzione",
              guidelines: "Garante linee guida, provvedimenti generali, and FAQ",
              topics: "Cookie, videosorveglianza, profilazione, telemarketing, dati sanitari, diritto oblio, trasferimento dati, valutazione impatto, trattamento automatizzato",
            },
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
            _meta: buildMeta(),
          });
        }

        case "it_dp_list_sources": {
          return textContent({
            sources: [
              {
                authority: "Garante per la protezione dei dati personali",
                country: "Italy",
                official_url: GARANTE_URL,
                covers: [
                  "decisions",
                  "sanctions (sanzioni)",
                  "prescriptions (provvedimenti)",
                  "ordinances (ordinanze-ingiunzione)",
                  "guidelines (linee guida)",
                  "general provisions (provvedimenti generali)",
                  "FAQ",
                ],
                language: "Italian (primary), some documents in English",
              },
            ],
            _meta: buildMeta(),
          });
        }

        case "it_dp_check_data_freshness": {
          const dataAge = getDataAge();
          return textContent({
            data_age: dataAge,
            source: "Garante per la protezione dei dati personali",
            source_url: GARANTE_URL,
            checked_at: new Date().toISOString(),
            _meta: buildMeta(),
          });
        }

        default:
          return errorContent(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorContent(`Error executing ${name}: ${message}`);
    }
  });

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
