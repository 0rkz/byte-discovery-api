import dotenv from "dotenv";
dotenv.config();

/**
 * The x402 gateway's PUBLIC base URL. This value is advertised to agents —
 * it appears in every `endpoints.x402` (feeds.ts), in `access.x402_gateway`
 * and in /.well-known/byte-protocol.json — so it MUST stay publicly
 * resolvable. Never repoint it at loopback to shorten the server-side fetch:
 * that publishes `http://127.0.0.1:3402/feeds/<topic>` to every agent.
 * Use X402_GATEWAY_FETCH below for that.
 */
const X402_GATEWAY = process.env.X402_GATEWAY || "http://localhost:3402";

/** Runtime configuration loaded from environment variables with sensible defaults. */
export const config = {
  port: parseInt(process.env.PORT || "3500", 10),
  rpcUrl: process.env.RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",

  // Public-facing URLs surfaced in /.well-known/byte-protocol.json + /discover.
  // Override via env in production deploys; default to localhost for local dev.
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "https://api.payperbyte.io",
  indexerUrl: process.env.INDEXER_URL || "https://feeds.payperbyte.io",
  marketplaceUrl: process.env.MARKETPLACE_URL || "https://www.payperbyte.io",
  x402Gateway: X402_GATEWAY,

  /**
   * Base URL used ONLY for the server-side `GET /feeds` catalog fetch, never
   * advertised. Defaults to the public base, so behaviour is unchanged until
   * this is explicitly set. Point it at the gateway on loopback
   * (`http://127.0.0.1:3402` — v4 literal, not `localhost`, because the
   * gateway binds v4 only) to take that fetch off the public rate-limit
   * bucket without changing a single URL agents see.
   */
  x402GatewayFetch: process.env.X402_GATEWAY_FETCH || X402_GATEWAY,

  /**
   * Deadline for the server's own outbound fetches (indexer + gateway).
   * Without one, a hung upstream holds a /discover request open until the
   * client gives up, and concurrent requests pile onto the same upstream.
   */
  gatewayFetchTimeoutMs: Number(process.env.GATEWAY_FETCH_TIMEOUT_MS ?? 5000),

  /**
   * How long an assembled catalog stays fresh. Every /discover previously did
   * live RPC reads plus a gateway fetch per request, so a burst rate-limited
   * itself; one shared catalog per window removes that. Also bounds how stale
   * a `degraded` last-good response can be.
   */
  catalogTtlMs: Number(process.env.CATALOG_CACHE_TTL_MS ?? 10_000),

  chainId: 421614,
  chain: "arbitrum-sepolia",

  // Two DISTINCT chains — clients must not conflate them:
  //  • payment  — where USDC settles (x402 "exact" on Base mainnet). This is the
  //    chain a buyer routes funds to; it is the network in every 402 challenge.
  //  • attestation — the consensus-critical EIP-712 "BYTE Library" anchor chain.
  //    Receipts verify against THIS chain/contract regardless of settlement rail.
  payment: {
    network: "eip155:8453",
    chain: "base",
    chainId: 8453,
    asset: "USDC",
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0xffFf4B8Da8C165B556326453446F6940C8AFE0DB",
  },
  attestation: {
    network: "eip155:421614",
    chain: "arbitrum-sepolia",
    chainId: 421614,
    domain: "BYTE Library",
    verifyingContract: "0x44729bB148F46d8Db509E47b0453edc271e06e95",
    note: "chainId 421614 (Arbitrum Sepolia testnet) is a FROZEN EIP-712 signing namespace for receipt signature recovery — NOT a fund rail. USDC settles on Base mainnet (see `payment` above); no funds move on testnet. The chainId stays 421614 regardless of settlement rail so every receipt verifies against the same domain. Mainnet re-anchoring is audit-gated.",
  },

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
