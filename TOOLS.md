# Tools Reference

This MCP server exposes 8 tools under the `it_dp_` prefix.

## Search & retrieval tools

### `it_dp_search_decisions`

Full-text search across Garante decisions (provvedimenti, sanzioni, ordinanze).

**Arguments:**

| Name | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Search query in Italian (e.g., `consenso cookie`, `Foodinho Glovo`) |
| `type` | string | No | Filter by type: `sanzione`, `provvedimento`, `ordinanza`, `parere` |
| `topic` | string | No | Filter by topic ID (see COVERAGE.md) |
| `limit` | number | No | Max results (default 20, max 100) |

**Returns:** `{ results: Decision[], count: number, _meta: Meta }`

Each result includes a `_citation` block for the deterministic citation pipeline.

---

### `it_dp_get_decision`

Retrieve a specific Garante decision by its reference number.

**Arguments:**

| Name | Type | Required | Description |
|---|---|---|---|
| `reference` | string | Yes | Decision reference (e.g., `GPDP-2021-001`) |

**Returns:** Full `Decision` object with `_citation` and `_meta`.

**Errors:** Returns `{ error: string, _error_type: "not_found" }` if the reference does not exist.

---

### `it_dp_search_guidelines`

Search Garante guidance documents (linee guida, provvedimenti generali, FAQ).

**Arguments:**

| Name | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Search query in Italian |
| `type` | string | No | Filter by type: `linee_guida`, `provvedimento_generale`, `FAQ`, `parere` |
| `topic` | string | No | Filter by topic ID |
| `limit` | number | No | Max results (default 20, max 100) |

**Returns:** `{ results: Guideline[], count: number, _meta: Meta }`

Each result includes a `_citation` block.

---

### `it_dp_get_guideline`

Retrieve a specific Garante guidance document by its database ID.

**Arguments:**

| Name | Type | Required | Description |
|---|---|---|---|
| `id` | number | Yes | Guideline database ID (from `it_dp_search_guidelines`) |

**Returns:** Full `Guideline` object with `_citation` and `_meta`.

**Errors:** Returns `{ error: string, _error_type: "not_found" }` if the ID does not exist.

---

## Meta tools

### `it_dp_list_topics`

List all covered data protection topics with Italian and English names. Use topic IDs to filter decisions and guidelines.

**Arguments:** none

**Returns:** `{ topics: Topic[], count: number, _meta: Meta }`

---

### `it_dp_about`

Return metadata about this MCP server: version, data source, coverage summary, and tool list.

**Arguments:** none

**Returns:** Server metadata object with `_meta`.

---

### `it_dp_list_sources`

List the data sources covered by this MCP server, including authority names, official URLs, and coverage details.

**Arguments:** none

**Returns:** `{ sources: Source[], _meta: Meta }`

---

### `it_dp_check_data_freshness`

Check when the data in this MCP was last updated. Returns the most recent decision and guideline dates in the database.

**Arguments:** none

**Returns:** `{ data_age: { decisions: string|null, guidelines: string|null }, source: string, source_url: string, checked_at: string, _meta: Meta }`

---

## Common response fields

### `_meta`

All tool responses include a `_meta` block:

```json
{
  "_meta": {
    "disclaimer": "Data sourced from Garante per la protezione dei dati personali. For informational purposes only. Not legal advice.",
    "data_age": { "decisions": "2024-11-15", "guidelines": "2024-10-01" },
    "copyright": "© Garante per la protezione dei dati personali",
    "source_url": "https://www.garanteprivacy.it/"
  }
}
```

### `_citation`

Individual items include a `_citation` block for the deterministic citation pipeline:

```json
{
  "_citation": {
    "canonical_ref": "GPDP-2021-001",
    "display_text": "Garante Decision GPDP-2021-001",
    "source_url": "https://www.garanteprivacy.it/",
    "lookup": {
      "tool": "it_dp_get_decision",
      "args": { "reference": "GPDP-2021-001" }
    }
  }
}
```
