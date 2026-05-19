import dotenv from "dotenv";
dotenv.config();

/** Runtime configuration loaded from environment variables with sensible defaults. */
export const config = {
  port: parseInt(process.env.PORT || "3500", 10),
  rpcUrl: process.env.RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",

  // Public-facing URLs surfaced in /.well-known/byte-protocol.json + /discover.
  // Override via env in production deploys; default to localhost for local dev.
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "https://api.payperbyte.io",
  indexerUrl: process.env.INDEXER_URL || "https://feeds.payperbyte.io",
  marketplaceUrl: process.env.MARKETPLACE_URL || "https://www.payperbyte.io",
  x402Gateway: process.env.X402_GATEWAY || "http://localhost:3402",

  chainId: 421614,
  chain: "arbitrum-sepolia",
} as const;

/** Deployed Byte Protocol contract addresses on Arbitrum Sepolia. */
export const contracts = {
  DataRegistry: "0x05D89769A066549115b1B4408bFf899D2737F30b" as const,
  DataStream: "0x7E12bF2B0d43B9Ea0Bc37A06EcAC36b810351F35" as const,
  SchemaRegistry: "0x2e490F33180F3d387d46c213ADf776135c052acf" as const,
  PQSVerifier: "0xD7c8423296a6E2Dd36466AC0e41884846a27cdE9" as const,
  Faucet: "0x19d25F286b8Dca21886bCBe9c21334C6F0C532FB" as const,
  PPBToken: "0x37a86eD3ee87109ff8cF96B3fe45c70a2ebB69f3" as const,
  AgentAttestation: "0xA20ad0c5b5e37954030C290a887020ACebaAA49C" as const,
} as const;

/** PQSVerifier — getVerifiedPQS returns the on-chain median composite. */
export const PQSVerifierABI = [
  {
    name: "getVerifiedPQS",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "publisher", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "disputeScore", type: "uint256" },
          { name: "retentionScore", type: "uint256" },
          { name: "freshnessScore", type: "uint256" },
          { name: "revenueQuality", type: "uint256" },
          { name: "composite", type: "uint256" },
          { name: "timestamp", type: "uint256" },
        ],
      },
    ],
  },
] as const;

/**
 * DataRegistry — canonical Publisher tuple field order. Viem decodes by position,
 * so this MUST match the Solidity struct in DataRegistry.sol exactly.
 */
export const DataRegistryABI = [
  {
    name: "getPublisher",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "publisher", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "status", type: "uint8" },
          { name: "tier", type: "uint8" },
          { name: "stakedAmount", type: "uint256" },
          { name: "sandboxStartTime", type: "uint256" },
          { name: "registeredAt", type: "uint256" },
          { name: "subscriberCount", type: "uint256" },
          { name: "messageCount", type: "uint256" },
          { name: "totalRevenue", type: "uint256" },
          { name: "lastActiveTimestamp", type: "uint256" },
          { name: "publicKey", type: "bytes32" },
          { name: "slashCount", type: "uint256" },
        ],
      },
    ],
  },
  {
    name: "getPublisherListLength",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "publisherList",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/** SchemaRegistry — Schema tuple. First three fields are uint32 (NOT uint256). */
export const SchemaRegistryABI = [
  {
    name: "getSchema",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "publisher", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "expectedSize", type: "uint32" },
          { name: "maxSize", type: "uint32" },
          { name: "frequencySeconds", type: "uint32" },
          { name: "pubClass", type: "uint8" },
          { name: "verType", type: "uint8" },
          { name: "methodologyHash", type: "bytes32" },
          { name: "topic", type: "bytes32" },
          { name: "pricePerKB", type: "uint256" },
          { name: "active", type: "bool" },
          { name: "registeredAt", type: "uint256" },
        ],
      },
    ],
  },
] as const;

/** Maps the on-chain tier enum (0-4) to display labels. */
export const TIER_NAMES = ["New", "Established", "Trusted", "Premium", "Elite"] as const;

/** Maps the on-chain status enum to display labels. */
export const STATUS_NAMES = [
  "Unregistered",
  "Sandbox",
  "Active",
  "Suspended",
  "Banned",
] as const;
