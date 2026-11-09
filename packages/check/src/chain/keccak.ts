// Keccak-256 (the Ethereum variant, 0x01 padding), pure TypeScript, no dependencies.
//
// Correctness is critical: a wrong 4-byte selector means a false finding. The permutation works on 32-bit
// halves of each 64-bit lane, which keeps it fast enough for the CPU limits of a Cloudflare Worker. It is
// checked in test/keccak.test.ts against known vectors and against viem for inputs of every length up to
// several blocks, and cross-checked against the hardcoded selectors in abi.ts.

// Round constants of Keccak-f[1600], split into their low and high 32 bits.
const RC_LO = new Uint32Array([
  0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001, 0x80008081, 0x00008009, 0x0000008a,
  0x00000088, 0x80008009, 0x8000000a, 0x8000808b, 0x0000008b, 0x00008089, 0x00008003, 0x00008002, 0x00000080,
  0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008,
]);
const RC_HI = new Uint32Array([
  0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000,
  0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000,
]);

// ρ rotation offsets and π destinations along the walk that starts at lane 1, as word indexes (2 per lane).
const ROTATIONS: number[] = [];
const PI_WORDS: number[] = [];
{
  let x = 1;
  let y = 0;
  for (let t = 0; t < 24; t++) {
    const nx = y;
    const ny = (2 * x + 3 * y) % 5;
    x = nx;
    y = ny;
    PI_WORDS.push(2 * (x + 5 * y));
    ROTATIONS.push((((t + 1) * (t + 2)) / 2) % 64);
  }
}

// Rotate the 64-bit lane (hi:lo) left by n bits, 0 < n < 64 and n != 32; these return the new low or high half.
function rotlLo(lo: number, hi: number, n: number): number {
  return n < 32 ? (lo << n) | (hi >>> (32 - n)) : (hi << (n - 32)) | (lo >>> (64 - n));
}

function rotlHi(lo: number, hi: number, n: number): number {
  return n < 32 ? (hi << n) | (lo >>> (32 - n)) : (lo << (n - 32)) | (hi >>> (64 - n));
}

// The state: 25 lanes, each as two 32-bit words, low word first.
function keccakF(s: Uint32Array): void {
  const c = new Uint32Array(10);
  for (let round = 0; round < 24; round++) {
    // θ
    for (let i = 0; i < 10; i++) c[i] = s[i]! ^ s[i + 10]! ^ s[i + 20]! ^ s[i + 30]! ^ s[i + 40]!;
    for (let x = 0; x < 5; x++) {
      const prev = ((x + 4) % 5) * 2;
      const next = ((x + 1) % 5) * 2;
      const dLo = c[prev]! ^ rotlLo(c[next]!, c[next + 1]!, 1);
      const dHi = c[prev + 1]! ^ rotlHi(c[next]!, c[next + 1]!, 1);
      for (let y = 0; y < 50; y += 10) {
        s[y + 2 * x] = s[y + 2 * x]! ^ dLo;
        s[y + 2 * x + 1] = s[y + 2 * x + 1]! ^ dHi;
      }
    }
    // ρ and π
    let lo = s[2]!;
    let hi = s[3]!;
    for (let t = 0; t < 24; t++) {
      const n = ROTATIONS[t]!;
      const w = PI_WORDS[t]!;
      const nextLo = s[w]!;
      const nextHi = s[w + 1]!;
      s[w] = rotlLo(lo, hi, n);
      s[w + 1] = rotlHi(lo, hi, n);
      lo = nextLo;
      hi = nextHi;
    }
    // χ
    for (let y = 0; y < 50; y += 10) {
      for (let i = 0; i < 10; i++) c[i] = s[y + i]!;
      for (let i = 0; i < 10; i++) s[y + i] = c[i]! ^ (~c[(i + 2) % 10]! & c[(i + 4) % 10]!);
    }
    // ι
    s[0] = s[0]! ^ RC_LO[round]!;
    s[1] = s[1]! ^ RC_HI[round]!;
  }
}

export function keccak256(input: Uint8Array): Uint8Array {
  const rate = 136; // bytes (1088 bits) for Keccak-256
  const s = new Uint32Array(50);

  // pad10*1 with the Keccak domain byte (0x01 .. 0x80); always at least one padding byte.
  const padded = new Uint8Array((Math.floor(input.length / rate) + 1) * rate);
  padded.set(input);
  padded[input.length] = padded[input.length]! ^ 0x01;
  padded[padded.length - 1] = padded[padded.length - 1]! ^ 0x80;

  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let w = 0; w < rate / 4; w++) {
      const i = offset + w * 4;
      s[w] = s[w]! ^ (padded[i]! | (padded[i + 1]! << 8) | (padded[i + 2]! << 16) | (padded[i + 3]! << 24));
    }
    keccakF(s);
  }

  const out = new Uint8Array(32);
  for (let w = 0; w < 8; w++) {
    const v = s[w]!;
    out[w * 4] = v & 0xff;
    out[w * 4 + 1] = (v >>> 8) & 0xff;
    out[w * 4 + 2] = (v >>> 16) & 0xff;
    out[w * 4 + 3] = (v >>> 24) & 0xff;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
