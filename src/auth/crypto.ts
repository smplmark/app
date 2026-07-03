// Auth cryptography, all on WebCrypto (native to Workers). Pure and deterministic where it can be;
// 100%-covered. Covers: SHA-256 hashing (API-key + verification-token lookup), high-entropy token
// generation, PBKDF2 password hashing/verification, API-key minting/masking, and AES-GCM
// encrypt/decrypt of the API-key plaintext at rest (for the reveal endpoint).

import { API_KEY_PREFIX } from "../config";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── base64 / base64url ───────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── hashing ──────────────────────────────────────────────────────────────────

/** SHA-256 of a string, hex-encoded. Used for the O(1) unique-index lookup on API keys + tokens. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A high-entropy URL-safe random token. `bytes` of entropy (default 32 = 256 bits). */
export function randomToken(bytes = 32): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Constant-time string comparison (avoids leaking match length/position via timing). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── passwords (PBKDF2-HMAC-SHA256) ───────────────────────────────────────────

const PBKDF2_ITERATIONS = 210_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_HASH_BYTES = 32;

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    PBKDF2_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Hash a password to a self-describing string: `pbkdf2$sha256$<iters>$<saltB64url>$<hashB64url>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
}

/** Verify a password against a stored PBKDF2 string. Any malformed stored value → false. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  let expected: Uint8Array;
  let salt: Uint8Array;
  try {
    salt = base64UrlToBytes(parts[3]);
    expected = base64UrlToBytes(parts[4]);
  } catch {
    return false;
  }
  const actual = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(bytesToBase64Url(actual), bytesToBase64Url(expected));
}

// ── API keys ─────────────────────────────────────────────────────────────────

/** Mint a fresh API-key plaintext: `sm_api_<43 url-safe chars>` (~256 bits). */
export function generateApiKey(): string {
  return API_KEY_PREFIX + randomToken(32);
}

/** The masked display prefix stored alongside a key: `sm_api_` + first 8 body chars. */
export function apiKeyPrefix(plaintext: string): string {
  const body = plaintext.startsWith(API_KEY_PREFIX)
    ? plaintext.slice(API_KEY_PREFIX.length)
    : plaintext;
  return API_KEY_PREFIX + body.slice(0, 8);
}

// ── AES-GCM (encrypt the API-key plaintext for reveal) ───────────────────────

async function aesKey(secretBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(secretBase64);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** AES-GCM encrypt → base64(iv ‖ ciphertext). `secretBase64` is a base64 32-byte key. */
export async function encryptSecret(
  plaintext: string,
  secretBase64: string,
): Promise<string> {
  const key = await aesKey(secretBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext)),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return bytesToBase64(packed);
}

/** Reverse of encryptSecret. Throws on tamper / wrong key. */
export async function decryptSecret(
  packedBase64: string,
  secretBase64: string,
): Promise<string> {
  const key = await aesKey(secretBase64);
  const packed = base64ToBytes(packedBase64);
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return dec.decode(pt);
}

/** Generate a base64 32-byte key suitable for KEY_ENCRYPTION_SECRET (used by tests / setup). */
export function generateEncryptionKey(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}
