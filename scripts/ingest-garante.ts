/**
 * Ingestion crawler for the Italian Data Protection Authority (Garante per la
 * protezione dei dati personali) — garanteprivacy.it.
 *
 * Scrapes provvedimenti (decisions/sanctions), linee guida (guidelines), and
 * general provisions from the Garante website and populates the local SQLite
 * database used by the MCP server.
 *
 * Usage:
 *   npx tsx scripts/ingest-garante.ts                   # full crawl
 *   npx tsx scripts/ingest-garante.ts --resume           # skip already-ingested docwebs
 *   npx tsx scripts/ingest-garante.ts --dry-run           # fetch + parse, no DB writes
 *   npx tsx scripts/ingest-garante.ts --force             # drop existing data first
 *   npx tsx scripts/ingest-garante.ts --max-pages 5       # limit pages per category
 *   npx tsx scripts/ingest-garante.ts --max-decisions 50  # cap total decisions
 *
 * Requires: cheerio (npm i -D cheerio)
 *
 * Rate limit: minimum 1500 ms between HTTP requests.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import * as cheerio from "cheerio";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["GARANTE_DB_PATH"] ?? "data/garante.db";
const BASE_URL = "https://www.garanteprivacy.it";
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3000;
const DEFAULT_MAX_PAGES = 200; // safety cap per category
const DEFAULT_MAX_ITEMS = Infinity;

const USER_AGENT =
  "AnsvarGaranteIngester/1.0 (+https://ansvar.eu; data-protection-research)";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const FLAG_RESUME = args.includes("--resume");
const FLAG_DRY_RUN = args.includes("--dry-run");
const FLAG_FORCE = args.includes("--force");

function flagValue(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const MAX_PAGES = Number(flagValue("--max-pages") ?? DEFAULT_MAX_PAGES);
const MAX_DECISIONS = Number(flagValue("--max-decisions") ?? DEFAULT_MAX_ITEMS);
const MAX_GUIDELINES = Number(
  flagValue("--max-guidelines") ?? DEFAULT_MAX_ITEMS,
);

// ---------------------------------------------------------------------------
// Garante search categories
//
// Each category maps to a tipologia ID used by the Liferay search portlet.
// The "target" field says which DB table to populate.
// ---------------------------------------------------------------------------

interface SearchCategory {
  label: string;
  tipologiaIds: string[];
  target: "decisions" | "guidelines";
  defaultType: string;
}

const CATEGORIES: SearchCategory[] = [
  {
    label: "Ordinanze ingiunzione (sanctions / injunctions)",
    tipologiaIds: ["10526"],
    target: "decisions",
    defaultType: "ordinanza",
  },
  {
    label: "Provvedimenti correttivi e sanzionatori",
    tipologiaIds: ["9271403"],
    target: "decisions",
    defaultType: "provvedimento_sanzionatorio",
  },
  {
    label: "Provvedimenti a carattere generale",
    tipologiaIds: ["10532"],
    target: "guidelines",
    defaultType: "provvedimento_generale",
  },
  {
    label: "Linee guida",
    tipologiaIds: ["10516"],
    target: "guidelines",
    defaultType: "linee_guida",
  },
  {
    label: "Pareri del Garante",
    tipologiaIds: ["10527"],
    target: "decisions",
    defaultType: "parere",
  },
  {
    label: "Prescrizioni",
    tipologiaIds: ["9625871"],
    target: "decisions",
    defaultType: "prescrizione",
  },
  {
    label: "Ammonimenti",
    tipologiaIds: ["9150852"],
    target: "decisions",
    defaultType: "ammonimento",
  },
];

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.log(`[${ts}] ${msg}`);
}

function warn(msg: string): void {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.warn(`[${ts}] WARN: ${msg}`);
}

function error(msg: string): void {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.error(`[${ts}] ERROR: ${msg}`);
}

// ---------------------------------------------------------------------------
// Rate-limited HTTP fetch with retry
// ---------------------------------------------------------------------------

let lastRequestTs = 0;

async function rateLimitedFetch(url: string): Promise<string> {
  const now = Date.now();
  const elapsed = now - lastRequestTs;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTs = Date.now();
      const resp = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "it-IT,it;q=0.9,en;q=0.5",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} for ${url}`);
      }
      return await resp.text();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        const backoff = RETRY_BACKOFF_MS * attempt;
        warn(
          `Attempt ${attempt}/${MAX_RETRIES} failed for ${url}: ${lastErr.message} — retrying in ${backoff}ms`,
        );
        await sleep(backoff);
      }
    }
  }
  throw new Error(
    `Failed after ${MAX_RETRIES} attempts: ${lastErr?.message ?? "unknown error"}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Search result listing — parse one page of results
// ---------------------------------------------------------------------------

interface SearchResultEntry {
  docwebId: string;
  title: string;
  date: string | null; // DD/MM/YYYY as found on the page
  tipologia: string | null;
}

function buildSearchUrl(tipologiaIds: string[], page: number): string {
  const portlet = "_g_gpdp5_search_GGpdp5SearchPortlet";
  const params = new URLSearchParams();
  params.set("p_p_id", "g_gpdp5_search_GGpdp5SearchPortlet");
  params.set("p_p_lifecycle", "0");
  params.set("p_p_state", "normal");
  params.set("p_p_mode", "view");
  params.set(`${portlet}_mvcRenderCommandName`, "/renderSearch");
  params.set(`${portlet}_text`, "");
  params.set(`${portlet}_dataInizio`, "");
  params.set(`${portlet}_dataFine`, "");
  params.set(`${portlet}_idsTipologia`, tipologiaIds.join(","));
  params.set(`${portlet}_paginaWeb`, "false");
  params.set(`${portlet}_allegato`, "false");
  params.set(`${portlet}_ordinamentoPer`, "DESC");
  params.set(`${portlet}_ordinamentoTipo`, "data");
  params.set(`${portlet}_cur`, String(page));
  return `${BASE_URL}/home/ricerca?${params.toString()}`;
}

async function fetchSearchPage(
  tipologiaIds: string[],
  page: number,
): Promise<{ entries: SearchResultEntry[]; hasNextPage: boolean }> {
  const url = buildSearchUrl(tipologiaIds, page);
  const html = await rateLimitedFetch(url);
  const $ = cheerio.load(html);

  const entries: SearchResultEntry[] = [];

  // Each result is an anchor tag pointing to /web/guest/home/docweb/-/docweb-display/docweb/<ID>
  // We find all such links and extract surrounding metadata.
  const docwebLinks = $(
    'a[href*="/docweb/-/docweb-display/docweb/"]',
  ).toArray();

  for (const el of docwebLinks) {
    const href = $(el).attr("href") ?? "";

    // Extract docweb numeric ID from href
    const idMatch = href.match(/\/docweb\/(\d+)/);
    if (!idMatch?.[1]) continue;
    const docwebId = idMatch[1];

    // Title is the anchor text
    const title = $(el).text().trim();
    if (!title) continue;

    // Skip duplicate links (same page may have sidebar/footer links)
    if (entries.some((e) => e.docwebId === docwebId)) continue;

    // Walk up to parent container and look for date + tipologia text.
    // The Liferay search portlet renders date in DD/MM/YYYY format and
    // tipologia text near the result title. We search within the parent
    // container (typically 3-4 levels up) for those patterns.
    const parentBlock = $(el).closest("div, li, article, section");
    const blockText = parentBlock.length > 0 ? parentBlock.text() : "";

    // Date: DD/MM/YYYY
    const dateMatch = blockText.match(/(\d{2}\/\d{2}\/\d{4})/);
    const date = dateMatch?.[1] ?? null;

    // Tipologia: look for known category labels
    let tipologia: string | null = null;
    const tipoPatterns = [
      "Ordinanza ingiunzione",
      "Provvedimento correttivo e sanzionatorio",
      "Provvedimento a carattere generale",
      "Linee guida",
      "Parere del Garante",
      "Prescrizione",
      "Ammonimento",
      "Deliberazione",
      "Provvedimento",
    ];
    for (const tp of tipoPatterns) {
      if (blockText.includes(tp)) {
        tipologia = tp;
        break;
      }
    }

    entries.push({ docwebId, title, date, tipologia });
  }

  // Pagination: check if there is a link to page+1
  const nextPageStr = String(page + 1);
  const hasNextPage = $(
    `a[href*="${encodeURIComponent("_cur=" + nextPageStr)}"], a[href*="_cur=${nextPageStr}"]`,
  ).length > 0;

  return { entries, hasNextPage };
}

// ---------------------------------------------------------------------------
// Detail page parsing — fetch and extract a single provvedimento / guideline
// ---------------------------------------------------------------------------

interface ParsedDocument {
  docwebId: string;
  reference: string;
  title: string;
  date: string | null; // ISO YYYY-MM-DD
  type: string;
  entityName: string | null;
  fineAmount: number | null;
  summary: string | null;
  fullText: string;
  topics: string[];
  gdprArticles: string[];
}

function docwebUrl(id: string): string {
  return `${BASE_URL}/home/docweb/-/docweb-display/docweb/${id}`;
}

/**
 * Parse an Italian date string like "10 febbraio 2022" into ISO "2022-02-10".
 * Also handles DD/MM/YYYY format from search results.
 */
function parseItalianDate(raw: string): string | null {
  // DD/MM/YYYY
  const slashMatch = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch?.[1] && slashMatch[2] && slashMatch[3]) {
    return `${slashMatch[3]}-${slashMatch[2].padStart(2, "0")}-${slashMatch[1].padStart(2, "0")}`;
  }

  const months: Record<string, string> = {
    gennaio: "01",
    febbraio: "02",
    marzo: "03",
    aprile: "04",
    maggio: "05",
    giugno: "06",
    luglio: "07",
    agosto: "08",
    settembre: "09",
    ottobre: "10",
    novembre: "11",
    dicembre: "12",
  };
  const textMatch = raw.match(
    /(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(\d{4})/i,
  );
  if (textMatch?.[1] && textMatch[2] && textMatch[3]) {
    const day = textMatch[1].padStart(2, "0");
    const month = months[textMatch[2].toLowerCase()];
    const year = textMatch[3];
    if (month) {
      return `${year}-${month}-${day}`;
    }
  }

  return null;
}

/**
 * Try to extract a monetary fine from the text.
 * Italian convention uses dots for thousands and commas for decimals:
 *   "20.000.000 di euro" → 20000000
 *   "2.600.000 euro"     → 2600000
 */
function extractFine(text: string): number | null {
  // Match patterns like "sanzione ... di 20.000.000 ... euro" or
  // "multa di EUR 11.500.000" or "€ 2.600.000"
  const patterns = [
    /(?:sanzione|multa|ammenda|importo)[^.]{0,120}?(\d[\d.]+)\s*(?:di\s+)?euro/gi,
    /(?:sanzione|multa|ammenda|importo)[^.]{0,120}?(?:EUR|€)\s*(\d[\d.]+)/gi,
    /(\d[\d.]+)\s*(?:di\s+)?euro[^.]{0,80}(?:sanzione|multa|ammenda)/gi,
    /(?:EUR|€)\s*(\d[\d.]+)[^.]{0,80}(?:sanzione|multa|ammenda)/gi,
    // Broader: just "N.NNN.NNN di euro" or "N.NNN.NNN euro"
    /(\d{1,3}(?:\.\d{3}){1,4})\s*(?:di\s+)?euro/gi,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match?.[1]) {
      const cleaned = match[1].replace(/\./g, "");
      const value = Number(cleaned);
      if (!isNaN(value) && value > 0) {
        return value;
      }
    }
  }

  return null;
}

/**
 * Try to extract the entity (company/organisation) name from the title or
 * leading text. Common patterns:
 *   "Ordinanza ingiunzione nei confronti di Clearview AI - ..."
 *   "Provvedimento — Foodinho S.r.l. (Glovo) — ..."
 *   "... nei confronti di ENI Gas e Luce S.p.A. ..."
 */
function extractEntity(title: string, bodyPrefix: string): string | null {
  // "nei confronti di <entity>" (most common)
  const confrontiMatch = (title + " " + bodyPrefix).match(
    /nei confronti di\s+(.+?)(?:\s*[-–—]\s*|\s*\(|\s*per\s|\s*$)/i,
  );
  if (confrontiMatch?.[1]) {
    const entity = confrontiMatch[1].trim().replace(/\s+/g, " ");
    if (entity.length > 2 && entity.length < 200) return entity;
  }

  // "— <Entity> —" in title
  const dashMatch = title.match(/[-–—]\s*(.+?)\s*[-–—]/);
  if (dashMatch?.[1]) {
    const candidate = dashMatch[1].trim();
    // Only accept if it looks like a company name (has uppercase start, not too long)
    if (
      candidate.length > 2 &&
      candidate.length < 120 &&
      /^[A-Z\u00C0-\u00FF]/.test(candidate)
    ) {
      return candidate;
    }
  }

  return null;
}

/**
 * Extract GDPR article references from text.
 * Matches patterns like "art. 5", "artt. 44-49", "articolo 22",
 * "art. 9, par. 2, lett. h".
 */
function extractGdprArticles(text: string): string[] {
  const articles = new Set<string>();

  // "art(t). N" patterns
  const artPattern = /\bart(?:t|icol[oi])?\.\s*(\d+)/gi;
  let match: RegExpExecArray | null;
  while ((match = artPattern.exec(text)) !== null) {
    if (match[1]) {
      const num = parseInt(match[1], 10);
      // GDPR has 99 articles
      if (num >= 1 && num <= 99) {
        articles.add(String(num));
      }
    }
  }

  // "artt. N-M" ranges
  const rangePattern = /\bartt?\.\s*(\d+)\s*[-–]\s*(\d+)/gi;
  while ((match = rangePattern.exec(text)) !== null) {
    if (match[1] && match[2]) {
      const start = parseInt(match[1], 10);
      const end = parseInt(match[2], 10);
      if (start >= 1 && end <= 99 && start < end && end - start <= 20) {
        for (let n = start; n <= end; n++) {
          articles.add(String(n));
        }
      }
    }
  }

  return [...articles].sort((a, b) => Number(a) - Number(b));
}

/**
 * Map Italian topic keywords found in Garante text to our controlled vocabulary.
 */
function inferTopics(text: string): string[] {
  const topics: string[] = [];
  const lower = text.toLowerCase();

  const topicKeywords: [string, string[]][] = [
    ["cookie", ["cookie", "tracciamento online", "strumenti di tracciamento"]],
    [
      "videosorveglianza",
      ["videosorveglianza", "telecamera", "impianti video"],
    ],
    [
      "profilazione",
      ["profilazione", "profiling", "scoring", "punteggio di reputazione"],
    ],
    [
      "telemarketing",
      [
        "telemarketing",
        "chiamate commerciali",
        "registro delle opposizioni",
        "marketing telefonico",
      ],
    ],
    [
      "dati_sanitari",
      [
        "dati sanitari",
        "dati relativi alla salute",
        "fascicolo sanitario",
        "cartella clinica",
      ],
    ],
    [
      "diritto_oblio",
      [
        "diritto all'oblio",
        "diritto alla cancellazione",
        "deindicizzazione",
      ],
    ],
    [
      "trasferimento_dati",
      [
        "trasferimento di dati",
        "trasferimento internazionale",
        "paesi terzi",
        "clausole contrattuali standard",
        "trasferimento verso",
      ],
    ],
    [
      "valutazione_impatto",
      [
        "valutazione d'impatto",
        "valutazione di impatto",
        "dpia",
        "vipd",
      ],
    ],
    [
      "trattamento_automatizzato",
      [
        "decisioni automatizzate",
        "trattamento automatizzato",
        "algoritm",
        "intelligenza artificiale",
      ],
    ],
  ];

  for (const [topicId, keywords] of topicKeywords) {
    if (keywords.some((kw) => lower.includes(kw))) {
      topics.push(topicId);
    }
  }

  return topics;
}

/**
 * Build a short summary from the first meaningful paragraph(s) of the
 * full text, capped at ~500 characters.
 */
function buildSummary(fullText: string, maxLen = 500): string {
  // Skip very short header lines, take the first paragraph of substance.
  const paragraphs = fullText
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 80);

  if (paragraphs.length === 0) {
    return fullText.slice(0, maxLen).trim();
  }

  let summary = paragraphs[0]!;
  if (summary.length > maxLen) {
    const cutoff = summary.lastIndexOf(" ", maxLen);
    summary = summary.slice(0, cutoff > 0 ? cutoff : maxLen) + "...";
  }
  return summary;
}

async function fetchAndParseDocument(
  docwebId: string,
  fallbackDate: string | null,
  fallbackType: string,
): Promise<ParsedDocument | null> {
  const url = docwebUrl(docwebId);
  let html: string;
  try {
    html = await rateLimitedFetch(url);
  } catch (err) {
    error(
      `Failed to fetch docweb ${docwebId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const $ = cheerio.load(html);

  // --- Title ---
  // Primary: h2.interna-titolo or first h2 inside #interna-webcontent.
  // Fallback: first <h2> on the page that is not navigation.
  let title =
    $("h2.interna-titolo").first().text().trim() ||
    $("#interna-webcontent h2").first().text().trim() ||
    $("h2").filter((_i, el) => $(el).text().trim().length > 10).first().text().trim() ||
    "";

  if (!title) {
    // Last resort: use <title> tag minus site suffix
    title = $("title").text().replace(/\s*[-–|].*$/, "").trim();
  }
  if (!title) {
    warn(`No title found for docweb ${docwebId}, skipping`);
    return null;
  }

  // --- Full text ---
  // The main content lives in #interna-webcontent or .portlet-body.
  // We extract text, stripping navigation chrome.
  let contentEl = $("#interna-webcontent");
  if (contentEl.length === 0) {
    contentEl = $(".portlet-body .journal-content-article");
  }
  if (contentEl.length === 0) {
    contentEl = $(".portlet-body");
  }

  // Remove nav elements, script, style, header, footer from the content clone
  const contentClone = contentEl.clone();
  contentClone.find("nav, script, style, header, footer, .breadcrumb, .portlet-title").remove();

  let fullText = contentClone
    .find("p, li, h3, h4, h5, h6, div.journal-content-article, td")
    .map((_i, el) => $(el).text().trim())
    .get()
    .filter((t: string) => t.length > 0)
    .join("\n\n");

  if (!fullText || fullText.length < 50) {
    // Broader fallback: just grab all text from the content element
    fullText = contentClone.text().replace(/\s{3,}/g, "\n\n").trim();
  }

  if (!fullText || fullText.length < 30) {
    warn(`No meaningful content for docweb ${docwebId}, skipping`);
    return null;
  }

  // --- Date ---
  let date: string | null = null;

  // Try to find date in the title (common: "Provvedimento del 12 marzo 2026")
  date = parseItalianDate(title);

  // Try metadata from the page text (registration line: "n. 50 del 10 febbraio 2022")
  if (!date) {
    const regMatch = fullText.match(
      /(?:n\.\s*\d+\s+)?del\s+(\d{1,2}\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+\d{4})/i,
    );
    if (regMatch?.[1]) {
      date = parseItalianDate(regMatch[1]);
    }
  }

  // Fallback: use the date from the search result listing
  if (!date && fallbackDate) {
    date = parseItalianDate(fallbackDate);
  }

  // --- Reference ---
  // Convention: GPDP-<YYYY>-<docwebId> (since the Garante does not use a
  // consistent public reference scheme beyond docweb IDs).
  const year = date ? date.slice(0, 4) : "XXXX";
  const reference = `GPDP-${year}-${docwebId}`;

  // --- Type ---
  const type = mapTipologiaToType(title, fallbackType);

  // --- Entity name ---
  const bodyPrefix = fullText.slice(0, 1500);
  const entityName = extractEntity(title, bodyPrefix);

  // --- Fine amount ---
  const fineAmount = extractFine(fullText);

  // --- GDPR articles ---
  const gdprArticles = extractGdprArticles(fullText);

  // --- Topics ---
  const topics = inferTopics(title + " " + fullText.slice(0, 5000));

  // --- Summary ---
  const summary = buildSummary(fullText);

  return {
    docwebId,
    reference,
    title,
    date,
    type,
    entityName,
    fineAmount,
    summary,
    fullText,
    topics,
    gdprArticles,
  };
}

function mapTipologiaToType(title: string, fallbackType: string): string {
  const lower = title.toLowerCase();
  if (lower.includes("ordinanza ingiunzione")) return "ordinanza";
  if (lower.includes("linee guida")) return "linee_guida";
  if (lower.includes("provvedimento generale") || lower.includes("carattere generale"))
    return "provvedimento_generale";
  if (lower.includes("parere")) return "parere";
  if (lower.includes("ammonimento")) return "ammonimento";
  if (lower.includes("prescrizione")) return "prescrizione";
  if (lower.includes("autorizzazione")) return "autorizzazione";
  if (lower.includes("deliberazione")) return "deliberazione";
  return fallbackType;
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    log(`Created data directory: ${dir}`);
  }

  if (FLAG_FORCE && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    log(`Deleted existing database (--force)`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return db;
}

function existingDecisionRefs(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT reference FROM decisions")
    .all() as { reference: string }[];
  return new Set(rows.map((r) => r.reference));
}

function existingGuidelineRefs(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT reference FROM guidelines WHERE reference IS NOT NULL")
    .all() as { reference: string }[];
  return new Set(rows.map((r) => r.reference));
}

function insertDecision(
  db: Database.Database,
  doc: ParsedDocument,
): boolean {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO decisions
        (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      doc.reference,
      doc.title,
      doc.date,
      doc.type,
      doc.entityName,
      doc.fineAmount,
      doc.summary,
      doc.fullText,
      doc.topics.length > 0 ? JSON.stringify(doc.topics) : null,
      doc.gdprArticles.length > 0 ? JSON.stringify(doc.gdprArticles) : null,
      "final",
    );
    return true;
  } catch (err) {
    error(
      `DB insert failed for decision ${doc.reference}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

function insertGuideline(
  db: Database.Database,
  doc: ParsedDocument,
): boolean {
  try {
    db.prepare(
      `INSERT INTO guidelines
        (reference, title, date, type, summary, full_text, topics, language)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      doc.reference,
      doc.title,
      doc.date,
      doc.type,
      doc.summary,
      doc.fullText,
      doc.topics.length > 0 ? JSON.stringify(doc.topics) : null,
      "it",
    );
    return true;
  } catch (err) {
    error(
      `DB insert failed for guideline ${doc.reference}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

function ensureTopics(db: Database.Database): void {
  const topicRows: { id: string; name_it: string; name_en: string; description: string }[] = [
    {
      id: "cookie",
      name_it: "Cookie e tracciamento",
      name_en: "Cookies and tracking",
      description:
        "Utilizzo di cookie e tecnologie di tracciamento — consenso e obblighi informativi.",
    },
    {
      id: "videosorveglianza",
      name_it: "Videosorveglianza",
      name_en: "Video surveillance",
      description: "Sistemi di videosorveglianza in luoghi pubblici e privati.",
    },
    {
      id: "profilazione",
      name_it: "Profilazione",
      name_en: "Profiling",
      description:
        "Profilazione degli utenti e decisioni automatizzate con effetti significativi (art. 22 GDPR).",
    },
    {
      id: "telemarketing",
      name_it: "Telemarketing",
      name_en: "Telemarketing",
      description:
        "Contatto a fini commerciali tramite telefono, email e altri canali.",
    },
    {
      id: "dati_sanitari",
      name_it: "Dati sanitari",
      name_en: "Health data",
      description:
        "Trattamento di dati relativi alla salute (art. 9 GDPR).",
    },
    {
      id: "diritto_oblio",
      name_it: "Diritto all'oblio",
      name_en: "Right to be forgotten",
      description:
        "Diritto alla cancellazione dei dati personali online (art. 17 GDPR).",
    },
    {
      id: "trasferimento_dati",
      name_it: "Trasferimento internazionale di dati",
      name_en: "International data transfers",
      description:
        "Trasferimento di dati personali verso paesi terzi (artt. 44-49 GDPR).",
    },
    {
      id: "valutazione_impatto",
      name_it: "Valutazione d'impatto sulla protezione dei dati",
      name_en: "Data Protection Impact Assessment",
      description:
        "Valutazione d'impatto (DPIA/VIPD) per trattamenti ad alto rischio (art. 35 GDPR).",
    },
    {
      id: "trattamento_automatizzato",
      name_it: "Trattamento automatizzato e decisioni algoritmiche",
      name_en: "Automated processing and algorithmic decisions",
      description:
        "Trattamento automatizzato e decisioni basate su algoritmi (art. 22 GDPR).",
    },
    {
      id: "minori",
      name_it: "Protezione dei minori",
      name_en: "Child protection",
      description:
        "Protezione dei dati personali dei minori — consenso genitoriale e sicurezza online (art. 8 GDPR).",
    },
    {
      id: "data_breach",
      name_it: "Violazione dei dati personali",
      name_en: "Personal data breach",
      description:
        "Notifica e gestione delle violazioni dei dati personali (artt. 33-34 GDPR).",
    },
    {
      id: "biometria",
      name_it: "Dati biometrici",
      name_en: "Biometric data",
      description:
        "Trattamento di dati biometrici — riconoscimento facciale, impronte digitali (art. 9 GDPR).",
    },
    {
      id: "lavoro",
      name_it: "Trattamento dati nel rapporto di lavoro",
      name_en: "Employment data processing",
      description:
        "Trattamento dei dati personali dei lavoratori — controllo, sorveglianza, geolocalizzazione.",
    },
    {
      id: "pubblica_amministrazione",
      name_it: "Pubblica amministrazione",
      name_en: "Public administration",
      description:
        "Trattamento dei dati personali da parte di enti pubblici.",
    },
  ];

  const stmt = db.prepare(
    "INSERT OR IGNORE INTO topics (id, name_it, name_en, description) VALUES (?, ?, ?, ?)",
  );

  const insertAll = db.transaction(() => {
    for (const t of topicRows) {
      stmt.run(t.id, t.name_it, t.name_en, t.description);
    }
  });

  insertAll();
}

// ---------------------------------------------------------------------------
// Main crawl loop
// ---------------------------------------------------------------------------

async function crawlCategory(
  db: Database.Database,
  category: SearchCategory,
  existingRefs: Set<string>,
): Promise<{ fetched: number; inserted: number; skipped: number; errors: number }> {
  const stats = { fetched: 0, inserted: 0, skipped: 0, errors: 0 };
  const maxItems =
    category.target === "decisions" ? MAX_DECISIONS : MAX_GUIDELINES;

  log(`--- ${category.label} (target: ${category.target}) ---`);

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (stats.inserted + stats.skipped >= maxItems) {
      log(`  Reached item cap (${maxItems}), stopping`);
      break;
    }

    log(`  Page ${page}...`);
    let entries: SearchResultEntry[];
    let hasNextPage: boolean;

    try {
      const result = await fetchSearchPage(category.tipologiaIds, page);
      entries = result.entries;
      hasNextPage = result.hasNextPage;
    } catch (err) {
      error(
        `  Failed to fetch search page ${page}: ${err instanceof Error ? err.message : String(err)}`,
      );
      stats.errors++;
      break;
    }

    if (entries.length === 0) {
      log(`  No results on page ${page}, done with category`);
      break;
    }

    log(`  Found ${entries.length} entries on page ${page}`);

    for (const entry of entries) {
      if (stats.inserted + stats.skipped >= maxItems) break;

      if (FLAG_RESUME) {
        // Check if any ref containing this docweb ID exists
        const alreadyExists = [...existingRefs].some((r) =>
          r.endsWith(`-${entry.docwebId}`),
        );
        if (alreadyExists) {
          stats.skipped++;
          continue;
        }
      }

      stats.fetched++;
      const doc = await fetchAndParseDocument(
        entry.docwebId,
        entry.date,
        category.defaultType,
      );

      if (!doc) {
        stats.errors++;
        continue;
      }

      if (FLAG_RESUME && existingRefs.has(doc.reference)) {
        stats.skipped++;
        continue;
      }

      if (FLAG_DRY_RUN) {
        log(
          `  [DRY-RUN] Would insert ${category.target}: ${doc.reference} — ${doc.title.slice(0, 80)}`,
        );
        stats.inserted++;
        continue;
      }

      let ok: boolean;
      if (category.target === "decisions") {
        ok = insertDecision(db, doc);
      } else {
        ok = insertGuideline(db, doc);
      }

      if (ok) {
        existingRefs.add(doc.reference);
        stats.inserted++;
        log(
          `  Inserted ${category.target.slice(0, -1)}: ${doc.reference} — ${doc.title.slice(0, 80)}`,
        );
      } else {
        stats.errors++;
      }
    }

    if (!hasNextPage) {
      log(`  No more pages, done with category`);
      break;
    }
  }

  return stats;
}

async function main(): Promise<void> {
  log("=== Garante Data Protection Ingestion Crawler ===");
  log(`Database: ${DB_PATH}`);
  log(
    `Flags: resume=${FLAG_RESUME} dry-run=${FLAG_DRY_RUN} force=${FLAG_FORCE}`,
  );
  log(`Limits: max-pages=${MAX_PAGES} max-decisions=${MAX_DECISIONS} max-guidelines=${MAX_GUIDELINES}`);
  log("");

  const db = FLAG_DRY_RUN ? null : initDb();

  if (db) {
    ensureTopics(db);
    log("Topics seeded");
  }

  // Collect existing references for --resume support
  const existingDecisionSet = db ? existingDecisionRefs(db) : new Set<string>();
  const existingGuidelineSet = db
    ? existingGuidelineRefs(db)
    : new Set<string>();

  const totals = { fetched: 0, inserted: 0, skipped: 0, errors: 0 };

  for (const category of CATEGORIES) {
    const refSet =
      category.target === "decisions"
        ? existingDecisionSet
        : existingGuidelineSet;

    const stats = await crawlCategory(
      db as Database.Database,
      category,
      refSet,
    );

    totals.fetched += stats.fetched;
    totals.inserted += stats.inserted;
    totals.skipped += stats.skipped;
    totals.errors += stats.errors;

    log(
      `  Category done: fetched=${stats.fetched} inserted=${stats.inserted} skipped=${stats.skipped} errors=${stats.errors}`,
    );
    log("");
  }

  // --- Final summary ---
  log("=== Crawl Complete ===");
  log(
    `  Total fetched:  ${totals.fetched}`,
  );
  log(`  Total inserted: ${totals.inserted}`);
  log(`  Total skipped:  ${totals.skipped}`);
  log(`  Total errors:   ${totals.errors}`);

  if (db) {
    const decisionCount = (
      db.prepare("SELECT count(*) as cnt FROM decisions").get() as {
        cnt: number;
      }
    ).cnt;
    const guidelineCount = (
      db.prepare("SELECT count(*) as cnt FROM guidelines").get() as {
        cnt: number;
      }
    ).cnt;
    const topicCount = (
      db.prepare("SELECT count(*) as cnt FROM topics").get() as {
        cnt: number;
      }
    ).cnt;

    log("");
    log("Database summary:");
    log(`  Topics:     ${topicCount}`);
    log(`  Decisions:  ${decisionCount}`);
    log(`  Guidelines: ${guidelineCount}`);

    db.close();
  }

  log(`\nDone.`);
}

main().catch((err) => {
  error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
