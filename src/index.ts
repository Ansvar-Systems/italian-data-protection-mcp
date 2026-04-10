#!/usr/bin/env node

/**
 * Italian Data Protection MCP — stdio entry point.
 *
 * Provides MCP tools for querying Garante decisions, sanctions, and
 * data protection guidance documents.
 *
 * Tool prefix: it_dp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "italian-data-protection-mcp";

const GARANTE_URL = "https://www.garanteprivacy.it/";

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "it_dp_search_decisions",
    description:
      "Full-text search across Garante decisions (provvedimenti, sanzioni, ordinanze). Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited. Search in Italian for best results (e.g., 'consenso', 'videosorveglianza', 'Clearview').",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query in Italian (e.g., 'consenso cookie', 'videosorveglianza', 'Foodinho Glovo')",
        },
        type: {
          type: "string",
          enum: ["sanzione", "provvedimento", "ordinanza", "parere"],
          description: "Filter by decision type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'cookie', 'videosorveglianza', 'profilazione', 'dati_sanitari'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "it_dp_get_decision",
    description:
      "Get a specific Garante decision by reference number (e.g., 'GPDP-2021-001', 'GARANTE-2022-CL').",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: {
          type: "string",
          description: "Garante decision reference number",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "it_dp_search_guidelines",
    description:
      "Search Garante guidance documents: linee guida, provvedimenti generali, and FAQ. Covers GDPR implementation, cookie e tracciamento, videosorveglianza, profilazione, telemarketing, and more.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query in Italian (e.g., 'cookie tracciamento', 'valutazione impatto', 'trattamento automatizzato')",
        },
        type: {
          type: "string",
          enum: ["linee_guida", "provvedimento_generale", "FAQ", "parere"],
          description: "Filter by guidance type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'cookie', 'videosorveglianza', 'profilazione', 'telemarketing'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "it_dp_get_guideline",
    description:
      "Get a specific Garante guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "Guideline database ID (from it_dp_search_guidelines results)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "it_dp_list_topics",
    description:
      "List all covered data protection topics with Italian and English names. Use topic IDs to filter decisions and guidelines.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "it_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "it_dp_list_sources",
    description: "List the data sources covered by this MCP server, including authority names, official URLs, and coverage details.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "it_dp_check_data_freshness",
    description: "Check when the data in this MCP was last updated. Returns the most recent decision and guideline dates in the database.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

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

// --- Helpers ------------------------------------------------------------------

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
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
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

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

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
            "Garante per la protezione dei dati personali MCP server. Provides access to Italian data protection authority decisions, sanctions, prescriptions, and official guidance documents including linee guida and provvedimenti generali.",
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

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
