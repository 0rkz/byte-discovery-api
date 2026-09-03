/**
 * Feed discovery module.
 *
 * Enumerates data feed publishers from the BYTE Library indexer (preferred)
 * or falls back to on-chain enumeration via DataRegistry. Each feed is
 * enriched with schema metadata and access endpoints.
 */

import { createPublicClient, http } from "viem";
import { arbitrumSepolia } from "viem/chains";
import {
  config,
  contracts,
  DataRegistryABI,
  SchemaRegistryABI,
} from "./config.js";

/** Viem public client for Arbitrum Sepolia on-chain reads. */
const client = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(config.rpcUrl),
});

/**
 * Thrown when a catalog could not be assembled from every upstream it needs
 * AND there is no last-good catalog to fall back on. The routes turn this
 * into 503 + Retry-After.
 *
 * The rule this enforces (byte/CLAUDE.md §1, fail-closed): we would rather
 * answer "I cannot tell you right now" than answer with a catalog we could
 * not price. A partially-assembled catalog is not a smaller truth — it is a
 * wrong answer that looks exactly like a right one, because a feed missing
 * from /discover and a feed that does not exist are indistinguishable to the
 * agent reading it.
 */
export class CatalogUnavailableError extends Error {
  /** Short machine-ish cause, e.g. "gateway /feeds 429". Safe to show a client. */
  readonly reason: string;
  constructor(reason: string) {
    super(`catalog unavailable: ${reason}`);
    this.name = "CatalogUnavailableError";
    this.reason = reason;
  }
}

/** A single data feed with publisher metadata and access endpoints. */
export interface Feed {
  publisher: string;
  topic: string;
  /** @deprecated DEPRECATED (misnamed): for gateway-fronted feeds this is
   *  the per-call price in µUSDC, identical to pricePerCall. Use
   *  pricePerCall. Removed next release. */
  pricePerKB: number; // µUSDC (6 decimals)
  /** The price of ONE call, in atomic µUSDC (6 decimals) — identical to the
   *  gateway's `priceAtomic` for gateway-fronted feeds. `null` when this
   *  feed is not fronted by the x402 gateway (no enforced per-call price
   *  exists to report). */
  pricePerCall: number | null;
  frequencySeconds: number;
  subscribers: number;
  messages: number;
  /** Data provenance as advertised by the gateway (e.g. "first-party"). */
  provenance: string;
  /** On-chain DataRegistry publisher address, or null for gateway-only
   *  first-party oracles (which have no on-chain publisher — never faked). */
  onchain: string | null;
  /** Whether this feed can actually be bought right now (the gateway fronts
   *  it — `x402Topics.has(topic)`). An on-chain SchemaRegistry registration
   *  is NOT a purchase route: registerSchema commits a schema on-chain, but
   *  buying data goes through the x402 gateway, and a feed can be registered
   *  without ever being fronted there (2026-08-04 fix — see buildEndpoints). */
  purchasable: boolean;
  endpoints: {
    x402?: string;
    mcp?: string;
    onchain: string;
  };
}

/** Top-level response shape returned by the /discover endpoint. */
export interface DiscoveryResponse {
  protocol: string;
  version: string;
  /** The BYTE Library protocol / attestation-anchor chain (NOT the payment
   *  chain). Kept for back-compat; route USDC by `payment` below. */
  chain: string;
  chainId: number;
  /** USDC settlement rail — where a buyer ROUTES funds (Base mainnet). */
  payment: {
    network: string;
    chain: string;
    chainId: number;
    asset: string;
    usdcAddress: string;
    payTo: string;
  };
  /** EIP-712 receipt anchor — verify receipts against THIS chain/contract,
   *  regardless of the settlement rail above. */
  attestation: {
    network: string;
    chain: string;
    chainId: number;
    domain: string;
    verifyingContract: string;
    /** Plain-language explanation of the testnet chainId vs the mainnet fund rail
     *  — so a client does not read 421614 as a place funds move. */
    note: string;
  };
  /** Count of feed topics (was misnamed `totalPublishers` — these are feeds, not
   *  independent orgs). The honest distinct-operator count is `distinctOperators`. */
  totalFeeds: number;
  /** Distinct operating organizations behind the feeds: 1 — all first-party PayPerByte
   *  (the per-feed publisher addresses are PayPerByte-operated keys, not third parties). */
  distinctOperators: number;
  totalMessages: number;
  feeds: Feed[];
  access: {
    x402_gateway: string;
    mcp_server: string;
    indexer_api: string;
  };
  /**
   * ABSENT on a healthy response — not `false`. Present and `true` only when
   * at least one upstream read failed and this body is therefore the LAST
   * GOOD catalog, not a fresh one. Prices and feeds are real values that were
   * correct at `lastGoodAt`; they are not placeholders and not guesses.
   *
   * What to do with it: an agent may still read prices from a degraded body,
   * but should expect the enforced 402 price to be authoritative and should
   * not treat a feed's absence as a delisting. Check `lastGoodAt` for age.
   */
  degraded?: true;
  /** Why the refresh failed, e.g. "gateway /feeds 429" or
   *  "schema read failed for 0xa820…". Only present alongside `degraded`. */
  degradedReason?: string;
  /** ISO timestamp of the last fully-successful assembly. Only present
   *  alongside `degraded`. */
  lastGoodAt?: string;
}

/**
 * Decode a bytes32 hex value to a printable topic string, or null when the
 * bytes hold no usable topic (absent, a hash, random bytes, wrong length).
 *
 * Returns NULL rather than the old "data-feed" sentinel. That sentinel was
 * one of the two producers of the placeholder feeds measured on 2026-09-03:
 * a publisher with no readable topic was emitted as a feed literally named
 * `data-feed` priced 0, and several such publishers at once collided into
 * duplicate entries under that one name. A caller must now decide explicitly
 * what to do with "no topic" — here, skip the publisher — instead of being
 * handed a plausible-looking string it cannot distinguish from a real topic.
 */
function decodeTopicOrNull(hex: string): string | null {
  if (!hex || typeof hex !== "string") return null;
  const bytes = hex.replace(/^0x/, "");
  let str = "";
  for (let i = 0; i < bytes.length; i += 2) {
    const code = parseInt(bytes.substr(i, 2), 16);
    if (Number.isNaN(code)) return null;
    if (code === 0) break;
    str += String.fromCharCode(code);
  }
  if (str.length < 2 || str.length > 31) return null;
  if (!/^[a-zA-Z0-9._\-: ]+$/.test(str)) return null;
  return str;
}

/**
 * THE topic-comparison key, used on BOTH sides of every topic lookup in this
 * file — every Set/Map built to be checked against a topic, and every needle
 * checked against one. One named function instead of scattered inline
 * `.toLowerCase()` calls (FD + team lead, 2026-08-04): this file had THREE
 * separate normalized-haystack/un-normalized-needle mismatches accumulate
 * across as many edits (x402Topics/gatewayByTopic construction; the Fix B
 * merge's `present`/DELISTED_TOPICS check), each "safe" today only because
 * fetchX402Feeds() happens to already lowercase upstream — an implicit
 * cross-function contract, not a local guarantee. A single function everyone
 * reaches for is the fix that survives the NEXT lookup someone adds, not just
 * these three.
 */
function normalizeTopic(topic: string | null | undefined): string {
  // String(topic ?? ""), not `topic || ""`: a non-string topic from parsed
  // JSON (a stray number, e.g.) makes `topic || ""` return the NUMBER itself
  // (`5 || ""` is `5`), and `.toLowerCase()` on that throws — taking the
  // endpoint down rather than degrading. 12 of 13 call sites pass parsed JSON
  // straight through with no .toString() guard (FD, A6). Fails LOUD either
  // way, which is the safe direction, but String(x ?? "") gets the same
  // safety without the crash.
  //
  // Signature stays `string | null | undefined`, NOT widened to `unknown`
  // (FD's required correction, A6): the coercion and the widening are
  // separable, and only one pays for anything. The one place a non-string
  // topic can actually originate is fetchX402Feeds()'s `.map((f: any) => ...)`
  // — `any` is assignable to `string` regardless of this parameter's declared
  // type, so the narrow signature never protected that boundary and widening
  // it buys nothing there. It WOULD surrender the guard that protects every
  // other call site (a developer passing a genuinely-mistyped value) for no
  // gain. If a non-string topic ever needs handling for real, this file
  // already has the right pattern one line below fetchX402Feeds's own
  // extraction: `if (!topic) return null;` — skip the malformed feed,
  // fail closed, don't coerce-and-continue.
  return String(topic ?? "").toLowerCase();
}

/**
 * Fetch JSON from the BYTE Library indexer, returning null on any failure.
 *
 * Null here is NOT a catalog failure: the indexer is a fast path, and
 * getFeeds() falls back to enumerating publishers on-chain, which produces a
 * complete catalog on its own. That fallback is the reason this one stays
 * "return null" while the gateway fetch below does not.
 */
async function fetchFromIndexer(path: string): Promise<any> {
  try {
    const res = await fetch(`${config.indexerUrl}${path}`, {
      signal: AbortSignal.timeout(config.gatewayFetchTimeoutMs),
    });
    if (!res.ok) {
      console.error(
        `[discover] indexer ${path} FAILED (${res.status}) — falling back to on-chain enumeration`,
      );
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(
      `[discover] indexer ${path} FAILED (${(err as Error)?.name || "error"}) — falling back to on-chain enumeration`,
    );
    return null;
  }
}

/** A feed as advertised by the x402 gateway's `/feeds` catalog. */
interface GatewayFeed {
  topic: string; // lowercased slug (gateway `id`/`topic`)
  /** @deprecated DEPRECATED (misnamed): for gateway-fronted feeds this is
   *  the per-call price in µUSDC, identical to pricePerCall. Use
   *  pricePerCall. Removed next release. */
  pricePerKB: number; // µUSDC (gateway `priceAtomic`)
  /** The price of ONE call, in atomic µUSDC (6 decimals) — the gateway's
   *  `priceAtomic`. Every GatewayFeed is, by construction, gateway-fronted,
   *  so this is never null here. */
  pricePerCall: number;
  provenance: string; // gateway-advertised data provenance
}

/**
 * Fetch the full feed catalog the x402 gateway serves. Used for TWO things:
 *  1. gating the `x402` endpoint URL — most on-chain publishers are not fronted
 *     by the gateway, and advertising a gateway URL for them 404s for the agent;
 *  2. surfacing gateway-only first-party oracles (address-reputation, pkg-verdict,
 *     sanctions-screen, reasoning-verdict, liquidation-stream, positioning-snapshot)
 *     that have NO on-chain DataRegistry publisher, so the indexer/chain
 *     enumeration never sees them.
 * FAILURE IS NOT AN EMPTY CATALOG. This used to return [] on any failure, and
 * the caller could not tell "the gateway fronts nothing" from "I could not
 * reach the gateway". Those produce very different responses: the first is a
 * true empty catalog, the second silently drops every gateway-only feed,
 * nulls every pricePerCall, and re-prices the survivors from their on-chain
 * registration default — which is how threat-intel came to be advertised at
 * 3000 when the gateway enforces 50000. Measured 2026-09-03: 6 of 60 public
 * /discover reads, 41 of 60 at concurrency 10.
 *
 * GOOD = HTTP 2xx AND `feeds` is an array. An empty array from a 2xx IS good.
 * Everything else — non-2xx, parse error, timeout, thrown fetch — is a
 * failure carrying a short reason the caller reports rather than hides.
 *
 * Reads `config.x402GatewayFetch`, which is the ONLY place that variable is
 * used. Every URL this file advertises to agents keeps `config.x402Gateway`.
 */
type GatewayResult =
  | { ok: true; feeds: GatewayFeed[] }
  | { ok: false; reason: string };

async function fetchX402Feeds(): Promise<GatewayResult> {
  let data: any;
  try {
    const res = await fetch(`${config.x402GatewayFetch}/feeds`, {
      signal: AbortSignal.timeout(config.gatewayFetchTimeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `gateway /feeds ${res.status}` };
    data = await res.json();
  } catch (err) {
    // AbortSignal.timeout() rejects with a TimeoutError; say "timeout" plainly.
    const name = (err as Error)?.name || "error";
    return {
      ok: false,
      reason: `gateway /feeds ${name === "TimeoutError" ? "timeout" : name}`,
    };
  }

  if (!Array.isArray(data?.feeds)) {
    return { ok: false, reason: "gateway /feeds malformed body (no feeds array)" };
  }

  const parsed: GatewayFeed[] = data.feeds
    .map((f: any): GatewayFeed | null => {
      const topic = normalizeTopic((f.topic ?? f.id ?? "").toString());
      if (!topic) return null;
      const priceAtomic = Number(f.priceAtomic ?? f.pricePerKB ?? 0) || 0;
      return {
        topic,
        pricePerKB: priceAtomic,
        pricePerCall: priceAtomic,
        provenance: (f.provenance ?? "").toString() || "first-party",
      };
    })
    .filter((f: GatewayFeed | null): f is GatewayFeed => f !== null);

  return { ok: true, feeds: parsed };
}

/**
 * Build a feed's access endpoints. `onchain` always applies; `mcp` AND
 * `x402` are BOTH gated on the gateway actually fronting this topic
 * (2026-08-04 fix — registered != purchasable, founder GO).
 *
 * Why mcp is gated now, not just x402: the MCP tool `byte_buy_data`
 * (mcp-server/src/tools/buy.ts) resolves its documented step 1 to
 * `GET {x402Gateway}/feeds/<slug>` — the EXACT route x402Topics decides. A
 * topic registered on-chain (SchemaRegistry) but not fronted by the gateway
 * has no working buy route at all, so advertising `mcp: "byte_buy_data"`
 * for it handed agents a buy verb for something unbuyable. The failure
 * lands on the UNPAID probe leg of that tool (its own comment: "nothing has
 * been signed and no money is at risk") — a false catalog claim, not a
 * payment hazard.
 *
 * Three live cases this closes: signature-screen and cctp-attestation-latency
 * (registered 2026-08-04, never fronted by the gateway) and — the
 * pre-existing one this same fix reaches — evidence-pack, removed from the
 * gateway 2026-07-28 for an integrity violation but never added to
 * DELISTED_TOPICS below, so it kept advertising `mcp: "byte_buy_data"` for
 * ten days on the strength of this exact gap (x402 was already correctly
 * gated; mcp was not).
 */
export function buildEndpoints(
  topic: string,
  x402Topics: Set<string>
): Feed["endpoints"] {
  const endpoints: Feed["endpoints"] = {
    onchain: contracts.DataStream,
  };
  if (x402Topics.has(normalizeTopic(topic))) {
    endpoints.mcp = "byte_buy_data";
    endpoints.x402 = `${config.x402Gateway}/feeds/${topic}`;
  }
  return endpoints;
}

/** What a publisher's on-chain state resolved to. */
interface OnChainPublisher {
  status: number;
  topic: string;
  pricePerKB: number;
  frequencySeconds: number;
  active: boolean;
  subscribers: number;
  messages: number;
}

/**
 * The outcome of reading one publisher. THREE outcomes, not two — this is the
 * distinction the old `| null` return could not carry, and the reason a failed
 * RPC read looked identical to a publisher that simply is not in the catalog:
 *
 *  ok        — read succeeded, publisher belongs in the catalog
 *  skipped   — read succeeded and the publisher legitimately is NOT a feed
 *              (unregistered, banned, or no usable topic). NOT a failure.
 *  failed    — we could not read it. The catalog is INCOMPLETE and must not
 *              be served as if it were whole.
 */
type PublisherRead =
  | { kind: "ok"; data: OnChainPublisher }
  | { kind: "skipped" }
  | { kind: "failed"; reason: string };

/**
 * Read a publisher's state by joining DataRegistry and SchemaRegistry in
 * parallel.
 *
 * A failed SchemaRegistry read used to fall through to `topic: "data-feed",
 * pricePerKB: 0` — a feed that does not exist, at a price that is not real.
 * Under RPC contention several publishers degraded at once and collided into
 * duplicate `data-feed` entries; one measured response carried 13 feeds for a
 * 12-feed catalog because `weather` was emitted as a placeholder AND re-added
 * by the gateway merge. A read we could not do is now reported, never
 * substituted for.
 */
async function getOnChainPublisherData(
  publisher: `0x${string}`,
): Promise<PublisherRead> {
  try {
    const [pubResult, schemaResult] = await Promise.allSettled([
      client.readContract({
        address: contracts.DataRegistry,
        abi: DataRegistryABI,
        functionName: "getPublisher",
        args: [publisher],
      }),
      client.readContract({
        address: contracts.SchemaRegistry,
        abi: SchemaRegistryABI,
        functionName: "getSchema",
        args: [publisher],
      }),
    ]);

    if (pubResult.status !== "fulfilled" || !pubResult.value) {
      return {
        kind: "failed",
        reason: `publisher read failed for ${publisher}`,
      };
    }
    const pub = pubResult.value as {
      status: number;
      subscriberCount: bigint;
      messageCount: bigint;
    };

    // Skip unregistered or banned publishers. A deliberate exclusion, not a
    // failure — the catalog is still complete without them.
    if (Number(pub.status) === 0 || Number(pub.status) === 4) {
      return { kind: "skipped" };
    }

    // A REJECTED schema read is not "no schema" — it is "we do not know".
    // Report it; the assembly is incomplete.
    if (schemaResult.status !== "fulfilled") {
      return {
        kind: "failed",
        reason: `schema read failed for ${publisher}`,
      };
    }

    const schema = schemaResult.value as
      | {
          frequencySeconds: number;
          topic: string;
          pricePerKB: bigint;
          active: boolean;
        }
      | null
      | undefined;

    // Read succeeded and there is no schema, or its topic bytes hold nothing
    // usable: this publisher has no feed to advertise. Skipping is honest;
    // emitting it under a made-up name at price 0 was not.
    const topic = schema ? decodeTopicOrNull(schema.topic) : null;
    if (!schema || !topic) return { kind: "skipped" };

    return {
      kind: "ok",
      data: {
        status: Number(pub.status),
        topic,
        pricePerKB: Number(schema.pricePerKB),
        frequencySeconds: Number(schema.frequencySeconds),
        active: schema.active,
        subscribers: Number(pub.subscriberCount),
        messages: Number(pub.messageCount),
      },
    };
  } catch (err) {
    return {
      kind: "failed",
      reason: `publisher read threw for ${publisher} (${(err as Error)?.name || "error"})`,
    };
  }
}

/**
 * Topics whose on-chain publishers are still registered but whose feeds have
 * been DELISTED from the product (retired or superseded). getFeeds enumerates
 * on-chain publishers, so without this filter the discovery API advertises dead
 * feeds and points agents at endpoints the product no longer serves. Keep in
 * sync with the gateway's delistings (x402-gateway feedRegistry).
 */
const DELISTED_TOPICS = new Set([
  "crypto-top100", // delisted 2026-06-12 (commodity; CoinGecko no-resale)
  "btc-metrics", // legacy, retired
  "token-safety", // delisted 2026-06-12 (provider licensing pending)
  "fact-oracle", // retired
  "merchant-trust", // superseded by address-reputation
  "pkg-facts", // superseded by pkg-verdict
  "cve-facts", // superseded by threat-intel
  "wiki-facts", // retired
  "bridge-flow", // retired
  // ── concentration cut 2026-07-03 (11 off-thesis feeds; keep-both retained
  //    runtime-eol + threat-intel, so they are NOT delisted). Mirrors the
  //    gateway feedRegistry cut (x402-gateway 499c7e1). ──
  "defi-yields",
  "space-weather",
  "news-feed",
  "code-pulse",
  "x402-pulse",
  "stablecoin-rails",
  "perp-funding",
  "usc-statute",
  "agent-compute",
  "agent-memory",
  "agent-tools",
  // ── founder-approved 2026-08-25 (AskUserQuestion, in-session) ──
  // evidence-pack: per the 2026-07-28 delist (removed from the gateway
  // feedRegistry for an integrity violation — served off-description output
  // with an undisclosed third-party egress path; see x402-gateway
  // config.ts's own delist comment). It was registered on-chain from before
  // that date and had been sitting PENDING a formal DELISTED_TOPICS entry
  // (ops/scripts/discover-gateway-consistency-check.cjs KNOWN_PENDING) —
  // this closes that gap; discovery-api now stops advertising it too.
  "evidence-pack",
  // signature-screen: unfinished build — registered on-chain 2026-08-04
  // (register_oracles.py FEEDS) but no gateway route was ever built.
  // Delisted here until the build is completed, not a retirement of intent.
  "signature-screen",
]);

/**
 * Build the full discovery response: enumerate publishers and enrich each
 * with on-chain data.
 */
/**
 * One assembly attempt. Returns the catalog it built AND whether every
 * upstream read it needed actually succeeded.
 *
 * `incomplete` is ONE marker collected across all three former fail-open
 * sites and checked once by the caller — not three separate mechanisms. If it
 * is non-null the response must not be served as fresh, whatever it contains.
 */
async function assembleCatalog(): Promise<{
  response: DiscoveryResponse;
  incomplete: string | null;
}> {
  // Fix A: request the full publisher page. The indexer's default page size is
  // 20 but it holds 24 publishers, so the unpaginated call truncated the list
  // (dropping `earthquakes`, a live feed) and caused the 15↔16 discover flap.
  const [indexerData, gatewayResult] = await Promise.all([
    fetchFromIndexer("/publishers?limit=200"),
    fetchX402Feeds(),
  ]);

  // Without the gateway catalog nothing below can be priced or marked
  // purchasable, so there is no partial answer worth assembling. Bail before
  // doing on-chain reads we would only have to throw away.
  if (!gatewayResult.ok) {
    return { response: emptyResponse(), incomplete: gatewayResult.reason };
  }
  const gatewayFeeds = gatewayResult.feeds;

  // Every upstream read that failed during this assembly. Non-empty ⇒ the
  // catalog is incomplete, no matter how many feeds it happens to hold.
  const failures: string[] = [];

  // Topics the gateway fronts (for the x402 endpoint decoration) + a lookup
  // for gateway-advertised provenance. normalizeTopic()'d HERE, at
  // construction — not just relied upon from fetchX402Feeds()'s own
  // normalization (which does already normalize `topic`, so this never fires
  // today; FD, 2026-08-04). Every lookup against both of these already
  // normalizes its needle; building the haystack without the same
  // normalization made that an IMPLICIT cross-function contract instead of a
  // local guarantee — fails closed today (a mismatched entry just never
  // matches, so a feed drops to no buy affordance rather than gaining a
  // false one), but a local, redundant normalization removes the implicit
  // dependency entirely rather than trusting it holds forever.
  const x402Topics = new Set(gatewayFeeds.map((f) => normalizeTopic(f.topic)));
  const gatewayByTopic = new Map(gatewayFeeds.map((f) => [normalizeTopic(f.topic), f]));

  let feeds: Feed[] = [];
  let totalMessages = 0;

  if (indexerData && Array.isArray(indexerData)) {
    // Indexer-driven: fast path, enriched with fresh on-chain reads.
    const feedPromises = indexerData.map(async (pub: any) => {
      const address = pub.address || pub.publisher;
      const read = await getOnChainPublisherData(address as `0x${string}`);
      if (read.kind === "failed") {
        failures.push(read.reason);
        return null;
      }
      if (read.kind === "skipped") return null;
      const onChain = read.data;

      totalMessages += onChain.messages;

      return {
        publisher: address,
        topic: onChain.topic,
        // Price comes from the GATEWAY when the feed is gateway-fronted, and
        // only falls back on-chain when it is not. The 402 challenge is the
        // only price that is ENFORCED — an agent that budgets from a
        // registry value the gateway will reject has been mispriced by us.
        // Measured 2026-09-02: all five on-chain publishers carry the
        // registration default pricePerKB=3000 on Arbitrum Sepolia (421614)
        // while the gateway settles on Base (8453) at 5000/10000/20000/50000;
        // only `earthquakes` agreed, and only because its gateway price
        // happens to be 3000 too. Same resolution the `provenance` field
        // below already uses — gatewayByTopic first, on-chain as fallback.
        pricePerKB:
          gatewayByTopic.get(normalizeTopic(onChain.topic))?.pricePerKB ??
          onChain.pricePerKB,
        // Gateway priceAtomic when this feed is gateway-fronted, else null —
        // never the on-chain per-KB figure onChain.pricePerKB falls back to
        // above: a per-KB number must never appear under the per-call name.
        pricePerCall:
          gatewayByTopic.get(normalizeTopic(onChain.topic))?.pricePerCall ??
          null,
        frequencySeconds: onChain.frequencySeconds,
        subscribers: onChain.subscribers,
        messages: onChain.messages,
        provenance:
          gatewayByTopic.get(normalizeTopic(onChain.topic))?.provenance ??
          "on-chain",
        onchain: address,
        // Registered on-chain != fronted by the gateway (2026-08-04 fix) —
        // same check buildEndpoints uses to gate mcp/x402, computed here too
        // so `purchasable` is an explicit signal, not inferred from whether
        // `endpoints.mcp` happens to be present.
        purchasable: x402Topics.has(normalizeTopic(onChain.topic)),
        endpoints: buildEndpoints(onChain.topic, x402Topics),
      } satisfies Feed;
    });

    const settled = await Promise.all(feedPromises);
    feeds = settled.filter((f) => f !== null) as Feed[];
  } else {
    // Fallback path: enumerate publishers directly from the registry.
    try {
      const count = await client.readContract({
        address: contracts.DataRegistry,
        abi: DataRegistryABI,
        functionName: "getPublisherListLength",
      });

      const pubCount = Number(count);
      for (let i = 0; i < pubCount; i++) {
        try {
          const address = await client.readContract({
            address: contracts.DataRegistry,
            abi: DataRegistryABI,
            functionName: "publisherList",
            args: [BigInt(i)],
          });

          const read = await getOnChainPublisherData(address as `0x${string}`);
          if (read.kind === "failed") {
            failures.push(read.reason);
            continue;
          }
          if (read.kind === "skipped") continue;
          const onChain = read.data;

          totalMessages += onChain.messages;

          feeds.push({
            publisher: address as string,
            topic: onChain.topic,
            // See the identical resolution in the indexer-driven path above:
            // the gateway's enforced price wins whenever the feed is fronted.
            pricePerKB:
              gatewayByTopic.get(normalizeTopic(onChain.topic))?.pricePerKB ??
              onChain.pricePerKB,
            // See the identical resolution in the indexer-driven path above:
            // gateway priceAtomic when fronted, else null — never the
            // on-chain per-KB fallback that pricePerKB above uses.
            pricePerCall:
              gatewayByTopic.get(normalizeTopic(onChain.topic))
                ?.pricePerCall ?? null,
            frequencySeconds: onChain.frequencySeconds,
            subscribers: onChain.subscribers,
            messages: onChain.messages,
            provenance:
              gatewayByTopic.get(normalizeTopic(onChain.topic))
                ?.provenance ?? "on-chain",
            onchain: address as string,
            // Registered on-chain != fronted by the gateway — see the
            // indexer-driven path above for the full note.
            purchasable: x402Topics.has(normalizeTopic(onChain.topic)),
            endpoints: buildEndpoints(onChain.topic, x402Topics),
          });
        } catch (err) {
          // A per-publisher read that throws is a MISSING FEED, not a feed
          // that does not exist. Record it; the assembly is incomplete.
          failures.push(
            `publisher enumeration failed at index ${i} (${(err as Error)?.name || "error"})`,
          );
        }
      }
    } catch (err) {
      // This used to return an empty feed list at HTTP 200 — measured 19 times
      // in 60 concurrent requests. An empty catalog is a claim that the
      // product has no feeds; we do not get to make it because a read failed.
      failures.push(
        `chain enumeration failed (${(err as Error)?.name || "error"})`,
      );
    }
  }

  // Drop delisted feeds whose on-chain publishers are still registered, so the
  // catalog reflects the LIVE product (not retired/superseded feeds). Recompute
  // the message total over the surviving feeds.
  feeds = feeds.filter((f) => !DELISTED_TOPICS.has(normalizeTopic(f.topic)));

  // Fix B: surface first-party gateway-only oracles — feeds that are live +
  // billable via x402 but have NO on-chain DataRegistry publisher, so the
  // indexer/chain enumeration above never includes them. Merge in any gateway
  // feed not already present and not delisted — marked HONESTLY as
  // first-party with onchain=null; we never fake an on-chain publisher
  // address.
  //
  // As of 2026-08-04 this set is address-reputation, pkg-verdict,
  // sanctions-screen, reasoning-verdict, merchant-screen, and
  // positioning-snapshot — but treat that as a snapshot to VERIFY against the
  // live /feeds catalog, not a fact to trust. An EARLIER version of this exact
  // comment named liquidation-stream here (delisted 2026-07-28) and OMITTED
  // merchant-screen (live the whole time) — the identical hardcoded-list-goes-
  // stale defect this session has been closing everywhere else in this file
  // (methods, x402Topics/gatewayByTopic normalization below), just caught in
  // prose instead of code this time.
  //
  // Counts drift constantly and are NOT asserted equal: checked live
  // 2026-08-04, /discover served 13 feeds while gateway /feeds served 10 —
  // legitimately different, not a bug, because a feed can be registered
  // on-chain without a gateway route yet (signature-screen,
  // cctp-attestation-latency) or delisted from the gateway without a
  // DELISTED_TOPICS entry yet (evidence-pack, until a human resolves it — see
  // KNOWN_PENDING in ops/scripts/discover-gateway-consistency-check.cjs,
  // which is the standing, automated way to check these two counts against
  // each other; don't hand-recompute or restate a specific number here again).
  const present = new Set(feeds.map((f) => normalizeTopic(f.topic)));
  for (const gf of gatewayFeeds) {
    if (present.has(normalizeTopic(gf.topic)) || DELISTED_TOPICS.has(normalizeTopic(gf.topic))) continue;
    feeds.push({
      publisher: "first-party",
      // normalizeTopic()'d, not raw gf.topic (FD, A6 — 2026-08-04): the
      // Feed type above (line ~145) already documents `topic: string; //
      // lowercased slug` — emitting the gateway's raw, possibly-mixed-case
      // topic here violated that contract on every response this merge ever
      // touched. Normalizing is the fix, not relaxing the comment: every
      // downstream consumer of this field does its own topic-set maths
      // (ops/scripts/discover-gateway-consistency-check.cjs is the immediate
      // example), so an un-normalized emission forces each one to reimplement
      // normalizeTopic() itself — the exact scattered-`.toLowerCase()` defect
      // this file closed one level down, just pushed across the module
      // boundary instead of staying inside it. Costs no fidelity: the x402
      // URL two lines below already uses the RAW gf.topic on purpose (it's a
      // route, not an identity) — this is the same exact-string-for-routes /
      // normalized-string-for-identity split the file already made, now
      // applied consistently to the field it names as an identity.
      topic: normalizeTopic(gf.topic),
      pricePerKB: gf.pricePerKB,
      // This merge only runs for topics IN gatewayFeeds (loop guard above),
      // so gf.pricePerCall is always defined here — always gateway-fronted.
      pricePerCall: gf.pricePerCall,
      frequencySeconds: 0,
      subscribers: 0,
      messages: 0,
      provenance: gf.provenance || "first-party",
      onchain: null,
      // This merge only ever runs for topics IN gatewayFeeds (the loop guard
      // above), so every feed reaching this line is, by construction,
      // fronted by the gateway right now — always purchasable.
      purchasable: true,
      endpoints: {
        mcp: "byte_buy_data",
        onchain: "", // no on-chain publisher for a gateway-only first-party feed
        // RAW gf.topic, deliberately NOT normalized — this builds a ROUTE the
        // gateway must match byte-for-byte, unlike `topic` above (an identity
        // field, always normalized). Do not "fix" this to normalizeTopic().
        x402: `${config.x402Gateway}/feeds/${gf.topic}`,
      },
    });
    present.add(normalizeTopic(gf.topic));
  }

  totalMessages = feeds.reduce((sum, f) => sum + f.messages, 0);

  return {
    response: {
      protocol: "byte",
      version: "1.0",
      chain: config.chain,
      chainId: config.chainId,
      payment: config.payment,
      attestation: config.attestation,
      totalFeeds: feeds.length,
      distinctOperators: 1, // all first-party PayPerByte — not independent orgs
      totalMessages,
      feeds,
      access: {
        // The PUBLIC base, never config.x402GatewayFetch — this string is
        // advertised to agents.
        x402_gateway: config.x402Gateway,
        mcp_server: "https://mcp.payperbyte.io/mcp",
        indexer_api: config.indexerUrl,
      },
    },
    incomplete: failures.length ? failures.join("; ") : null,
  };
}

/** The shape returned when an assembly bailed before it could build anything. */
function emptyResponse(): DiscoveryResponse {
  return {
    protocol: "byte",
    version: "1.0",
    chain: config.chain,
    chainId: config.chainId,
    payment: config.payment,
    attestation: config.attestation,
    totalFeeds: 0,
    distinctOperators: 1,
    totalMessages: 0,
    feeds: [],
    access: {
      x402_gateway: config.x402Gateway,
      mcp_server: "https://mcp.payperbyte.io/mcp",
      indexer_api: config.indexerUrl,
    },
  };
}

// ---------------------------------------------------------------------------
// Catalog cache, single-flight, and the last-good fallback.
//
// Process memory only — a restart starts cold, which is correct: a cold
// process has nothing it can honestly call "last good".
// ---------------------------------------------------------------------------

/** The last catalog every upstream agreed on. Also the cache. */
let lastGood: DiscoveryResponse | null = null;
/** ISO stamp of when `lastGood` was assembled. */
let lastGoodAt: string | null = null;
/** Epoch ms of the same, for age arithmetic. */
let lastGoodMs = 0;
/** Epoch ms of the last returned result — TTL is measured from here. */
let servedAt = 0;
/** What we last returned (good or degraded), served while inside the TTL. */
let lastResult: DiscoveryResponse | null = null;
/** The in-flight assembly, shared by every concurrent caller. */
let inFlight: Promise<DiscoveryResponse> | null = null;

/** Test seam: drop all cached state. Not used in production paths. */
export function __resetCatalogCacheForTests(): void {
  lastGood = null;
  lastGoodAt = null;
  lastGoodMs = 0;
  servedAt = 0;
  lastResult = null;
  inFlight = null;
}

/** Human-readable age, e.g. "41s". */
function ageSeconds(sinceMs: number): string {
  return `${Math.max(0, Math.round((Date.now() - sinceMs) / 1000))}s`;
}

/**
 * Assemble a catalog, or serve the last good one, or fail closed.
 *
 * Never returns a catalog built from a partial set of upstream reads. The
 * three outcomes are:
 *   1. every read succeeded          → fresh catalog, cached, becomes last-good
 *   2. a read failed, last-good held → last-good + `degraded` disclosure
 *   3. a read failed, nothing held   → CatalogUnavailableError (→ 503)
 */
async function refreshCatalog(): Promise<DiscoveryResponse> {
  const { response, incomplete } = await assembleCatalog();

  if (!incomplete) {
    // A real but suspiciously small catalog is still served — it may be a
    // genuine delisting — but it never passes unremarked.
    if (lastGood && response.totalFeeds * 2 < lastGood.totalFeeds) {
      console.error(
        `[discover] gateway catalog shrank ${lastGood.totalFeeds} -> ${response.totalFeeds}`,
      );
    }
    lastGood = response;
    lastGoodMs = Date.now();
    lastGoodAt = new Date(lastGoodMs).toISOString();
    return response;
  }

  if (lastGood) {
    console.error(
      `[discover] upstream FAILED (${incomplete}) — serving last-good catalog from ${lastGoodAt} (age ${ageSeconds(lastGoodMs)})`,
    );
    // A COPY: the cached last-good must never carry the degraded keys itself,
    // or the next healthy hit would inherit them.
    return {
      ...lastGood,
      degraded: true,
      degradedReason: incomplete,
      lastGoodAt: lastGoodAt as string,
    };
  }

  console.error(
    `[discover] upstream FAILED (${incomplete}) — no last-good catalog, answering 503`,
  );
  throw new CatalogUnavailableError(incomplete);
}

/**
 * Build the full discovery response: enumerate publishers and enrich each
 * with on-chain data.
 *
 * Concurrent callers inside the TTL share one assembly. Before this, every
 * request did its own live RPC reads plus a gateway fetch, so a burst
 * rate-limited itself against the gateway and then fell open on the 429 —
 * which is how 41 of 60 concurrent requests returned a wrong catalog.
 */
export async function getFeeds(): Promise<DiscoveryResponse> {
  if (lastResult && Date.now() - servedAt < config.catalogTtlMs) {
    return lastResult;
  }
  if (inFlight) return inFlight;

  inFlight = refreshCatalog()
    .then((res) => {
      lastResult = res;
      servedAt = Date.now();
      return res;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
