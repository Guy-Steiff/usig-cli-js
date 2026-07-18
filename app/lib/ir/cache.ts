/**
 * app/lib/ir/cache.ts
 *
 * IRCache — in-memory store for SignalFrames.
 *
 * Key structure:
 *   primaryKey   = fileFingerprint(file)   = "name:size:lastModified"
 *   secondaryKey = hintsKey(hints)         = JSON of active hint fields, or ''
 *   storeKey     = `${primaryKey}::${secondaryKey}`
 *
 * A single File can have multiple cached frames (one per unique IngestHints
 * combination — e.g. one per plugin column selection).  The base frame
 * (hintsKey = '') carries the shared columnar metadata used by the UI.
 *
 * invalidate(file) removes ALL frames for that file in O(n) where n is the
 * total number of cached frames (typically small — a few dozen at most).
 *
 * This class is intentionally framework-agnostic and has no React dependency.
 * It can be used in Node CLI, Web Workers, or browser React equally.
 */

import type { SignalFrame, IRManifestEntry } from './types';
import type { IngestHints } from '../ingest/ingest';

// ─────────────────────────────────────────────────────────────────────────────
// Schema version — bump when SignalFrame shape changes incompatibly
// ─────────────────────────────────────────────────────────────────────────────

export const IR_SCHEMA_VERSION = '1.0.0';

// ─────────────────────────────────────────────────────────────────────────────
// Key helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce a deterministic fingerprint for a File object.
 *
 * Uses name + size + lastModified — enough to detect re-drops of a modified
 * file.  Content hashing is intentionally omitted (O(n) cost, unacceptable for
 * large captures at file-add time).
 */
export function fileFingerprint(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

/**
 * Produce a stable serialization key for an IngestHints object.
 *
 * Only the fields that affect the parsed waveform content are included.
 * Sample slicing fields are included to distinguish frame views.
 * Returns '' when hints is undefined or all fields are undefined.
 */
export function hintsKey(hints?: IngestHints): string {
  if (!hints) return '';
  const HINT_KEYS: (keyof IngestHints)[] = [
    'sampleRateHz',
    'signalColumn',
    'fsGhzColumnRegex',
    'preserveBinIndex',
    'dtype',
    'endianness',
    'headerBytes',
    'units',
    'startSample',
    'endSample',
  ];
  const normalized: Record<string, unknown> = {};
  for (const k of HINT_KEYS) {
    const v = hints[k];
    if (v !== undefined) normalized[k] = v;
  }
  return Object.keys(normalized).length > 0
    ? JSON.stringify(normalized, Object.keys(normalized).sort())
    : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// IRCache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IRCache — fast in-memory SignalFrame store.
 *
 * All methods are synchronous (reads/writes are just Map operations).
 * Ingestion I/O is handled by IREngine.
 *
 * Typical usage:
 *   const cache = new IRCache();
 *   // ... IREngine populates it ...
 *   const frame = cache.get(file, hints);   // O(1) lookup
 *   cache.invalidate(file);                  // on file removal
 *   cache.clear();                           // on pipeline reset
 */
export class IRCache {
  /** The underlying store. Key = "fingerprint::hintsKey". */
  private readonly store = new Map<string, SignalFrame>();

  private storeKey(fingerprint: string, hk: string): string {
    return `${fingerprint}::${hk}`;
  }

  // ── Read ────────────────────────────────────────────────────────────────

  get(file: File, hints?: IngestHints): SignalFrame | undefined {
    return this.store.get(this.storeKey(fileFingerprint(file), hintsKey(hints)));
  }

  has(file: File, hints?: IngestHints): boolean {
    return this.store.has(this.storeKey(fileFingerprint(file), hintsKey(hints)));
  }

  // ── Write ───────────────────────────────────────────────────────────────

  set(file: File, hints: IngestHints | undefined, frame: SignalFrame): void {
    this.store.set(this.storeKey(fileFingerprint(file), hintsKey(hints)), frame);
  }

  // ── Invalidation ────────────────────────────────────────────────────────

  /**
   * Remove ALL cached frames for a file (base + all per-hints variants).
   * Call when the file is removed from the pipeline.
   */
  invalidate(file: File): void {
    const prefix = `${fileFingerprint(file)}::`;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  /** Clear the entire cache. */
  clear(): void {
    this.store.clear();
  }

  // ── Inspection ──────────────────────────────────────────────────────────

  /** Total number of cached frames. */
  get size(): number {
    return this.store.size;
  }

  /**
   * Return a JSON-safe manifest of all cached frames.
   * Safe to log, display in the UI, or serialise to a file.
   */
  getManifest(): IRManifestEntry[] {
    return Array.from(this.store.values()).map(f => ({
      cacheKey:      f.cacheKey,
      hintsKey:      f.hintsKey,
      fileName:      f.packet.metadata.sourceFile ?? f.cacheKey.split(':')[0],
      numSamples:    f.packet.metadata.numSamples,
      sampleRateHz:  f.packet.metadata.sampleRateHz,
      units:         f.packet.metadata.units,
      headers:       f.headers,
      ingestedAt:    f.ingestedAt,
      schemaVersion: f.schemaVersion,
    }));
  }

  /** Current IR schema version (static — same for all instances). */
  static readonly SCHEMA_VERSION: string = IR_SCHEMA_VERSION;
}

