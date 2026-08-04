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

/** A single data feed with publisher metadata and access endpoints. */
export interface Feed {
  publisher: string;
  topic: string;
  pricePerKB: number; // µUSDC (6 decimals)
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
}

/**
 * Decode a bytes32 hex value to a printable topic string. Schemas store
 * topics as ASCII padded with null bytes. If the bytes don't decode to
 * printable ASCII (e.g., the value is a hash or random bytes), fall back
 * to "data-feed".
 */
function decodeTopic(hex: string): string {
  if (!hex || typeof hex !== "string") return "data-feed";
  const bytes = hex.replace(/^0x/, "");
  let str = "";
  for (let i = 0; i < bytes.length; i += 2) {
    const code = parseInt(bytes.substr(i, 2), 16);
    if (Number.isNaN(code)) return "data-feed";
    if (code === 0) break;
    str += String.fromCharCode(code);
  }
  if (str.length < 2 || str.length > 31) return "data-feed";
  if (!/^[a-zA-Z0-9._\-: ]+$/.test(str)) return "data-feed";
  return str;
}

/** Fetch JSON from the BYTE Library indexer, returning null on any failure. */
async function fetchFromIndexer(path: string): Promise<any> {
  try {
    const res = await fetch(`${config.indexerUrl}${path}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** A feed as advertised by the x402 gateway's `/feeds` catalog. */
interface GatewayFeed {
  topic: string; // lowercased slug (gateway `id`/`topic`)
  pricePerKB: number; // µUSDC (gateway `priceAtomic`)
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
 * Returns [] on any failure (→ no x402 decoration, no gateway merge; graceful).
 */
async function fetchX402Feeds(): Promise<GatewayFeed[]> {
  try {
    const res = await fetch(`${config.x402Gateway}/feeds`);
    if (!res.ok) return [];
    const data = await res.json();
    const feeds = Array.isArray(data?.feeds) ? data.feeds : [];
    return feeds
      .map((f: any): GatewayFeed | null => {
        const topic = (f.topic ?? f.id ?? "").toString().toLowerCase();
        if (!topic) return null;
        return {
          topic,
          pricePerKB: Number(f.priceAtomic ?? f.pricePerKB ?? 0) || 0,
          provenance: (f.provenance ?? "").toString() || "first-party",
        };
      })
      .filter((f: GatewayFeed | null): f is GatewayFeed => f !== null);
  } catch {
    return [];
  }
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
  if (x402Topics.has(topic.toLowerCase())) {
    endpoints.mcp = "byte_buy_data";
    endpoints.x402 = `${config.x402Gateway}/feeds/${topic}`;
  }
  return endpoints;
}

/**
 * Read a publisher's state by joining DataRegistry and SchemaRegistry in
 * parallel. Returns null if the publisher's core record can't be read;
 * a missing schema gets safe defaults.
 */
async function getOnChainPublisherData(publisher: `0x${string}`): Promise<{
  status: number;
  topic: string;
  pricePerKB: number;
  frequencySeconds: number;
  active: boolean;
  subscribers: number;
  messages: number;
} | null> {
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

    if (pubResult.status !== "fulfilled" || !pubResult.value) return null;
    const pub = pubResult.value as {
      status: number;
      subscriberCount: bigint;
      messageCount: bigint;
    };

    // Skip unregistered or banned publishers.
    if (Number(pub.status) === 0 || Number(pub.status) === 4) return null;

    const schema =
      schemaResult.status === "fulfilled" && schemaResult.value
        ? (schemaResult.value as {
            frequencySeconds: number;
            topic: string;
            pricePerKB: bigint;
            active: boolean;
          })
        : null;

    return {
      status: Number(pub.status),
      topic: schema ? decodeTopic(schema.topic) : "data-feed",
      pricePerKB: schema ? Number(schema.pricePerKB) : 0,
      frequencySeconds: schema ? Number(schema.frequencySeconds) : 0,
      active: schema ? schema.active : false,
      subscribers: Number(pub.subscriberCount),
      messages: Number(pub.messageCount),
    };
  } catch {
    return null;
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
]);

/**
 * Build the full discovery response: enumerate publishers and enrich each
 * with on-chain data.
 */
export async function getFeeds(): Promise<DiscoveryResponse> {
  // Fix A: request the full publisher page. The indexer's default page size is
  // 20 but it holds 24 publishers, so the unpaginated call truncated the list
  // (dropping `earthquakes`, a live feed) and caused the 15↔16 discover flap.
  const [indexerData, gatewayFeeds] = await Promise.all([
    fetchFromIndexer("/publishers?limit=200"),
    fetchX402Feeds(),
  ]);

  // Topics the gateway fronts (for the x402 endpoint decoration) + a lookup for
  // gateway-advertised provenance.
  const x402Topics = new Set(gatewayFeeds.map((f) => f.topic));
  const gatewayByTopic = new Map(gatewayFeeds.map((f) => [f.topic, f]));

  let feeds: Feed[] = [];
  let totalMessages = 0;

  if (indexerData && Array.isArray(indexerData)) {
    // Indexer-driven: fast path, enriched with fresh on-chain reads.
    const feedPromises = indexerData.map(async (pub: any) => {
      const address = pub.address || pub.publisher;
      const onChain = await getOnChainPublisherData(address as `0x${string}`);
      if (!onChain) return null;

      totalMessages += onChain.messages;

      return {
        publisher: address,
        topic: onChain.topic,
        pricePerKB: onChain.pricePerKB,
        frequencySeconds: onChain.frequencySeconds,
        subscribers: onChain.subscribers,
        messages: onChain.messages,
        provenance:
          gatewayByTopic.get((onChain.topic || "").toLowerCase())?.provenance ??
          "on-chain",
        onchain: address,
        // Registered on-chain != fronted by the gateway (2026-08-04 fix) —
        // same check buildEndpoints uses to gate mcp/x402, computed here too
        // so `purchasable` is an explicit signal, not inferred from whether
        // `endpoints.mcp` happens to be present.
        purchasable: x402Topics.has((onChain.topic || "").toLowerCase()),
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

          const onChain = await getOnChainPublisherData(address as `0x${string}`);
          if (!onChain) continue;

          totalMessages += onChain.messages;

          feeds.push({
            publisher: address as string,
            topic: onChain.topic,
            pricePerKB: onChain.pricePerKB,
            frequencySeconds: onChain.frequencySeconds,
            subscribers: onChain.subscribers,
            messages: onChain.messages,
            provenance:
              gatewayByTopic.get((onChain.topic || "").toLowerCase())
                ?.provenance ?? "on-chain",
            onchain: address as string,
            // Registered on-chain != fronted by the gateway — see the
            // indexer-driven path above for the full note.
            purchasable: x402Topics.has((onChain.topic || "").toLowerCase()),
            endpoints: buildEndpoints(onChain.topic, x402Topics),
          });
        } catch {
          // Skip individual publisher read failures and continue.
        }
      }
    } catch {
      // No on-chain data available — return empty feed list.
    }
  }

  // Drop delisted feeds whose on-chain publishers are still registered, so the
  // catalog reflects the LIVE product (not retired/superseded feeds). Recompute
  // the message total over the surviving feeds.
  feeds = feeds.filter((f) => !DELISTED_TOPICS.has((f.topic || "").toLowerCase()));

  // Fix B: surface first-party gateway-only oracles. These feeds (address-
  // reputation, pkg-verdict, sanctions-screen, reasoning-verdict,
  // liquidation-stream, positioning-snapshot) are live + billable via x402 but
  // have NO on-chain DataRegistry publisher, so the indexer/chain enumeration
  // above never includes them. Merge in any gateway feed not already present and
  // not delisted — marked HONESTLY as first-party with onchain=null; we never
  // fake an on-chain publisher address. Result: /discover == /feeds == 22.
  const present = new Set(feeds.map((f) => (f.topic || "").toLowerCase()));
  for (const gf of gatewayFeeds) {
    if (present.has(gf.topic) || DELISTED_TOPICS.has(gf.topic)) continue;
    feeds.push({
      publisher: "first-party",
      topic: gf.topic,
      pricePerKB: gf.pricePerKB,
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
        x402: `${config.x402Gateway}/feeds/${gf.topic}`,
      },
    });
    present.add(gf.topic);
  }

  totalMessages = feeds.reduce((sum, f) => sum + f.messages, 0);

  return {
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
      x402_gateway: config.x402Gateway,
      mcp_server: "https://mcp.payperbyte.io/mcp",
      indexer_api: config.indexerUrl,
    },
  };
}
