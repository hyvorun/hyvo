/**
 * secp256k1 in WebAssembly (libsecp256k1 as built by tiny-secp256k1). On a cold isolate the
 * JavaScript implementation in viem takes about 50 ms of CPU to recover or sign once, against a
 * limit of 10 ms on the Workers Free plan; this takes about 6 ms and 4 ms (docs/OPEN_ITEMS.md item
 * 21). The wasm file is imported directly because the package's own loader reads it with `fs`.
 */
import { getAddress, keccak256, type Address, type Hex } from "viem";
import secpModule from "../../node_modules/tiny-secp256k1/lib/secp256k1.wasm";

interface SecpExports {
  memory: WebAssembly.Memory;
  HASH_INPUT: WebAssembly.Global;
  PRIVATE_INPUT: WebAssembly.Global;
  SIGNATURE_INPUT: WebAssembly.Global;
  PUBLIC_KEY_INPUT: WebAssembly.Global;
  initializeContext(): void;
  signRecoverable(extraData: number): number;
  recover(outputLength: number, recoveryId: number): number;
  pointFromScalar(outputLength: number): number;
}

const UNCOMPRESSED = 65;
/** The curve order: r and s must be below it. */
const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

let secp: SecpExports | null = null;

/** Created on first use: the module asks for random numbers, which Workers refuse in global scope. */
function exports_(): SecpExports {
  if (!secp) {
    const instance = new WebAssembly.Instance(secpModule, {
      "./rand.js": { generateInt32: () => crypto.getRandomValues(new Int32Array(1))[0]! },
      "./validate_error.js": {
        throwError: (code: number) => {
          throw new TypeError(`secp256k1 error ${code}`);
        },
      },
    });
    secp = instance.exports as unknown as SecpExports;
    secp.initializeContext();
  }
  return secp;
}

function area(wasm: SecpExports, pointer: WebAssembly.Global, length: number): Uint8Array {
  return new Uint8Array(wasm.memory.buffer, pointer.value as number, length);
}

function hexBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Uint8Array.from(clean.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function toHex(bytes: Uint8Array): Hex {
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function addressOfPublicKey(uncompressed: Uint8Array): Address {
  return getAddress(`0x${keccak256(uncompressed.subarray(1)).slice(-40)}`);
}

/** The address that signed `hash`, or null for anything that is not a valid 65-byte signature. */
export function recoverAddress(hash: Hex, signature: Hex): Address | null {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  const r = BigInt(signature.slice(0, 66));
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130), 16);
  const recoveryId = v >= 27 ? v - 27 : v;
  if (r === 0n || s === 0n || r >= ORDER || s >= ORDER || (recoveryId !== 0 && recoveryId !== 1)) return null;
  try {
    const wasm = exports_();
    area(wasm, wasm.HASH_INPUT, 32).set(hexBytes(hash));
    area(wasm, wasm.SIGNATURE_INPUT, 64).set(hexBytes(signature.slice(2, 130)));
    if (wasm.recover(UNCOMPRESSED, recoveryId) !== 1) return null;
    return addressOfPublicKey(area(wasm, wasm.PUBLIC_KEY_INPUT, UNCOMPRESSED).slice());
  } catch {
    secp = null; // a trap can leave the instance unusable; the next call makes a new one
    return null;
  }
}

/** Sign a 32-byte hash (RFC 6979, low s). The key is cleared from wasm memory afterwards. */
export function signHash(hash: Hex, privateKey: Hex): { r: Hex; s: Hex; yParity: 0 | 1; v: bigint } {
  const wasm = exports_();
  const keyArea = area(wasm, wasm.PRIVATE_INPUT, 32);
  try {
    area(wasm, wasm.HASH_INPUT, 32).set(hexBytes(hash));
    keyArea.set(hexBytes(privateKey));
    const recoveryId = wasm.signRecoverable(0);
    if (recoveryId !== 0 && recoveryId !== 1) throw new Error("unexpected recovery id");
    const signature = area(wasm, wasm.SIGNATURE_INPUT, 64).slice();
    return {
      r: toHex(signature.subarray(0, 32)),
      s: toHex(signature.subarray(32)),
      yParity: recoveryId,
      v: BigInt(27 + recoveryId),
    };
  } finally {
    keyArea.fill(0);
  }
}

export function addressOfKey(privateKey: Hex): Address {
  const wasm = exports_();
  const keyArea = area(wasm, wasm.PRIVATE_INPUT, 32);
  try {
    keyArea.set(hexBytes(privateKey));
    if (wasm.pointFromScalar(UNCOMPRESSED) !== 1) throw new Error("invalid private key");
    return addressOfPublicKey(area(wasm, wasm.PUBLIC_KEY_INPUT, UNCOMPRESSED).slice());
  } finally {
    keyArea.fill(0);
  }
}
