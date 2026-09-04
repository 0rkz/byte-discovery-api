/**
 * Verification for the 2026-09-03 fail-CLOSED change.
 *
 * A SECOND file rather than more blocks in test-feeds-fix.js, for one
 * mechanical reason: config.ts reads process.env at MODULE LOAD, so tests
 * that need a different GATEWAY_FETCH_TIMEOUT_MS, CATALOG_CACHE_TTL_MS or
 * X402_GATEWAY_FETCH cannot share one loaded module with the others. Each
 * scenario here sets env and then re-requires dist/lib/{config,feeds}.js with
 * their require-cache entries deleted, which test-feeds-fix.js never does.
 *
 * Same style as test-feeds-fix.js: no framework, mock viem + global.fetch,
 * drive the COMPILED dist/ build, no real network call. The viem mock is a
 * compact local one rather than a shared import so each test file still reads
 * top-to-bottom on its own.
 *
 * Run:
 *   cd discovery-api && npm run build && node test-feeds-degraded.js
 */

const path = require("path");

let PASS = 0;
let FAIL = 0;
function check(name, cond, detail) {
  if (cond) {
    PASS++;
    console.log(`  ok   ${name}`);
  } else {
    FAIL++;
    console.log(`  FAIL ${name}  <- ${detail !== undefined ? JSON.stringify(detail) : ""}`);
  }
}

function topicToHex(topic) {
  const bytes = Buffer.from(topic, "ascii");
  const padded = Buffer.concat([bytes, Buffer.alloc(32 - bytes.length)]);
  return "0x" + padded.toString("hex");
}

// ── viem mock: installed ONCE, survives every re-require of feeds.js ────────
let mockPublishers = [];
let mockListOrder = [];
let schemaRejectsFor = null;   // address whose getSchema read fails
let listLengthThrows = false;  // chain enumeration itself fails

const viemModule = require("viem");
Object.defineProperty(viemModule, "createPublicClient", {
  value: () => ({
    readContract: async ({ functionName, args }) => {
      const byAddr = new Map(mockPublishers.map((p) => [p.address.toLowerCase(), p]));
      const addr = (args && args[0] ? String(args[0]) : "").toLowerCase();
      if (functionName === "getPublisher") {
        const p = byAddr.get(addr);
        if (!p) throw new Error(`mock RPC: no publisher at ${addr}`);
        return {
          status: p.status, tier: 0, stakedAmount: 0n, sandboxStartTime: 0n,
          registeredAt: 0n, subscriberCount: p.subscriberCount, messageCount: p.messageCount,
          totalRevenue: 0n, lastActiveTimestamp: 0n,
          publicKey: "0x" + "00".repeat(32), slashCount: 0n,
        };
      }
      if (functionName === "getSchema") {
        if (schemaRejectsFor && addr === schemaRejectsFor.toLowerCase()) {
          throw new Error("mock RPC: schema read failed");
        }
        const p = byAddr.get(addr);
        return {
          expectedSize: 4096, maxSize: 65536,
          frequencySeconds: p.schema.frequencySeconds, pubClass: 0, verType: 0,
          methodologyHash: "0x" + "11".repeat(32), topic: p.schema.topicHex,
          pricePerKB: p.schema.pricePerKB, active: true, registeredAt: 0n,
        };
      }
      if (functionName === "getPublisherListLength") {
        if (listLengthThrows) throw new Error("mock RPC: enumeration failed");
        return BigInt(mockListOrder.length);
      }
      if (functionName === "publisherList") return mockListOrder[Number(args[0])];
      throw new Error(`mock RPC: unhandled ${functionName}`);
    },
  }),
  writable: true,
  configurable: true,
});

// ── fetch mock ─────────────────────────────────────────────────────────────
let gatewayMode = "ok";      // ok | status | throw | hang | body
let gatewayStatus = 429;
let gatewayBody = null;      // served verbatim as the 2xx JSON when mode is "body"
let gatewayFeeds = [];
let indexerPublishers = null;
let indexerMode = "ok";      // ok | hang
let gatewayCalls = [];       // every URL the gateway fetch was called with

// A fetch that settles ONLY when its signal aborts — the shape of a hung
// upstream. With no signal at all it never settles, which is exactly what a
// build that forgot the AbortSignal would do in production; the test around
// it must then time out rather than pass by accident.
function hangUntilAbort(opts) {
  return new Promise((_resolve, reject) => {
    if (!opts || !opts.signal) return;
    opts.signal.addEventListener("abort", () => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      reject(e);
    });
  });
}

// A real fetch is asynchronous, so a signal that fires "immediately" still
// beats the response. The ok-mode mock answers after one short macrotask and
// then honours an aborted signal. Without this, a 0 ms timeout and a 5 s one
// were indistinguishable to the suite, and T14's live check passed on the
// unguarded build (VER L2).
async function respectAbort(opts) {
  await new Promise((r) => setTimeout(r, 5));
  if (opts && opts.signal && opts.signal.aborted) {
    const e = new Error("The operation was aborted due to timeout");
    e.name = "TimeoutError";
    throw e;
  }
}

// A rejected recovery must fail a CHECK, never crash the runner (VER L4).
async function settle(promise) {
  try { return { res: await promise, err: null }; } catch (err) { return { res: null, err }; }
}

global.fetch = async (url, opts) => {
  if (String(url).includes("/publishers?limit=200")) {
    if (indexerMode === "hang") return hangUntilAbort(opts);
    if (indexerPublishers === null) return { ok: false, status: 503 };
    await respectAbort(opts);
    return { ok: true, status: 200, json: async () => indexerPublishers };
  }
  if (String(url).endsWith("/feeds")) {
    gatewayCalls.push(String(url));
    if (gatewayMode === "status") return { ok: false, status: gatewayStatus };
    if (gatewayMode === "body") return { ok: true, status: 200, json: async () => gatewayBody };
    if (gatewayMode === "throw") throw new TypeError("fetch failed");
    if (gatewayMode === "hang") {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const e = new Error("The operation was aborted due to timeout");
          e.name = "TimeoutError";
          reject(e);
        });
      });
    }
    await respectAbort(opts);
    return { ok: true, status: 200, json: async () => ({ feeds: gatewayFeeds }) };
  }
  throw new Error(`mock fetch: unhandled URL ${url}`);
};

// ── fresh module instance with a chosen environment ────────────────────────
const FEEDS = path.resolve(__dirname, "./dist/lib/feeds.js");
const CONFIG = path.resolve(__dirname, "./dist/lib/config.js");
const HTTP_ERRORS = path.resolve(__dirname, "./dist/lib/http-errors.js");

function loadFeeds(env = {}) {
  const defaults = {
    CATALOG_CACHE_TTL_MS: "0",
    GATEWAY_FETCH_TIMEOUT_MS: "5000",
    X402_GATEWAY: "https://x402.payperbyte.io",
    X402_GATEWAY_FETCH: "",
    LAST_GOOD_MAX_AGE_MS: "",
    CATALOG_FAILURE_CACHE_MS: "0",
  };
  for (const [k, v] of Object.entries({ ...defaults, ...env })) {
    if (v === "") delete process.env[k];
    else process.env[k] = String(v);
  }
  delete require.cache[CONFIG];
  delete require.cache[FEEDS];
  delete require.cache[HTTP_ERRORS];
  return require(FEEDS);
}

// Config alone, with the environment set EXACTLY as given — an empty string
// stays an empty string here (dotenv spells an unset `KEY=` line that way),
// which loadFeeds() above deliberately turns into "unset".
const MS_VARS = ["GATEWAY_FETCH_TIMEOUT_MS", "CATALOG_CACHE_TTL_MS", "LAST_GOOD_MAX_AGE_MS", "CATALOG_FAILURE_CACHE_MS"];
function loadConfig(env = {}) {
  for (const k of MS_VARS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = String(v);
  delete require.cache[CONFIG];
  return require(CONFIG).config;
}

// A 3-feed on-chain fixture plus a gateway that fronts all three.
function fixture(n = 3) {
  const names = ["alpha-feed", "beta-feed", "gamma-feed", "delta-feed"];
  mockPublishers = [];
  mockListOrder = [];
  for (let i = 0; i < n; i++) {
    const addr = "0x" + String(i + 1).repeat(40).slice(0, 40);
    mockPublishers.push({
      address: addr, status: 1, subscriberCount: 1n, messageCount: 10n,
      schema: { topicHex: topicToHex(names[i]), pricePerKB: 3000n, frequencySeconds: 3600 },
    });
    mockListOrder.push(addr);
  }
  indexerPublishers = mockPublishers.map((p) => ({ address: p.address }));
  gatewayFeeds = names.slice(0, n).map((t, i) => ({
    topic: t, priceAtomic: (i + 1) * 10000, provenance: "first-party",
  }));
  schemaRejectsFor = null;
  listLengthThrows = false;
  gatewayMode = "ok";
  gatewayBody = null;
  indexerMode = "ok";
  gatewayCalls = [];
}

const sameFeeds = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// AbortSignal.timeout() schedules an UNREF'd timer: it does not by itself keep
// the event loop alive. With a mocked fetch that only settles when the signal
// aborts, node found nothing else pending and exited 0 in the middle of T3 —
// printing no summary and silently skipping the remaining 8 tests, while a CI
// reading only the exit code would have called that a pass. This interval is
// what keeps the loop alive; production does not need it because the HTTP
// server holds the loop open.
async function main() {
  const keepAlive = setInterval(() => {}, 25);
  try {
    await run();
  } finally {
    clearInterval(keepAlive);
  }
}

async function run() {
  // ── T5: healthy response carries none of the degradation keys ───────────
  console.log("\n── T5: healthy response ──");
  fixture();
  let m = loadFeeds();
  const healthy = await m.getFeeds();
  check("healthy: 3 feeds", healthy.totalFeeds === 3, healthy.totalFeeds);
  check("healthy: 'degraded' key ABSENT (not false)", !("degraded" in healthy));
  check("healthy: 'degradedReason' key ABSENT", !("degradedReason" in healthy));
  check("healthy: 'lastGoodAt' key ABSENT", !("lastGoodAt" in healthy));

  // ── T1: one good call, then a 429 → last-good, disclosed ────────────────
  console.log("\n── T1: gateway 429 AFTER a good call ──");
  fixture();
  m = loadFeeds();
  const good = await m.getFeeds();
  gatewayMode = "status";
  gatewayStatus = 429;
  const degraded = await m.getFeeds();
  check("429: feeds deep-equal the last good catalog", sameFeeds(good.feeds, degraded.feeds));
  check("429: totalFeeds unchanged", degraded.totalFeeds === good.totalFeeds, degraded.totalFeeds);
  check("429: degraded === true", degraded.degraded === true);
  check("429: degradedReason names the status", /429/.test(degraded.degradedReason || ""), degraded.degradedReason);
  check("429: lastGoodAt is an ISO timestamp",
    typeof degraded.lastGoodAt === "string" && !Number.isNaN(Date.parse(degraded.lastGoodAt)), degraded.lastGoodAt);
  check("429: NOT the on-chain-only set (prices still the gateway's)",
    degraded.feeds.every((f) => f.pricePerCall !== null));
  check("429: the cached last-good itself stays clean for the next healthy hit",
    !("degraded" in good));

  // ── T2: 429 with NO prior good call → typed error ───────────────────────
  console.log("\n── T2: gateway 429 with no last-good ──");
  fixture();
  m = loadFeeds();
  gatewayMode = "status";
  gatewayStatus = 429;
  let threw = null;
  try { await m.getFeeds(); } catch (e) { threw = e; }
  check("no last-good: getFeeds rejects", threw !== null);
  check("no last-good: error is CatalogUnavailableError",
    threw && threw.name === "CatalogUnavailableError", threw && threw.name);
  check("no last-good: error carries a reason naming the status",
    threw && /429/.test(threw.reason || ""), threw && threw.reason);

  // ── T2c: a 2xx whose body is JSON but not a catalog is a FAILURE ────────
  // Pins the `Array.isArray(data?.feeds)` half of "good". A build that read
  // a non-array as [] would serve the on-chain-only set at 200 — the very
  // fail-open this change removed, reachable through a JSON error page.
  console.log("\n── T2c: gateway 2xx with a {} body ──");
  fixture();
  m = loadFeeds();
  gatewayMode = "body";
  gatewayBody = {};
  let bodyErr = null;
  let bodyRes = null;
  try { bodyRes = await m.getFeeds(); } catch (e) { bodyErr = e; }
  check("{} body, cold: rejected — a JSON-but-not-a-catalog 2xx is not an empty catalog",
    bodyErr !== null && bodyRes === null, bodyRes && bodyRes.totalFeeds);
  check("{} body, cold: CatalogUnavailableError",
    bodyErr && bodyErr.name === "CatalogUnavailableError", bodyErr && bodyErr.name);
  check("{} body, cold: reason says the body is malformed",
    bodyErr && /malformed/.test(bodyErr.reason || ""), bodyErr && bodyErr.reason);

  fixture();
  m = loadFeeds();
  const beforeBody = await m.getFeeds();
  gatewayMode = "body";
  gatewayBody = { feeds: "not an array" };
  const { res: afterBody, err: afterBodyErr } = await settle(m.getFeeds());
  check("non-array feeds, warm: last-good served and labelled degraded — never a 0-feed 200",
    afterBody && afterBody.degraded === true && sameFeeds(afterBody.feeds, beforeBody.feeds),
    afterBody ? afterBody.totalFeeds : afterBodyErr && afterBodyErr.reason);
  check("non-array feeds, warm: prices still the gateway's (not re-priced from the chain)",
    afterBody && afterBody.feeds.every((f) => f.pricePerCall !== null));

  // ── T3: hung gateway aborts on the timeout ──────────────────────────────
  console.log("\n── T3: gateway hangs, AbortSignal.timeout fires ──");
  fixture();
  m = loadFeeds({ GATEWAY_FETCH_TIMEOUT_MS: "200" });
  gatewayMode = "hang";
  const t0 = Date.now();
  let timeoutErr = null;
  try { await m.getFeeds(); } catch (e) { timeoutErr = e; }
  const elapsed = Date.now() - t0;
  check("hang: rejected rather than hanging forever", timeoutErr !== null);
  check(`hang: returned within 1500 ms (took ${elapsed} ms)`, elapsed < 1500);
  check("hang: reason says timeout", timeoutErr && /timeout/i.test(timeoutErr.reason || ""), timeoutErr && timeoutErr.reason);

  // ── T3b: hung INDEXER aborts on the timeout; the chain fallback answers ──
  // Pins the AbortSignal on fetchFromIndexer. Without it a hung indexer holds
  // every /discover open until the client gives up. The race below is what
  // turns "hangs forever" into a failed check instead of a hung suite.
  console.log("\n── T3b: indexer hangs, AbortSignal.timeout fires, chain fallback answers ──");
  fixture();
  m = loadFeeds({ GATEWAY_FETCH_TIMEOUT_MS: "200" });
  indexerMode = "hang";
  const t1 = Date.now();
  let raceTimer = null;
  const raced = await Promise.race([
    m.getFeeds().catch((e) => e),
    new Promise((r) => { raceTimer = setTimeout(r, 3000, "HUNG"); }),
  ]);
  clearTimeout(raceTimer);
  const elapsedIdx = Date.now() - t1;
  indexerMode = "ok";
  check("indexer hang: getFeeds settled instead of hanging", raced !== "HUNG");
  check(`indexer hang: settled within 1500 ms (took ${elapsedIdx} ms)`, elapsedIdx < 1500);
  check("indexer hang: a full catalog came from the chain fallback, not degraded",
    raced && raced.totalFeeds === 3 && !("degraded" in raced), raced && (raced.totalFeeds ?? raced.name));

  // ── T4: fetch throws ────────────────────────────────────────────────────
  console.log("\n── T4: gateway fetch throws ──");
  fixture();
  m = loadFeeds();
  gatewayMode = "throw";
  let throwErr = null;
  try { await m.getFeeds(); } catch (e) { throwErr = e; }
  check("throw: CatalogUnavailableError", throwErr && throwErr.name === "CatalogUnavailableError");
  check("throw: reason names the error", throwErr && /TypeError/.test(throwErr.reason || ""), throwErr && throwErr.reason);

  // ── T6: fetch base is split from the advertised base ────────────────────
  console.log("\n── T6: X402_GATEWAY_FETCH used ONLY for the fetch ──");
  fixture();
  m = loadFeeds({ X402_GATEWAY: "https://x402.example", X402_GATEWAY_FETCH: "http://127.0.0.1:3402" });
  const split = await m.getFeeds();
  check("split: the gateway was fetched over loopback",
    gatewayCalls.length > 0 && gatewayCalls.every((u) => u.startsWith("http://127.0.0.1:3402")), gatewayCalls);
  check("split: access.x402_gateway advertises the PUBLIC base",
    split.access.x402_gateway === "https://x402.example", split.access.x402_gateway);
  check("split: a served feed's endpoints.x402 advertises the PUBLIC base",
    split.feeds.every((f) => !f.endpoints.x402 || f.endpoints.x402.startsWith("https://x402.example")),
    split.feeds.map((f) => f.endpoints.x402));

  // ── T7: a rejected schema read never becomes a placeholder feed ─────────
  console.log("\n── T7: one publisher's schema read fails ──");
  fixture();
  m = loadFeeds();
  const beforeSchemaFail = await m.getFeeds();
  schemaRejectsFor = mockPublishers[1].address;
  const afterSchemaFail = await m.getFeeds();
  check("schema-fail: no feed is named 'data-feed'",
    !afterSchemaFail.feeds.some((f) => f.topic === "data-feed"),
    afterSchemaFail.feeds.map((f) => f.topic));
  check("schema-fail: no duplicate topics",
    new Set(afterSchemaFail.feeds.map((f) => f.topic)).size === afterSchemaFail.feeds.length,
    afterSchemaFail.feeds.map((f) => f.topic));
  check("schema-fail: served as last-good + degraded, not silently short",
    afterSchemaFail.degraded === true && sameFeeds(afterSchemaFail.feeds, beforeSchemaFail.feeds));
  check("schema-fail: reason names the site",
    /schema read failed/.test(afterSchemaFail.degradedReason || ""), afterSchemaFail.degradedReason);

  console.log("\n── T7b: same failure with no last-good → 503 path ──");
  fixture();
  m = loadFeeds();
  schemaRejectsFor = mockPublishers[1].address;
  let schemaErr = null;
  try { await m.getFeeds(); } catch (e) { schemaErr = e; }
  check("schema-fail, cold: CatalogUnavailableError not a short catalog",
    schemaErr && schemaErr.name === "CatalogUnavailableError", schemaErr && schemaErr.name);

  // ── T8: indexer down AND chain enumeration fails ────────────────────────
  console.log("\n── T8: indexer null AND chain enumeration throws ──");
  fixture();
  m = loadFeeds();
  indexerPublishers = null;
  listLengthThrows = true;
  let enumErr = null;
  let enumRes = null;
  try { enumRes = await m.getFeeds(); } catch (e) { enumErr = e; }
  check("enum-fail: never a 0-feed catalog returned as success",
    enumErr !== null && enumRes === null, enumRes && enumRes.totalFeeds);
  check("enum-fail: CatalogUnavailableError", enumErr && enumErr.name === "CatalogUnavailableError");
  check("enum-fail: reason names chain enumeration",
    enumErr && /enumeration failed/.test(enumErr.reason || ""), enumErr && enumErr.reason);

  // ── T9: single-flight — 10 concurrent callers, one upstream read set ────
  console.log("\n── T9: 10 concurrent getFeeds() share one assembly ──");
  fixture();
  m = loadFeeds();
  gatewayCalls = [];
  const results = await Promise.all(Array.from({ length: 10 }, () => m.getFeeds()));
  check("concurrent: gateway /feeds fetched exactly ONCE for 10 callers",
    gatewayCalls.length === 1, gatewayCalls.length);
  check("concurrent: all 10 results deep-equal",
    results.every((r) => sameFeeds(r, results[0])));

  // ── T10: TTL decides re-assembly ───────────────────────────────────────
  console.log("\n── T10: catalog cache TTL ──");
  fixture();
  m = loadFeeds({ CATALOG_CACHE_TTL_MS: "50" });
  await m.getFeeds();
  const callsAfterFirst = gatewayCalls.length;
  await m.getFeeds();
  check("ttl: a second call inside the TTL does NOT refetch",
    gatewayCalls.length === callsAfterFirst, gatewayCalls.length);
  await new Promise((r) => setTimeout(r, 80));
  await m.getFeeds();
  check("ttl: a call after the TTL DOES refetch",
    gatewayCalls.length === callsAfterFirst + 1, gatewayCalls.length);

  // ── T11: a real but much smaller catalog is served, and flagged ─────────
  console.log("\n── T11: catalog shrinks by more than half ──");
  fixture(4);
  m = loadFeeds({ CATALOG_CACHE_TTL_MS: "0" });
  const big = await m.getFeeds();
  const logged = [];
  const realErr = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  gatewayFeeds = [gatewayFeeds[0]];
  mockPublishers = mockPublishers.slice(0, 1);
  mockListOrder = mockListOrder.slice(0, 1);
  indexerPublishers = mockPublishers.map((p) => ({ address: p.address }));
  const small = await m.getFeeds();
  console.error = realErr;
  check("shrink: big catalog was 4", big.totalFeeds === 4, big.totalFeeds);
  check("shrink: the smaller catalog IS served (a real delisting must not 503)",
    small.totalFeeds === 1, small.totalFeeds);
  check("shrink: served as good — 'degraded' ABSENT", !("degraded" in small));
  check("shrink: one journal line records it",
    logged.some((l) => /shrank 4 -> 1/.test(l)), logged);

  // ── T12: a last-good older than LAST_GOOD_MAX_AGE_MS is not served ─────
  console.log("\n── T12: last-good older than LAST_GOOD_MAX_AGE_MS → 503 ──");
  fixture();
  m = loadFeeds({ LAST_GOOD_MAX_AGE_MS: "100" });
  const freshMax = await m.getFeeds();
  gatewayMode = "status";
  gatewayStatus = 429;
  const young = await m.getFeeds();
  check("max-age: inside the window the last-good is served, labelled degraded",
    young.degraded === true && sameFeeds(young.feeds, freshMax.feeds), young.degraded);
  await new Promise((r) => setTimeout(r, 150));
  let oldErr = null;
  let oldRes = null;
  try { oldRes = await m.getFeeds(); } catch (e) { oldErr = e; }
  check("max-age: past the window the route fails closed, no stale 200",
    oldErr !== null && oldRes === null, oldRes && oldRes.lastGoodAt);
  check("max-age: CatalogUnavailableError", oldErr && oldErr.name === "CatalogUnavailableError", oldErr && oldErr.name);
  check("max-age: reason carries the upstream cause AND the age",
    oldErr && /429/.test(oldErr.reason || "") && /older than 100 ms/.test(oldErr.reason || ""), oldErr && oldErr.reason);
  gatewayMode = "ok";
  const { res: recovered, err: recoveredErr } = await settle(m.getFeeds());
  check("max-age: a healthy upstream afterwards serves a fresh, clean catalog",
    recovered && recovered.totalFeeds === 3 && !("degraded" in recovered),
    recovered ? recovered.totalFeeds : recoveredErr && recoveredErr.reason);

  // ── T13: the cold 503 is remembered for CATALOG_FAILURE_CACHE_MS ───────
  console.log("\n── T13: negative cache on the cold-503 path ──");
  fixture();
  m = loadFeeds({ CATALOG_FAILURE_CACHE_MS: "150" });
  gatewayMode = "status";
  gatewayStatus = 429;
  let cold1 = null;
  try { await m.getFeeds(); } catch (e) { cold1 = e; }
  const callsAfterCold = gatewayCalls.length;
  gatewayMode = "ok"; // the upstream is healthy again at once — the cache must still answer
  let cold2 = null;
  try { await m.getFeeds(); } catch (e) { cold2 = e; }
  check("neg-cache: first cold call fails closed", cold1 && cold1.name === "CatalogUnavailableError", cold1 && cold1.name);
  check("neg-cache: a call inside the window is answered from memory — no upstream fetch",
    cold2 && cold2.name === "CatalogUnavailableError" && gatewayCalls.length === callsAfterCold,
    { err: cold2 && cold2.name, calls: gatewayCalls.length });
  check("neg-cache: the remembered reason is the observed one", cold2 && /429/.test(cold2.reason || ""), cold2 && cold2.reason);
  await new Promise((r) => setTimeout(r, 200));
  const { res: afterWindow, err: afterWindowErr } = await settle(m.getFeeds());
  check("neg-cache: after the window the upstream is tried again and a fresh catalog served",
    afterWindow && afterWindow.totalFeeds === 3 && !("degraded" in afterWindow) && gatewayCalls.length === callsAfterCold + 1,
    afterWindow ? gatewayCalls.length : afterWindowErr && afterWindowErr.reason);
  check("neg-cache: the good result CLEARS the remembered failure (seam)",
    m.__catalogStateForTests().hasLastFailure === false, m.__catalogStateForTests());
  gatewayMode = "status";
  const { res: laterFail, err: laterFailErr } = await settle(m.getFeeds());
  check("neg-cache: a later failure serves degraded last-good, not the old 503",
    laterFail && laterFail.degraded === true && sameFeeds(laterFail.feeds, afterWindow.feeds),
    laterFail ? laterFail.degraded : laterFailErr && laterFailErr.reason);

  fixture();
  m = loadFeeds({ CATALOG_FAILURE_CACHE_MS: "1000" });
  gatewayMode = "status";
  for (let i = 0; i < 5; i++) { try { await m.getFeeds(); } catch (_) { /* expected */ } }
  check("neg-cache: 5 sequential cold calls inside the window cost ONE gateway fetch",
    gatewayCalls.length === 1, gatewayCalls.length);

  fixture();
  m = loadFeeds({ CATALOG_FAILURE_CACHE_MS: "0" });
  gatewayMode = "status";
  for (let i = 0; i < 3; i++) { try { await m.getFeeds(); } catch (_) { /* expected */ } }
  check("neg-cache: 0 disables it — every cold call retries the upstream", gatewayCalls.length === 3, gatewayCalls.length);

  // ── T14: env values that cannot be a deadline fall back, loudly ────────
  console.log("\n── T14: env parse guard ──");
  const guardLines = [];
  const realErrGuard = console.error;
  console.error = (...a) => guardLines.push(a.join(" "));
  const cUnset = loadConfig({});
  const cEmpty = loadConfig({ GATEWAY_FETCH_TIMEOUT_MS: "" });
  const linesAfterEmpty = guardLines.length;
  const cWs = loadConfig({ GATEWAY_FETCH_TIMEOUT_MS: "  " });
  const linesAfterWs = guardLines.length;
  const cAbc = loadConfig({ GATEWAY_FETCH_TIMEOUT_MS: "abc" });
  const linesAfterAbc = guardLines.length;
  const cZero = loadConfig({ GATEWAY_FETCH_TIMEOUT_MS: "0" });
  const cNeg = loadConfig({ LAST_GOOD_MAX_AGE_MS: "-5", CATALOG_FAILURE_CACHE_MS: "-1" });
  const cOk = loadConfig({ GATEWAY_FETCH_TIMEOUT_MS: "250", CATALOG_CACHE_TTL_MS: "0", LAST_GOOD_MAX_AGE_MS: "60000", CATALOG_FAILURE_CACHE_MS: "0" });
  console.error = realErrGuard;
  check("guard: defaults are 5000 / 10000 / 900000 / 2000",
    cUnset.gatewayFetchTimeoutMs === 5000 && cUnset.catalogTtlMs === 10000 &&
    cUnset.lastGoodMaxAgeMs === 900000 && cUnset.catalogFailureCacheMs === 2000,
    [cUnset.gatewayFetchTimeoutMs, cUnset.catalogTtlMs, cUnset.lastGoodMaxAgeMs, cUnset.catalogFailureCacheMs]);
  check("guard: GATEWAY_FETCH_TIMEOUT_MS=\"\" → default, silently (dotenv's unset)",
    cEmpty.gatewayFetchTimeoutMs === 5000 && linesAfterEmpty === 0, [cEmpty.gatewayFetchTimeoutMs, linesAfterEmpty]);
  check("guard: whitespace-only value → default, silently (Number(\"  \") would be 0)",
    cWs.gatewayFetchTimeoutMs === 5000 && linesAfterWs === 0, [cWs.gatewayFetchTimeoutMs, linesAfterWs]);
  check("guard: \"abc\" → default + ONE line naming the variable and value",
    cAbc.gatewayFetchTimeoutMs === 5000 && linesAfterAbc === 1 && /GATEWAY_FETCH_TIMEOUT_MS="abc"/.test(guardLines[0] || ""),
    guardLines);
  check("guard: \"0\" is not a deadline → default (0 aborted every fetch)", cZero.gatewayFetchTimeoutMs === 5000, cZero.gatewayFetchTimeoutMs);
  check("guard: negative max-age / failure-cache → defaults",
    cNeg.lastGoodMaxAgeMs === 900000 && cNeg.catalogFailureCacheMs === 2000, [cNeg.lastGoodMaxAgeMs, cNeg.catalogFailureCacheMs]);
  check("guard: valid values pass through; CATALOG_CACHE_TTL_MS=0 (cache off) stays legal",
    cOk.gatewayFetchTimeoutMs === 250 && cOk.catalogTtlMs === 0 && cOk.lastGoodMaxAgeMs === 60000 && cOk.catalogFailureCacheMs === 0,
    [cOk.gatewayFetchTimeoutMs, cOk.catalogTtlMs, cOk.lastGoodMaxAgeMs, cOk.catalogFailureCacheMs]);
  check("guard: one line per bad value, none for good ones", guardLines.length === 4, guardLines.length);

  // the guard's live effect: a 0 timeout in the unit no longer means permanent 503
  fixture();
  const realErrLive = console.error;
  console.error = () => {};
  m = loadFeeds({ GATEWAY_FETCH_TIMEOUT_MS: "0" });
  let liveErr = null;
  let liveRes = null;
  try { liveRes = await m.getFeeds(); } catch (e) { liveErr = e; }
  console.error = realErrLive;
  check("guard, live: GATEWAY_FETCH_TIMEOUT_MS=0 still assembles a catalog (fetches are not aborted at once)",
    liveErr === null && liveRes && liveRes.totalFeeds === 3 && !("degraded" in liveRes), liveErr && liveErr.reason);

  // ── 503 contract at the HTTP layer, via the shared helper ──────────────
  console.log("\n── 503 helper: the contract all five routes use ──");
  const { sendCatalogError } = require(HTTP_ERRORS);
  const { CatalogUnavailableError } = require(FEEDS);
  function fakeRes() {
    const r = { code: null, headers: {}, body: null };
    r.status = (c) => { r.code = c; return r; };
    r.set = (k, v) => { r.headers[k] = v; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
  }
  const outage = fakeRes();
  sendCatalogError(outage, new CatalogUnavailableError("gateway /feeds 429"), "L", "M");
  check("helper: catalog outage answers 503", outage.code === 503, outage.code);
  check("helper: Retry-After header set", outage.headers["Retry-After"] === "10", outage.headers);
  check("helper: body says degraded with the reason",
    outage.body && outage.body.degraded === true && /429/.test(outage.body.degradedReason || ""), outage.body);
  check("helper: body error string is the documented one",
    outage.body && outage.body.error === "gateway catalog unavailable", outage.body);

  const other = fakeRes();
  const realErr2 = console.error;
  console.error = () => {};
  sendCatalogError(other, new Error("something else"), "L", "Failed to fetch feed data");
  console.error = realErr2;
  check("helper: a non-catalog error still answers 500", other.code === 500, other.code);
  check("helper: 500 body unchanged from today's",
    other.body && other.body.error === "Failed to fetch feed data", other.body);

  console.log("\n" + "=".repeat(60));
  console.log(`${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
