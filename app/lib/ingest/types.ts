/**
 * app/lib/ingest/types.ts
 *
 * Canonical data model for the JS signal ingestion layer.
 *
 * Mirrors the unified_signal canonical data model (Section 2) but expressed in
 * TypeScript.  All analysis plugins receive a WaveformPacket — never a File,
 * never a CSV string.
 *
 * Future path:
 *   JS (browser)  →  Python backend (unified_signal)  →  C/C++ DSP core
 * The WaveformPacket shape is intentionally close to unified_signal's
 * (waveform: np.ndarray[float32], metadata: dict) tuple so serialisation
 * (JSON metadata + binary payload over fetch/WebSocket) is straightforward.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Canonical metadata — mirrors unified_signal Section 2
// ─────────────────────────────────────────────────────────────────────────────

export type SourceFormat = 'csv' | 'txt' | 'xlsx' | 'bin' | 'json' | 'hdf5' | 'unknown';
export type SignalUnits  = 'volts' | 'amps' | 'adc_codes' | 'dbm' | 'normalized' | string;

/**
 * Optional metadata fields — may be present depending on source and analysis.
 * Corresponds to unified_signal OPTIONAL_METADATA.
 */
export interface WaveformMetadata {
  // ── Provenance ────────────────────────────────────────────────────────────
  sourceFile?: string;
  captureTimestamp?: string;      // ISO 8601
  instrument?: string;            // e.g. 'Keysight MSO-X 4154A'
  processingHistory?: string[];   // append-only transformation log

  // ── Scaling & units ───────────────────────────────────────────────────────
  units?: SignalUnits;

  // ── Binary format specifics ───────────────────────────────────────────────
  endianness?: 'little' | 'big';
  signed?: boolean;
  bitDepth?: number;              // Effective bit depth (e.g. 12 for 12-bit ADC)
  storageBitDepth?: number;       // Storage bit depth (e.g. 16 for packed 12-bit)
  headerBytes?: number;

  // ── Multi-channel ─────────────────────────────────────────────────────────
  channels?: number;
  channelLabels?: string[];
  channelIndex?: number;          // 0-based index of this packet within a multi-channel capture

  // ── Provenance tracking (mirrors unified_signal) ──────────────────────────
  userOverrides?: Record<string, unknown>;
  inferredFields?: string[];      // fields that were inferred, not declared
}

export interface WaveformPacket {
  /** Normalised sample array — dtype float32, one sample per element. */
  waveform: Float32Array;
  /** All metadata for this packet. */
  metadata: WaveformMetadata;
}
