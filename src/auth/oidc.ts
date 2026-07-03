// OIDC (Google + Microsoft), adapted from smplkit's flow to Workers. Discovery is fetched per
// provider and cached per-isolate. The id_token is verified with jose against the provider JWKS
// (RS256, audience=client_id; issuer checked for Google, skipped for Microsoft's multi-tenant
// `common`). The transient state/nonce ride in a short-lived signed cookie (see routes/auth.ts).
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { OidcClient } from "../config";
import type { Provider } from "../types";

export interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

const discoveryCache = new Map<string, Discovery>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function discover(discoveryUrl: string): Promise<Discovery> {
  const cached = discoveryCache.get(discoveryUrl);
  if (cached) return cached;
  const res = await fetch(discoveryUrl);
  if (!res.ok) throw new Error(`OIDC discovery failed for ${discoveryUrl}`);
  const doc = (await res.json()) as Discovery;
  discoveryCache.set(discoveryUrl, doc);
  return doc;
}

/** Build the provider authorization URL to redirect the user to. */
export function buildAuthorizationUrl(
  discovery: Discovery,
  client: OidcClient,
  params: { redirectUri: string; state: string; nonce: string },
): string {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", client.scope);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  return url.toString();
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
}

/** Exchange the authorization code for tokens. */
export async function exchangeCode(
  discovery: Discovery,
  client: OidcClient,
  params: { code: string; redirectUri: string },
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error("OIDC token exchange failed");
  return (await res.json()) as TokenResponse;
}

export interface OidcProfile {
  subject: string;
  email: string;
  email_verified: boolean;
  display_name: string | null;
}

function jwksFor(discovery: Discovery): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksCache.get(discovery.jwks_uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(discovery.jwks_uri));
    jwksCache.set(discovery.jwks_uri, set);
  }
  return set;
}

/** Verify the id_token and extract the profile. Throws on invalid token / nonce mismatch. */
export async function verifyIdToken(
  discovery: Discovery,
  client: OidcClient,
  provider: Provider,
  idToken: string,
  expectedNonce: string,
): Promise<OidcProfile> {
  const { payload } = await jwtVerify(idToken, jwksFor(discovery), {
    audience: client.clientId,
    // Microsoft's multi-tenant `common` issuer varies per tenant; verify issuer for Google only.
    issuer: provider === "GOOGLE" ? discovery.issuer : undefined,
  });
  if (payload.nonce !== expectedNonce) {
    throw new Error("OIDC nonce mismatch");
  }
  const subject = String(payload.sub);
  const email =
    typeof payload.email === "string"
      ? payload.email
      : typeof payload.preferred_username === "string"
        ? payload.preferred_username
        : "";
  if (!email) throw new Error("OIDC token has no email claim");
  // Microsoft attests ownership; Google carries an explicit email_verified claim.
  const email_verified =
    provider === "MICROSOFT" ? true : payload.email_verified === true;
  const display_name = typeof payload.name === "string" ? payload.name : null;
  return { subject, email, email_verified, display_name };
}
