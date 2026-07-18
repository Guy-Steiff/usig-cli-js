/**
 * binReader.ts — Browser-native oscilloscope binary waveform reader
 *
 * Supports:
 *   - Keysight / Agilent  .bin files  (magic bytes: 'AG')
 *   - Rigol               .bin files  (magic bytes: 'RG')
 *
 * All parsing uses DataView on an ArrayBuffer — no Node.js dependencies.
 * Designed for use in Next.js API routes (Node) AND browser client code.
 *
 * Usage
 * -----
 *   // From a File object (browser / <input type="file">):
 *   const buf = await file.arrayBuffer();
 *   const meta = parseBinMetadata(buf, file.name);
 *
 *   // From a fetch response (API route):
 *   const buf = await response.arrayBuffer();
 *   const meta = parseBinMetadata(buf, 'capture.bin');
 */

// ─────────────────────────────────────────────────────────────────────────────
// Unit-code translation  (same as Python bin_reader.py)
// ─────────────────────────────────────────────────────────────────────────────

const UNITS_MAP: Record<number, string> = {
  1: 'Volts',
  2: 'Seconds',
  3: 'Constant',
  4: 'Amps',
  5: 'dB',
  6: 'Hz',
};

/**
 * Resolve a units code from the Keysight/Rigol waveform header.
 * Some firmware versions store units as a 4-byte integer enum; others store
 * a short ASCII string in the same field (e.g. " V  " → 0x20562020 → 543162400).
 * We try the numeric lookup first, then fall back to parsing the bytes as ASCII.
 */
function resolveUnitsCode(code: number): string {
  if (UNITS_MAP[code]) return UNITS_MAP[code];
  // Interpret the 4-byte int as an ASCII string (little-endian: byte0 is LSB)
  const chars = [
    (code      ) & 0xFF,
    (code >>  8) & 0xFF,
    (code >> 16) & 0xFF,
    (code >> 24) & 0xFF,
  ].map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '').join('').trim();
  if (chars.length > 0) {
    const lc = chars.toLowerCase();
    if (lc === 'v'  || lc === 'volt' || lc === 'volts') return 'Volts';
    if (lc === 'a'  || lc === 'amp'  || lc === 'amps')  return 'Amps';
    if (lc === 's'  || lc === 'sec'  || lc === 'second' || lc === 'seconds') return 'Seconds';
    if (lc === 'hz' || lc === 'hertz') return 'Hz';
    if (lc === 'db' || lc === 'dbv' || lc === 'dbm') return 'dB';
    return chars;  // return the raw ASCII string so the UI can show it
  }
  return `code:${code}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public metadata type
// ─────────────────────────────────────────────────────────────────────────────

export interface BinFileMetadata {
  /** 'Keysight/Agilent' | 'Rigol' | 'unknown' */
  vendor: string;
  /** e.g. 'MSO-X 4154A', 'DHO804' */
  deviceModel: string;
  /** e.g. '2020-11-22'  — empty string if not stored in file */
  captureDate: string;
  /** e.g. '18:52:30'    — empty string if not stored in file */
  captureTime: string;

  /** Samples per second (derived from x_increment) */
  sampleRateHz: number;
  /** Total number of samples in the first waveform */
  numSamples: number;
  /** Number of waveforms / channels stored in the file */
  numWaveforms: number;

  /** Time between adjacent samples (seconds) */
  xIncrement: number;
  /** Time of the first sample (seconds) */
  xOrigin: number;
  /** Display window width (seconds) */
  xDisplayRange: number;

  /** 'Volts' | 'Seconds' | 'Amps' | 'dB' | 'Hz' | … */
  xUnits: string;
  yUnits: string;

  /**
   * Y-axis scaling (from waveform header).
   * Physical value = (raw_code - yReference) * yIncrement + yOrigin
   * These are embedded in Keysight/Agilent files; for float32 captures the
   * samples are already in physical units (the scaling has been applied by the scope).
   */
  yIncrement: number;
  yOrigin: number;
  yReference: number;

  /** Format version integer (1, 3, or 10) */
  formatVersion: number;
  /** Bits per sample point */
  bitsPerPoint: number;
  /** Waveform type code */
  waveformType: number;
  /** Segment index (for segmented-memory captures) */
  segmentIndex: number;
  /** Full frame/model label from file (e.g. 'MSO-X 4154A:MY12345678') */
  frameLabel: string;
  /** File size as reported in the header (bytes) */
  fileSizeBytes: number;

  /** Original filename */
  sourceFile: string;

  /** Set to a description if parsing failed */
  parseError?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Read a null-terminated / fixed-width ASCII string from a DataView. */
function readString(view: DataView, byteOffset: number, length: number): string {
  const bytes: number[] = [];
  for (let i = 0; i < length; i++) {
    const b = view.getUint8(byteOffset + i);
    if (b === 0) break;
    bytes.push(b);
  }
  return String.fromCharCode(...bytes).trim();
}

/** Detect vendor from the first 2 bytes ('AG' or 'RG'). */
export function detectBinVendor(buffer: ArrayBuffer): 'keysight' | 'rigol' | null {
  const bytes = new Uint8Array(buffer, 0, 2);
  const magic = String.fromCharCode(bytes[0], bytes[1]);
  if (magic === 'AG') return 'keysight';
  if (magic === 'RG') return 'rigol';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core parser  (Keysight and Rigol share the same binary layout)
// ─────────────────────────────────────────────────────────────────────────────

/** Parse metadata from an AG (Keysight) or RG (Rigol) binary waveform file. */
function parseAgRgMetadata(
  view: DataView,
  vendorName: string,
  sourceFile: string,
): BinFileMetadata {
  let offset = 2; // skip magic bytes

  // ── File header ──────────────────────────────────────────────────────────
  const versionStr = readString(view, offset, 2);
  const version = parseInt(versionStr, 10);
  offset += 2;

  let fileSizeBytes: number;
  let numWaveforms: number;

  if (version === 1 || version === 10) {
    fileSizeBytes = view.getUint32(offset, true); offset += 4;
    numWaveforms  = view.getUint32(offset, true); offset += 4;
    // file header total: magic(2) + version(2) + size(4) + waveforms(4) = 12 bytes
  } else if (version === 3) {
    // 64-bit size — JavaScript can't represent >2^53 exactly but that's fine for metadata
    const lo = view.getUint32(offset, true);
    const hi = view.getUint32(offset + 4, true);
    fileSizeBytes = lo + hi * 2 ** 32; offset += 8;
    numWaveforms  = view.getUint32(offset, true); offset += 4;
    // file header total: magic(2) + version(2) + size(8) + waveforms(4) = 16 bytes
  } else {
    throw new Error(`Unsupported format version: ${version}`);
  }

  // ── Waveform header ───────────────────────────────────────────────────────
  // The waveform header block starts with a int32 size (includes itself = 140 bytes)
  const whLen = view.getInt32(offset, true);
  const wh = new DataView(view.buffer, view.byteOffset + offset, whLen);
  offset += whLen;

  // Struct layout: "5if3d2i16s16s24s16sdI"  (all little-endian, no padding)
  // Byte offsets within the waveform-header block (byte 0 is the length byte = size field):
  //   [  0] size       int32
  //   [  4] wave_type  int32
  //   [  8] buffers    int32
  //   [ 12] points     int32
  //   [ 16] average    int32    (5th 'i' of '5i')
  //   [ 20] x_d_range  float32  ('f')
  //   [ 24] x_d_origin float64  (first of '3d')
  //   [ 32] x_increment float64
  //   [ 40] x_origin   float64
  //   [ 48] x_units    int32    (first of '2i')
  //   [ 52] y_units    int32
  //   [ 56] date       16 bytes
  //   [ 72] time       16 bytes
  //   [ 88] frame      24 bytes
  //   [112] label      16 bytes
  //   [128] time_tags  float64
  //   [136] segment    uint32
  const wave_type    = wh.getInt32(4,  true);
  const num_buffers  = wh.getInt32(8,  true);
  const points       = wh.getInt32(12, true);
  const x_d_range    = wh.getFloat32(20, true);
  const x_d_origin   = wh.getFloat64(24, true);
  const x_increment  = wh.getFloat64(32, true);
  const x_origin     = wh.getFloat64(40, true);
  const x_units_code = wh.getInt32(48, true);
  const y_units_code = wh.getInt32(52, true);
  const dateStr      = readString(wh, 56, 16);
  const timeStr      = readString(wh, 72, 16);
  const frameStr     = readString(wh, 88, 24);
  const segment      = wh.getUint32(136, true);

  void num_buffers; // referenced for structure clarity

  const sampleRateHz = x_increment > 0 ? 1.0 / x_increment : 0;
  const deviceModel  = frameStr.split(':')[0].trim();

  return {
    vendor:         vendorName,
    deviceModel,
    captureDate:    dateStr,
    captureTime:    timeStr,
    sampleRateHz,
    numSamples:     points,
    numWaveforms,
    xIncrement:     x_increment,
    xOrigin:        x_origin,
    xDisplayRange:  x_d_range,
    xUnits:         resolveUnitsCode(x_units_code),
    yUnits:         resolveUnitsCode(y_units_code),
    yIncrement:     0,   // filled in below (for raw-code captures only; float32 captures are pre-scaled)
    yOrigin:        0,
    yReference:     0,
    formatVersion:  version,
    bitsPerPoint:   0,  // filled in below from data header
    waveformType:   wave_type,
    segmentIndex:   segment,
    frameLabel:     frameStr,
    fileSizeBytes,
    sourceFile,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract metadata from a Keysight/Agilent or Rigol .bin file.
 *
 * @param buffer     ArrayBuffer of the .bin file contents
 * @param sourceFile Original filename (used only for the metadata record)
 * @returns          BinFileMetadata — all available fields, or `parseError` set on failure
 */
export function parseBinMetadata(
  buffer: ArrayBuffer,
  sourceFile: string,
): BinFileMetadata {
  const empty: BinFileMetadata = {
    vendor: 'unknown', deviceModel: '', captureDate: '', captureTime: '',
    sampleRateHz: 0, numSamples: 0, numWaveforms: 0,
    xIncrement: 0, xOrigin: 0, xDisplayRange: 0,
    xUnits: '', yUnits: '', yIncrement: 0, yOrigin: 0, yReference: 0,
    formatVersion: 0, bitsPerPoint: 0,
    waveformType: 0, segmentIndex: 0, frameLabel: '', fileSizeBytes: 0,
    sourceFile,
  };

  const vendor = detectBinVendor(buffer);
  if (!vendor) {
    return {
      ...empty,
      vendor: 'unknown',
      parseError: 'No legacy instrument header detected.',
    };
}

  try {
    const view = new DataView(buffer);
    const meta = parseAgRgMetadata(
      view,
      vendor === 'keysight' ? 'Keysight/Agilent' : 'Rigol',
      sourceFile,
    );

    // Parse data header for bitsPerPoint
    // File header size: magic(2)+version(2)+size(4)+waveforms(4)=12  for v1/10
    //                   magic(2)+version(2)+size(8)+waveforms(4)=16  for v3
    const fhSize = (meta.formatVersion === 3) ? 16 : 12;
    // Waveform header length is stored as int32 in the first 4 bytes of the wh block
    const whLen2 = view.getInt32(fhSize, true);
    const dhOffset = fhSize + whLen2;
    const dhLen = view.getInt32(dhOffset, true); // data header also starts with its size as int32
    const dh = new DataView(buffer, dhOffset, dhLen);
    const bpp = dh.getInt16(6, true); // DataHeader: size(4) data_type(2) bpp(2)
    meta.bitsPerPoint = bpp;

    return meta;
  } catch (err) {
    return { ...empty, vendor: vendor === 'keysight' ? 'Keysight/Agilent' : 'Rigol',
      parseError: String(err) };
  }
}

/**
 * Convert BinFileMetadata to a flat key→value record suitable for
 * display in the per-file metadata suggestion panel.
 *
 * Non-empty / non-zero fields only are included.
 */
export function binMetaToSuggestions(meta: BinFileMetadata): Record<string, string> {
  const out: Record<string, string> = {};

  const add = (key: string, val: string | number | undefined) => {
    if (val === undefined || val === null || val === '' || val === 0) return;
    out[key] = String(val);
  };

  add('vendor',          meta.vendor);
  add('device_model',    meta.deviceModel);
  add('capture_date',    meta.captureDate);
  add('capture_time',    meta.captureTime);
  add('sample_rate_hz',  meta.sampleRateHz);
  add('num_samples',     meta.numSamples);
  add('num_waveforms',   meta.numWaveforms);
  add('x_increment',     meta.xIncrement);
  add('x_origin',        meta.xOrigin);
  add('x_units',         meta.xUnits);
  add('y_units',         meta.yUnits);
  add('format_version',  meta.formatVersion);
  add('bits_per_point',  meta.bitsPerPoint);
  add('segment_index',   meta.segmentIndex);
  add('frame_label',     meta.frameLabel);

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingestion helpers — extract raw samples at the pipeline level
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the raw waveform samples from a Keysight/Rigol .bin ArrayBuffer.
 * Returns a Float32Array (or Uint8Array for 8-bit captures).
 * Throws if the file cannot be parsed.
 */
export function readBinSamples(
  buffer: ArrayBuffer,
  meta: BinFileMetadata,
  waveformIndex = 0,
): Float32Array | Uint8Array {
  const view = new DataView(buffer);
  const fhSize = meta.formatVersion === 3 ? 16 : 12;
  const total = Math.max(1, meta.numWaveforms || 1);
  const target = Math.min(Math.max(Math.trunc(waveformIndex), 0), total - 1);

  let cursor = fhSize;
  let dataOffset = 0;
  let dataLen = 0;
  let selectedBpp = meta.bitsPerPoint;

  for (let i = 0; i <= target; i++) {
    const whLen = view.getInt32(cursor, true);
    const dhOffset = cursor + whLen;
    const dhLen = view.getInt32(dhOffset, true);
    const dh = new DataView(buffer, dhOffset, dhLen);
    const bpp = dh.getInt16(6, true);
    const points = view.getInt32(cursor + 12, true);
    const bytesPerSample = bpp === 8 ? 1 : 4;

    dataOffset = dhOffset + dhLen;
    dataLen = Math.max(0, points * bytesPerSample);
    selectedBpp = bpp;
    cursor = dataOffset + dataLen;
    if (cursor > buffer.byteLength) throw new Error('Corrupt BIN: waveform block exceeds file length.');
  }

  if (dataLen <= 0) throw new Error('No sample data found after headers.');

  if (selectedBpp === 8) {
    return new Uint8Array(buffer, dataOffset, dataLen);
  }
  return new Float32Array(buffer, dataOffset, Math.floor(dataLen / 4));
}

/**
 * Convert a .bin file into a synthetic CSV File object that the rest of the
 * pipeline can consume transparently — zero plugin changes required.
 *
 * Column layout:
 *   samples   — raw ADC / voltage values (one row per sample)
 *
 * The synthetic File's name keeps the original stem but uses .csv extension
 * so parseCsv() in PipelineBlock accepts it. The original .bin File object is
 * passed through as-is for display purposes; only the returned File is fed to
 * plugins.
 *
 * @param binFile   Original File object (.bin)
 * @param buffer    ArrayBuffer already loaded from binFile
 * @param meta      Parsed BinFileMetadata
 * @returns         Synthetic CSV File with header "samples\n<val>\n..."
 */
// ─────────────────────────────────────────────────────────────────────────────
// Raw-samples side-channel
//
// Plugin parseSamples() normally reads a CSV column by name. For bin files that
// would require serialising millions of floats to a string and re-parsing them —
// extremely slow. Instead, we register the typed array here keyed on the File
// object. parseSamples() checks this cache first and returns the typed array
// directly if present, bypassing all CSV logic.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WeakMap<File, { colName: string; samples: Float32Array | Uint8Array }>
 *
 * Populated by binToFile(); consumed by parseSamples() in smeasPlugin (and any
 * other plugin that calls file.text() to read columnar data).
 *
 * Keyed on the *synthetic* File object returned by binToFile() so that the entry
 * is GC'd as soon as the File is no longer referenced.
 */
export const binSamplesCache = new WeakMap<
  File,
  { colName: string; samples: Float32Array | Uint8Array }
>();

/**
 * Create a lightweight synthetic File object for a .bin waveform and register
 * its samples in binSamplesCache so plugins can retrieve them without CSV parsing.
 *
 * The returned File has an empty body — it is only used as a WeakMap key and for
 * its .name property. Plugins MUST check binSamplesCache before calling file.text().
 *
 * @param binFile   Original .bin File (used only for the synthetic file name)
 * @param data      Pre-extracted typed array OR ArrayBuffer (extracted internally)
 * @param meta      Parsed BinFileMetadata
 */
export function binToFile(
  binFile: File,
  data: ArrayBuffer | Float32Array | Uint8Array,
  meta: BinFileMetadata,
): File {
  const samples: Float32Array | Uint8Array =
    data instanceof ArrayBuffer ? readBinSamples(data, meta) : data;
  const colName = (meta.yUnits && meta.yUnits !== '') ? meta.yUnits : 'samples';

  // Build a minimal stub CSV (header only) so parseCsv() doesn't throw on length check.
  // The actual data is served from binSamplesCache, never from the CSV text.
  const stubCsv = colName + '\n0\n';  // header + one dummy row so parseCsv length guard passes
  const csvName = binFile.name.replace(/\.bin$/i, '.bin.csv');
  const syntheticFile = new File([stubCsv], csvName, { type: 'text/csv' });

  binSamplesCache.set(syntheticFile, { colName, samples });
  return syntheticFile;
}













