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
 * combination — e.g. one per plugin column selection). The base frame
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
 * file. Content hashing is intentionally omitted (O(n) cost, unacceptable for
 * large captures at file-add time).
 */
export function fileFingerprint(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

/**
 * Produce a stable serialization key for an IngestHints object.
 *
 * IMPORTANT:
 * Keep this list restricted to properties that actually exist on
 * IngestHints. Do not use arbitrary property names here because TypeScript
 * correctly rejects them when they are not part of the IngestHints type.
 */
export function hintsKey(hints?: IngestHints): string {
  if (!hints) return '';

  /*
   * Derive the keys from the actual IngestHints type.
   *
   * The previous implementation contained fields from an older ingestion
   * interface, including:
   *
   *   sampleRateHz
   *   fsGhzColumnRegex
   *   dtype
   *   encoding
   *   bytes_per_sample
   *   offset
   *   scale
   *   offset_value
   *   samples
   *
   * Those are not currently part of IngestHints and therefore caused
   * TS2322 errors.
   *
   * Keep only fields which are known to exist in the current interface.
   */
  const normalized: Record<string, unknown> = {};

  /*
   * These fields are intentionally accessed through a typed key list.
   *
   * If your current IngestHints interface contains additional fields that
   * affect ingestion, add them here.
   */
  const hintKeys: (keyof IngestHints)[] = [
    'signalColumn',
    'preserveBinIndex',
    'endianness',
    'headerBytes',
    'channelIndex',
    'units',
    'startSample',
    'endSample',
  ];

  for (const key of hintKeys) {
    const value = hints[key];

    if (value !== undefined) {
      normalized[key] = value;
    }
  }

  return Object.keys(normalized).length > 0
    ? JSON.stringify(
        normalized,
        Object.keys(normalized).sort()
      )
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
 *   const frame = cache.get(file, hints);
 *   cache.invalidate(file);
 *   cache.clear();
 */
export class IRCache {
  /** The underlying store. Key = "fingerprint::hintsKey". */
  private readonly store = new Map<string, SignalFrame>();

  private storeKey(
    fingerprint: string,
    hintKey: string
  ): string {
    return `${fingerprint}::${hintKey}`;
  }

  // ── Read ────────────────────────────────────────────────────────────────

  get(
    file: File,
    hints?: IngestHints
  ): SignalFrame | undefined {
    return this.store.get(
      this.storeKey(
        fileFingerprint(file),
        hintsKey(hints)
      )
    );
  }

  has(
    file: File,
    hints?: IngestHints
  ): boolean {
    return this.store.has(
      this.storeKey(
        fileFingerprint(file),
        hintsKey(hints)
      )
    );
  }

  // ── Write ───────────────────────────────────────────────────────────────

  set(
    file: File,
    hints: IngestHints | undefined,
    frame: SignalFrame
  ): void {
    this.store.set(
      this.storeKey(
        fileFingerprint(file),
        hintsKey(hints)
      ),
      frame
    );
  }

  // ── Invalidation ────────────────────────────────────────────────────────

  /**
   * Remove ALL cached frames for a file (base + all per-hints variants).
   * Call when the file is removed from the pipeline.
   */
  invalidate(file: File): void {
    const prefix = `${fileFingerprint(file)}::`;

    /*
     * Array.from() avoids the TS2802 error when the project target is below
     * ES2015 and downlevelIteration is not enabled.
     */
    for (const key of Array.from(this.store.keys())) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
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
   * Safe to log, display in the UI, or serialize to a file.
   */
  getManifest(): IRManifestEntry[] {
    return Array.from(this.store.values()).map(
      (frame): IRManifestEntry => {
        const metadata = frame.packet.metadata;

        /*
         * The metadata properties are currently typed as unknown.
         * Normalize them before constructing IRManifestEntry.
         */
        const numSamples = Number(metadata.numSamples);
        const sampleRateHz = Number(metadata.sampleRateHz);

        return {
          cacheKey: frame.cacheKey,
          hintsKey: frame.hintsKey,
          fileName:
            metadata.sourceFile ??
            frame.cacheKey.split(':')[0],
          numSamples,
          sampleRateHz,
          units: metadata.units,
          headers: frame.headers,
          ingestedAt: frame.ingestedAt,
          schemaVersion: frame.schemaVersion,
        };
      }
    );
  }

  /** Current IR schema version (static — same for all instances). */
  static readonly SCHEMA_VERSION: string =
    IR_SCHEMA_VERSION;
}
