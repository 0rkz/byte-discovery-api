/**
 * BYTE Library Discovery API
 *
 * Machine-readable REST endpoint for AI agents to discover BYTE Library
 * data feeds and query publisher metadata.
 *
 * @see /.well-known/byte-protocol.json for the standard discovery file.
 */

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { keccak256, toBytes } from "viem";
import { config, contracts } from "./lib/config";
import { getFeeds } from "./lib/feeds";

// Payload archive served by feed bots' broadcast_helper.py. Key is the
// SHA-256 hash committed on-chain → files named {hash}.json (no 0x prefix).
const PAYLOAD_ARCHIVE_DIR =
  process.env.PAYLOAD_ARCHIVE_DIR || "../data-feeds/archive";

const app = express();
app.use(cors());
app.use(express.json());

// ─── defensive headers (security audit: api.payperbyte.io had no HSTS) ──
// Same values the gateway emits via helmet: 1y HSTS incl. subdomains.
// Served behind the Cloudflare tunnel, so the origin header reaches clients.
app.use((_req, res, next) => {
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "byte-discovery-api",
    version: "1.0",
    timestamp: new Date().toISOString(),
  });
});

// Well-known discovery file — comprehensive machine-readable protocol description
app.get("/.well-known/byte-protocol.json", (_req, res) => {
  res.json({
    protocol: "byte",
    name: "BYTE Library",
    version: "1.0.0",
    tagline:
      "Per-byte data for AI agents — pay in USDC, no token, no API keys",
    chain: {
      name: "Arbitrum Sepolia",
      chainId: config.chainId,
      type: "testnet",
    },

    model: {
      summary:
        "BYTE Library is a first-party catalog of data feeds and oracles " +
        "for AI agents. Agents pay per byte in USDC; every broadcast " +
        "commits a content hash on-chain so the data can be verified.",
      for_agents:
        "Discover a feed, pay per byte in USDC, receive verifiable data. " +
        "No accounts, no API keys, no subscriptions, no humans in the loop.",
      trust:
        "Verifiability-first — each broadcast's content hash is committed " +
        "on-chain, so any agent can check the data it paid for against it.",
    },

    economics: {
      settlement: "USDC — per-byte, atomic, on-chain",
      pricing: "Per kilobyte, set per feed (catalog default $0.003/KB)",
      token: "None — BYTE Library has no token",
      commitment: "No API keys, no subscription, no minimum commitment",
    },

    catalog: {
      sections: [
        "Security & trust",
        "Markets",
        "Earth & space",
        "Developer",
        "Knowledge",
      ],
      browse: `${config.publicBaseUrl}/discover`,
    },

    access: {
      discovery: `${config.publicBaseUrl}/discover`,
      x402_gateway: config.x402Gateway,
      mcp_server: "npx byte-mcp-server",
      indexer_api: config.indexerUrl,
      marketplace: config.marketplaceUrl,
    },

    contracts: {
      DataRegistry: contracts.DataRegistry,
      DataStream: contracts.DataStream,
      SchemaRegistry: contracts.SchemaRegistry,
      USDC: contracts.USDC,
    },

    quick_start: {
      step_1: "GET /discover to browse the feed catalog",
      step_2: "Pick a feed; read its price-per-KB and schema",
      step_3:
        "Subscribe and pay per byte in USDC via the MCP tool or x402 gateway",
      step_4: "Receive data with an on-chain content hash you can verify",
    },
  });
});

// Main discovery endpoint
app.get("/discover", async (_req, res) => {
  try {
    const discovery = await getFeeds();
    res.json(discovery);
  } catch (err) {
    console.error("Error fetching feeds:", err);
    res.status(500).json({ error: "Failed to fetch feed data" });
  }
});

// Search feeds
app.get("/discover/search", async (req, res) => {
  try {
    const q = (req.query.q as string || "").toLowerCase();
    const minMessages = parseInt(req.query.minMessages as string) || 0;

    const discovery = await getFeeds();

    let filtered = discovery.feeds;

    if (q) {
      filtered = filtered.filter(
        (f) =>
          f.topic.toLowerCase().includes(q) ||
          f.publisher.toLowerCase().includes(q)
      );
    }

    if (minMessages > 0) {
      filtered = filtered.filter((f) => f.messages >= minMessages);
    }

    res.json({
      protocol: "byte",
      query: { q, minMessages },
      results: filtered.length,
      feeds: filtered,
    });
  } catch (err) {
    console.error("Error searching feeds:", err);
    res.status(500).json({ error: "Failed to search feeds" });
  }
});

// Get specific feed by topic
app.get("/discover/:topic", async (req, res) => {
  try {
    const { topic } = req.params;
    const discovery = await getFeeds();

    const feed = discovery.feeds.find(
      (f) => f.topic.toLowerCase() === topic.toLowerCase()
    );

    if (!feed) {
      res.status(404).json({ error: `Feed not found: ${topic}` });
      return;
    }

    res.json(feed);
  } catch (err) {
    console.error("Error fetching feed:", err);
    res.status(500).json({ error: "Failed to fetch feed data" });
  }
});

// Publisher directory — the publisher-centric view of the same data /discover
// exposes feed-first. Agents that look a publisher up directly land here
// instead of 404ing.
app.get("/publishers", async (_req, res) => {
  try {
    const discovery = await getFeeds();
    res.json({
      protocol: "byte",
      count: discovery.feeds.length,
      publishers: discovery.feeds,
    });
  } catch (err) {
    console.error("Error fetching publishers:", err);
    res.status(500).json({ error: "Failed to fetch publisher data" });
  }
});

// Single publisher by address — feed metadata and on-chain stats.
app.get("/publisher/:address", async (req, res) => {
  try {
    const { address } = req.params;
    const discovery = await getFeeds();

    const publisher = discovery.feeds.find(
      (f) => f.publisher.toLowerCase() === address.toLowerCase()
    );

    if (!publisher) {
      res.status(404).json({ error: `Publisher not found: ${address}` });
      return;
    }

    res.json(publisher);
  } catch (err) {
    console.error("Error fetching publisher:", err);
    res.status(500).json({ error: "Failed to fetch publisher data" });
  }
});

// Payload archive — look up a broadcast's full JSON by its on-chain hash.
// Mercat links here from publisher cards to render "latest published" payloads.
//
// r2 defense-in-depth: when served, re-derive keccak256 over the canonical
// payload bytes and log a warning on mismatch. Bytes are still served (a
// false-positive caused by a canonicalization quirk would otherwise break
// production); the warning surfaces archive-corruption signal without
// breaking consumers. The subscriber-side SDK verifyPayload is the
// authoritative check.
app.get("/payload/:hash", (req, res) => {
  const raw = (req.params.hash || "").toLowerCase();
  const hash = raw.startsWith("0x") ? raw.slice(2) : raw;

  // Hash must be exactly 64 hex chars — guards against path traversal.
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    res.status(400).json({ error: "Invalid payload hash format" });
    return;
  }

  const filePath = path.join(PAYLOAD_ARCHIVE_DIR, `${hash}.json`);
  try {
    const body = fs.readFileSync(filePath, "utf8");
    try {
      const envelope = JSON.parse(body);
      const canonical = JSON.stringify(envelope.payload);
      const derived = keccak256(toBytes(canonical)).slice(2).toLowerCase();
      if (derived !== hash) {
        console.warn(
          `[archive] hash drift for ${hash}: derived=${derived} (may be canonicalization, not corruption)`,
        );
      }
    } catch {
      // Verification is best-effort observability; never break the read path.
    }
    res.setHeader("Content-Type", "application/json");
    res.send(body);
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      res.status(404).json({
        error: "Payload not in archive",
        hint: "Archive only contains payloads broadcast AFTER 2026-04-24 18:05 UTC",
      });
      return;
    }
    console.error("Payload read error:", err);
    res.status(500).json({ error: "Failed to read payload" });
  }
});

// Recent payloads across all publishers — mtime-sorted, most recent first.
// Lightweight: returns hash + sidecar metadata only (no payload body).
app.get("/payloads/recent", (req, res) => {
  const limit = Math.min(parseInt((req.query.limit as string) || "50", 10), 200);
  try {
    if (!fs.existsSync(PAYLOAD_ARCHIVE_DIR)) {
      res.json({ count: 0, payloads: [] });
      return;
    }
    const files = fs
      .readdirSync(PAYLOAD_ARCHIVE_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const full = path.join(PAYLOAD_ARCHIVE_DIR, f);
        return { file: f, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);

    const payloads = files.map(({ file }) => {
      const body = JSON.parse(
        fs.readFileSync(path.join(PAYLOAD_ARCHIVE_DIR, file), "utf8"),
      );
      return {
        payload_hash: body.payload_hash,
        payload_length: body.payload_length,
        publisher: body.publisher,
        subscriber_count: body.subscriber_count,
        tx_hash: body.tx_hash,
        archived_at: body.archived_at,
        feed: body.payload?.feed,
      };
    });

    res.json({ count: payloads.length, payloads });
  } catch (err) {
    console.error("Recent payloads error:", err);
    res.status(500).json({ error: "Failed to list payloads" });
  }
});

// Filter recent payloads for a specific publisher address.
app.get("/payloads/publisher/:address", (req, res) => {
  const target = req.params.address.toLowerCase();
  const limit = Math.min(parseInt((req.query.limit as string) || "20", 10), 100);

  try {
    if (!fs.existsSync(PAYLOAD_ARCHIVE_DIR)) {
      res.json({ count: 0, payloads: [] });
      return;
    }
    const files = fs
      .readdirSync(PAYLOAD_ARCHIVE_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const full = path.join(PAYLOAD_ARCHIVE_DIR, f);
        return { file: f, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    const matches: any[] = [];
    for (const { file } of files) {
      if (matches.length >= limit) break;
      const body = JSON.parse(
        fs.readFileSync(path.join(PAYLOAD_ARCHIVE_DIR, file), "utf8"),
      );
      if ((body.publisher || "").toLowerCase() === target) {
        matches.push({
          payload_hash: body.payload_hash,
          payload_length: body.payload_length,
          subscriber_count: body.subscriber_count,
          tx_hash: body.tx_hash,
          archived_at: body.archived_at,
          feed: body.payload?.feed,
          payload: body.payload,
        });
      }
    }

    res.json({ count: matches.length, payloads: matches });
  } catch (err) {
    console.error("Publisher payloads error:", err);
    res.status(500).json({ error: "Failed to list publisher payloads" });
  }
});

app.listen(config.port, () => {
  console.log(`Byte Discovery API running on port ${config.port}`);
  console.log(`  /discover          — Browse all feeds`);
  console.log(`  /discover/search   — Search feeds`);
  console.log(`  /discover/:topic   — Get feed by topic`);
  console.log(`  /publishers        — Publisher directory`);
  console.log(`  /publisher/:addr   — Get publisher by address`);
  console.log(`  /health            — Health check`);
  console.log(`  /.well-known/byte-protocol.json — Agent discovery file`);
});
