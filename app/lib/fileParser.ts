/**
 * File Parsing Utilities
 *
 * Handles CSV and XLSX file parsing for data analysis.
 * Returns standardized data format for use across components.
 */

import ExcelJS from 'exceljs';

export interface ParsedData {
  headers: string[];
  rows: Record<string, any>[];
  firstNumericVariable?: string;
  fileNameColumns?: Record<string, string | number>; // columns injected from the file name
}

// ─── File-name column inference ───────────────────────────────────────────────
//
// Algorithm: scan the file name (extension stripped) for every NUMBER token.
// For each number:
//   • the word immediately to its LEFT  (separated by any combo of _ - space)
//     becomes the parameter/column name.
//   • the word immediately to its RIGHT (same separators) becomes the unit
//     and is appended to the column name:  <param>_<unit>
//   • if there is no left word, fall back to "param_<n>"
//   • if there is no right word, use just <param> with no unit suffix
//   • a "p" inside the numeric token that is flanked by digits is treated
//     as a decimal point:  123p5 → 123.5,  1p2 → 1.2
//
// Examples:
//   "freq_123p5mhz_temp_85c_chip3"
//     → freq_mhz = 123.5,  temp_c = 85,  chip = 3
//
//   "enob_snr_x2p4ghz_ss_corner"
//     → snr_ghz = 2.4   (left=snr, num=2.4, right=ghz)
//     alphabetic-only tokens that have no adjacent number are kept as
//     plain string tags:  tag_enob="enob", tag_ss="ss", tag_corner="corner"

type FileNameColumn = Record<string, string | number>;

/**
 * Extract columns from the file name.
 * Returns {} if nothing useful is found.
 */
/**
 * inferColumnsFromFileName
 *
 * Scans a file name and extracts numeric parameters as extra columns that are
 * injected into every row of the parsed CSV.  This lets users upload files like:
 *
 *   "adc_vdd1p8v_freq100mhz_temp_85c_tt.csv"
 *
 * and automatically get columns  vdd_v=1.8, freq_mhz=100, temp_c=85 without
 * ever touching the CSV content.
 *
 * ── Algorithm ────────────────────────────────────────────────────────────────
 *
 * 1. Strip the file extension.
 * 2. Replace digit-p-digit sequences with a NULL-byte placeholder so that the
 *    "p" acting as a decimal point is not mistaken for a letter during the later
 *    alpha↔digit boundary split.  "123p5" → "123\x005" → 123.5 after restore.
 * 3. Split the name on underscores, hyphens and spaces.
 * 4. Within each segment, split further at every transition between a letter and
 *    a digit (or vice-versa) so that fused tokens like "freq123p5mhz" become the
 *    three logical tokens ["freq", "123.5", "mhz"].
 * 5. Walk the token array.  For each NUMBER token, look for:
 *      • LEFT  neighbour: nearest preceding alphabetic token ≥ 2 chars that has
 *        NOT already been "consumed" as the right-unit of a previous number.
 *        Single-char tokens (a, p, v, c …) are excluded on the left because they
 *        are too ambiguous on their own.
 *      • RIGHT neighbour: nearest following alphabetic token.  Single-char units
 *        (c, v, b …) ARE allowed on the right, because unit suffixes are commonly
 *        one character.
 *    BOTH neighbours must be present for the triple to be recorded.  A number
 *    with only one side (e.g. a bare timestamp digit "30", or a lone revision "3")
 *    is discarded — this prevents false positives from date stamps like
 *    "2023-13-30" where "-13" would otherwise look like a temperature.
 * 6. Alphabetic tokens (≥ 2 chars) that were never consumed as left/right context
 *    for any number are emitted as generic string columns: generic_1, generic_2, …
 *    No semantic/domain meaning is assumed for these.
 *
 * ── Examples ─────────────────────────────────────────────────────────────────
 *
 *   "freq_123p5mhz_temp_85c_chip3.csv"
 *     freq_mhz = 123.5   (left=freq, num=123.5, right=mhz)
 *     temp_c   = 85      (left=temp, num=85,    right=c)
 *     generic_1 = "chip" (chip has no numeric right neighbour, 3 has no left ≥2)
 *
 *   "radar_a0_p2_Freq_120p0MHzCH2_…_02-05-2023--13-30-30_testing.csv"
 *     freq_mhzch = 120.0  (left=Freq, num=120.0, right=MHzCH — fused token)
 *     generic_1  = "radar"
 *     Timestamp digits (02, 05, 2023, 13, 30, 30) are all discarded because
 *     they have no ≥2-char alphabetic neighbour on at least one side.
 */
export function inferColumnsFromFileName(fileName: string): FileNameColumn {
  // Strip extension
  const base = fileName.replace(/\.[^.]+$/, '');

  // Step 1: replace digit-p-digit with digit-\x00-digit so the 'p' decimal
  // marker survives the alpha↔digit split below unchanged.
  // e.g. "123p5" → "123\x005"
  const withPlaceholder = base.replace(/(\d)p(\d)/gi, '$1\x00$2');

  // Step 2: split on _ - space separators
  const raw = withPlaceholder.split(/[\s_\-]+/).filter(Boolean);

  // Step 3: within each segment, split further at every letter↔digit boundary
  // so "freq123" → ["freq","123"] and "85c" → ["85","c"]
  const tokens: string[] = [];
  for (const tok of raw) {
    const parts = tok.split(/(?<=[a-zA-Z])(?=\d)|(?<=\d)(?=[a-zA-Z])/);
    for (const p of parts) tokens.push(p);
  }

  // parseNum: restore \x00 → '.' and check for a pure numeric token
  const parseNum = (t: string): number | null => {
    const restored = t.replace(/\x00/g, '.');
    if (!/^\d+(?:\.\d+)?$/.test(restored)) return null;
    return parseFloat(restored);
  };

  // displayTok: restore \x00 → 'p' for tag names
  const displayTok = (t: string) => t.replace(/\x00/g, 'p');

  const result: FileNameColumn = {};
  const usedCols = new Set<string>();
  const usedIndices = new Set<number>();

  const register = (col: string, val: string | number) => {
    if (!usedCols.has(col)) { usedCols.add(col); result[col] = val; }
  };

  for (let i = 0; i < tokens.length; i++) {
    const num = parseNum(tokens[i]);
    if (num === null) continue;

    // Left neighbour: purely-alphabetic token ≥2 chars, not already consumed as
    // the right-unit of a previous number.
    const leftWord = (i > 0 && !usedIndices.has(i - 1) && /^[a-zA-Z]{2,}$/.test(tokens[i - 1]))
      ? tokens[i - 1].toLowerCase() : null;

    // Right neighbour: purely-alphabetic token (single-char units like c/v/b valid).
    // Require ≥2 chars when there is NO left word to prevent noise like "value_p".
    const rightRaw = (i + 1 < tokens.length && /^[a-zA-Z]+$/.test(tokens[i + 1]))
      ? tokens[i + 1] : null;
    const rightWord = rightRaw
      ? (leftWord !== null || rightRaw.length >= 2 ? rightRaw.toLowerCase() : null)
      : null;

    // ── Require BOTH neighbours ────────────────────────────────────────────
    // A number with only one neighbour is ambiguous (lone suffix, timestamp
    // fragment, revision number, etc.).  Skip it entirely.
    if (leftWord === null || rightWord === null) continue;

    usedIndices.add(i - 1);
    usedIndices.add(i + 1);
    usedIndices.add(i);

    register(`${leftWord}_${rightWord}`, num);
  }

  // Remaining alphabetic tokens (≥2 chars) not consumed as context →
  // generic_1, generic_2, ... (no named semantics assumed)
  let genericCounter = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (usedIndices.has(i)) continue;
    const tok = displayTok(tokens[i]);
    if (/^[a-zA-Z]{2,}$/.test(tok)) {
      genericCounter++;
      register(`generic_${genericCounter}`, tok);
    }
  }

  return result;
}

/**
 * Parse CSV file into structured data
 */
export const parseCSV = async (file: File): Promise<ParsedData> => {
  const text = await file.text();
  const lines = text.trim().split('\n');

  if (lines.length < 2) {
    throw new Error('CSV file must have at least a header and one data row');
  }

  // Parse header
  const headers = lines[0].split(',').map(h => h.trim());

  // Find first numeric variable
  const firstNumericVar = headers.find((h, idx) => {
    const sampleValue = lines[1].split(',')[idx];
    return !isNaN(parseFloat(sampleValue));
  });

  // Infer extra columns from the file name
  const fileNameColumns = inferColumnsFromFileName(file.name);
  const fnColNames = Object.keys(fileNameColumns);
  const allHeaders = [...headers, ...fnColNames.filter(c => !headers.includes(c))];

  // Parse data rows
  const rows = lines.slice(1).map((line, idx) => {
    const values = line.split(',').map(v => v.trim());
    const row: Record<string, any> = { id: idx };

    headers.forEach((header, i) => {
      const value = values[i];
      const numValue = parseFloat(value);
      row[header] = isNaN(numValue) ? value : numValue;
    });

    // Inject file-name-derived columns
    Object.assign(row, fileNameColumns);

    return row;
  });

  return {
    headers: allHeaders,
    rows,
    firstNumericVariable: firstNumericVar,
    fileNameColumns,
  };
};

/**
 * Parse XLSX/XLS file into structured data
 */
export const parseXLSX = async (file: File): Promise<ParsedData> => {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(arrayBuffer);

  // Use first sheet
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error('Excel file has no sheets.');

  const jsonData: any[][] = [];
  worksheet.eachRow({ includeEmpty: false }, row => {
    jsonData.push((row.values as any[]).slice(1)); // ExcelJS row.values is 1-indexed
  });

  if (jsonData.length < 2) {
    throw new Error('Excel file must have at least a header row and one data row');
  }

  // Parse header
  const headers = jsonData[0].map((h: any) => String(h ?? '').trim());

  // Find first numeric variable
  const firstNumericVar = headers.find((h: string, idx: number) => {
    const sampleValue = jsonData[1][idx];
    return typeof sampleValue === 'number' || !isNaN(parseFloat(String(sampleValue)));
  });

  // Infer extra columns from the file name
  const fileNameColumns = inferColumnsFromFileName(file.name);
  const fnColNames = Object.keys(fileNameColumns);
  const allHeaders = [...headers, ...fnColNames.filter(c => !headers.includes(c))];

  // Parse data rows
  const rows = jsonData.slice(1).map((row: any[], idx: number) => {
    const dataRow: Record<string, any> = { id: idx };

    headers.forEach((header: string, i: number) => {
      const value = row[i];

      if (typeof value === 'number') {
        dataRow[header] = value;
      } else if (value !== undefined && value !== null) {
        const numValue = parseFloat(String(value));
        dataRow[header] = isNaN(numValue) ? String(value) : numValue;
      } else {
        dataRow[header] = '';
      }
    });

    // Inject file-name-derived columns
    Object.assign(dataRow, fileNameColumns);

    return dataRow;
  });

  return {
    headers: allHeaders,
    rows,
    firstNumericVariable: firstNumericVar,
    fileNameColumns,
  };
};

/**
 * Parse any supported file type (CSV or XLSX)
 */
export const parseFile = async (file: File): Promise<ParsedData> => {
  const fileName = file.name.toLowerCase();

  if (fileName.endsWith('.csv')) {
    return parseCSV(file);
  } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
    return parseXLSX(file);
  } else {
    throw new Error('Unsupported file type. Please upload CSV or XLSX file.');
  }
};
