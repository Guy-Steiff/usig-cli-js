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

export type SourceFormat =
  | 'csv'
  | 'txt'
  | 'xlsx'
  | 'bin'
  | 'json'
  | 'hdf5'
  | 'unknown';

// export type SignalUnits =
//   | 'volts'
//   | 'amps'
//   | 'adc_codes'
//   | 'dbm'
//   | 'normalized'
//   | string;

export interface WaveformArray {
  label: string;
  waveform: Float32Array;
}

export interface WaveformMetadata {
  // Provenance
  sourceFile?: string;
  captureTimestamp?: string;
  instrument?: string;
  processingHistory?: string[];

  // Scaling / units
  units?: SignalUnits;

  // Binary format
  endianness?: 'little' | 'big';
  signed?: boolean;
  bitDepth?: number;
  storageBitDepth?: number;
  headerBytes?: number;

  // Multi-channel
  channels?: number;
  channelLabels?: string[];
  channelIndex?: number;

  // General metadata / provenance
  metadataSources?: Record<string, unknown>;
  userOverrides?: Record<string, unknown>;
  inferredFields?: string[];

  // Allow ingestion-specific metadata such as fs,
  // fftLength, toneMode, etc.
  [key: string]: unknown;
}

export interface WaveformPacket {
  waveform: Float32Array;
  metadata: WaveformMetadata;

  /**
   * All varying numeric columns preserved by table ingestion.
   */
  arrays?: WaveformArray[];

  /**
   * Compatibility alias for arrays.
   */
  channels?: WaveformArray[];
}

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

/**
 * One independently preserved varying column from a tabular source.
 *
 * A table may contain multiple waveform-like arrays:
 *   time, voltage, frequency, I, Q, etc.
 *
 * The mapper deliberately does not decide which one is "the signal".
 */
export interface WaveformArray {
  label: string;
  waveform: Float32Array;
}

export interface WaveformPacket {
  /** Primary/compatibility waveform — normally the first array. */
  waveform: Float32Array;

  /** All preserved varying arrays from tabular ingestion. */
  arrays?: WaveformArray[];

  /**
   * Compatibility alias for older consumers.
   * Normally references the same array objects as `arrays`.
   */
  channels?: WaveformArray[];

  /** All metadata for this packet. */
  metadata: WaveformMetadata;
}

export interface WaveformPacket {
  /** Normalised sample array — dtype float32, one sample per element. */
  waveform: Float32Array;
  /** All metadata for this packet. */
  metadata: WaveformMetadata;
}
