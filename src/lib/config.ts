import dotenv from "dotenv";
dotenv.config();

/** Runtime configuration loaded from environment variables with sensible defaults. */
export const config = {
  port: parseInt(process.env.PORT || "3500", 10),
  rpcUrl: process.env.RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",
  indexerUrl: process.env.INDEXER_URL || "http://localhost:8080",
  x402Gateway: process.env.X402_GATEWAY || "http://localhost:3402",
  chainId: 421614,
  chain: "arbitrum-sepolia",
} as const;

/** Deployed Byte Protocol contract addresses on Arbitrum Sepolia. */
export const contracts = {
  DataRegistry: "0x05D89769A066549115b1B4408bFf899D2737F30b" as const,
  DataStream: "0x7E12bF2B0d43B9Ea0Bc37A06EcAC36b810351F35" as const,
  SchemaRegistry: "0x2e490F33180F3d387d46c213ADf776135c052acf" as const,
  PQSVerifier: "0x67F97fc5E45889d3BFf7dcBA114Ca210f1896b0d" as const,
  Faucet: "0x19d25F286b8Dca21886bCBe9c21334C6F0C532FB" as const,
} as const;

/** Minimal ABI for reading publisher quality scores from PQSVerifier. */
export const PQSVerifierABI = [
  {
    inputs: [{ name: "publisher", type: "address" }],
    name: "getPublisherScore",
    outputs: [{ name: "score", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "publisher", type: "address" }],
    name: "getPublisherTier",
    outputs: [{ name: "tier", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/** Minimal ABI for reading publisher metadata from DataRegistry. */
export const DataRegistryABI = [
  {
    inputs: [{ name: "publisher", type: "address" }],
    name: "getPublisherInfo",
    outputs: [
      { name: "topic", type: "string" },
      { name: "description", type: "string" },
      { name: "pricePerKB", type: "uint256" },
      { name: "frequency", type: "uint256" },
      { name: "active", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getPublisherCount",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "index", type: "uint256" }],
    name: "getPublisherByIndex",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/** Minimal ABI for reading subscriber/message counts from DataStream. */
export const DataStreamABI = [
  {
    inputs: [{ name: "publisher", type: "address" }],
    name: "getSubscriberCount",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "publisher", type: "address" }],
    name: "getMessageCount",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
