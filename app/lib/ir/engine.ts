/**
 * app/lib/ir/engine.ts
 *
 * IREngine — the orchestrator between raw file ingestion and the IR cache.
 *
 * This is the ONLY entry point through which PipelineBlock (or any future
 * CLI / headless runner) should obtain WaveformPackets.
 *
 * Design principles (from the system spec):
 *   • "Ingestion happens once" — each (file × hints) combination is ingested
 *     exactly once; all subsequent requests are served from the cache.
 *   • "Plugins consume IR only" — callers receive a SignalFrame; the raw File
 *     object is never passed through to analysis logic.
 *   • "Deterministic reproducibility" — same file + same hints → same frame,
 *     even across independent IREngine instances (given identical inputs).
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 *   // Create once per pipeline session (useRef in React):
 *   const engine = new IREngine();
 *
 *   // File added:
 *   const colsResult = await engine.getColumnarData(file);  // UI / param seeding
 *
 *   // Run button pressed (per file, per plugin):
 *   const frame = await engine.getOrIngest(file, hints);    // cache hit if same hints
 *   plugin.runFromWaveform(frame.packet, params);
 *
 *   // File removed:
 *   engine.invalidate(file);
 *
 *   // Pipeline reset:
 *   engine.clear();
 *
 * ─── Performance notes ──────────────────────────────────────────────────────
 *
 *   Before IR (old flow):
 *     add time:  ingestAllColumns()       ← 1 read
 *                ingestFile()             ← 1 read (thumbnail/guidance)
 *     run time:  ingestFile()             ← 1 read per file
 *                ingestFile(hints) × N   ← N reads (one per plugin that declares hints)
 *     Total per file per run: 2 + 1 + N reads
 *
 *   After IR (new flow):
 *     add time:  getColumnarData()        ← 1 read (same as before)
 *                getOrIngest()            ← 1 read; frame cached
 *     run time:  getOrIngest()            ← 0 reads (cache HIT for base)
 *                getOrIngest(hints) × N  ← 0 reads for hints already seen,
 *                                          1 read only on first occurrence
 *     Total per file per run (steady state): 0 reads — all served from cache
 */

import { ingestFile, ingestAllColumns } from '../ingest';
import type { IngestHints, IngestColumnsResult } from '../ingest/ingest';
import type { SignalFrame, IRManifestEntry } from './types';
import { IRCache, fileFingerprint, hintsKey as makeHintsKey } from './cache';
import { ingestMappedBinary } from './binMapper';

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────

export interface IREngineStats {
  /** Number of cache lookups that returned a cached frame. */
  hits: number;
  /** Number of cache lookups that triggered a new ingestion. */
  misses: number;
  /** Total number of frames currently in the cache. */
  size: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// IREngine
// ─────────────────────────────────────────────────────────────────────────────

export class IREngine {
  /** Exposed so callers can inspect or export the raw cache if needed. */
  readonly cache: IRCache;

  private _stats: Omit<IREngineStats, 'size'> = { hits: 0, misses: 0 };

  constructor(cache?: IRCache) {
    this.cache = cache ?? new IRCache();
  }

  // ── Primary API ────────────────────────────────────────────────────────────

  /**
   * Get or create a SignalFrame for a (file, hints) pair.
   *
   * Cache hit  → returns the existing frame immediately (no I/O).
   * Cache miss → ingests the file, builds the frame, stores it, returns it.
   *
   * On a cache miss the engine:
   *   1. Calls ingestAllColumns(file) to populate headers / singleValueColumns /
   *      capturedVars — but only if those aren't already known from a base frame.
   *   2. Calls ingestFile(file, hints) to obtain the WaveformPacket.
   *   3. Assembles the SignalFrame and stores it in the cache.
   *
   * The hints parameter is optional.  Omitting it produces the base frame
   * (heuristic column selection, no overrides).
   */
  async getOrIngest(file: File, hints?: IngestHints): Promise<SignalFrame> {
    // ── Cache hit ──────────────────────────────────────────────────────────
    if (this.cache.has(file, hints)) {
      this._stats.hits++;
      return this.cache.get(file, hints)!;
    }

    this._stats.misses++;

    // ── Derive columnar metadata ───────────────────────────────────────────
    // Re-use data from the base frame if already cached, to avoid an extra
    // ingestAllColumns() call when this is a hints variant of a known file.
    let columnarMeta: Pick<SignalFrame, 'headers' | 'singleValueColumns' | 'capturedVars'>;

    const baseFrame = this.cache.get(file /* no hints = base key */);
    if (baseFrame) {
      columnarMeta = {
        headers:             baseFrame.headers,
        singleValueColumns:  baseFrame.singleValueColumns,
        capturedVars:        baseFrame.capturedVars,
      };
    } else {
      // First time we've seen this file — fetch all columns for metadata.
      const colsResult = await ingestAllColumns(file);
      columnarMeta = {
        headers:            colsResult.headers,
        singleValueColumns: colsResult.singleValueColumns,
        capturedVars:       colsResult.capturedVars,
      };
    }

    // ── Ingest the single-signal waveform packet ───────────────────────────
    const packet = await ingestFile(file, hints);

    // ── Build and cache the frame ──────────────────────────────────────────
    const frame: SignalFrame = {
      packet,
      headers:            columnarMeta.headers,
      singleValueColumns: columnarMeta.singleValueColumns,
      capturedVars:       columnarMeta.capturedVars,
      cacheKey:     fileFingerprint(file),
      hintsKey:     makeHintsKey(hints),
      ingestedAt:   Date.now(),
      schemaVersion: IRCache.SCHEMA_VERSION,
    };

    this.cache.set(file, hints, frame);
    return frame;
  }

  /**
   * Get all columns from a file for UI / parameter seeding purposes.
   *
   * This is a pass-through to ingestAllColumns() — it does NOT populate the
   * IR cache (a WaveformPacket requires a column selection decision).
   *
   * When the engine already has a cached base frame for this file, the columnar
   * data can be reconstructed from it cheaply:
   *   frame.headers, frame.singleValueColumns, frame.capturedVars
   * However, `columns` (the full Float32Array per column) is NOT stored in the
   * SignalFrame to avoid holding large duplicate buffers in memory.  If callers
   * need the full column arrays they should call ingestAllColumns() directly or
   * use this method, which always returns fresh data.
   *
   * For a combined "get columns AND pre-warm the base IR frame" call, use
   * getOrIngestWithColumns() below.
   */
  async getColumnarData(file: File): Promise<IngestColumnsResult> {
    return ingestAllColumns(file);
  }

  /**
   * Combined file-add operation: get columnar data AND pre-warm the base IR frame.
   *
   * This performs at most 2 file reads (ingestAllColumns + ingestFile), stores
   * the base SignalFrame in the cache, and returns the full IngestColumnsResult.
   *
   * Preferred over calling getColumnarData() + getOrIngest() separately because
   * it avoids a redundant ingestAllColumns() call on the second request.
   *
   * Typical usage at file-add time:
   *   const colsResult = await engine.getOrIngestWithColumns(file);
   *   // Use colsResult for UI (headers, singleValueColumns, columnUniqueCounts)
   *   // The base SignalFrame is now cached — zero extra reads at run time.
   */
  async getOrIngestWithColumns(file: File): Promise<IngestColumnsResult> {
    // Always fetch columnar data (needed for the full columns map).
    const colsResult = await ingestAllColumns(file);

    // Pre-warm the base frame only if not already cached.
    if (!this.cache.has(file /* no hints */)) {
      this._stats.misses++;
      const packet = await ingestFile(file);
      const frame: SignalFrame = {
        packet,
        headers:            colsResult.headers,
        singleValueColumns: colsResult.singleValueColumns,
        capturedVars:       colsResult.capturedVars,
        cacheKey:     fileFingerprint(file),
        hintsKey:     makeHintsKey(undefined),
        ingestedAt:   Date.now(),
        schemaVersion: IRCache.SCHEMA_VERSION,
      };
      this.cache.set(file, undefined, frame);
    } else {
      this._stats.hits++;
    }

    return colsResult;
  }

  // ── Cache management ───────────────────────────────────────────────────────

  /**
   * Invalidate ALL cached frames for a file.
   * Call when the file is removed from the pipeline.
   */
  invalidate(file: File): void {
    this.cache.invalidate(file);
  }

  /** Clear the entire cache and reset statistics. */
  clear(): void {
    this.cache.clear();
    this._stats = { hits: 0, misses: 0 };
  }

  // ── Inspection ─────────────────────────────────────────────────────────────

  /** Cache hit/miss statistics and current cache size. */
  getStats(): IREngineStats {
    return { ...this._stats, size: this.cache.size };
  }

  /** JSON-safe manifest of all cached frames (for debug / export). */
  getManifest(): IRManifestEntry[] {
    return this.cache.getManifest();
  }
}

