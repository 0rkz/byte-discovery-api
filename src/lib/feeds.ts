/**
 * Feed discovery module.
 *
 * Enumerates data feed publishers from the Byte Protocol indexer (preferred)
 * or falls back to on-chain enumeration via DataRegistry. Each feed is
 * enriched with PQS scores, subscriber counts, and attestation summaries.
 */

import { createPublicClient, http } from "viem";
import { arbitrumSepolia } from "viem/chains";
import {
  config,
  contracts,
  PQSVerifierABI,
  DataRegistryABI,
  DataStreamABI,
} from "./config";

/** Viem public client for Arbitrum Sepolia on-chain reads. */
const client = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(config.rpcUrl),
});

/** A single data feed with publisher metadata, quality scores, and access endpoints. */
export interface Feed {
  publisher: string;
  topic: string;
  description: string;
  tier: string;
  pqs: number;
  pricePerKB: number;
  frequency: number;
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

/** Read all publisher metadata from on-chain contracts in a single parallel batch. */
async function getOnChainPublisherData(publisher: `0x${string}`): Promise<{
  topic: string;
  description: string;
  pricePerKB: number;
  frequency: number;
  active: boolean;
  pqs: number;
  tier: string;
  subscribers: number;
  messages: number;
} | null> {
  try {
    const [info, score, tier, subscribers, messages] = await Promise.allSettled([
      client.readContract({
        address: contracts.DataRegistry,
        abi: DataRegistryABI,
        functionName: "getPublisherInfo",
        args: [publisher],
      }),
      client.readContract({
        address: contracts.PQSVerifier,
        abi: PQSVerifierABI,
        functionName: "getPublisherScore",
        args: [publisher],
      }),
      client.readContract({
        address: contracts.PQSVerifier,
        abi: PQSVerifierABI,
        functionName: "getPublisherTier",
        args: [publisher],
      }),
      client.readContract({
        address: contracts.DataStream,
        abi: DataStreamABI,
        functionName: "getSubscriberCount",
        args: [publisher],
      }),
      client.readContract({
        address: contracts.DataStream,
        abi: DataStreamABI,
        functionName: "getMessageCount",
        args: [publisher],
      }),
    ]);

    const infoResult = info.status === "fulfilled" ? (info.value as any) : null;
    const scoreResult =
      score.status === "fulfilled" ? Number(score.value) : 10000;
    const tierResult =
      tier.status === "fulfilled" ? (tier.value as string) : "New";
    const subsResult =
      subscribers.status === "fulfilled" ? Number(subscribers.value) : 0;
    const msgsResult =
      messages.status === "fulfilled" ? Number(messages.value) : 0;

    if (infoResult) {
      return {
        topic: infoResult[0] || "unknown",
        description: infoResult[1] || "",
        pricePerKB: Number(infoResult[2]),
        frequency: Number(infoResult[3]),
        active: infoResult[4],
        pqs: scoreResult,
        tier: tierResult,
        subscribers: subsResult,
        messages: msgsResult,
      };
    }

    return null;
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
  // Try indexer first for publisher list
  const indexerData = await fetchFromIndexer("/publishers");

  let feeds: Feed[] = [];
  let totalMessages = 0;

  if (indexerData && Array.isArray(indexerData)) {
    // Build feeds from indexer data, enrich with on-chain
    const feedPromises = indexerData.map(async (pub: any) => {
      const address = pub.address || pub.publisher;
      const onChain = await getOnChainPublisherData(address as `0x${string}`);

      const topic = onChain?.topic || pub.topic || "unknown";
      const msgCount = onChain?.messages || pub.messageCount || pub.messages || 0;
      totalMessages += msgCount;

      const att = attestationCounts.get(address.toLowerCase()) || {
        positive: 0,
        negative: 0,
      };

      return {
        publisher: address,
        topic,
        description: onChain?.description || pub.description || "",
        tier: onChain?.tier || pub.tier || "New",
        pqs: onChain?.pqs ?? pub.pqs ?? 10000,
        pricePerKB: onChain?.pricePerKB ?? pub.pricePerKB ?? 1000,
        frequency: onChain?.frequency ?? pub.frequency ?? 3600,
        subscribers: onChain?.subscribers ?? pub.subscribers ?? 0,
        messages: msgCount,
        attestations: {
          positive: att.positive,
          negative: att.negative,
          total: att.positive + att.negative,
        },
        endpoints: {
          x402: `${config.x402Gateway}/feeds/${topic}`,
          mcp: "byte_subscribe",
          onchain: contracts.DataStream,
        },
      } satisfies Feed;
    });

    feeds = await Promise.all(feedPromises);
  } else {
    // Fallback: try on-chain publisher enumeration
    try {
      const count = await client.readContract({
        address: contracts.DataRegistry,
        abi: DataRegistryABI,
        functionName: "getPublisherCount",
      });

      const pubCount = Number(count);
      for (let i = 0; i < pubCount; i++) {
        try {
          const address = await client.readContract({
            address: contracts.DataRegistry,
            abi: DataRegistryABI,
            functionName: "getPublisherByIndex",
            args: [BigInt(i)],
          });

          const onChain = await getOnChainPublisherData(
            address as `0x${string}`
          );
          if (onChain && onChain.active) {
            totalMessages += onChain.messages;
            const att = attestationCounts.get(
              (address as string).toLowerCase()
            ) || { positive: 0, negative: 0 };

            feeds.push({
              publisher: address as string,
              topic: onChain.topic,
              description: onChain.description,
              tier: onChain.tier,
              pqs: onChain.pqs,
              pricePerKB: onChain.pricePerKB,
              frequency: onChain.frequency,
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
          }
        } catch {
          // Skip invalid publisher index
        }
      }
    } catch {
      // No on-chain data available
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
