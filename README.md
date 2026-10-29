# @pipeworx/gsa-elibrary

Who currently holds a GSA Multiple Award Schedule (MAS) contract and can bid
on task orders — the complement to usaspending's past-award data and to
`gsa-calc`'s labor-rate-only coverage.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `gsa_schedule_search(keyword, search_type?)` — search by keyword, SIN
  number, NAICS code, or contractor/manufacturer name. Returns matching
  MAS/GWAC categories and SINs, plus contractor matches with contract
  numbers — the starting point for finding a valid schedule/SIN pair.
- `gsa_schedule_contract_holders(sin, schedule?, keyword?, limit?, offset?)` —
  every contract holder currently listed under a SIN, with contract number,
  phone, city and state. `keyword` filters client-side against name, contract
  number, city, or state. `schedule` defaults to `"MAS"`.
- `gsa_contractor_profile(contractor_name, contract_number?, sin?, schedule?)`
  — every schedule/GWAC a contractor holds and its contract number on each,
  plus which of those contracts are closed to new awards. Pass a `sin` (and
  `schedule`) already known to be held by the contractor to also pull
  phone/city/state from that SIN's contract-holder listing. Address, email,
  website, SAM UEI, NAICS, socio-economic/exclusion-list status, and
  option-period end date are **not available from this tool** — see "Behaviour
  worth knowing" below.

## Auth

Keyless. No login, no API key, no CAPTCHA.

## Data sources

- GSA, eLibrary — the public Multiple Award Schedule / GWAC contract-holder
  directory. Every page answers a bare, unauthenticated request; nothing is
  mirrored or cached beyond the length of one call.

## Behaviour worth knowing

- **No JSON API.** eLibrary is a legacy server-rendered site with no
  documented API for contract-holder data (a separate, undocumented
  `search_categories`-style endpoint covers SIN/category metadata only, not
  contractors). This pack parses the same HTML pages a browser would load.
- **The site's own "Download Contractors (xls/csv)" link needs a continued
  session cookie** from the page that rendered it — fetched cold it returns
  "System Error: Unable to access GSA eLibrary". The per-SIN listing page
  needs no such continuity: it is a plain GET with no CSRF token, and it
  already renders the FULL contractor list for a SIN on one page with no
  server-side pagination (measured live: SIN 541511 returns 341 rows at
  ~70KB; SIN 541611 returns 3,107 rows in one ~5.2MB response, which this pack
  still parses in single-digit milliseconds). `limit`/`offset` are applied
  after parsing, the way the upstream itself would if it supported paging.
- **eLibrary's per-contract detail page is blocked from our network.**
  Measured live post-deploy: the search-results page and the per-SIN listing
  page both answer (the search page occasionally 403s once and then clears on
  a retry — this pack retries that one, bounded to a single attempt so a real
  block still fails loudly), but the per-contractor detail page returns HTTP
  403 on every attempt. `gsa_contractor_profile` does not call it at all — it
  builds the profile from the two reachable routes instead (a contractor-name
  search for schedule/contract-number associations, plus an optional per-SIN
  lookup for phone/city/state), and the response's `fields_unavailable` list
  plus `note` say plainly which fields that combination cannot supply. If the
  search itself is also blocked after its one retry, the tool returns
  `found: false` with a note saying so, rather than surfacing a raw 403.
- **A SIN's category description can run past 1,000 characters** with no
  `<br>`/closing tag inside the first few hundred. Title and description are
  parsed as two separately-bounded windows rather than one combined pattern,
  so a long description can't cause the whole match (including the short
  title/SIN) to silently fail.
- **The contractor-listing table's columns are not fixed** — some SINs insert
  an extra "Disaster Purchasing" icon cell between the name and contract-number
  cells, some don't. Rows are parsed by locating each contractor link and
  reading only the text between it and the next one, rather than assuming a
  fixed column offset.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "gsa-elibrary": {
      "url": "https://gateway.pipeworx.io/gsa-elibrary/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/gsa-elibrary/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/gsa_schedule_search \
  -H 'Content-Type: application/json' \
  -d '{"keyword":"cybersecurity"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/gsa_schedule_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-gsa-elibrary` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/gsa-elibrary/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "gsa-elibrary": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-gsa-elibrary"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Gsa Elibrary data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
