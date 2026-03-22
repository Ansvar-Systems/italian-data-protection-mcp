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
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { searchDecisions, getDecision, searchGuidelines, getGuideline, listTopics, } from "./db.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "italian-data-protection-mcp";
let pkgVersion = "0.1.0";
try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    pkgVersion = pkg.version;
}
catch {
    // fallback
}
// --- Tool definitions (shared with index.ts) ---------------------------------
const TOOLS = [
    {
        name: "it_dp_search_decisions",
        description: "Full-text search across Garante decisions (provvedimenti, sanzioni, ordinanze). Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited. Search in Italian for best results.",
        inputSchema: {
            type: "object",
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
            type: "object",
            properties: {
                reference: { type: "string", description: "Garante decision reference number" },
            },
            required: ["reference"],
        },
    },
    {
        name: "it_dp_search_guidelines",
        description: "Search Garante guidance documents: linee guida, provvedimenti generali, and FAQ.",
        inputSchema: {
            type: "object",
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
            type: "object",
            properties: {
                id: { type: "number", description: "Guideline database ID" },
            },
            required: ["id"],
        },
    },
    {
        name: "it_dp_list_topics",
        description: "List all covered data protection topics with Italian and English names.",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "it_dp_about",
        description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
        inputSchema: { type: "object", properties: {}, required: [] },
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
function createMcpServer() {
    const server = new Server({ name: SERVER_NAME, version: pkgVersion }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOLS,
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args = {} } = request.params;
        function textContent(data) {
            return {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
        }
        function errorContent(message) {
            return {
                content: [{ type: "text", text: message }],
                isError: true,
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
                    return textContent({ results, count: results.length });
                }
                case "it_dp_get_decision": {
                    const parsed = GetDecisionArgs.parse(args);
                    const decision = getDecision(parsed.reference);
                    if (!decision) {
                        return errorContent(`Decision not found: ${parsed.reference}`);
                    }
                    return textContent(decision);
                }
                case "it_dp_search_guidelines": {
                    const parsed = SearchGuidelinesArgs.parse(args);
                    const results = searchGuidelines({
                        query: parsed.query,
                        type: parsed.type,
                        topic: parsed.topic,
                        limit: parsed.limit,
                    });
                    return textContent({ results, count: results.length });
                }
                case "it_dp_get_guideline": {
                    const parsed = GetGuidelineArgs.parse(args);
                    const guideline = getGuideline(parsed.id);
                    if (!guideline) {
                        return errorContent(`Guideline not found: id=${parsed.id}`);
                    }
                    return textContent(guideline);
                }
                case "it_dp_list_topics": {
                    const topics = listTopics();
                    return textContent({ topics, count: topics.length });
                }
                case "it_dp_about": {
                    return textContent({
                        name: SERVER_NAME,
                        version: pkgVersion,
                        description: "Garante per la protezione dei dati personali MCP server. Provides access to Italian data protection authority decisions, sanctions, and official guidance documents.",
                        data_source: "Garante per la protezione dei dati personali (https://www.garanteprivacy.it/)",
                        tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
                    });
                }
                default:
                    return errorContent(`Unknown tool: ${name}`);
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return errorContent(`Error executing ${name}: ${message}`);
        }
    });
    return server;
}
// --- HTTP server -------------------------------------------------------------
async function main() {
    const sessions = new Map();
    const httpServer = createServer((req, res) => {
        handleRequest(req, res, sessions).catch((err) => {
            console.error(`[${SERVER_NAME}] Unhandled error:`, err);
            if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Internal server error" }));
            }
        });
    });
    async function handleRequest(req, res, activeSessions) {
        const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
        if (url.pathname === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
            return;
        }
        if (url.pathname === "/mcp") {
            const sessionId = req.headers["mcp-session-id"];
            if (sessionId && activeSessions.has(sessionId)) {
                const session = activeSessions.get(sessionId);
                await session.transport.handleRequest(req, res);
                return;
            }
            const mcpServer = createMcpServer();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
            await mcpServer.connect(transport);
            transport.onclose = () => {
                if (transport.sessionId) {
                    activeSessions.delete(transport.sessionId);
                }
                mcpServer.close().catch(() => { });
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
