interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * GSA eLibrary — Multiple Award Schedule (MAS) contract holders.
 *
 * usaspending shows awards that were already made; this shows who currently
 * HOLDS a schedule contract and can bid on task orders — the complement
 * fleet #3260 asked for. GSA CALC+ (`gsa-calc`) covers labor rates only and
 * does not list contract holders itself.
 *
 * SOURCE. GSA, eLibrary — the public MAS/GWAC contract-holder directory. No
 * key, no login, no CAPTCHA. The site is a legacy Java/Struts app: every page
 * is plain server-rendered HTML with no JSON API, so this pack parses the
 * same three page types a human browsing eLibrary would hit:
 *   - a keyword search page (SIN/category matches + contractor matches)
 *   - a per-SIN contractor-listing page (the one with a plain GET form)
 *   - a per-contract contractor-profile page
 * All three answer a bare, unauthenticated GET — measured live 2026-10-18.
 * Proxied live on every call; nothing is mirrored or cached beyond what a
 * normal client would hold for the length of one request.
 *
 * WHY REGEX AND NOT A BULK DOWNLOAD. The site's own "Download Contractors
 * (xls | csv)" link requires continuing a session cookie from the page that
 * rendered it — fetched without that continuity it returns "System Error:
 * Unable to access GSA eLibrary", which is a session gate, not a bulk file.
 * The plain per-SIN listing page already carries every field this pack needs
 * (contractor name, contract number, phone, city, state), is a GET with no
 * CSRF token, and renders the FULL contractor list for a SIN on one page —
 * no server-side paging. Measured live: SIN 541511 (IT value-added resellers)
 * returns 341 rows at ~70KB; SIN 541611 (management/business consulting)
 * returns 3,107 rows in a single ~5.2MB response that still parses in single-
 * digit milliseconds with the regexes below. This pack fetches the whole page
 * per call (a live client has no cheaper option) and applies limit/offset on
 * the parsed result, the way the upstream itself would if it supported paging.
 *
 * PARSING NOTES, measured against real pages:
 *   - A SIN's category description can run past 1,000 characters with no
 *     `<br>`/`</font>` inside the first few hundred — an early version of the
 *     title/description regex here anchored BOTH in one match and silently
 *     dropped every SIN whose description was long enough to miss that
 *     anchor (it just fails to match at all, which reads as "no results").
 *     Fixed by capturing title and description as two separate, bounded
 *     windows rather than one combined pattern.
 *   - The contractor-listing table's columns are NOT fixed: some SINs insert
 *     an extra "Disaster Purchasing" icon cell between the contractor-name
 *     cell and the contract-number cell, some don't. Rows are therefore
 *     parsed by locating each `contractorInfo.do` link and then searching
 *     only the text BETWEEN that link and the next one for phone/city/state,
 *     rather than assuming a fixed column offset.
 *   - `contractorInfo.do` requires BOTH `contractNumber` AND `contractorName`
 *     (exact case, exact spelling as eLibrary stores it) — a contract number
 *     alone 404s with "Invalid Contract Number/Contractor Name". A caller who
 *     only has a company name is resolved via the keyword search first.
 *   - EPLS (exclusion list) status and other value cells sit in a `<td>`
 *     whose closing tag is inconsistent (`</font>` is sometimes simply
 *     missing from the upstream markup) — fields are captured up to the next
 *     literal `<`, never up to a specific closing tag, so a dropped closing
 *     tag upstream doesn't silently drop the field here.
 *
 * THE PER-CONTRACT DETAIL PAGE (`contractorInfo.do`) IS BLOCKED FROM OUR
 * EGRESS. Measured live post-deploy, 2026-10-19: `gsa_schedule_search` and
 * `gsa_schedule_contract_holders` work from the gateway (`searchResults.do`
 * and `sinDetails.do` both answer, the former with an occasional single
 * 403 that clears on retry), but `contractorInfo.do` returns HTTP 403 on
 * every attempt — GSA's front end evidently treats that one page
 * differently for datacenter/Worker egress. `gsa_contractor_profile` no
 * longer calls it at all: it builds a profile from the two routes that ARE
 * reachable (a contractor-name search, plus an optional per-SIN listing
 * lookup) and says plainly which fields that combination cannot supply
 * (address, email, website, SAM UEI, NAICS, socio-economic/exclusion-list
 * status, option-period end date — all of those live ONLY on the blocked
 * page). This is a `fields_unavailable` list, not a crash: a caller who
 * needs those fields should treat them as genuinely not obtainable from
 * this route right now, not retry them.
 */


const UPSTREAM_NAME = 'GSA eLibrary';
const BASE = 'https://www.gsaelibrary.gsa.gov/ElibMain/';
const UA = 'pipeworx-mcp-gsa-elibrary/1.0 (+https://pipeworx.io)';
const SOURCE = 'GSA, eLibrary — Multiple Award Schedule contract-holder directory';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `retryOnBlock: true` buys ONE bounded retry, after a short backoff, when
 * the upstream answers 403 or 429 — measured live, `searchResults.do` 403'd
 * on a cold first call and then answered cleanly on retry, which reads like
 * a transient edge/WAF hiccup rather than a standing block. Bounded to a
 * single retry on purpose: a page that is GENUINELY blocked (contractorInfo.do
 * 403'd on 4/4 live attempts, no recovery) must still fail loudly after one
 * extra try, not spin silently.
 */
async function pwFetch(path: string, opts: { retryOnBlock?: boolean } = {}): Promise<string> {
  const url = `${BASE}${path}`;
  const init = { headers: { 'User-Agent': UA, Accept: 'text/html' } };
  let res = await fetchWithTimeout(url, init, UPSTREAM_NAME);
  if (opts.retryOnBlock && (res.status === 403 || res.status === 429)) {
    await sleep(600);
    res = await fetchWithTimeout(url, init, UPSTREAM_NAME);
  }
  if (!res.ok) {
    // httpError reads the upstream's own response body (its HTML <title>,
    // typically — "Access Denied", a WAF challenge page, etc.) and never
    // echoes the request path/query we built, per the name-the-source-not-
    // the-route rule: the path lives only here in source, never in a
    // caller-facing message.
    throw await httpError(res, UPSTREAM_NAME);
  }
  return res.text();
}

function decodeHref(v: string): string {
  return decodeURIComponent(v.replace(/\+/g, ' '));
}

function encodeParam(v: string): string {
  return encodeURIComponent(v).replace(/%20/g, '+');
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// ── gsa_schedule_search ─────────────────────────────────────────────────

interface CategoryMatch {
  schedule_number: string;
  sin: string;
  title: string | null;
  description: string | null;
}

interface ContractorMatch {
  contractor_name: string;
  contract_number: string;
}

function parseCategoryMatches(html: string): CategoryMatch[] {
  const linkRe =
    /sinDetails\.do\?scheduleNumber=([^&"]+)&specialItemNumber=([^&"]+)&executeQuery=YES">[^<]+<\/a>/g;
  const out: CategoryMatch[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html))) {
    const schedule_number = decodeHref(m[1]!);
    const sin = decodeHref(m[2]!);
    const key = `${schedule_number}|${sin}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const context = html.slice(linkRe.lastIndex, linkRe.lastIndex + 700);
    const titleM = /<td><font class=columntitle size='2'>([^<]*)<\/font>/.exec(context);
    let title: string | null = null;
    let description: string | null = null;
    if (titleM) {
      title = stripTags(titleM[1]!);
      const afterTitle = context.slice(titleM.index + titleM[0].length);
      const descM = /<font size='2'>\s*-?\s*([\s\S]{0,420})/.exec(afterTitle);
      if (descM) description = stripTags(descM[1]!).slice(0, 300);
    }
    out.push({ schedule_number, sin, title, description });
  }
  return out;
}

function parseContractorMatches(html: string): ContractorMatch[] {
  const re =
    /<dd><a href="contractorInfo\.do\?contractNumber=([^&"]+)&contractorName=([^&"]+)&executeQuery=YES">/g;
  const out: ContractorMatch[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const contract_number = decodeHref(m[1]!);
    const contractor_name = decodeHref(m[2]!);
    const key = `${contract_number}|${contractor_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ contractor_name, contract_number });
  }
  return out;
}

async function scheduleSearch(args: Record<string, unknown>): Promise<unknown> {
  const keyword = String(args.keyword ?? '').trim();
  if (!keyword) throw new Error('keyword is required');
  const searchTypeArg = String(args.search_type ?? 'all_words');
  const searchTypeMap: Record<string, string> = {
    all_words: 'allWords',
    any_words: 'anyWords',
    exact_phrase: 'exactWords',
  };
  const searchType = searchTypeMap[searchTypeArg];
  if (!searchType) {
    throw new Error(
      `search_type must be one of: ${Object.keys(searchTypeMap).join(', ')} (got "${searchTypeArg}")`,
    );
  }

  const html = await pwFetch(
    `searchResults.do?searchText=${encodeParam(keyword)}&searchType=${searchType}`,
    { retryOnBlock: true },
  );

  if (/No matches found using your search criteria/i.test(html)) {
    return {
      source: SOURCE,
      keyword,
      search_type: searchTypeArg,
      category_match_count: 0,
      contractor_match_count: 0,
      category_matches: [],
      contractor_matches: [],
      note: `No GSA eLibrary matches for keyword "${keyword}" with search_type "${searchTypeArg}". Try any_words, a shorter phrase, or a SIN/NAICS code.`,
    };
  }

  const category_matches = parseCategoryMatches(html).slice(0, 50);
  const contractor_matches = parseContractorMatches(html).slice(0, 50);

  return {
    source: SOURCE,
    keyword,
    search_type: searchTypeArg,
    category_match_count: category_matches.length,
    contractor_match_count: contractor_matches.length,
    category_matches,
    contractor_matches,
  };
}

// ── gsa_schedule_contract_holders ───────────────────────────────────────

interface ContractHolder {
  contractor_name: string;
  contract_number: string;
  phone: string | null;
  city: string | null;
  state: string | null;
}

function parseContractHolders(html: string): ContractHolder[] {
  const linkRe =
    /href=contractorInfo\.do\?contractNumber=([^&]+)&amp;contractorName=([^&]+)&amp;executeQuery=YES>/g;
  const positions: { idx: number; contractNumber: string; contractorName: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html))) {
    positions.push({
      idx: linkRe.lastIndex,
      contractNumber: decodeHref(m[1]!),
      contractorName: decodeHref(m[2]!),
    });
  }
  const out: ContractHolder[] = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i]!.idx;
    const end = i + 1 < positions.length ? positions[i + 1]!.idx : Math.min(html.length, start + 2000);
    const chunk = html.slice(start, end);
    const phoneM = /<td align=middle><font size=1>([^<]*)<\/font><\/td>/.exec(chunk);
    const cityStateM =
      /<td align=right>\s*<font size=1>([^<]*)<\/font><font size="2">([^<]*)<\/font>/.exec(chunk);
    out.push({
      contractor_name: positions[i]!.contractorName,
      contract_number: positions[i]!.contractNumber,
      phone: phoneM ? stripTags(phoneM[1]!) || null : null,
      city: cityStateM ? stripTags(cityStateM[1]!).replace(/,$/, '').trim() || null : null,
      state: cityStateM ? stripTags(cityStateM[2]!) || null : null,
    });
  }
  return out;
}

async function scheduleContractHolders(args: Record<string, unknown>): Promise<unknown> {
  const sin = String(args.sin ?? '').trim();
  if (!sin) throw new Error('sin (Special Item Number) is required');
  const schedule = String(args.schedule ?? 'MAS').trim() || 'MAS';
  const keyword = args.keyword !== undefined ? String(args.keyword).trim() : '';
  const limitArg = Number(args.limit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitArg) ? Math.min(Math.max(1, Math.trunc(limitArg)), MAX_LIMIT) : DEFAULT_LIMIT;
  const offsetArg = Number(args.offset ?? 0);
  const offset = Number.isFinite(offsetArg) ? Math.max(0, Math.trunc(offsetArg)) : 0;

  const html = await pwFetch(
    `sinDetails.do?scheduleNumber=${encodeParam(schedule)}&specialItemNumber=${encodeParam(sin)}&executeQuery=YES`,
  );

  if (/Could not retrieve Schedule Details - Invalid Category/i.test(html)) {
    throw new Error(
      `GSA eLibrary has no SIN "${sin}" under schedule "${schedule}". Use gsa_schedule_search to find a valid schedule/SIN pair first.`,
    );
  }

  const totalM = /(\d+)\s+contractors/.exec(html);
  const total_contractors = totalM ? Number(totalM[1]) : 0;

  let holders = parseContractHolders(html);

  if (total_contractors === 0 && holders.length === 0) {
    return {
      source: SOURCE,
      schedule,
      sin,
      keyword: keyword || null,
      total_contractors: 0,
      matched_contractors: 0,
      returned: 0,
      offset,
      limit,
      holders: [],
      note: `Schedule "${schedule}", SIN "${sin}" currently has 0 contract holders listed in GSA eLibrary.`,
    };
  }

  if (keyword) {
    const needle = keyword.toLowerCase();
    holders = holders.filter(
      (h) =>
        h.contractor_name.toLowerCase().includes(needle) ||
        h.contract_number.toLowerCase().includes(needle) ||
        (h.city ?? '').toLowerCase().includes(needle) ||
        (h.state ?? '').toLowerCase().includes(needle),
    );
  }

  const matched_contractors = holders.length;
  const page = holders.slice(offset, offset + limit);

  const result: Record<string, unknown> = {
    source: SOURCE,
    schedule,
    sin,
    keyword: keyword || null,
    total_contractors,
    matched_contractors,
    returned: page.length,
    offset,
    limit,
    holders: page,
  };

  if (keyword && matched_contractors === 0) {
    result.note = `0 of ${total_contractors} contract holders under schedule "${schedule}", SIN "${sin}" matched keyword "${keyword}" (matched against contractor name, contract number, city, and state).`;
  }

  return result;
}

// ── gsa_contractor_profile ──────────────────────────────────────────────
//
// Does NOT call contractorInfo.do — see the header note above. Built
// entirely from two reachable routes: a contractor-name search
// (searchResults.do, same endpoint gsa_schedule_search uses) for schedule/
// contract-number associations, plus an OPTIONAL per-SIN listing lookup
// (sinDetails.do, same endpoint gsa_schedule_contract_holders uses) when the
// caller supplies a `sin` — that row carries phone/city/state, which the
// search page alone does not.

const PROFILE_FIELDS_UNAVAILABLE = [
  'address',
  'email',
  'website',
  'sam_uei',
  'naics',
  'socio_economic',
  'excluded_parties_status',
  'current_option_period_end',
] as const;

interface ScheduleAssociation {
  schedule_number: string;
  schedule_title: string | null;
  contract_number: string;
  contractor_name: string;
  closed_for_new_awards: boolean;
}

/**
 * Contractor matches on a search-results page are grouped under a schedule
 * header ("ALIAN2" / "Alliant 2") followed by a "Contractors" block of one or
 * more `<dd>` entries. Unlike `parseContractorMatches` (which only needs the
 * contract number + name), this also keeps which schedule each match sits
 * under — that schedule association is the one thing `gsa_contractor_profile`
 * can still report without the blocked per-contract page. Bounded by the
 * NEXT schedule header's position rather than a fixed byte window, the same
 * fix `parseCategoryMatches` needed: a schedule's own description text can
 * run past any fixed window.
 */
function parseContractorScheduleMatches(html: string): ScheduleAssociation[] {
  const schedRe = /scheduleSummary\.do\?scheduleNumber=([^"]+)">[^<]*<\/a>/g;
  const positions: { idx: number; scheduleNumber: string }[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = schedRe.exec(html))) {
    positions.push({ idx: schedRe.lastIndex, scheduleNumber: decodeHref(sm[1]!) });
  }
  const ddRe =
    /<dd><a href="contractorInfo\.do\?contractNumber=([^&"]+)&contractorName=([^&"]+)&executeQuery=YES">/g;
  const out: ScheduleAssociation[] = [];
  for (let i = 0; i < positions.length; i++) {
    const { idx, scheduleNumber } = positions[i]!;
    const end = i + 1 < positions.length ? positions[i + 1]!.idx : html.length;
    const chunk = html.slice(idx, end);
    const titleM = /<font class=columntitle size='2'>([^<]*)<\/font>/.exec(chunk);
    const schedule_title = titleM ? stripTags(titleM[1]!) : null;
    ddRe.lastIndex = 0;
    let dm: RegExpExecArray | null;
    while ((dm = ddRe.exec(chunk))) {
      // Right after `</a> [CONTRACTNUM]`, a closed contract carries a red
      // "Contract Closed for New Awards" marker in the next ~150 chars — the
      // one signal in this HTML for "holds a contract but can no longer be
      // awarded new task orders on it", which matters for a "can bid" answer.
      const afterDd = chunk.slice(ddRe.lastIndex, ddRe.lastIndex + 150);
      out.push({
        schedule_number: scheduleNumber,
        schedule_title,
        contract_number: decodeHref(dm[1]!),
        contractor_name: decodeHref(dm[2]!),
        closed_for_new_awards: /Contract Closed for New Awards/i.test(afterDd),
      });
    }
  }
  return out;
}

function blockedProfileResult(contractorName: string, err: unknown): Record<string, unknown> {
  const detail = err instanceof Error ? err.message : String(err);
  return {
    source: SOURCE,
    contractor_name: contractorName,
    found: false,
    note:
      `GSA blocks this lookup from our network — GSA eLibrary refused the contractor search ` +
      `even after a retry (${detail}). This is not a bad argument; retry later, or use ` +
      `gsa_schedule_contract_holders with a known schedule/SIN, which answers from this same network.`,
  };
}

async function contractorProfile(args: Record<string, unknown>): Promise<unknown> {
  const contractorNameArg = String(args.contractor_name ?? '').trim();
  if (!contractorNameArg) throw new Error('contractor_name is required');
  const contractNumberFilter = args.contract_number !== undefined ? String(args.contract_number).trim() : '';
  const sinArg = args.sin !== undefined ? String(args.sin).trim() : '';
  const scheduleArg = String(args.schedule ?? 'MAS').trim() || 'MAS';

  let html: string;
  try {
    html = await pwFetch(
      `searchResults.do?searchText=${encodeParam(contractorNameArg)}&searchType=exactWords`,
      { retryOnBlock: true },
    );
  } catch (err) {
    return blockedProfileResult(contractorNameArg, err);
  }

  if (/No matches found using your search criteria/i.test(html)) {
    return {
      source: SOURCE,
      contractor_name: contractorNameArg,
      found: false,
      note: `No GSA eLibrary contractor matching "${contractorNameArg}". Names must match eLibrary's registered spelling — try gsa_schedule_search first.`,
    };
  }

  const needle = contractorNameArg.toLowerCase();
  let associations = parseContractorScheduleMatches(html).filter(
    (a) => a.contractor_name.toLowerCase() === needle,
  );
  if (contractNumberFilter) {
    associations = associations.filter((a) => a.contract_number === contractNumberFilter);
  }

  if (associations.length === 0) {
    return {
      source: SOURCE,
      contractor_name: contractorNameArg,
      found: false,
      note: contractNumberFilter
        ? `GSA eLibrary search found "${contractorNameArg}" but no schedule association with contract_number "${contractNumberFilter}". Omit contract_number to see every schedule it holds.`
        : `No GSA eLibrary contractor matching "${contractorNameArg}". Names must match eLibrary's registered spelling — try gsa_schedule_search first.`,
    };
  }

  const canonicalName = associations[0]!.contractor_name;
  const seen = new Set<string>();
  const schedules_held: { schedule_number: string; schedule_title: string | null; contract_number: string; closed_for_new_awards: boolean }[] = [];
  for (const a of associations) {
    const key = `${a.schedule_number}|${a.contract_number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    schedules_held.push({
      schedule_number: a.schedule_number,
      schedule_title: a.schedule_title,
      contract_number: a.contract_number,
      closed_for_new_awards: a.closed_for_new_awards,
    });
  }

  let contact: { sin: string; schedule: string; contract_number: string; phone: string | null; city: string | null; state: string | null } | null = null;
  let sin_note: string | null = null;
  if (sinArg) {
    try {
      const sinHtml = await pwFetch(
        `sinDetails.do?scheduleNumber=${encodeParam(scheduleArg)}&specialItemNumber=${encodeParam(sinArg)}&executeQuery=YES`,
      );
      if (/Could not retrieve Schedule Details - Invalid Category/i.test(sinHtml)) {
        sin_note = `No SIN "${sinArg}" under schedule "${scheduleArg}" — phone/city/state not pulled.`;
      } else {
        const holder = parseContractHolders(sinHtml).find(
          (h) => h.contractor_name.toLowerCase() === canonicalName.toLowerCase(),
        );
        if (holder) {
          contact = { sin: sinArg, schedule: scheduleArg, contract_number: holder.contract_number, phone: holder.phone, city: holder.city, state: holder.state };
        } else {
          sin_note = `"${canonicalName}" does not appear in the schedule "${scheduleArg}", SIN "${sinArg}" contract-holder listing — phone/city/state not available from that SIN.`;
        }
      }
    } catch (err) {
      sin_note = `Could not read schedule "${scheduleArg}", SIN "${sinArg}" for contact details (${err instanceof Error ? err.message : String(err)}).`;
    }
  }

  const note = contact
    ? `Built from GSA eLibrary's contractor search plus the schedule "${contact.schedule}", SIN "${contact.sin}" contract-holder listing. ${PROFILE_FIELDS_UNAVAILABLE.join(', ')} come only from eLibrary's per-contract detail page, which is blocked from our network and not available here.`
    : `Built from GSA eLibrary's contractor search only — phone/city/state need a known schedule+SIN; pass \`sin\` (and \`schedule\`) to pull those from gsa_schedule_contract_holders's same listing. ${PROFILE_FIELDS_UNAVAILABLE.join(', ')} come only from eLibrary's per-contract detail page, which is blocked from our network and not available here.${sin_note ? ` ${sin_note}` : ''}`;

  return {
    source: SOURCE,
    found: true,
    contractor_name: canonicalName,
    schedules_held,
    schedule_count: schedules_held.length,
    phone: contact?.phone ?? null,
    city: contact?.city ?? null,
    state: contact?.state ?? null,
    address: null,
    email: null,
    website: null,
    sam_uei: null,
    naics: null,
    socio_economic: null,
    excluded_parties_status: null,
    current_option_period_end: null,
    fields_unavailable: contact
      ? [...PROFILE_FIELDS_UNAVAILABLE]
      : ['phone', 'city', 'state', ...PROFILE_FIELDS_UNAVAILABLE],
    note,
  };
}

// ── tool registration ───────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'gsa_schedule_search',
    description:
      'Search GSA eLibrary by keyword, SIN number, NAICS code, or contractor/manufacturer name. Returns matching Multiple Award Schedule (MAS) categories/SINs and contractor matches with contract numbers — the starting point for finding who holds a GSA schedule contract.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keyword: {
          type: 'string',
          description: 'Keyword, SIN/category number, NAICS code, contract number, or contractor/manufacturer name',
        },
        search_type: {
          type: 'string',
          enum: ['all_words', 'any_words', 'exact_phrase'],
          description: 'How to match multi-word keywords (default all_words)',
        },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'gsa_schedule_contract_holders',
    description:
      'List Multiple Award Schedule contract holders for a given SIN (Special Item Number), optionally narrowed by a keyword matched against contractor name, contract number, city, or state. Returns each holder\'s contract number, phone, and location. Use gsa_schedule_search first to find a valid schedule/SIN pair.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sin: { type: 'string', description: 'Special Item Number (SIN), e.g. "541511" or "ALL 2"' },
        schedule: { type: 'string', description: 'Schedule/GWAC number the SIN belongs to (default "MAS")' },
        keyword: { type: 'string', description: 'Optional filter against contractor name, contract number, city, or state' },
        limit: { type: 'number', description: `Max holders to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
        offset: { type: 'number', description: 'Pagination offset (default 0)' },
      },
      required: ['sin'],
    },
  },
  {
    name: 'gsa_contractor_profile',
    description:
      'Look up which GSA Multiple Award Schedule(s)/GWAC(s) a contractor holds and its contract number(s) on each. Pass a known `sin` (and `schedule`) to also pull phone/city/state from that SIN\'s contract-holder listing. Address, email, website, SAM UEI, NAICS, socio-economic/exclusion-list status, and option-period end date are not available from this tool — eLibrary\'s per-contract detail page that carries them is blocked from our network; the response names this plainly.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        contractor_name: { type: 'string', description: 'Contractor/manufacturer name (matched case-insensitively against eLibrary\'s search results)' },
        contract_number: { type: 'string', description: 'Optional — narrow to one specific contract number when the contractor holds several' },
        sin: { type: 'string', description: 'Optional — a Special Item Number already known to be held by this contractor (e.g. from gsa_schedule_search), used to additionally pull phone/city/state' },
        schedule: { type: 'string', description: 'Schedule/GWAC number the `sin` belongs to (default "MAS"); only used when `sin` is given' },
      },
      required: ['contractor_name'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'gsa_schedule_search':
      return scheduleSearch(args);
    case 'gsa_schedule_contract_holders':
      return scheduleContractHolders(args);
    case 'gsa_contractor_profile':
      return contractorProfile(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
