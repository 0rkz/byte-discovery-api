/**
 * Attestation system for publisher quality.
 *
 * AI agents can submit signed attestations rating the quality of a data
 * publisher. Signatures are verified using EIP-191 (viem's verifyMessage)
 * and attestations are rate-limited to one per agent per publisher per 24h.
 */

import { verifyMessage, keccak256, toBytes } from "viem";
import * as fs from "fs";
import * as path from "path";

/** File path for persistent attestation storage. */
const ATTESTATION_FILE = path.resolve(__dirname, "../../data/attestations.json");

/** Rate limit window: one attestation per agent per publisher per 24 hours. */
const RATE_LIMIT_MS = 24 * 60 * 60 * 1000;

/** A signed quality attestation submitted by an AI agent about a publisher. */
export interface Attestation {
  publisher: string;
  score: number;
  accuracy: number;
  latency_ms: number;
  uptime_pct: number;
  evidence: string;
  agent_address: string;
  signature: string;
  timestamp: number;
}

/** Load all attestations from disk, returning an empty array if the file is missing. */
function loadAttestations(): Attestation[] {
  try {
    const data = fs.readFileSync(ATTESTATION_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

/** Persist the full attestation array to disk, creating the data directory if needed. */
function saveAttestations(attestations: Attestation[]): void {
  const dir = path.dirname(ATTESTATION_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(ATTESTATION_FILE, JSON.stringify(attestations, null, 2));
}

/** Return all attestations for a given publisher address (case-insensitive). */
export function getAttestationsForPublisher(publisher: string): Attestation[] {
  const all = loadAttestations();
  return all.filter(
    (a) => a.publisher.toLowerCase() === publisher.toLowerCase()
  );
}

/** Compute positive/negative attestation counts per publisher across all stored attestations. */
export function getAttestationCounts(): Map<
  string,
  { positive: number; negative: number }
> {
  const all = loadAttestations();
  const counts = new Map<string, { positive: number; negative: number }>();

  for (const att of all) {
    const key = att.publisher.toLowerCase();
    const existing = counts.get(key) || { positive: 0, negative: 0 };
    // Score >= 7000 = positive, < 7000 = negative
    if (att.score >= 7000) {
      existing.positive++;
    } else {
      existing.negative++;
    }
    counts.set(key, existing);
  }

  return counts;
}

/**
 * Validate, verify, and store a new attestation.
 *
 * Verification: the agent signs `keccak256(publisher + score + timestamp)`.
 * The server accepts any timestamp within a 5-minute window of the current time.
 * Rate limit: one attestation per agent per publisher per 24 hours.
 */
export async function submitAttestation(body: {
  publisher: string;
  score: number;
  accuracy: number;
  latency_ms: number;
  uptime_pct: number;
  evidence: string;
  agent_address: string;
  signature: string;
}): Promise<{ success: boolean; error?: string }> {
  const {
    publisher,
    score,
    accuracy,
    latency_ms,
    uptime_pct,
    evidence,
    agent_address,
    signature,
  } = body;

  // Validate required fields
  if (!publisher || !agent_address || !signature) {
    return { success: false, error: "Missing required fields: publisher, agent_address, signature" };
  }

  if (typeof score !== "number" || score < 0 || score > 10000) {
    return { success: false, error: "Score must be a number between 0 and 10000" };
  }

  // Verify signature
  const timestamp = Math.floor(Date.now() / 1000);
  // Agent signs: keccak256(publisher + score + timestamp)
  // We accept timestamps within a 5 minute window
  let verified = false;
  for (let t = timestamp - 300; t <= timestamp; t++) {
    const message = keccak256(
      toBytes(`${publisher.toLowerCase()}${score}${t}`)
    );
    try {
      const valid = await verifyMessage({
        address: agent_address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });
      if (valid) {
        verified = true;
        break;
      }
    } catch {
      // Try next timestamp
    }
  }

  if (!verified) {
    return { success: false, error: "Invalid signature" };
  }

  // Rate limit check: 1 attestation per agent per publisher per 24h
  const all = loadAttestations();
  const now = Date.now();
  const existing = all.find(
    (a) =>
      a.agent_address.toLowerCase() === agent_address.toLowerCase() &&
      a.publisher.toLowerCase() === publisher.toLowerCase() &&
      now - a.timestamp < RATE_LIMIT_MS
  );

  if (existing) {
    return {
      success: false,
      error: "Rate limited: 1 attestation per agent per publisher per 24h",
    };
  }

  // Store attestation
  const attestation: Attestation = {
    publisher,
    score,
    accuracy: accuracy || 0,
    latency_ms: latency_ms || 0,
    uptime_pct: uptime_pct || 0,
    evidence: evidence || "",
    agent_address,
    signature,
    timestamp: now,
  };

  all.push(attestation);
  saveAttestations(all);

  return { success: true };
}
