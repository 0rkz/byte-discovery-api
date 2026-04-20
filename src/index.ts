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
import { config, contracts } from "./lib/config";
import { getFeeds } from "./lib/feeds";
import {
  getAttestationsForPublisher,
  getAttestationCounts,
  submitAttestation,
} from "./lib/attestations";

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

// Well-known discovery file
app.get("/.well-known/byte-protocol.json", (_req, res) => {
  res.json({
    protocol: "byte",
    version: "1.0",
    name: "Byte Protocol Discovery",
    description:
      "Decentralized machine-to-machine data marketplace. Query /discover for available feeds.",
    chain: config.chain,
    chainId: config.chainId,
    contracts: {
      DataRegistry: contracts.DataRegistry,
      DataStream: contracts.DataStream,
      SchemaRegistry: contracts.SchemaRegistry,
      PQSVerifier: contracts.PQSVerifier,
    },
    endpoints: {
      discover: "/discover",
      search: "/discover/search",
      attestations: "/attestations",
      health: "/health",
    },
    access: {
      x402_gateway: config.x402Gateway,
      mcp_server: "npx byte-mcp-server",
      indexer_api: config.indexerUrl,
      faucet: contracts.Faucet,
    },
    documentation: "https://docs.byteprotocol.io",
    spec: "https://github.com/byte-protocol/spec",
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
          f.description.toLowerCase().includes(q) ||
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

app.listen(config.port, () => {
  console.log(`Byte Discovery API running on port ${config.port}`);
  console.log(`  /discover          — Browse all feeds`);
  console.log(`  /discover/search   — Search feeds`);
  console.log(`  /discover/:topic   — Get feed by topic`);
  console.log(`  /attestations      — Submit/view attestations`);
  console.log(`  /health            — Health check`);
  console.log(`  /.well-known/byte-protocol.json — Agent discovery file`);
});
