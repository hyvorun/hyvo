/** Random identifiers: run ids (ULID), order ids (bytes32), leases, nonces and session tokens. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const encoder = new TextEncoder();

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** `run_` + a ULID: 48-bit millisecond time and 80 random bits in Crockford base32. */
export function newRunId(ms: number = Date.now()): string {
  let time = "";
  let t = ms;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  let random = 0n;
  for (const byte of randomBytes(10)) random = (random << 8n) | BigInt(byte);
  let tail = "";
  for (let i = 0; i < 16; i++) {
    tail = CROCKFORD.charAt(Number(random & 31n)) + tail;
    random >>= 5n;
  }
  return `run_${time}${tail}`;
}

export function randomHex(length: number): `0x${string}` {
  return `0x${[...randomBytes(length)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An unguessable token for a session (shown once; only its SHA-256 is stored). */
export function newToken(): string {
  return base64url(randomBytes(32));
}

export function newLeaseId(): string {
  return `lease_${base64url(randomBytes(18))}`;
}

/** SIWE nonces must be alphanumeric (EIP-4361); 24 characters is about 143 bits. */
export function newNonce(): string {
  return [...randomBytes(24)].map((b) => ALPHANUMERIC.charAt(b % ALPHANUMERIC.length)).join("");
}

export function newId(prefix: string): string {
  return `${prefix}_${base64url(randomBytes(12))}`;
}

export function sha256Hex(text: string): Promise<string> {
  return sha256Bytes(encoder.encode(text));
}

/** SHA-256 as lowercase hex. WebCrypto is native, so this stays cheap at any size. */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
