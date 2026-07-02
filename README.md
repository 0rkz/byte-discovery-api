# Byte Discovery API

Machine-readable discovery endpoint for AI agents to find, evaluate, and subscribe to verified Byte Protocol data feeds.

Agents hit `/.well-known/byte-protocol.json` to bootstrap -- it returns every contract address, endpoint URL, and capability they need. From there, `/discover` lists all active feeds with pricing, subscriber/message counts, and provenance labels.

The public deployment of this service runs at **`https://api.payperbyte.io`** (`/discover`, `/.well-known/byte-protocol.json`, `/health`). Payments settle in **USDC on Base mainnet** (`eip155:8453`) via the x402 gateway at `https://x402.payperbyte.io`. Chain ID `421614` (Arbitrum Sepolia) appears throughout as the frozen EIP-712 attestation/registry namespace -- it is a signing namespace, **not** the payment rail; see the `payment` vs `attestation` blocks in the live `/discover` response.

## The `.well-known/byte-protocol.json` Standard

Byte Protocol publishers and discovery nodes serve a static JSON file at the well-known path `/.well-known/byte-protocol.json`. AI agents can fetch this single URL to learn everything about a Byte node:

```jsonc
// Abridged from the live file at https://api.payperbyte.io/.well-known/byte-protocol.json
{
  "protocol": "byte",
  "name": "BYTE Library",
  "version": "1.0.0",
  "tagline": "Per-byte data for AI agents — pay in USDC, no token, no API keys",
  // 421614 is the frozen EIP-712 attestation/registry namespace (Arbitrum Sepolia
  // testnet), NOT the payment rail — x402 USDC payments settle on Base mainnet
  // (eip155:8453); see the `payment` block in /discover.
  "chain": { "name": "Arbitrum Sepolia", "chainId": 421614, "type": "testnet" },
  "catalog": {
    "sections": ["Security & trust", "Markets", "Earth & space", "Developer", "Knowledge"],
    "browse": "https://api.payperbyte.io/discover"
  },
  "access": {
    "discovery": "https://api.payperbyte.io/discover",
    "x402_gateway": "https://x402.payperbyte.io",
    "mcp_server": "npx byte-mcp-server",
    "indexer_api": "https://feeds.payperbyte.io",
    "marketplace": "https://www.payperbyte.io"
  },
  "contracts": {
    "DataRegistry": "0x086990937Cf931e36E01487CD63407f281f1Fc6A",
    "DataStream": "0x44729bB148F46d8Db509E47b0453edc271e06e95",
    "SchemaRegistry": "0x4102BA342A3e9f495bD553D99D1590470C32EE88",
    "USDC": "0x1c16659aeb3aE28467E90348fAAB8874a0D3A4d3"
  }
  // ...plus `model`, `economics`, and `quick_start` blocks — fetch the live URL
  // above for the full manifest.
}
```

This gives an agent everything it needs: contract addresses to interact on-chain, REST endpoints for off-chain queries, and access methods (x402 payment gateway, MCP server, indexer).

## Endpoints

### `GET /health`

Health check.

```json
{
  "status": "ok",
  "service": "byte-discovery-api",
  "version": "1.0",
  "timestamp": "2025-09-15T12:00:00.000Z"
}
```

### `GET /.well-known/byte-protocol.json`

Standard discovery file (see above).

### `GET /discover`

List all active data feeds with publisher metadata, pricing, and provenance labels. The response carries two distinct chain blocks: `payment` (where USDC settles — Base mainnet) and `attestation` (the frozen EIP-712 signing namespace — chain 421614).

```jsonc
// Abridged from the live response at https://api.payperbyte.io/discover
{
  "protocol": "byte",
  "version": "1.0",
  "chain": "arbitrum-sepolia",
  "chainId": 421614,
  "payment": {
    "network": "eip155:8453",
    "chain": "base",
    "chainId": 8453,
    "asset": "USDC"
  },
  "attestation": {
    "network": "eip155:421614",
    "chain": "arbitrum-sepolia",
    "chainId": 421614,
    "domain": "BYTE Library",
    "verifyingContract": "0x44729bB148F46d8Db509E47b0453edc271e06e95"
  },
  "totalFeeds": 22,
  "totalMessages": 44236,
  "feeds": [
    {
      "publisher": "0xa820763c023a929e83c59e4fd5a623e5a8efe941",
      "topic": "weather",
      "pricePerKB": 3000,
      "frequencySeconds": 3600,
      "subscribers": 2,
      "messages": 680,
      "provenance": "eip712-attested",
      "onchain": "0xa820763c023a929e83c59e4fd5a623e5a8efe941",
      "endpoints": {
        "mcp": "byte_buy_data",
        "onchain": "0x44729bB148F46d8Db509E47b0453edc271e06e95",
        "x402": "https://x402.payperbyte.io/feeds/weather"
      }
    }
  ],
  "access": {
    "x402_gateway": "https://x402.payperbyte.io",
    "mcp_server": "https://mcp.payperbyte.io/mcp",
    "indexer_api": "https://feeds.payperbyte.io"
  }
}
```

### `GET /discover/search`

Search and filter feeds.

| Query param   | Type   | Description                        |
|---------------|--------|------------------------------------|
| `q`           | string | Full-text search on topic, description, publisher |
| `minMessages` | number | Minimum message count              |

```
GET /discover/search?q=weather&minMessages=100
```

```json
{
  "protocol": "byte",
  "query": { "q": "weather", "minMessages": 100 },
  "results": 2,
  "feeds": [ ... ]
}
```

### `GET /discover/:topic`

Get a single feed by topic name.

```
GET /discover/weather/us/hourly
```

Returns the feed object or `404` if not found.

### Attestation routes (not implemented)

Earlier drafts of this README documented `GET /attestations/:publisher` and `POST /attestations` routes for agent-signed publisher ratings. Those routes are **not implemented** in the current code (`src/index.ts`) and return 404 on the live deployment -- do not build against them. Payload verification instead uses the EIP-712 `PayloadAttestation` scheme (domain `BYTE Library`, chain 421614) described in `/discover`'s `attestation` block, and each feed carries a `provenance` label.

## Installation

```bash
git clone https://github.com/0rkz/byte-discovery-api.git
cd byte-discovery-api
npm install
```

## Configuration

Copy the example environment file and edit as needed:

```bash
cp .env.example .env
```

### Environment Variables

| Variable          | Default                                   | Description                          |
|-------------------|-------------------------------------------|--------------------------------------|
| `PORT`            | `3500`                                    | HTTP server port                     |
| `RPC_URL`         | `https://sepolia-rollup.arbitrum.io/rpc`  | Arbitrum Sepolia JSON-RPC endpoint (registry/attestation chain -- used for on-chain fallback reads, **not** the payment rail) |
| `PUBLIC_BASE_URL` | `https://api.payperbyte.io`               | Public base URL surfaced in `/.well-known` + `/discover` |
| `INDEXER_URL`     | `https://feeds.payperbyte.io`             | Indexer API URL                      |
| `MARKETPLACE_URL` | `https://www.payperbyte.io`               | Marketplace site URL                 |
| `X402_GATEWAY`    | `http://localhost:3402` (local dev)       | x402 payment gateway URL -- the production deploy sets `https://x402.payperbyte.io` |

## Build and Run

```bash
# Build
npm run build

# Production
npm start

# Development (ts-node)
npm run dev
```

The API starts on `http://localhost:3500` by default (local dev). The public deployment of this service is served at `https://api.payperbyte.io`.

## How It Works

The Discovery API aggregates data from two sources:

1. **Byte Indexer** (preferred) -- queries the indexer API for a list of registered publishers and their metadata.
2. **On-chain fallback** -- if the indexer is unavailable, enumerates publishers directly from the `DataRegistry` contract on Arbitrum Sepolia.

Each feed is enriched with:
- **Subscriber and message counts** from the indexer (or the on-chain registry on fallback)
- **A `provenance` label** (e.g. `eip712-attested`, `first-party`) as advertised by the gateway -- a statement of who signed the exact bytes, not of data correctness

## License

MIT
