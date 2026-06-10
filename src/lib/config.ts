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

  // BYTE Library v1 — deploy block on Arbitrum Sepolia (chain 421614).
  // Source: byte-protocol-contracts/deployments/arbitrum-sepolia.json "byte-library".
  deployBlock: 270092067,
  libraryVersion: "1.0" as const,
} as const;

/**
 * BYTE Library v1 contract addresses on Arbitrum Sepolia (chain 421614).
 * Source: byte-protocol-contracts/deployments/arbitrum-sepolia.json "byte-library".
 *
 * BYTE Library is a no-token, first-party data catalog: feeds and oracles
 * register on DataRegistry, broadcast through DataStream, and settle per byte
 * in USDC. There is no token, staking, reputation engine, validator registry,
 * dispute layer or burn — so none of those contracts exist here.
 */
export const contracts = {
  DataRegistry: "0x086990937Cf931e36E01487CD63407f281f1Fc6A" as const,
  // BYTE Library r2 redeploy: bump to the new DataStreamLib address at
  // cut-over (task #7 Phase 6). discovery-api doesn't decode events from
  // this contract — the pin is metadata served via the discovery surface —
  // but the value must be current so consumers reading the published
  // address point at the live contract.
  DataStream: "0x44729bB148F46d8Db509E47b0453edc271e06e95" as const,
  SchemaRegistry: "0x4102BA342A3e9f495bD553D99D1590470C32EE88" as const,
  USDC: "0x1c16659aeb3aE28467E90348fAAB8874a0D3A4d3" as const,
} as const;

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

/** Maps the on-chain status enum to display labels. */
export const STATUS_NAMES = [
  "Unregistered",
  "Sandbox",
  "Active",
  "Suspended",
  "Banned",
] as const;
