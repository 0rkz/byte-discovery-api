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
      "pricePerCall": 3000,
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

## When the catalog cannot be built (fail-closed)

`/discover` and the four routes that read the same catalog
(`/discover/search`, `/discover/:topic`, `/publishers`, `/publisher/:address`)
depend on the x402 gateway's `/feeds` catalog and on per-publisher on-chain
reads. If any of those reads fails, the API does **not** answer with whatever
it managed to collect.

Why: a catalog assembled from a partial set of reads looks exactly like a real
one. On 2026-09-03 a rate-limited gateway made `/discover` advertise
`threat-intel` at 3000 µUSDC while the gateway enforced 50000, drop 7 of 12
feeds, and null every `pricePerCall` — all at HTTP 200, so nothing downstream
could tell. An agent that budgets from those numbers gets a 402 it cannot pay.

What happens instead:

| Situation | Response |
|---|---|
| Every read succeeded | 200, normal body. `degraded`, `degradedReason` and `lastGoodAt` are **absent** |
| A read failed, a previous good catalog exists and is younger than `LAST_GOOD_MAX_AGE_MS` | 200, the **last good** catalog plus the three fields below |
| A read failed, no good catalog yet (e.g. just restarted) — or the last good one is **older than `LAST_GOOD_MAX_AGE_MS`** | **503** with `Retry-After: 10` and `{ "error": "gateway catalog unavailable", "degraded": true, "degradedReason": "…" }` |

Fields present only on a degraded response:

- `degraded` — always `true` when present. Absent, never `false`, on a healthy response.
- `degradedReason` — short cause, e.g. `gateway /feeds 429` or `schema read failed for 0x…`.
- `lastGoodAt` — ISO timestamp of the last fully successful assembly.

A degraded body carries real prices that were correct at `lastGoodAt` — not
placeholders and not guesses. Treat the enforced 402 price as authoritative,
and do not read a feed's absence as a delisting while `degraded` is set.

A degraded body is served for at most `LAST_GOOD_MAX_AGE_MS` (default 15
minutes) after `lastGoodAt`; past that the routes answer 503 rather than
disclose prices that are too old to act on. A degraded body already in the
catalog cache can still be served for up to one `CATALOG_CACHE_TTL_MS` beyond
that age.

A 503 with no last-good catalog is remembered for `CATALOG_FAILURE_CACHE_MS`
(default 2 s): requests inside that window get the same 503 without another
upstream attempt, so a cold start inside a gateway rate-limit window does not
spend one gateway fetch per incoming request.

### Environment

| Variable | Default | What it does |
|---|---|---|
| `X402_GATEWAY` | `http://localhost:3402` | The gateway base **advertised to agents**. Must stay publicly resolvable. |
| `X402_GATEWAY_FETCH` | same as `X402_GATEWAY` | Base used **only** for the server's own `/feeds` fetch. Point it at loopback to keep that fetch off the public rate limit; nothing agents see changes. |
| `GATEWAY_FETCH_TIMEOUT_MS` | `5000` | Deadline for the server's outbound fetches. Must be ≥ 1. |
| `CATALOG_CACHE_TTL_MS` | `10000` | How long one assembled catalog is reused. Concurrent requests share a single assembly. `0` turns the cache off. |
| `LAST_GOOD_MAX_AGE_MS` | `900000` (15 min) | Oldest last-good catalog that is still served as `degraded`. Older → 503. Must be ≥ 1. |
| `CATALOG_FAILURE_CACHE_MS` | `2000` | How long a no-last-good 503 is re-served without retrying the upstreams. `0` turns it off. |

Each of the four `*_MS` values must be a finite number of milliseconds at or
above its floor. An empty value means "not set" (the default applies
silently); anything else that does not parse — `abc`, a negative number, a
`0` where the floor is `1` — falls back to the default and logs one
`[config]` line at start-up naming the variable and the value it rejected.
Before this guard, `GATEWAY_FETCH_TIMEOUT_MS=` in a unit file became a
timeout of `0`, which aborted every fetch and turned the service into a
permanent 503.

### Checking it

```sh
scripts/probe-discover-concurrent.sh http://127.0.0.1:3500 60 10
```

Sends 60 requests at concurrency 10 (bash; the throttle is `xargs -P`, a hard
cap) and prints the count of 200s and 503s. Exit `1` if any 200 carries a non-modal or
degraded catalog; exit `2` if no response was a 200 at all (down, or failing
closed — either way there is no catalog to judge). A sequential check does
not catch the first class: the broken build passed one ~90% of the time.
