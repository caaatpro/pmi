/**
 * Unified Freshness Gate (Phase 3a)
 *
 * Replaces withFreshObservations() as the public API for all retrieval
 * surfaces: checks the observation generation counter so the Orama index is
 * up-to-date before any read. (Mini-skills, once a second indexed source, are
 * ordinary coding_convention observations since Baton migration baton-5.)
 *
 * withFreshObservations() remains in observations.ts as @internal —
 * only called by this module and legacy test code.
 */

import { ensureFreshObservations } from './observations.js';

/**
 * Ensure observations are fresh in the Orama index.
 * Returns true if the index was refreshed.
 */
export async function ensureFreshIndex(options: { loadCorpus?: boolean } = {}): Promise<boolean> {
  return ensureFreshObservations(options);
}

/**
 * Centralized freshness gate — wraps a read-facing function with
 * ensureFreshIndex() so callers cannot forget the freshness check.
 *
 * Usage:
 *   return withFreshIndex(async () => { ... read from Orama ... });
 *
 * Phase 3a: replaces withFreshObservations() at all retrieval call sites.
 */
export async function withFreshIndex<T>(
  fn: () => T | Promise<T>,
  options: { loadCorpus?: boolean } = {},
): Promise<T> {
  await ensureFreshIndex(options);
  return fn();
}
