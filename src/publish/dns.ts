// Domain-ownership verification over DNS-over-HTTPS (Workers can't do raw DNS). We ask Cloudflare's
// public DoH resolver for a domain's TXT records and look for the challenge token the user was told to
// publish. The token is public by design — it proves control of the domain, it is not a secret.
import { randomToken } from "../auth/crypto";

/** The prefix of every challenge value; the full token is what the user adds to DNS as a TXT record. */
export const VERIFICATION_TOKEN_PREFIX = "smplmark-verify=";

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

/** True if any TXT record exactly equals the expected challenge token. */
export function txtRecordsContain(values: string[], token: string): boolean {
  return values.includes(token);
}
