/**
 * Short-lived URLs signed by the Worker (docs/API.md), so they behave the same under
 * `wrangler dev` as deployed:
 *
 * - artifact: `sig = hex(HMAC-SHA256(ARTIFACT_SIGNING_KEY, "<runId>\n<exp>"))`
 * - upload:   `sig = hex(HMAC-SHA256(ARTIFACT_SIGNING_KEY, "upload\n<runId>\n<leaseId>\n<exp>"))`
 *
 * `exp` is in Unix seconds. The two messages cannot collide: a run id is never "upload".
 */
const encoder = new TextEncoder();

export const ARTIFACT_TTL_SECONDS = 15 * 60;
export const UPLOAD_TTL_SECONDS = 15 * 60;

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function sign(secret: string, message: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(message));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time check (WebCrypto HMAC verify) of a hex signature; false for malformed input. */
async function verify(secret: string, message: string, sig: string): Promise<boolean> {
  if (!secret || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const bytes = new Uint8Array(sig.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
  return crypto.subtle.verify("HMAC", await hmacKey(secret), bytes, encoder.encode(message));
}

export function signArtifact(secret: string, runId: string, exp: number): Promise<string> {
  return sign(secret, `${runId}\n${exp}`);
}

export function verifyArtifact(secret: string, runId: string, exp: number, sig: string): Promise<boolean> {
  return verify(secret, `${runId}\n${exp}`, sig);
}

export function signUpload(secret: string, runId: string, leaseId: string, exp: number): Promise<string> {
  return sign(secret, `upload\n${runId}\n${leaseId}\n${exp}`);
}

export function verifyUpload(secret: string, runId: string, leaseId: string, exp: number, sig: string): Promise<boolean> {
  return verify(secret, `upload\n${runId}\n${leaseId}\n${exp}`, sig);
}

/**
 * A webhook's secret: derived, so none is stored. It cannot collide with the links above: their messages start with a
 * run id or "upload".
 */
export async function webhookSecret(key: string, webhookId: string): Promise<string> {
  return `whsec_${await sign(key, `webhook\n${webhookId}`)}`;
}

/** The `X-Hyvo-Signature` header of a delivery. */
export async function webhookSignature(secret: string, timestamp: number, body: string): Promise<string> {
  return `t=${timestamp},v1=${await sign(secret, `${timestamp}.${body}`)}`;
}

/** Constant-time string comparison for bearer tokens. */
export async function sameSecret(given: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  // Compare HMACs of both values under a random key: equal length, constant time, no length leak.
  const key = (await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"])) as CryptoKey;
  const [a, b] = await Promise.all([
    crypto.subtle.sign("HMAC", key, encoder.encode(given)),
    crypto.subtle.sign("HMAC", key, encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}
