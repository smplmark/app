import { afterEach, describe, expect, it } from "vitest";
import {
  clearScopeCache,
  evictCachedScope,
  getCachedScope,
  setCachedScope,
  type ResolvedScope,
} from "../../src/auth/scope_cache";

const scope = (keyId: string): ResolvedScope => ({
  keyId,
  account_id: "a1",
  scope_type: "ACCOUNT",
  scope_ref: null,
});

afterEach(clearScopeCache);

describe("scope cache", () => {
  it("misses, then hits within the TTL", () => {
    const now = 1000;
    expect(getCachedScope("h1", now)).toBeNull();
    setCachedScope("h1", scope("k1"), now);
    expect(getCachedScope("h1", now + 10)?.keyId).toBe("k1");
  });

  it("expires an entry after the TTL", () => {
    setCachedScope("h2", scope("k2"), 0);
    expect(getCachedScope("h2", 60_001)).toBeNull();
  });

  it("evicts a single entry on demand and clears all", () => {
    setCachedScope("h3", scope("k3"), 0);
    evictCachedScope("h3");
    expect(getCachedScope("h3", 1)).toBeNull();
    setCachedScope("h4", scope("k4"), 0);
    clearScopeCache();
    expect(getCachedScope("h4", 1)).toBeNull();
  });

  it("bounds memory by evicting the oldest entry past the cap", () => {
    for (let i = 0; i < 1000; i++) setCachedScope(`k${i}`, scope(`k${i}`), 0);
    setCachedScope("overflow", scope("overflow"), 0);
    expect(getCachedScope("k0", 1)).toBeNull(); // oldest evicted
    expect(getCachedScope("overflow", 1)?.keyId).toBe("overflow");
  });
});
