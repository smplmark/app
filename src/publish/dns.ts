// Domain-ownership verification over DNS-over-HTTPS (Workers can't do raw DNS). We ask Cloudflare's
// public DoH resolver for a domain's TXT records and look for the challenge token the user was told to
// publish. The token is public by design — it proves control of the domain, it is not a secret.
import { randomToken } from "../auth/crypto";

/** The prefix of every challenge value; the full token is what the user adds to DNS as a TXT record. */
export const VERIFICATION_TOKEN_PREFIX = "smplmark-verify=";

/**
 * The namespaced subdomain the challenge TXT record may also live on: `_smplmark-verify.<domain>`.
 * Writing a record here requires the same whole-zone control as the apex, so it proves ownership just
 * as well — while sidestepping apex-TXT quirks (e.g. Route 53 treating a literal "@" as a hostname).
 * We accept the token at the apex OR here; we deliberately do NOT accept it at an arbitrary subdomain,
 * since a subdomain can be delegated to a tenant who does not control the parent zone.
 */
export const VERIFICATION_SUBDOMAIN_PREFIX = "_smplmark-verify";

/** The DNS names a domain's challenge token may be published on: the root and the namespaced prefix. */
export function verificationNames(domain: string): string[] {
  return [domain, `${VERIFICATION_SUBDOMAIN_PREFIX}.${domain}`];
}

/** Mint a fresh, per-claim challenge token, e.g. "smplmark-verify=<random>". */
export function generateVerificationToken(): string {
  return VERIFICATION_TOKEN_PREFIX + randomToken(18);
}

/** Unwrap DoH TXT rdata: one or more quoted strings, concatenated (chunked records join). */
function unquoteTxt(data: string): string {
  const parts = data.match(/"(?:[^"\\]|\\.)*"/g);
  if (parts) return parts.map((p) => p.slice(1, -1).replace(/\\"/g, '"')).join("");
  return data;
}

/**
 * The TXT record values for a domain, via Cloudflare DoH. Throws on a network error or non-2xx
 * response so callers can distinguish "the check failed" (leave state untouched) from "resolved, no
 * matching record" (a genuine miss). A domain that resolves with no TXT records returns [].
 */
export async function lookupTxt(domain: string): Promise<string[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=TXT`;
  const res = await fetch(url, { headers: { Accept: "application/dns-json" } });
  if (!res.ok) {
    throw new Error(`DoH lookup for ${domain} failed with status ${res.status}`);
  }
  const body = (await res.json()) as { Answer?: { type?: number; data?: string }[] };
  const answers = body.Answer ?? [];
  return answers
    .filter((a): a is { type: number; data: string } => a.type === 16 && typeof a.data === "string")
    .map((a) => unquoteTxt(a.data));
}

/**
 * True if the challenge token appears in any of the given TXT record values. Deliberately forgiving:
 * a substring match over each trimmed value, so it tolerates surrounding whitespace and the wrapping
 * quotes some DNS consoles keep. Safe because the token is high-entropy and only ever shown to the
 * account that requested the check — so its presence anywhere in a record we trust proves control.
 */
export function txtRecordsContain(values: string[], token: string): boolean {
  const needle = token.trim();
  if (!needle) return false;
  return values.some((v) => v.trim().includes(needle));
}

/**
 * Whether the domain publishes its challenge token — checked at BOTH the apex and the
 * `_smplmark-verify.<domain>` subdomain (either proves whole-zone control). The two DoH queries run
 * concurrently. Resolution semantics preserve "never lapse on ambiguity": the token being found wins;
 * if it isn't found and any query failed (network/resolver), we throw so the caller leaves state
 * untouched rather than treating an inconclusive check as a genuine miss.
 */
export async function domainHasVerificationToken(domain: string, token: string): Promise<boolean> {
  const results = await Promise.allSettled(verificationNames(domain).map((name) => lookupTxt(name)));
  for (const r of results) {
    if (r.status === "fulfilled" && txtRecordsContain(r.value, token)) return true;
  }
  if (results.some((r) => r.status === "rejected")) {
    throw new Error(`DoH lookup for ${domain} was inconclusive (a resolver query failed)`);
  }
  return false;
}
