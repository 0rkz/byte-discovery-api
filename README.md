# Byte Discovery API

Machine-readable discovery endpoint for AI agents to find, evaluate, and subscribe to Byte Protocol data feeds.

Agents hit `/.well-known/byte-protocol.json` to bootstrap -- it returns every contract address, endpoint URL, and capability they need. From there, `/discover` lists all active feeds with quality scores, pricing, and attestation summaries.

## The `.well-known/byte-protocol.json` Standard

Byte Protocol publishers and discovery nodes serve a static JSON file at the well-known path `/.well-known/byte-protocol.json`. AI agents can fetch this single URL to learn everything about a Byte node:

```jsonc
{
  "protocol": "byte",
  "version": "1.0",
  "name": "Byte Protocol Discovery",
  "description": "Decentralized machine-to-machine data marketplace. Query /discover for available feeds.",
  "chain": "arbitrum-sepolia",
  "chainId": 421614,
  "contracts": {
    "DataRegistry": "0x05D8...",
    "DataStream": "0x7E12...",
    "SchemaRegistry": "0x2e49...",
    "PQSVerifier": "0x67F9..."
  },
  "endpoints": {
    "discover": "/discover",
    "search": "/discover/search",
    "attestations": "/attestations",
    "health": "/health"
  },
  "access": {
    "x402_gateway": "http://localhost:3402",
    "mcp_server": "npx byte-mcp-server",
    "indexer_api": "http://localhost:8080",
    "faucet": "0x19d2..."
  },
  "documentation": "https://docs.byteprotocol.io",
  "spec": "https://github.com/byte-protocol/spec"
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

List all active data feeds with publisher metadata, PQS (Publisher Quality Score), pricing, and attestation summaries.

```json
{
  "protocol": "byte",
  "version": "1.0",
  "chain": "arbitrum-sepolia",
  "chainId": 421614,
  "totalPublishers": 3,
  "totalMessages": 14500,
  "feeds": [
    {
      "publisher": "0xABC...",
      "topic": "weather/us/hourly",
      "description": "Hourly US weather observations from 500+ stations",
      "tier": "Gold",
      "pqs": 9200,
      "pricePerKB": 500,
      "frequency": 3600,
      "subscribers": 12,
      "messages": 8400,
      "attestations": { "positive": 5, "negative": 0, "total": 5 },
      "endpoints": {
        "x402": "http://localhost:3402/feeds/weather/us/hourly",
        "mcp": "byte_subscribe",
        "onchain": "0x7E12..."
      }
    }
  ],
  "access": {
    "x402_gateway": "http://localhost:3402",
    "mcp_server": "npx byte-mcp-server",
    "indexer_api": "http://localhost:8080",
    "faucet": "0x19d2..."
  }
}
```

### `GET /discover/search`

Search and filter feeds.

| Query param   | Type   | Description                        |
|---------------|--------|------------------------------------|
| `q`           | string | Full-text search on topic, description, publisher |
| `minPQS`      | number | Minimum PQS score (0-10000)        |
| `minMessages` | number | Minimum message count              |
| `tier`        | string | Exact tier match (`Gold`, `Silver`, `Bronze`, `New`) |

```
GET /discover/search?q=weather&minPQS=8000&tier=gold
```

```json
{
  "protocol": "byte",
  "query": { "q": "weather", "minPQS": 8000, "minMessages": 0, "tier": "gold" },
  "results": 1,
  "feeds": [ ... ]
}
```

### `GET /discover/:topic`

Get a single feed by topic name.

```
GET /discover/weather/us/hourly
```

Returns the feed object or `404` if not found.

### `GET /attestations/:publisher`

Get all attestations for a publisher address.

```json
{
  "publisher": "0xABC...",
  "total": 5,
  "positive": 5,
  "negative": 0,
  "average_score": 9100,
  "attestations": [
    {
      "publisher": "0xABC...",
      "score": 9200,
      "accuracy": 95,
      "latency_ms": 120,
      "uptime_pct": 99,
      "evidence": "Sampled 100 messages, 95 matched schema",
      "agent_address": "0xDEF...",
      "signature": "0x...",
      "timestamp": 1694793600000
    }
  ]
}
```

### `POST /attestations`

Submit a signed quality attestation for a publisher.

**Request body:**

```json
{
  "publisher": "0xABC...",
  "score": 9200,
  "accuracy": 95,
  "latency_ms": 120,
  "uptime_pct": 99,
  "evidence": "Sampled 100 messages, 95 matched schema",
  "agent_address": "0xDEF...",
  "signature": "0x..."
}
```

**Signature verification:**

The agent must sign the following message using EIP-191 (`personal_sign`):

```
keccak256(publisherAddress + score + timestamp)
```

Where `publisherAddress` is lowercased, `score` is the numeric value, and `timestamp` is the current Unix epoch in seconds. The server accepts timestamps within a 5-minute window.

**Rate limiting:** One attestation per agent per publisher per 24 hours.

**Scoring:** Scores range from 0-10000 (basis points). A score >= 7000 counts as positive; below 7000 counts as negative.

## Attestation System

The attestation system provides a decentralized reputation layer for data publishers:

1. **Agents evaluate publishers** by subscribing to feeds and measuring quality metrics (accuracy, latency, uptime).
2. **Agents sign attestations** using their wallet, binding their identity to the rating.
3. **Attestations are aggregated** into positive/negative counts displayed alongside each feed in `/discover`.
4. **Rate limiting** prevents spam -- each agent can only attest once per publisher per 24-hour window.

This creates a feedback loop where high-quality publishers surface to the top and agents can make informed subscription decisions.

## Installation

```bash
git clone https://github.com/byte-protocol/discovery-api.git
cd discovery-api
npm install
```

## Configuration

Copy the example environment file and edit as needed:

```bash
cp .env.example .env
```

### Environment Variables

| Variable       | Default                                   | Description                          |
|----------------|-------------------------------------------|--------------------------------------|
| `PORT`         | `3500`                                    | HTTP server port                     |
| `RPC_URL`      | `https://sepolia-rollup.arbitrum.io/rpc`  | Arbitrum Sepolia JSON-RPC endpoint   |
| `INDEXER_URL`  | `http://localhost:8080`                   | Byte Protocol indexer API URL        |
| `X402_GATEWAY` | `http://localhost:3402`                   | x402 payment gateway URL             |

## Build and Run

```bash
# Build
npm run build

# Production
npm start

# Development (ts-node)
npm run dev
```

The API starts on `http://localhost:3500` by default.

## How It Works

The Discovery API aggregates data from two sources:

1. **Byte Indexer** (preferred) -- queries the indexer API for a list of registered publishers and their metadata.
2. **On-chain fallback** -- if the indexer is unavailable, enumerates publishers directly from the `DataRegistry` contract on Arbitrum Sepolia.

Each publisher is enriched with:
- **PQS (Publisher Quality Score)** from the `PQSVerifier` contract (0-10000 scale)
- **Tier classification** (`Gold`, `Silver`, `Bronze`, `New`) from `PQSVerifier`
- **Subscriber and message counts** from the `DataStream` contract
- **Attestation summaries** from locally stored agent attestations

## License

MIT
