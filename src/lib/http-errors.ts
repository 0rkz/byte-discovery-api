import type { Response } from "express";
import { CatalogUnavailableError } from "./feeds.js";

/**
 * Single place every catalog-reading route sends its errors.
 *
 * All five catalog routes (/discover, /discover/search, /discover/:topic,
 * /publishers, /publisher/:address) serve slices of ONE catalog and every one
 * of them exposes prices and `purchasable`. None can answer honestly from the
 * indexer or the chain alone, so the contract has to be uniform: if the
 * catalog could not be assembled and there is no last-good copy, they all say
 * 503, not a 200 built from whatever happened to be reachable.
 *
 * Anything that is not a catalog outage keeps today's 500.
 *
 * Lives in its own module rather than in index.ts so it can be tested
 * directly — requiring index.ts starts a listening server as a side effect.
 */
export function sendCatalogError(
  res: Response,
  err: unknown,
  logLabel: string,
  fallbackMessage: string,
): void {
  if (err instanceof CatalogUnavailableError) {
    res.status(503).set("Retry-After", "10").json({
      error: "gateway catalog unavailable",
      degraded: true,
      degradedReason: err.reason,
    });
    return;
  }
  console.error(logLabel, err);
  res.status(500).json({ error: fallbackMessage });
}
