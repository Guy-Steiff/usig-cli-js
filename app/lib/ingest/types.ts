/**
 * app/lib/ingest/types.ts
 *
 * Canonical data model for the JS signal ingestion layer.
 *
 * Mirrors the unified_signal canonical data model (Section 2) but expressed in
 * TypeScript. All analysis plugins receive a WaveformPacket — never a File,
 * never a CSV string.
 *
 * Future path:
 *   JS (browser)  →  Python backend (unified_signal)  →  C/C++ DSP core
 *
 * The WaveformPacket shape is intentionally close to unified_signal's
 * (waveform: np.ndarray[float32], metadata: dict) tuple so serialisation
 * (JSON metadata + binary payload over fetch/WebSocket) is straightforward.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Canonical source format
// ─────────────────────────────────────────────────────────────────────────────

export type SourceFormat =
  | 'csv'
  | 'txt'
  | 'xlsx'
  | 'bin'
  | 'json'
  | 'hdf5'
  | 'unknown';

// ─────────────────────────────────────────────────────────────────────────────
// Preserved waveform arrays
// ─────────────────────────────────────────────────────────────────────────────

export interface WaveformArray {
  label: string;
  waveform: Float32Array;
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical waveform metadata
// ─────────────────────────────────────────────────────────────────────────────

export interface WaveformMetadata {
  // Provenance
  sourceFile?: string;
  captureTimestamp?: string;
  instrument?: string;
  processingHistory?: string[];

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

  // Metadata / provenance
  metadataSources?: Record<string, unknown>;
  userOverrides?: Record<string, unknown>;
  inferredFields?: string[];

  // Allow ingestion-specific metadata such as:
  // fs, fftLength, toneMode, device, acquisitionMode, etc.
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical waveform packet
// ─────────────────────────────────────────────────────────────────────────────

export interface WaveformPacket {
  /**
   * Primary/compatibility waveform.
   *
   * For multi-array table ingestion this normally references the first
   * preserved waveform array.
   */
  waveform: Float32Array;

  /**
   * All independently preserved varying numeric columns.
   */
  arrays?: WaveformArray[];

  /**
   * Compatibility alias for older consumers.
   *
   * Normally references the same array objects as `arrays`.
   */
  channels?: WaveformArray[];

  /**
   * All metadata associated with the packet.
   */
  metadata: WaveformMetadata;
}