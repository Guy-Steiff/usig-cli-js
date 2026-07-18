/**
 * app/lib/ir/types.ts
 *
 * Intermediate Representation (IR) type definitions.
 *
 * Conceptual mapping (FFmpeg analogy):
 *   File bytes  →  demux/decode  →  SignalFrame  →  plugin filters  →  outputs
 *
 * The SignalFrame IS the IR.  Once a file has been ingested into a SignalFrame,
 * that frame is the only data structure plugins ever consume.  They never touch
 * raw File objects, CSV strings, or binary bytes.
 *
 * A SignalFrame bundles TWO views of the same source file:
 *   1. `packet`            — canonical single-signal WaveformPacket (selected column
 *                            + full metadata), the primary input to analysis plugins.
 *   2. `headers` / …      — columnar snapshot (all column names, single-value columns,
 *                            filename-extracted vars), used by the UI and param seeding.
 *
 * The `hintsKey` distinguishes frames produced with different IngestHints (e.g.
 * different column selections), so each unique (file × hints) combination is
 * cached and reused exactly once.
 *
 * Serialization:
 *   serializeFrame()  →  { meta: string (JSON); waveform: ArrayBuffer }
 *   deserializeFrame() reconstructs a full SignalFrame from those two parts.
 *   This enables future CLI / headless batch mode to pass IR between processes
 *   without re-reading source files.
 */

import type { WaveformPacket } from '../ingest/types';

// ─────────────────────────────────────────────────────────────────────────────
// Core IR: SignalFrame
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SignalFrame — the canonical IR for one ingested file at a specific hints config.
 *
 * Plugins receive `frame.packet` (WaveformPacket).  They never see the File object.
 *
 * The frame is immutable after creation: the ingestion engine produces it once
 * and the cache returns the same reference on every subsequent lookup.
 */
export interface SignalFrame {
  // ── Primary signal data ───────────────────────────────────────────────────
  /** The canonical waveform packet: Float32Array + metadata. */
  packet: WaveformPacket;

  // ── Columnar snapshot (pipeline UI / param seeding) ───────────────────────
  /** All column headers from the source file (or ['samples'] for binary). */
  headers: string[];

  /**
   * Columns where every non-empty cell has the same value.
   * Candidates for automatic plugin parameter injection (e.g. fs column in CSV).
   */
  singleValueColumns: Record<string, string>;

  /**
   * Pipeline-level variables extracted from the filename.
   * Keys: 'fs_hz' | 'adc_bits' | 'vfs_pp' | 'fin_hz' (all SI base units).
   */
  capturedVars: Record<string, number>;

  // ── Provenance ────────────────────────────────────────────────────────────
  /**
   * Deterministic file fingerprint: "name:size:lastModified".
   * Used as the primary cache key.  Does NOT hash file content (too expensive
   * for large captures), but is sufficient to detect re-drops of the same file.
   */
  cacheKey: string;

  /**
   * Stable serialization of the IngestHints used to produce this frame.
   * Empty string = base frame (no hints, heuristic column selection).
   * Non-empty = JSON of the active hint fields.
   */
  hintsKey: string;

  /** Unix timestamp (ms) at the moment this frame was created. */
  ingestedAt: number;

  /**
   * IR schema version — bump when SignalFrame shape changes in a
   * backward-incompatible way so deserializers can reject stale blobs.
   */
  schemaVersion: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest entry — JSON-safe summary of a cached frame
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IRManifestEntry — lightweight summary of a cached SignalFrame.
 * Safe to log, display in the UI, or emit to a JSON file.
 * Contains no binary data.
 */
export interface IRManifestEntry {
  cacheKey: string;
  hintsKey: string;
  fileName: string;
  numSamples: number;
  sampleRateHz: number;
  units: string | undefined;
  headers: string[];
  ingestedAt: number;
  schemaVersion: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialized IR — binary-portable form
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SerializedIR — the portable, binary-compatible form of a SignalFrame.
 *
 * Format:
 *   `meta`     — JSON string containing all SignalFrame fields except the
 *                waveform Float32Array itself.
 *   `waveform` — raw ArrayBuffer copy of `frame.packet.waveform`.
 *
 * This is the exchange format for:
 *   - exporting IR to disk (future CLI batch mode)
 *   - passing IR between the browser and a Node worker
 *   - persisting IR in IndexedDB for session resumption
 */
export interface SerializedIR {
  /** JSON-encoded SignalFrame metadata (no waveform bytes). */
  meta: string;
  /** Raw Float32 waveform bytes. Length = numSamples × 4. */
  waveform: ArrayBuffer;
}

