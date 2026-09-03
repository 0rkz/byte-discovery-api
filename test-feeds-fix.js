/**
 * Verification for the 2026-08-04 fix: "registered != purchasable".
 *
 * No test framework exists in this repo (checked: package.json has no test
 * script, no *.test.* files anywhere under src/). This drives the REAL
 * getFeeds() and buildEndpoints() end-to-end against the COMPILED build
 * (dist/lib/feeds.js — what actually runs in production, `node dist/index.js`)
 * — not extracted logic fragments — by mocking viem's createPublicClient
 * (module-mutation via `require`, BEFORE feeds.js is first required, so its
 * own `require("viem")` captures the mock) and global.fetch (for the
 * indexer + gateway calls). No real network call is made.
 *
 * Plain JS, not TS: raw ts-node against this repo's src/*.ts cannot resolve
 * the .js-suffixed internal imports at runtime (confirmed pre-existing —
 * even `npm run dev` fails the same way; tsc's own NodeNext-style extension
 * resolution only works for its OWN compiled output, not ts-node's direct
 * pass-through). Testing against dist/ sidesteps that entirely and is
 * arguably more honest anyway: it is what actually ships.
 *
 * Run:
 *   cd discovery-api && npm run build && node test-feeds-fix.js
 */

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

// ── topic <-> bytes32 hex, matching feeds.ts's decodeTopic exactly ──────────
function topicToHex(topic) {
  const bytes = Buffer.from(topic, "ascii");
  if (bytes.length > 32) throw new Error(`topic too long: ${topic}`);
  const padded = Buffer.concat([bytes, Buffer.alloc(32 - bytes.length)]);
  return "0x" + padded.toString("hex");
}

// ── mock viem BEFORE feeds.js is ever required ──────────────────────────────
let mockPublishers = [];
let mockPublisherListOrder = [];

const viemModule = require("viem");
const realCreatePublicClient = viemModule.createPublicClient;
// viem is published ESM; under Node's cjs-esm interop the namespace object
// exposes each export as a getter-only accessor, so a plain assignment
// throws ("has only a getter"). The property IS configurable (checked via
// Object.getOwnPropertyDescriptor), so replace it with a plain writable
// data property instead.
Object.defineProperty(viemModule, "createPublicClient", {
  value: (_args) => ({
    readContract: async ({ functionName, args }) => {
      const byAddress = new Map(mockPublishers.map((p) => [p.address.toLowerCase(), p]));
      if (functionName === "getPublisher") {
        const addr = (args[0] || "").toLowerCase();
        const p = byAddress.get(addr);
        if (!p) throw new Error(`mock RPC: no publisher registered at ${addr}`);
        return {
          status: p.status,
          tier: 0,
          stakedAmount: 0n,
          sandboxStartTime: 0n,
          registeredAt: 0n,
          subscriberCount: p.subscriberCount,
          messageCount: p.messageCount,
          totalRevenue: 0n,
          lastActiveTimestamp: 0n,
          publicKey: "0x" + "00".repeat(32),
          slashCount: 0n,
        };
      }
      if (functionName === "getSchema") {
        const addr = (args[0] || "").toLowerCase();
        const p = byAddress.get(addr);
        if (!p || !p.schema) {
          return {
            expectedSize: 0, maxSize: 0, frequencySeconds: 0, pubClass: 0, verType: 0,
            methodologyHash: "0x" + "00".repeat(32), topic: "0x" + "00".repeat(32),
            pricePerKB: 0n, active: false, registeredAt: 0n,
          };
        }
        return {
          expectedSize: 4096, maxSize: 65536, frequencySeconds: p.schema.frequencySeconds,
          pubClass: 0, verType: 0, methodologyHash: "0x" + "11".repeat(32),
          topic: p.schema.topicHex, pricePerKB: p.schema.pricePerKB, active: p.schema.active,
          registeredAt: 0n,
        };
      }
      if (functionName === "getPublisherListLength") {
        return BigInt(mockPublisherListOrder.length);
      }
      if (functionName === "publisherList") {
        const i = Number(args[0]);
        return mockPublisherListOrder[i];
      }
      throw new Error(`mock RPC: unhandled functionName ${functionName}`);
    },
  }),
  writable: true,
  configurable: true,
});

// ── mock global.fetch for the indexer + gateway calls ───────────────────────
let mockIndexerPublishers = null; // null -> indexer "down", forces fallback path
let mockGatewayFeeds = [];

const realFetch = global.fetch;
global.fetch = async (url) => {
  if (url.includes("/publishers?limit=200")) {
    if (mockIndexerPublishers === null) return { ok: false };
    return { ok: true, json: async () => mockIndexerPublishers };
  }
  if (url.endsWith("/feeds")) {
    return { ok: true, json: async () => ({ feeds: mockGatewayFeeds }) };
  }
  throw new Error(`mock fetch: unhandled URL ${url}`);
};

// NOW require the COMPILED feeds.js — its own require("viem") resolves to
// the SAME (already-mutated) cached module object.
const {
  getFeeds,
  buildEndpoints,
  __resetCatalogCacheForTests,
} = require("./dist/lib/feeds.js");

// getFeeds() caches a good catalog for CATALOG_CACHE_TTL_MS and shares one
// in-flight assembly between concurrent callers. Every scenario below swaps
// the mocks and then calls getFeeds() again, so each one must start from a
// cold cache or it would silently re-assert the PREVIOUS scenario's catalog.
// (That is exactly what happened when the cache landed: the last block failed
// while five earlier ones passed on stale data that happened to still match.)
async function freshGetFeeds() {
  __resetCatalogCacheForTests();
  return getFeeds();
}

async function main() {
  // ───────────────────────────────────────────────────────────────────────
  // Section 1: buildEndpoints() directly — the exact function that changed.
  // ───────────────────────────────────────────────────────────────────────
  console.log("\n── buildEndpoints(): served vs not-served ──");
  const served = buildEndpoints("test-served", new Set(["test-served"]));
  check("served topic: mcp is present", served.mcp === "byte_buy_data", served);
  check("served topic: x402 is present", typeof served.x402 === "string" && served.x402.length > 0, served);
  check("served topic: onchain is always present", typeof served.onchain === "string" && served.onchain.length > 0, served);

  const notServed = buildEndpoints("test-not-served", new Set(["test-served"]));
  check("NOT-served topic: mcp key is ABSENT (not just falsy)", !("mcp" in notServed), notServed);
  check("NOT-served topic: x402 key is ABSENT", !("x402" in notServed), notServed);
  check("NOT-served topic: onchain is STILL present", typeof notServed.onchain === "string" && notServed.onchain.length > 0, notServed);

  const mixedCase = buildEndpoints("Test-Served", new Set(["test-served"]));
  check("buildEndpoints matches case-insensitively", mixedCase.mcp === "byte_buy_data", mixedCase);

  // ───────────────────────────────────────────────────────────────────────
  // Section 2: getFeeds() end-to-end — indexer path, five cases at once.
  // ───────────────────────────────────────────────────────────────────────
  console.log("\n── getFeeds() via the indexer path: 5 realistic cases in one batch ──");
  const ADDR_SERVED = "0x1111111111111111111111111111111111111a";
  const ADDR_NOT_SERVED = "0x2222222222222222222222222222222222222b";
  const ADDR_EVIDENCE_PACK = "0x3333333333333333333333333333333333333c";
  const ADDR_DELISTED = "0x4444444444444444444444444444444444444d";

  mockPublishers = [
    { address: ADDR_SERVED, status: 1, subscriberCount: 2n, messageCount: 10n,
      schema: { frequencySeconds: 300, topicHex: topicToHex("test-served"), pricePerKB: 100000n, active: true } },
    { address: ADDR_NOT_SERVED, status: 1, subscriberCount: 0n, messageCount: 0n,
      schema: { frequencySeconds: 3600, topicHex: topicToHex("test-not-served"), pricePerKB: 100000n, active: true } },
    // The REAL historical bug shape: registered on-chain, removed from the
    // gateway, but never added to DELISTED_TOPICS — must still APPEAR, just
    // without a working buy verb.
    { address: ADDR_EVIDENCE_PACK, status: 1, subscriberCount: 5n, messageCount: 200n,
      schema: { frequencySeconds: 3600, topicHex: topicToHex("evidence-pack"), pricePerKB: 3000n, active: true } },
    // A REAL DELISTED_TOPICS entry — must be filtered OUT entirely regardless
    // of gateway/on-chain status, proving the (untouched) delisting path
    // still works after this fix.
    { address: ADDR_DELISTED, status: 1, subscriberCount: 1n, messageCount: 1n,
      schema: { frequencySeconds: 3600, topicHex: topicToHex("crypto-top100"), pricePerKB: 3000n, active: true } },
  ];
  mockIndexerPublishers = mockPublishers.map((p) => ({ address: p.address }));
  mockGatewayFeeds = [
    { topic: "test-served", priceAtomic: 100000, provenance: "first-party" },
    { topic: "test-gateway-only", priceAtomic: 5000, provenance: "first-party" },
    // deliberately NOT listing "test-not-served" or "evidence-pack" — that IS
    // the bug shape (removed from / never fronted by the gateway).
  ];

  const discovery = await freshGetFeeds();
  const byTopic = new Map(discovery.feeds.map((f) => [f.topic, f]));

  const servedFeed = byTopic.get("test-served");
  check("SERVED feed is present", !!servedFeed);
  check("  purchasable: true", servedFeed && servedFeed.purchasable === true, servedFeed);
  check("  endpoints.mcp present", servedFeed && servedFeed.endpoints.mcp === "byte_buy_data", servedFeed);
  check("  endpoints.x402 present", servedFeed && typeof servedFeed.endpoints.x402 === "string", servedFeed);
  check("  endpoints.onchain present (unchanged)", servedFeed && typeof servedFeed.endpoints.onchain === "string" && servedFeed.endpoints.onchain.length > 0, servedFeed);
  check("  onchain publisher address is set (unchanged)", servedFeed && servedFeed.onchain === ADDR_SERVED, servedFeed);

  const notServedFeed = byTopic.get("test-not-served");
  check("NOT-SERVED feed is STILL PRESENT (registered on-chain, just not purchasable)", !!notServedFeed);
  check("  purchasable: false", notServedFeed && notServedFeed.purchasable === false, notServedFeed);
  check("  endpoints.mcp is ABSENT", notServedFeed && !("mcp" in notServedFeed.endpoints), notServedFeed);
  check("  endpoints.x402 is ABSENT", notServedFeed && !("x402" in notServedFeed.endpoints), notServedFeed);
  check("  endpoints.onchain is STILL present", notServedFeed && typeof notServedFeed.endpoints.onchain === "string" && notServedFeed.endpoints.onchain.length > 0, notServedFeed);

  // evidence-pack was DELISTED (feeds.ts DELISTED_TOPICS) after this block was
  // written, so it must now be absent entirely — the block kept asserting the
  // pre-delisting shape and had been failing ever since. The "registered
  // on-chain but not fronted by the gateway, therefore still present and not
  // purchasable" case it used to cover is already covered above by
  // test-not-served; this now asserts the delisting instead.
  check("EVIDENCE-PACK is COMPLETELY ABSENT (in DELISTED_TOPICS)",
    !byTopic.has("evidence-pack"));

  check("DELISTED topic (crypto-top100) is COMPLETELY ABSENT — delisting filter unaffected by this fix",
    !byTopic.has("crypto-top100"));

  const gatewayOnlyFeed = byTopic.get("test-gateway-only");
  check("GATEWAY-ONLY feed (no on-chain publisher) is present via the merge", !!gatewayOnlyFeed);
  check("  purchasable: true (always, by construction)", gatewayOnlyFeed && gatewayOnlyFeed.purchasable === true, gatewayOnlyFeed);
  check("  onchain is null (never faked)", gatewayOnlyFeed && gatewayOnlyFeed.onchain === null, gatewayOnlyFeed);
  check("  endpoints.mcp present", gatewayOnlyFeed && gatewayOnlyFeed.endpoints.mcp === "byte_buy_data", gatewayOnlyFeed);
  check("  endpoints.x402 present", gatewayOnlyFeed && typeof gatewayOnlyFeed.endpoints.x402 === "string", gatewayOnlyFeed);

  // ───────────────────────────────────────────────────────────────────────
  // Section 2b (Wave 2 — pricePerCall): gateway-fronted feeds carry
  // pricePerCall === pricePerKB (both derived from the same gateway
  // priceAtomic); non-fronted feeds carry pricePerCall === null even though
  // pricePerKB still falls back to the on-chain per-KB figure.
  // ───────────────────────────────────────────────────────────────────────
  console.log("\n── pricePerCall: indexer path ──");
  check("SERVED (gateway-fronted): pricePerCall === pricePerKB",
    servedFeed && servedFeed.pricePerCall === servedFeed.pricePerKB && servedFeed.pricePerCall === 100000,
    servedFeed);
  check("NOT-SERVED (not gateway-fronted): pricePerCall is null (pricePerKB still on-chain fallback)",
    notServedFeed && notServedFeed.pricePerCall === null && notServedFeed.pricePerKB === 100000,
    notServedFeed);
  check("GATEWAY-ONLY (always fronted): pricePerCall === pricePerKB",
    gatewayOnlyFeed && gatewayOnlyFeed.pricePerCall === gatewayOnlyFeed.pricePerKB && gatewayOnlyFeed.pricePerCall === 5000,
    gatewayOnlyFeed);

  console.log("\n── exact before/after JSON, as requested ──");
  console.log("SERVED feed (test-served) full JSON:");
  console.log(JSON.stringify(servedFeed, null, 2));
  console.log("\nNOT-SERVED feed (test-not-served) full JSON:");
  console.log(JSON.stringify(notServedFeed, null, 2));

  // ───────────────────────────────────────────────────────────────────────
  // Section 3: same served/not-served pair via the FALLBACK (direct-chain
  // enumeration) path — proves parity, since this fix touches BOTH emit
  // sites identically.
  // ───────────────────────────────────────────────────────────────────────
  console.log("\n── getFeeds() via the FALLBACK path (indexer down) — same two cases ──");
  mockIndexerPublishers = null; // force the fallback branch
  mockPublisherListOrder = [ADDR_SERVED, ADDR_NOT_SERVED];
  mockPublishers = mockPublishers.slice(0, 2); // just the served + not-served pair

  const fallbackDiscovery = await freshGetFeeds();
  const fallbackByTopic = new Map(fallbackDiscovery.feeds.map((f) => [f.topic, f]));
  const fbServed = fallbackByTopic.get("test-served");
  const fbNotServed = fallbackByTopic.get("test-not-served");
  check("fallback path: served feed purchasable=true, mcp+x402 present",
    fbServed && fbServed.purchasable === true && fbServed.endpoints.mcp === "byte_buy_data" && typeof fbServed.endpoints.x402 === "string",
    fbServed);
  check("fallback path: not-served feed purchasable=false, NO mcp, NO x402",
    fbNotServed && fbNotServed.purchasable === false && !("mcp" in fbNotServed.endpoints) && !("x402" in fbNotServed.endpoints),
    fbNotServed);
  check("fallback path: pricePerCall === pricePerKB (gateway-fronted)",
    fbServed && fbServed.pricePerCall === fbServed.pricePerKB && fbServed.pricePerCall === 100000,
    fbServed);
  check("fallback path: pricePerCall is null (not gateway-fronted)",
    fbNotServed && fbNotServed.pricePerCall === null, fbNotServed);

  // ───────────────────────────────────────────────────────────────────────
  // Section 4: mixed-case gateway topic (FD LOW, 2026-08-04). x402Topics/
  // gatewayByTopic are now lowercased AT CONSTRUCTION (feeds.ts:314-315),
  // not just relied upon from fetchX402Feeds()'s own normalization. Honest
  // caveat: fetchX402Feeds() ALREADY lowercases every topic/id it reads off
  // the raw gateway JSON (line ~151), so this end-to-end test cannot, by
  // itself, isolate "would this have failed without the feeds.ts:314-315
  // fix" — that upstream normalization means it never could, through this
  // public interface. What it DOES prove is the thing that actually matters
  // to a consumer: a mixed-case topic in the RAW gateway response still
  // resolves to a correct, matching buy affordance end-to-end. The
  // construction-site fix itself is deliberately redundant defense — it
  // removes an IMPLICIT cross-function contract (this file trusting
  // fetchX402Feeds forever normalizes) in favor of a local guarantee, per
  // FD's finding, not because this test can catch its absence.
  // ───────────────────────────────────────────────────────────────────────
  console.log("\n── mixed-case gateway topic still resolves to a matching buy affordance ──");
  mockIndexerPublishers = mockPublishers.map((p) => ({ address: p.address })); // back to indexer path
  mockGatewayFeeds = [
    { topic: "Test-Served", priceAtomic: 100000, provenance: "first-party" }, // MIXED CASE in the raw response
  ];
  const mixedCaseDiscovery = await freshGetFeeds();
  const mixedCaseServed = mixedCaseDiscovery.feeds.find((f) => f.topic === "test-served");
  check("mixed-case gateway topic -> the (lowercase) discover topic is still purchasable",
    mixedCaseServed && mixedCaseServed.purchasable === true, mixedCaseServed);
  check("  endpoints.mcp present despite the gateway's raw topic being mixed-case",
    mixedCaseServed && mixedCaseServed.endpoints.mcp === "byte_buy_data", mixedCaseServed);
  check("  endpoints.x402 present too",
    mixedCaseServed && typeof mixedCaseServed.endpoints.x402 === "string", mixedCaseServed);

  // ───────────────────────────────────────────────────────────────────────
  // Section 5: Site 1 (FD + team lead, 2026-08-04) — the Fix B merge's
  // `present.has(gf.topic) || DELISTED_TOPICS.has(gf.topic)` used a RAW,
  // un-normalized needle against two lowercase-normalized haystacks. Same
  // honest caveat as Section 4: fetchX402Feeds() ALREADY normalizes every
  // topic/id off the raw gateway JSON before it ever becomes part of
  // `gatewayFeeds` (verified directly, feeds.ts ~line 168), so these
  // end-to-end tests — mixed case in the RAW mocked HTTP response — cannot,
  // by themselves, distinguish "fixed" from "reverted": both layers already
  // normalize today, and either alone would make these pass. See the
  // SEPARATE two-stage revert proof below (against the compiled dist/) for
  // what actually isolates the defense-in-depth property FD asked to prove.
  // ───────────────────────────────────────────────────────────────────────
  console.log("\n── Site 1: mixed-case gateway topic already delisted must NOT appear ──");
  mockPublishers = [];
  mockIndexerPublishers = [];
  mockGatewayFeeds = [{ topic: "Crypto-Top100", priceAtomic: 100, provenance: "first-party" }]; // real DELISTED_TOPICS entry, mixed case
  const delistedDiscovery = await freshGetFeeds();
  // NOTE: a leaked entry keeps gf.topic's ORIGINAL casing (feeds.ts pushes
  // `topic: gf.topic` verbatim in the Fix B merge, not a normalized copy) —
  // an exact-lowercase match here would silently miss it and pass either way.
  check("a mixed-case gateway topic matching a REAL DELISTED_TOPICS entry does not appear at all",
    !delistedDiscovery.feeds.some((f) => (f.topic || "").toLowerCase() === "crypto-top100"), delistedDiscovery.feeds);

  console.log("\n── Site 1: mixed-case gateway topic already on-chain must NOT be duplicated ──");
  mockPublishers = [
    { address: ADDR_SERVED, status: 1, subscriberCount: 0n, messageCount: 0n,
      schema: { frequencySeconds: 300, topicHex: topicToHex("test-served"), pricePerKB: 100000n, active: true } },
  ];
  mockIndexerPublishers = mockPublishers.map((p) => ({ address: p.address }));
  mockGatewayFeeds = [{ topic: "Test-Served", priceAtomic: 100000, provenance: "first-party" }]; // same topic, mixed case, already on-chain
  const dupDiscovery = await freshGetFeeds();
  // Same note as above: a spurious duplicate from Fix B would carry gf.topic's
  // original mixed case ("Test-Served"), not the lowercase "test-served" the
  // on-chain path derives via decodeTopic() — an exact-case filter here would
  // count only the legitimate on-chain entry and miss the duplicate entirely.
  const servedMatches = dupDiscovery.feeds.filter((f) => (f.topic || "").toLowerCase() === "test-served");
  check("exactly ONE entry for the topic — not merged a second time via Fix B",
    servedMatches.length === 1, dupDiscovery.feeds);
  check("  and it IS purchasable (on-chain entry correctly matched the gateway feed)",
    servedMatches[0] && servedMatches[0].purchasable === true, servedMatches);

  // ───────────────────────────────────────────────────────────────────────
  // Section 6 (FD ruling, A6, 2026-08-04): the Fix B merge's emitted `topic`
  // field must be normalizeTopic()'d, not raw gf.topic — the Feed type
  // above (line ~145) already documents `topic: string; // lowercased slug`,
  // so emitting the gateway's raw casing broke that contract on every
  // response this merge touches. The x402 URL stays on the RAW topic on
  // purpose (a route, not an identity) — normalizing IT would be the actual
  // bug.
  // SAME honest caveat as Sections 4/5, sharper here: fetchX402Feeds()
  // normalizeTopic()'s the topic BEFORE it is ever stored on GatewayFeed
  // (feeds.ts ~line 175) — gatewayFeeds is populated EXCLUSIVELY through
  // that one call site (verified: `gatewayFeeds` has exactly one producer in
  // getFeeds()), so by the time this loop runs, gf.topic is ALREADY
  // lowercase. That means an end-to-end test through the mocked HTTP
  // gateway response cannot, even in principle, distinguish "fixed" from
  // "reverted" for THIS specific line — worse than Sections 4/5, where the
  // upstream normalization was merely redundant with the downstream fix; here
  // it fully PRE-EMPTS it, so a mixed-case string in mockGatewayFeeds below
  // arrives at line ~462 already lowercased regardless of what this test
  // does. It also means the x402 URL's "byte-for-byte gateway casing" claim
  // is untestable through this path for the same reason (it's already been
  // lowercased by fetchX402Feeds() before it ever reaches the URL). The
  // genuine revert proof — reverting fetchX402Feeds()'s OWN normalization
  // (simulating that upstream safeguard broken) and confirming the Fix B
  // topic-field normalization independently catches it, WHILE the x402 URL
  // correctly preserves whatever raw casing the gateway supplied in that
  // scenario — was run against the compiled dist/, not here; reported
  // separately, not asserted by this suite.
  // ───────────────────────────────────────────────────────────────────────
  console.log("\n── Fix B: emitted topic field is normalized even though it's currently unreachable mixed-case ──");
  mockPublishers = [];
  mockIndexerPublishers = [];
  mockGatewayFeeds = [{ topic: "Brand-New-Oracle", priceAtomic: 50000, provenance: "first-party" }]; // gateway-only, no on-chain match
  const newOracleDiscovery = await freshGetFeeds();
  const newOracleEntry = newOracleDiscovery.feeds.find((f) => (f.topic || "").toLowerCase() === "brand-new-oracle");
  check("emitted topic field is exactly lowercase, never the mixed-case original",
    newOracleEntry && newOracleEntry.topic === "brand-new-oracle", newOracleEntry);
  check("  x402 URL is present and resolves this feed (route correctness is verified separately against dist/)",
    newOracleEntry && typeof newOracleEntry.endpoints.x402 === "string" && newOracleEntry.endpoints.x402.length > 0,
    newOracleEntry);

  console.log(`\n${"=".repeat(60)}\n${PASS} passed, ${FAIL} failed`);
  global.fetch = realFetch;
  viemModule.createPublicClient = realCreatePublicClient;
  process.exit(FAIL ? 1 : 0);
}

main().catch((err) => {
  console.error("TEST HARNESS CRASHED:", err);
  process.exit(1);
});
