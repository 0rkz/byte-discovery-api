/**
 * Byte Discovery API
 *
 * Machine-readable REST endpoint for AI agents to discover Byte Protocol
 * data feeds, query publisher metadata, and submit quality attestations.
 *
 * @see /.well-known/byte-protocol.json for the standard discovery file.
 */

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { config, contracts } from "./lib/config";
import { getFeeds } from "./lib/feeds";
import {
  getAttestationsForPublisher,
  getAttestationCounts,
  submitAttestation,
} from "./lib/attestations";

// Payload archive served by feed bots' broadcast_helper.py. Key is the
// SHA-256 hash committed on-chain → files named {hash}.json (no 0x prefix).
const PAYLOAD_ARCHIVE_DIR =
  process.env.PAYLOAD_ARCHIVE_DIR || "/home/orkz/byte/data-feeds/archive";

const app = express();
app.use(cors());
app.use(express.json());

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
    name: "Pay-Per-Byte Protocol",
    version: "1.0.0",
    tagline: "The open market for machine intelligence",
    chain: {
      name: "Arbitrum Sepolia",
      chainId: config.chainId,
      type: "testnet",
    },

    value: {
      for_subscribers:
        "Per-byte pricing. No API keys. No contracts. No humans in the loop. Quality scored on-chain.",
      for_publishers:
        "Stake reputation. Earn 35-70% of subscriber fees. PQS score compounds over time.",
      quality_guarantee:
        "PQS reputation scoring + agent attestations + dispute resolution + progressive slashing",
    },

    trust: {
      contracts: 17,
      tests: 516,
      security_audits: ["Slither (clean)", "Mythril (clean)"],
      admin_expiry:
        "Month 13 — enforced by smart contract, not a promise",
      governance:
        "Quadratic voting: sqrt(PPB) × (stakingDays / 365)",
      slashing_schedule: {
        first_offense: "5% stake",
        second_offense: "10% stake",
        third_offense: "25% stake + suspension",
        fabrication: "25% immediate",
        fourth_offense: "100% + permanent ban",
      },
    },

    economics: {
      settlement: "USDC (per-byte, atomic)",
      governance_token: "PPB",
      publisher_take:
        "35% (New) → 42% (Established) → 50% (Trusted) → 60% (Premium) → 70% (Elite)",
      fee_split: {
        publisher: "35-70%",
        validator: "10%",
        dividend_pool: "5%",
        burn_pool: "5%",
        dev_fund: "remainder",
      },
      minimum_fee: "$0.001 USDC per message",
    },

    access: {
      discovery: `${config.publicBaseUrl}/discover`,
      x402_gateway: config.x402Gateway,
      mcp_server: "npx byte-mcp-server",
      indexer_api: config.indexerUrl,
      marketplace: config.marketplaceUrl,
      github: {
        sdk: "https://github.com/0rkz/ppb-sdk",
        mcp: "https://github.com/0rkz/byte-mcp-server",
        x402: "https://github.com/0rkz/byte-x402-gateway",
        discovery: "https://github.com/0rkz/byte-discovery-api",
        cli: "https://github.com/0rkz/ppb-cli",
      },
      community: "https://discord.gg/QtJYR2XZ",
    },

    contracts: {
      DataRegistry: contracts.DataRegistry,
      DataStream: contracts.DataStream,
      SchemaRegistry: contracts.SchemaRegistry,
      PPBToken: contracts.PPBToken,
      TestnetFaucet: contracts.Faucet,
      PQSVerifier: contracts.PQSVerifier,
      AgentAttestation: contracts.AgentAttestation,
    },

    quick_start: {
      step_1: "GET /discover to browse available feeds",
      step_2: "Check PQS scores and attestations for quality",
      step_3: "Subscribe via MCP tool or x402 gateway",
      step_4: "Receive data. Rate quality via attestation.",
      step_5:
        "Better-rated publishers earn more subscribers. The best data wins.",
    },
  });
});

// Main discovery endpoint
app.get("/discover", async (_req, res) => {
  try {
    const counts = getAttestationCounts();
    const discovery = await getFeeds(counts);
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
    const minPQS = parseInt(req.query.minPQS as string) || 0;
    const minMessages = parseInt(req.query.minMessages as string) || 0;
    const tier = (req.query.tier as string || "").toLowerCase();

    const counts = getAttestationCounts();
    const discovery = await getFeeds(counts);

    let filtered = discovery.feeds;

    if (q) {
      filtered = filtered.filter(
        (f) =>
          f.topic.toLowerCase().includes(q) ||
          f.publisher.toLowerCase().includes(q)
      );
    }

    if (minPQS > 0) {
      filtered = filtered.filter((f) => f.pqs >= minPQS);
    }

    if (minMessages > 0) {
      filtered = filtered.filter((f) => f.messages >= minMessages);
    }

    if (tier) {
      filtered = filtered.filter((f) => f.tier.toLowerCase() === tier);
    }

    res.json({
      protocol: "byte",
      query: { q, minPQS, minMessages, tier: tier || undefined },
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
    const counts = getAttestationCounts();
    const discovery = await getFeeds(counts);

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

// Get attestations for a publisher
app.get("/attestations/:publisher", (req, res) => {
  const { publisher } = req.params;
  const attestations = getAttestationsForPublisher(publisher);

  const positive = attestations.filter((a) => a.score >= 7000).length;
  const negative = attestations.length - positive;

  res.json({
    publisher,
    total: attestations.length,
    positive,
    negative,
    average_score:
      attestations.length > 0
        ? Math.round(
            attestations.reduce((sum, a) => sum + a.score, 0) /
              attestations.length
          )
        : null,
    attestations,
  });
});

// Submit attestation
app.post("/attestations", async (req, res) => {
  try {
    const result = await submitAttestation(req.body);

    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.status(201).json({ success: true, message: "Attestation recorded" });
  } catch (err) {
    console.error("Error submitting attestation:", err);
    res.status(500).json({ error: "Failed to process attestation" });
  }
});

// Payload archive — look up a broadcast's full JSON by its on-chain hash.
// Mercat links here from publisher cards to render "latest published" payloads.
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
  console.log(`  /attestations      — Submit/view attestations`);
  console.log(`  /health            — Health check`);
  console.log(`  /.well-known/byte-protocol.json — Agent discovery file`);
});
