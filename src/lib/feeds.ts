/**
 * Feed discovery module.
 *
 * Enumerates data feed publishers from the Byte Protocol indexer (preferred)
 * or falls back to on-chain enumeration via DataRegistry. Each feed is
 * enriched with PQS scores, schema metadata, and attestation summaries.
 */

import { createPublicClient, http } from "viem";
import { arbitrumSepolia } from "viem/chains";
import {
  config,
  contracts,
  PQSVerifierABI,
  DataRegistryABI,
  SchemaRegistryABI,
  TIER_NAMES,
} from "./config.js";

/** Viem public client for Arbitrum Sepolia on-chain reads. */
const client = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(config.rpcUrl),
});

/** A single data feed with publisher metadata, quality scores, and access endpoints. */
export interface Feed {
  publisher: string;
  topic: string;
  tier: string;
  pqs: number; // composite, 0-10000 BPS
  pricePerKB: number; // µUSDC (6 decimals)
  frequencySeconds: number;
  subscribers: number;
  messages: number;
  attestations: { positive: number; negative: number; total: number };
  endpoints: {
    x402: string;
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
    faucet: string;
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

/** Fetch JSON from the Byte indexer, returning null on any failure. */
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
 * Read a publisher's full state by joining DataRegistry, SchemaRegistry, and
 * PQSVerifier in parallel. Returns null if the publisher's core record can't
 * be read; individual missing pieces (schema, PQS) get safe defaults.
 */
async function getOnChainPublisherData(publisher: `0x${string}`): Promise<{
  status: number;
  tier: string;
  topic: string;
  pricePerKB: number;
  frequencySeconds: number;
  active: boolean;
  pqs: number;
  subscribers: number;
  messages: number;
} | null> {
  try {
    const [pubResult, schemaResult, pqsResult] = await Promise.allSettled([
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
      client.readContract({
        address: contracts.PQSVerifier,
        abi: PQSVerifierABI,
        functionName: "getVerifiedPQS",
        args: [publisher],
      }),
    ]);

    if (pubResult.status !== "fulfilled" || !pubResult.value) return null;
    const pub = pubResult.value as {
      status: number;
      tier: number;
      stakedAmount: bigint;
      subscriberCount: bigint;
      messageCount: bigint;
      totalRevenue: bigint;
      lastActiveTimestamp: bigint;
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

    const pqs =
      pqsResult.status === "fulfilled" && pqsResult.value
        ? (pqsResult.value as { composite: bigint })
        : null;

    return {
      status: Number(pub.status),
      tier: TIER_NAMES[Number(pub.tier)] ?? "New",
      topic: schema ? decodeTopic(schema.topic) : "data-feed",
      pricePerKB: schema ? Number(schema.pricePerKB) : 0,
      frequencySeconds: schema ? Number(schema.frequencySeconds) : 0,
      active: schema ? schema.active : false,
      pqs: pqs ? Number(pqs.composite) : 0,
      subscribers: Number(pub.subscriberCount),
      messages: Number(pub.messageCount),
    };
  } catch {
    return null;
  }
}

/**
 * Build the full discovery response: enumerate publishers, enrich with
 * on-chain data, and merge attestation counts.
 */
export async function getFeeds(
  attestationCounts: Map<string, { positive: number; negative: number }>
): Promise<DiscoveryResponse> {
  const indexerData = await fetchFromIndexer("/publishers");

  let feeds: Feed[] = [];
  let totalMessages = 0;

  if (indexerData && Array.isArray(indexerData)) {
    // Indexer-driven: fast path, enriched with fresh on-chain reads.
    const feedPromises = indexerData.map(async (pub: any) => {
      const address = pub.address || pub.publisher;
      const onChain = await getOnChainPublisherData(address as `0x${string}`);
      if (!onChain) return null;

      totalMessages += onChain.messages;
      const att = attestationCounts.get(address.toLowerCase()) || {
        positive: 0,
        negative: 0,
      };

      return {
        publisher: address,
        topic: onChain.topic,
        tier: onChain.tier,
        pqs: onChain.pqs,
        pricePerKB: onChain.pricePerKB,
        frequencySeconds: onChain.frequencySeconds,
        subscribers: onChain.subscribers,
        messages: onChain.messages,
        attestations: {
          positive: att.positive,
          negative: att.negative,
          total: att.positive + att.negative,
        },
        endpoints: {
          x402: `${config.x402Gateway}/feeds/${onChain.topic}`,
          mcp: "byte_subscribe",
          onchain: contracts.DataStream,
        },
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
          const att = attestationCounts.get(
            (address as string).toLowerCase()
          ) || { positive: 0, negative: 0 };

          feeds.push({
            publisher: address as string,
            topic: onChain.topic,
            tier: onChain.tier,
            pqs: onChain.pqs,
            pricePerKB: onChain.pricePerKB,
            frequencySeconds: onChain.frequencySeconds,
            subscribers: onChain.subscribers,
            messages: onChain.messages,
            attestations: {
              positive: att.positive,
              negative: att.negative,
              total: att.positive + att.negative,
            },
            endpoints: {
              x402: `${config.x402Gateway}/feeds/${onChain.topic}`,
              mcp: "byte_subscribe",
              onchain: contracts.DataStream,
            },
          });
        } catch {
          // Skip individual publisher read failures and continue.
        }
      }
    } catch {
      // No on-chain data available — return empty feed list.
    }
  }

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
      faucet: contracts.Faucet,
    },
  };
}
