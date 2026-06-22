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
  endpoints: {
    x402?: string;
    mcp: string;
    onchain: string;
  };
}

/** Top-level response shape returned by the /discover endpoint. */
export interface DiscoveryResponse {
  protocol: string;
  version: string;
  chain: string;
  chainId: number;
  totalPublishers: number;
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

/**
 * Fetch the set of topics the x402 gateway actually serves. Used to gate the
 * `x402` endpoint URL — most on-chain publishers are not fronted by the
 * gateway, and advertising a gateway URL for them yields a 404 for the agent.
 * Returns an empty set on any failure (→ x402 omitted, mcp/onchain still given).
 */
async function fetchX402Topics(): Promise<Set<string>> {
  try {
    const res = await fetch(`${config.x402Gateway}/feeds`);
    if (!res.ok) return new Set();
    const data = await res.json();
    const feeds = Array.isArray(data?.feeds) ? data.feeds : [];
    return new Set(
      feeds
        .map((f: any) => (f.topic ?? f.id ?? "").toString().toLowerCase())
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

/**
 * Build a feed's access endpoints. `mcp` and `onchain` always apply; `x402` is
 * included only when the gateway serves that topic.
 */
function buildEndpoints(
  topic: string,
  x402Topics: Set<string>
): Feed["endpoints"] {
  const endpoints: Feed["endpoints"] = {
    mcp: "byte_subscribe",
    onchain: contracts.DataStream,
  };
  if (x402Topics.has(topic.toLowerCase())) {
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
]);

/**
 * Build the full discovery response: enumerate publishers and enrich each
 * with on-chain data.
 */
export async function getFeeds(): Promise<DiscoveryResponse> {
  const [indexerData, x402Topics] = await Promise.all([
    fetchFromIndexer("/publishers"),
    fetchX402Topics(),
  ]);

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
  totalMessages = feeds.reduce((sum, f) => sum + f.messages, 0);

  return {
    protocol: "byte",
    version: "1.0",
    chain: config.chain,
    chainId: config.chainId,
    totalPublishers: feeds.length,
    totalMessages,
    feeds,
    access: {
      x402_gateway: config.x402Gateway,
      mcp_server: "npx byte-mcp-server",
      indexer_api: config.indexerUrl,
    },
  };
}
