/**
 * app/lib/ir/bytes.ts
 * Runtime-neutral byte helpers.
 *
 * These utilities use only standard JavaScript typed-array and Web Platform
 * primitives. They work in Node, browser, Web Worker, and future WASM-facing
 * adapters.
 */

export function asUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }

  return new Uint8Array(data);
}

export function decodeUtf8(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): string {
  return new TextDecoder("utf-8").decode(
    bytes.subarray(start, end),
  );
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function indexOfBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
): number {
  if (needle.length === 0) return 0;

  const lastStart = haystack.length - needle.length;

  for (let start = 0; start <= lastStart; start += 1) {
    let matched = true;

    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }

    if (matched) return start;
  }

  return -1;
}