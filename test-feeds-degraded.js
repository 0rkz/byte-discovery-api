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
let gatewayMode = "ok";      // ok | status | throw | hang
let gatewayStatus = 429;
let gatewayFeeds = [];
let indexerPublishers = null;
let gatewayCalls = [];       // every URL the gateway fetch was called with

global.fetch = async (url, opts) => {
  if (String(url).includes("/publishers?limit=200")) {
    if (indexerPublishers === null) return { ok: false, status: 503 };
    return { ok: true, status: 200, json: async () => indexerPublishers };
  }
  if (String(url).endsWith("/feeds")) {
    gatewayCalls.push(String(url));
    if (gatewayMode === "status") return { ok: false, status: gatewayStatus };
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
