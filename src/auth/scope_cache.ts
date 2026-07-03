// Per-isolate API-key auth cache (§6): a module-global map of key_hash → resolved scope. A warm
// isolate authenticates a known key straight from memory; a miss falls through to one indexed D1
// read. Positives-only, short TTL. A revoke/rotate in the same isolate evicts the entry for
// immediate effect; cross-isolate revocation is eventually consistent within the TTL window.
import type { ScopeType } from "../types";

export interface ResolvedScope {
  keyId: string;
  account_id: string;
  scope_type: ScopeType;
  scope_ref: string | null;
}

interface Entry {
  value: ResolvedScope;
  expiresAt: number;
}

const TTL_MS = 60_000;
const MAX_ENTRIES = 1000;
const cache = new Map<string, Entry>();

export function getCachedScope(keyHash: string, now: number): ResolvedScope | null {
  const entry = cache.get(keyHash);
  if (entry === undefined) return null;
  if (entry.expiresAt <= now) {
    cache.delete(keyHash);
    return null;
  }
  return entry.value;
}

export function setCachedScope(
  keyHash: string,
  value: ResolvedScope,
  now: number,
): void {
  if (cache.size >= MAX_ENTRIES && !cache.has(keyHash)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(keyHash, { value, expiresAt: now + TTL_MS });
}

/** Evict a single entry (called on revoke/rotate for immediate same-isolate effect). */
export function evictCachedScope(keyHash: string): void {
  cache.delete(keyHash);
}

/** Test-only: reset the module-global cache between cases. */
export function clearScopeCache(): void {
  cache.clear();
}
