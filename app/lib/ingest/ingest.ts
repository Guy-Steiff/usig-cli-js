/**
 * app/lib/ingest/ingest.ts
 *
 * Ingestion layer — the ONLY place in the JS codebase that reads raw File bytes.
 *
 * Entry points:
 *   ingestFile(file, hints)    → WaveformPacket          (single signal column)
 *   ingestAllColumns(file)     → IngestColumnsResult     (all columns, pipeline UI)
 *
 * Architecture (mirrors unified_signal Section 3):
 *
 *   File
 *    │
 *    ▼ detectFormat()  ← magic bytes → extension
 *    ├─ 'bin'  → ingestBin()   ← Keysight/Rigol binary parsers
 *    ├─ 'csv'  → ingestCsv()   ← column selection + optional fs-column extraction
 *    ├─ 'xlsx' → ingestXlsx()  ← first worksheet, CSV-like column selection
 *    └─ 'txt'  → ingestTxt()   ← plain-text: one/many values per line, optional header,
 *                                  comment stripping (#), space/tab/comma delimited,
 *                                  columnar or flat.  Extensions: .txt .dat .tsv .asc
 *    (future: 'json', 'hdf5')
 *    │
 *    ▼
 *   WaveformPacket { waveform: Float32Array, metadata: WaveformMetadata }
 *    │
 *    ▼  ← passed to analysis plugins.  Plugins NEVER receive a File or CSV string.
 *   Analyzer Arsenal (smeas, sinl, hsio, …)
 *
 * Metadata precedence (mirrors unified_signal Section 2):
 *   1. hints (user/pipeline overrides)   ← highest priority
 *   2. Embedded file metadata            ← binary headers, CSV column names
 *   3. Inferred                          ← marked in inferredFields[]
 */

import { parseBinMetadata, readBinSamples } from '../binReader';
import type { WaveformPacket, WaveformMetadata } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Ingest hints — user / pipeline overrides (precedence level 1)
// ─────────────────────────────────────────────────────────────────────────────

export interface IngestHints {
  /** For CSV/TXT: which column contains the signal data. */
  signalColumn?: string;
  /**
   * When true (single_sided_power_spectrum mode): keep row order intact and
   * substitute -Infinity for unparseable cells instead of skipping them.
   */
  preserveBinIndex?: boolean;
  /** For generic binary: endianness. */
  endianness?: 'little' | 'big';
  /** For multi-waveform BIN files: 0-based waveform/channel index to ingest. */
  channelIndex?: number;
  /** Bytes to skip before sample data (generic binary). */
  headerBytes?: number;
  /** Physical units of the signal. */
  units?: WaveformMetadata['units'];
  /** 0-based first sample index to ingest (inclusive). */
  startSample?: number;
  /** 0-based last sample index to ingest (inclusive). */
  endSample?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-column inspection result
// Used by the pipeline at file-add time to populate headers, propose metadata
// columns as plugin-param candidates, and seed the column-select heuristic.
// ─────────────────────────────────────────────────────────────────────────────

export interface IngestColumnsResult {
  /** Ordered column names from the file. */
  headers: string[];

  /** Parsed numeric data keyed by column name. */
  columns: Record<string, Float32Array>;

  /**
   * Columns where every non-empty value is identical.
   * Useful for UI display only.
   * Plugins decide whether such values are meaningful parameters.
   */
  singleValueColumns: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline-level filename variable extraction
// Broad, domain-agnostic patterns — no plugin-specific knowledge here.
// Returns SI base-unit values (Hz, bits, volts).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a numeric string that may include:
 *   - decimal point:        "2.25"
 *   - p-decimal encoding:   "2p25" → 2.25
 *   - scientific notation:  "2.25e9", "2e9"
 *   - unit suffix handled externally
 */
function parseEncodedNumber(s: string): number {
  return parseFloat(s.replace(/p(?=\d)/gi, '.'));
}

/**
 * Normalise a frequency value + unit string → Hz.
 * unitStr is lower-cased before comparison.
 * Falls back to GHz if no unit is recognisable (legacy smeas convention).
 */
// function freqToHz(value: number, unitStr: string): number {
//   const u = unitStr.toLowerCase();
//   if (u.includes('ghz')) return value * 1e9;
//   if (u.includes('mhz')) return value * 1e6;
//   if (u.includes('khz')) return value * 1e3;
//   if (u.includes('hz'))  return value;
//   // No unit — honour scientific notation first (e.g. 2.25e9 ≈ Hz scale → Hz)
//   // Heuristic: if value >= 1e6 it's probably already in Hz; otherwise assume GHz.
//   return value >= 1e6 ? value : value * 1e9;
// }

/**
 * Extract pipeline-level captured variables from a filename.
 * Returns a map of well-known keys → SI values.
 */
// export function extractCapturedVarsFromFilename(filename: string): Record<string, number> {
//   const result: Record<string, number> = {};
//   const name = filename.replace(/\.[^.]+$/, ''); // strip extension
//
//   // ── Sampling frequency (fs) ──────────────────────────────────────────────
//   // Matches: fs2p25ghz, FS_2250MHz, sample_rate_1e9, samplerate44p1kHz, fs2.25e9
//   const fsMatch = name.match(
//     /(?:sample[_\-]?rate|[Ff][Ss])[_\-]?(\d+(?:[.,p]\d+)?(?:e[+\-]?\d+)?)\s*(GHz|MHz|kHz|Hz)?/i
//   );
//   if (fsMatch) {
//     const raw  = fsMatch[1].replace(',', '.');
//     const unit = fsMatch[2] ?? '';
//     const val  = parseEncodedNumber(raw);
//     if (!isNaN(val) && val > 0) result['fs_hz'] = freqToHz(val, unit);
//   }
//
//   // ── Input / fundamental frequency (fin) ─────────────────────────────────
//   // Matches: fin100mhz, f_in_100MHz, fin100p5MHz
//   const finMatch = name.match(
//     /\bf[_\-]?in[_\-]?(\d+(?:[.,p]\d+)?(?:e[+\-]?\d+)?)\s*(GHz|MHz|kHz|Hz)?/i
//   );
//   if (finMatch) {
//     const raw  = finMatch[1].replace(',', '.');
//     const unit = finMatch[2] ?? '';
//     const val  = parseEncodedNumber(raw);
//     if (!isNaN(val) && val > 0) result['fin_hz'] = freqToHz(val, unit);
//   }
//
//   // ── ADC bits ─────────────────────────────────────────────────────────────
//   // Matches: 12bit, 12b, 12bits, adc12, adc_12b
//   const bitsMatch = name.match(/(?:adc[_\-]?)?(\d{1,2})[_\-]?bits?\b/i)
//     ?? name.match(/\badc[_\-]?(\d{1,2})\b/i);
//   if (bitsMatch) {
//     const val = parseInt(bitsMatch[1], 10);
//     if (!isNaN(val) && val >= 4 && val <= 32) result['adc_bits'] = val;
//   }
//
//   // ── Full-scale Vpp ───────────────────────────────────────────────────────
//   // Matches: vfs2v, vpp2.0v, vfs_2p0, fullscale2v
//   const vfsMatch = name.match(
//     /(?:v(?:fs|pp|fullscale)|fullscale)[_\-]?(\d+(?:[.,p]\d+)?(?:e[+\-]?\d+)?)\s*v?\b/i
//   );
//   if (vfsMatch) {
//     const raw = vfsMatch[1].replace(',', '.');
//     const val = parseEncodedNumber(raw);
//     if (!isNaN(val) && val > 0) result['vfs_pp'] = val;
//   }
//
//   return result;
// }

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

type IngestFormat = 'bin' | 'csv' | 'txt' | 'xlsx';

function detectFormat(file: File, buffer: ArrayBuffer): IngestFormat {
  const magic   = new Uint8Array(buffer, 0, 2);
  const magicStr = String.fromCharCode(magic[0], magic[1]);
  if (magicStr === 'AG' || magicStr === 'RG') return 'bin';
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'bin' || ext === 'raw') return 'bin';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'csv') return 'csv';
  // .txt, .dat, .tsv, .asc, and anything else → plain-text path
  return 'txt';
}

function xlsxCellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const v = value as { text?: unknown; result?: unknown; richText?: Array<{ text?: unknown }> };
    if (typeof v.text === 'string') return v.text.trim();
    if (v.result !== undefined && v.result !== null) return String(v.result).trim();
    if (Array.isArray(v.richText)) return v.richText.map(rt => String(rt?.text ?? '')).join('').trim();
  }
  return String(value).trim();
}

async function parseXlsxTable(file: File): Promise<{ headers: string[]; dataRows: string[][] }> {
  const excelJsMod = await import('exceljs');
  const ExcelJS = excelJsMod.default ?? excelJsMod;
  const workbook = new ExcelJS.Workbook();
  const buffer = await file.arrayBuffer();
  await workbook.xlsx.load(buffer);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) return { headers: [], dataRows: [] };

  const rows: string[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values = (Array.isArray(row.values) ? row.values.slice(1) : []).map(xlsxCellToString);
    const hasAnyValue = values.some(v => v !== '');
    if (hasAnyValue) rows.push(values);
  });

  if (rows.length === 0) return { headers: [], dataRows: [] };

  const headers = rows[0].map((h, i) => h || `col_${i}`);
  const dataRows = rows.slice(1);
  return { headers, dataRows };
}

const stripCell = (s: string) => s.trim().replace(/^"|"$/g, '');

function sanitizeSampleIndex(v: unknown): number | undefined {
  if (!Number.isFinite(v)) return undefined;
  const n = Math.trunc(Number(v));
  return n >= 0 ? n : 0;
}

function computeSampleSlice(totalLength: number, hints: IngestHints): { start: number; endExclusive: number } {
  if (totalLength <= 0) return { start: 0, endExclusive: 0 };
  const start = Math.min(sanitizeSampleIndex(hints.startSample) ?? 0, totalLength);
  const rawEnd = sanitizeSampleIndex(hints.endSample);
  const endIncl = rawEnd === undefined ? totalLength - 1 : Math.min(rawEnd, totalLength - 1);
  if (endIncl < start) return { start, endExclusive: start };
  return { start, endExclusive: endIncl + 1 };
}

/** Parse a numeric cell, honouring ±Infinity spellings used by Python/numpy. */
function parseNumericCell(cell: string): number {
  const lc = cell.toLowerCase();
  if (lc === 'inf'  || lc === '+inf'  || lc === 'infinity'  || lc === '+infinity') return  Infinity;
  if (lc === '-inf' || lc === '-infinity') return -Infinity;
  return parseFloat(cell);
}


// ─────────────────────────────────────────────────────────────────────────────
// Binary ingestion
// A USIG BIN is first a portable analysis container that preserves plugin-relevant metadata and waveform data.
// It should be designed so it can evolve toward instrumentation compatibility where feasible,
// but never at the expense of preserving analysis information by default.
// Raw instrument-oriented binaries are an explicit opt-in mode (--raw-bin/--data-only).
//                +----------------------------------+
//                 | Analysis metadata                |
//                 | (plugins care)                   |
//                 +----------------------------------+
//                 | Binary descriptor                |
//                 | (reader cares)                   |
//                 +----------------------------------+
//                 | Waveform bytes                   |
//                 +----------------------------------+
// possible future addition: --profile keysight / --profile rigol to preserve more instrument-specific metadata
//
// ─────────────────────────────────────────────────────────────────────────────
function ingestBin(file: File, buffer: ArrayBuffer, hints: IngestHints): WaveformPacket {
  const binMeta = parseBinMetadata(buffer, file.name);
  if (binMeta.parseError) {
    throw new Error(`Binary parse failed for "${file.name}": ${binMeta.parseError}`);
  }
  const requestedChannel = Number.isInteger(hints.channelIndex)
    ? Number(hints.channelIndex)
    : 0;
  const maxChannel = Math.max(0, (binMeta.numWaveforms || 1) - 1);
  const selectedChannelIndex = Math.min(
    Math.max(requestedChannel, 0),
    maxChannel
  );
  const rawFull = readBinSamples(
    buffer,
    binMeta,
    selectedChannelIndex
  );
  const binSlice = computeSampleSlice(
    rawFull.length,
    hints
  );
  const rawSlice = rawFull.slice(
    binSlice.start,
    binSlice.endExclusive
  );
  const waveform =
    rawSlice instanceof Float32Array
      ? rawSlice
      : new Float32Array(rawSlice);
  const inferred: string[] = [];
  const metadata: WaveformMetadata = {
    sourceFile: file.name,
    instrument: binMeta.deviceModel || undefined,
    captureTimestamp: binMeta.captureDate ? `${binMeta.captureDate}T${binMeta.captureTime || '00:00:00'}` : undefined,
    processingHistory: [`ingested from binary "${file.name}"`],
    userOverrides:
      hints.channelIndex !== undefined
        ? {
            channelIndex: selectedChannelIndex,
          }
        : undefined,
    inferredFields: inferred,

    // Binary encoding information
    bitDepth: binMeta.bitsPerPoint,
    endianness: 'little',

    // Multi-channel information
    channels: binMeta.numWaveforms || 1,
    channelIndex: selectedChannelIndex,

    // Optional: keep this if bin metadata contains it
    units: binMeta.yUnits || undefined,
  };

  return {
    waveform,
    metadata,
  };
}
// ─────────────────────────────────────────────────────────────────────────────
// CSV ingestion
// ─────────────────────────────────────────────────────────────────────────────

function ingestCsv(file: File, text: string, hints: IngestHints): WaveformPacket {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) throw new Error(`"${file.name}" has fewer than 2 lines.`);

  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const headers   = lines[0].split(delimiter).map(stripCell);
  const allRows: string[][] = lines.slice(1).map(l => l.split(delimiter));
  const rowSlice = computeSampleSlice(allRows.length, hints);
  const dataRows = allRows.slice(rowSlice.start, rowSlice.endExclusive);

  // Column selection: hint > most-unique-values heuristic
  let colIdx = -1;
  if (hints.signalColumn) {
    colIdx = headers.indexOf(hints.signalColumn.trim());
    if (colIdx === -1) throw new Error(
      `Column "${hints.signalColumn}" not found in "${file.name}". Available: [${headers.join(', ')}]`
    );
  } else {
    const uniqueCounts = headers.map((_, ci) => new Set(dataRows.map(r => r[ci]?.trim() ?? '')).size);
    let maxU = -1;
    for (let ci = 0; ci < uniqueCounts.length; ci++) { if (uniqueCounts[ci] > maxU) { maxU = uniqueCounts[ci]; colIdx = ci; } }
  }

  const inferred: string[] = [];
  if (!hints.signalColumn) inferred.push('signalColumn');

  const preserveBinIndex = hints.preserveBinIndex ?? false;
  const samples: number[] = [];
  for (const row of dataRows) {
    const cell = stripCell(row[colIdx] ?? '');
    const v    = parseNumericCell(cell);
    if (isNaN(v)) {
      if (preserveBinIndex) samples.push(-Infinity);
      // else: skip (time-domain — a missing code is dropped)
    } else {
      samples.push(v);
    }
  }
  if (samples.length === 0) throw new Error(
    `No numeric samples found in column "${headers[colIdx]}" of "${file.name}".`
  );

  const metadata: WaveformMetadata = {
      sourceFile: file.name,
      units: hints.units,
      processingHistory: [
          `ingested column "${headers[colIdx]}" from CSV "${file.name}"`
      ],
      inferredFields: inferred,
      userOverrides: hints.signalColumn
          ? { signalColumn: hints.signalColumn }
          : undefined,
      channelLabels: [headers[colIdx]],
  };
  return {
      waveform: new Float32Array(samples),
      metadata,
  };
}

async function ingestXlsx(file: File, hints: IngestHints): Promise<WaveformPacket> {
  const { headers, dataRows: allRows } = await parseXlsxTable(file);

  if (headers.length === 0 || allRows.length === 0) {
    throw new Error(`"${file.name}" has no worksheet data rows.`);
  }

  const rowSlice = computeSampleSlice(allRows.length, hints);
  const dataRows = allRows.slice(rowSlice.start, rowSlice.endExclusive);

  let colIdx = -1;

  if (hints.signalColumn) {
    colIdx = headers.indexOf(hints.signalColumn.trim());

    if (colIdx === -1) {
      throw new Error(
        `Column "${hints.signalColumn}" not found in "${file.name}". ` +
        `Available: [${headers.join(', ')}]`
      );
    }
  } else {
    // Automatic selection is only a convenience fallback.
    // Record it as inferred because the user did not specify it.
    const uniqueCounts = headers.map(
      (_, ci) => new Set(dataRows.map(r => r[ci]?.trim() ?? '')).size
    );

    let maxU = -1;

    for (let ci = 0; ci < uniqueCounts.length; ci++) {
      if (uniqueCounts[ci] > maxU) {
        maxU = uniqueCounts[ci];
        colIdx = ci;
      }
    }
  }

  const inferred: string[] = [];

  if (!hints.signalColumn) {
    inferred.push('signalColumn');
  }

  const preserveBinIndex = hints.preserveBinIndex ?? false;

  const samples: number[] = [];

  for (const row of dataRows) {
    const cell = stripCell(row[colIdx] ?? '');
    const value = parseNumericCell(cell);

    if (isNaN(value)) {
      if (preserveBinIndex) {
        samples.push(-Infinity);
      }
    } else {
      samples.push(value);
    }
  }

  if (samples.length === 0) {
    throw new Error(
      `No numeric samples found in column "${headers[colIdx]}" of "${file.name}".`
    );
  }

  const waveform = new Float32Array(samples);

  const metadata: WaveformMetadata = {
    sourceFile: file.name,

    units: hints.units,

    processingHistory: [
      `ingested column "${headers[colIdx]}" from XLSX "${file.name}"`
    ],

    inferredFields: inferred,

    userOverrides: hints.signalColumn
      ? {
          signalColumn: hints.signalColumn,
        }
      : undefined,

    channelLabels: [
      headers[colIdx]
    ],
  };

  return {
    waveform,
    metadata,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TXT ingestion
//
// Handles the full range of plain-text scientific data formats:
//   • One sample per line (flat)              e.g.  123\n456\n789
//   • Multiple values per line (columnar)     e.g.  0  1.23  4.56\n1  2.34  5.67
//   • Optional header row                     first non-comment line with non-numeric tokens
//   • Comment lines stripped                  lines starting with # (Python/numpy convention)
//   • Delimiters: whitespace (space/tab), comma, semicolon — auto-detected
//   • signalColumn hint: column name from header  OR  0-based column index as string
//
// Mirrors unified_signal TXTParser (text.py): np.loadtxt semantics.
// ─────────────────────────────────────────────────────────────────────────────

/** Parse raw TXT content into a structured table (headers + data rows). */
function parseTxtContent(text: string): { headers: string[] | null; dataRows: string[][] } {
  // Strip comment lines (# prefix) and blank lines
  const lines = text
    .split(/\r?\n/)
    .filter(l => { const t = l.trim(); return t.length > 0 && !t.startsWith('#'); });

  if (lines.length === 0) return { headers: null, dataRows: [] };

  // Auto-detect delimiter: tab → space-run → comma → semicolon
  const firstLine = lines[0];
  let delimiter: RegExp;
  if (firstLine.includes('\t'))   delimiter = /\t/;
  else if (/\s{2,}/.test(firstLine)) delimiter = /\s+/;
  else if (firstLine.includes(',')) delimiter = /,/;
  else if (firstLine.includes(';')) delimiter = /;/;
  else                              delimiter = /\s+/;   // fallback: any whitespace

  const splitLine = (l: string): string[] =>
    l.trim().split(delimiter).map(s => s.trim()).filter(s => s.length > 0);

  // Header detection: first line has ANY non-numeric token → it's a header
  const firstTokens = splitLine(firstLine);
  const hasHeader   = firstTokens.some(t => isNaN(parseNumericCell(t)) && t !== '');

  if (hasHeader) {
    return {
      headers:  firstTokens,
      dataRows: lines.slice(1).map(splitLine),
    };
  }
  return {
    headers:  null,            // no header — columns named col_0, col_1, …
    dataRows: lines.map(splitLine),
  };
}

function ingestTxt(file: File, text: string, hints: IngestHints): WaveformPacket {
  const parsed = parseTxtContent(text);

  const allDataRows = parsed.dataRows;

  const rowSlice = computeSampleSlice(
    allDataRows.length,
    hints
  );

  const dataRows = allDataRows.slice(
    rowSlice.start,
    rowSlice.endExclusive
  );

  const headers = parsed.headers;

  if (dataRows.length === 0) {
    throw new Error(`No numeric data found in "${file.name}".`);
  }

  const numCols = dataRows[0].length;

  const colNames: string[] = headers
    ?? Array.from(
      { length: numCols },
      (_, i) => `col_${i}`
    );

  let colIdx = 0;

  if (hints.signalColumn) {
    const byName = colNames.indexOf(
      hints.signalColumn.trim()
    );

    if (byName !== -1) {
      colIdx = byName;
    } else {
      const byIndex = parseInt(
        hints.signalColumn.trim(),
        10
      );

      if (!isNaN(byIndex) &&
          byIndex >= 0 &&
          byIndex < numCols) {
        colIdx = byIndex;
      } else {
        throw new Error(
          `Column "${hints.signalColumn}" not found in "${file.name}". ` +
          `Available: [${colNames.join(', ')}]`
        );
      }
    }
  } else if (numCols > 1) {
    // Convenience fallback only.
    // Mark as inferred because the user did not select a column.
    let maxUnique = -1;

    for (let ci = 0; ci < numCols; ci++) {
      const uniqueCount = new Set(
        dataRows.map(r => r[ci] ?? '')
      ).size;

      if (uniqueCount > maxUnique) {
        maxUnique = uniqueCount;
        colIdx = ci;
      }
    }
  }

  const inferred: string[] = [];

  if (!hints.signalColumn) {
    inferred.push('signalColumn');
  }

  const preserveBinIndex = hints.preserveBinIndex ?? false;

  const samples: number[] = [];

  for (const row of dataRows) {
    const value = parseNumericCell(
      row[colIdx] ?? ''
    );

    if (isNaN(value)) {
      if (preserveBinIndex) {
        samples.push(-Infinity);
      }
    } else {
      samples.push(value);
    }
  }

  if (samples.length === 0) {
    throw new Error(
      `No numeric samples found in column "${colNames[colIdx]}" of "${file.name}".`
    );
  }

  const waveform = new Float32Array(samples);

  const metadata: WaveformMetadata = {
    sourceFile: file.name,

    units: hints.units,

    processingHistory: [
      `ingested column "${colNames[colIdx]}" from text file "${file.name}"`
    ],

    inferredFields: inferred,

    userOverrides: hints.signalColumn
      ? {
          signalColumn: hints.signalColumn,
        }
      : undefined,

    channelLabels: [
      colNames[colIdx],
    ],
  };

  return {
    waveform,
    metadata,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: single-signal ingestion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ingest a File into a canonical WaveformPacket.
 *
 * THIS IS THE ONLY FUNCTION THAT SHOULD READ RAW FILE BYTES FOR SIGNAL DATA.
 * Plugins receive a WaveformPacket — never a File, never a CSV string.
 *
 * @param file   Browser File object
 * @param hints  Optional overrides (sample rate, column, dtype, …)
 */
export async function ingestFile(file: File, hints: IngestHints = {}): Promise<WaveformPacket> {
  const buffer = await file.arrayBuffer();
  const format = detectFormat(file, buffer);
  switch (format) {
    case 'bin': return ingestBin(file, buffer, hints);
    case 'xlsx': return ingestXlsx(file, hints);
    case 'csv':
    case 'txt': {
      const text = await file.text();
      return format === 'csv' ? ingestCsv(file, text, hints) : ingestTxt(file, text, hints);
    }  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: multi-column inspection  (pipeline UI — file-add time)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse ALL columns from a file without selecting a single signal column.
 *
 * Used by the pipeline at file-add time to:
 *  1. Populate the column selector / header list shown to the user.
 *  2. Detect single-value columns (metadata candidates → plugin param proposals).
 *  3. Compute unique-value counts for the column-select auto-seed heuristic.
 *
 * Binary files return a synthetic single-column result derived from the header.
 * This function never throws — errors are returned as an empty result.
 */
export async function ingestAllColumns(file: File): Promise<IngestColumnsResult> {
  try {
    const buffer = await file.arrayBuffer();
    const format = detectFormat(file, buffer);

    if (format === 'bin') {
      const binMeta = parseBinMetadata(buffer, file.name);
      const colName = (binMeta.yUnits && binMeta.yUnits !== '') ? binMeta.yUnits : 'samples';
      const raw     = binMeta.parseError ? new Float32Array(0) : readBinSamples(buffer, binMeta);
      const wf      = (raw as unknown) instanceof Float32Array ? (raw as Float32Array) : new Float32Array(raw as ArrayLike<number>);
    return {
      headers: [colName],
      columns: { [colName]: wf },
      singleValueColumns: {},
    };
    }

    // For tabular formats, parse all columns using the appropriate parser.
    let headers: string[];
    let dataRows: string[][];

    if (format === 'csv') {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
      if (lines.length < 2) {
        return {
          headers: [],
          columns: {},
          singleValueColumns: {},
        };
      }
      const delimiter = lines[0].includes('\t') ? '\t' : ',';
      headers  = lines[0].split(delimiter).map(stripCell);
      dataRows = lines.slice(1).map(l => l.split(delimiter));
    } else if (format === 'xlsx') {
      const table = await parseXlsxTable(file);
      headers = table.headers;
      dataRows = table.dataRows;
      if (headers.length === 0 || dataRows.length === 0) {
        return { headers: [], columns: {}, singleValueColumns: {}};
      }
    } else {
      const text = await file.text();
      // TXT: use the full-featured parser (comment stripping, header detection, etc.)
      const parsed = parseTxtContent(text);
      const numCols = parsed.dataRows[0]?.length ?? 0;
      headers  = parsed.headers ?? Array.from({ length: numCols }, (_, i) => `col_${i}`);
      dataRows = parsed.dataRows;
    }

    const columns:             Record<string, Float32Array> = {};
    const singleValueColumns:  Record<string, string>       = {};

    for (let ci = 0; ci < headers.length; ci++) {
      const h       = headers[ci];
      const rawVals = dataRows.map(r => stripCell(r[ci] ?? ''));
      columns[h]    = new Float32Array(rawVals.map(parseNumericCell));

      const nonEmpty = rawVals.filter(v => v !== '');
      if (nonEmpty.length > 0 && new Set(nonEmpty).size === 1) {
        singleValueColumns[h] = nonEmpty[0];
      }
    }

    return { headers, columns, singleValueColumns };
  } catch {
    return { headers: [], columns: {}, singleValueColumns: {}};
  }
}

export type { WaveformPacket, WaveformMetadata };

