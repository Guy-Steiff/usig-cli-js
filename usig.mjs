#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsRaw from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import readline from 'node:readline';
import * as esbuild from 'esbuild';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const nodeModulesDir = path.join(scriptDir, 'node_modules');

const SUPPORTED_FORMATS = new Set(['text', 'json', 'csv', 'yaml']);

const USIG_BIN_MAGIC = Buffer.from('USIGIR1\n', 'ascii');

function isUsigBinaryContainer(buf) {
  return (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(USIG_BIN_MAGIC)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(args) {
  // CLI parsing intentionally follows a forgiving ffmpeg-like style:
  // - repeated flags are accepted
  // - plugin ids can be comma-separated or space-separated after -plugin
  // - a trailing bare token is treated as positional output path
  const result = {
    inputFile: null,
    pluginId: null,   // kept for compat; populated from pluginIds[0] after parse
    pluginIds: [],    // all requested plugin ids (supports -plugin smeas,sinl,hsioalpha)
    outputFile: null, // deprecated positional compatibility
    params: {},
    verbose: false,
    format: 'text',
    muxFormat: null,
    demuxFormat: null,
    inferMetaFromFilename: false,
    metaToFilename: false,
    help: false,
    probeMetadata: false,
    channelIndex: null,
    startSample: null,
    endSample: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-i' && i + 1 < args.length) {
      result.inputFile = args[++i];
    } else if (arg === '-plugin' && i + 1 < args.length) {
      // Accept repeated -plugin flags, comma-separated ids, and space-separated ids.
      // A token is treated as a plugin id if it contains no dot or path separator
      // (which would indicate a file path / output filename).
      const isPluginId = (s) => s && !s.includes('.') && !s.includes('/') && !s.includes('\\');
      for (const id of args[++i].split(',')) {
        const trimmed = id.trim();
        if (trimmed && !result.pluginIds.includes(trimmed)) result.pluginIds.push(trimmed);
      }
      // Consume additional space-separated plugin ids that follow
      while (i + 1 < args.length && !args[i + 1].startsWith('-') && isPluginId(args[i + 1])) {
        for (const id of args[++i].split(',')) {
          const trimmed = id.trim();
          if (trimmed && !result.pluginIds.includes(trimmed)) result.pluginIds.push(trimmed);
        }
      }
    } else if (arg === '-p' && i + 1 < args.length) {
      const pair = args[++i];
      let [key, ...valParts] = pair.split('=');
      let val = valParts.join('=');
      // Coerce value
      if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (!isNaN(val) && val !== '') val = Number(val);
      result.params[key.trim()] = val;
    } else if (arg === '--infer-meta-from-filename') {
      result.inferMetaFromFilename = true;
    } else if (arg === '--meta-to-filename') {
      result.metaToFilename = true;
    } else if (arg === '--probe-metadata') {
      result.probeMetadata = true;
    } else if ((arg === '--channel-index' || arg === '--channel') && i + 1 < args.length) {
      const idx = Number(args[++i]);
      if (Number.isInteger(idx) && idx >= 0) result.channelIndex = idx;
    } else if (arg === '--start-sample' && i + 1 < args.length) {
      const idx = Number(args[++i]);
      if (Number.isInteger(idx) && idx >= 0) result.startSample = idx;
    } else if (arg === '--end-sample' && i + 1 < args.length) {
      const idx = Number(args[++i]);
      if (Number.isInteger(idx) && idx >= 0) result.endSample = idx;
    } else if ((arg === '-of' || arg === '--format' || arg === '-print_format') && i + 1 < args.length) {
      result.format = String(args[++i]).toLowerCase();
    } else if (arg === '-v' || arg === 'verbose' || arg === '--verbose') {
      result.verbose = true;
    } else if (arg === '-h' || arg === '--help') {
      result.help = true;
    } else if (!arg.startsWith('-')) {
      // Backward compatibility with old positional output path.
      result.outputFile = arg;
    }
  }
  // backward compat: single-plugin callers use result.pluginId
  result.pluginId = result.pluginIds[0] ?? null;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Load plugin module (TSX → ESM via esbuild)
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// Help
// ─────────────────────────────────────────────────────────────────────────────

function printHelp() {
  process.stdout.write(`\
usig -- Unified Signal Instrument CLI  (ffprobe-style reporting)

USAGE
  node usig.mjs -i <input> -plugin <id[,id2]> [flags] [output]
  node usig.mjs -i <input> --mux bin  [conversion-flags] [output]
  node usig.mjs -i <input> --demux csv [conversion-flags] [output]
  node usig.mjs -h | --help

INPUT
  -i <file|glob>          Input file or glob pattern (repeatable)

PLUGIN SELECTION
  -plugin <id[,id2]>      Plugin id(s): smeas, sinl, hsioalpha
                          Repeatable, comma-separated, or space-separated.

PARAMETERS
  -p <key=value>          Override plugin parameter (repeatable)
                          Values auto-coerced to number / boolean / string.

OUTPUT
  [output_path]           Positional output path (ffmpeg style). Default: stdout
  -of <fmt>               Output format: text (default), json, csv, yaml
  --format <fmt>          Alias for -of
  -print_format <fmt>     Alias for -of

VERBOSITY
  -v / --verbose          Enable verbose logging (or bare 'verbose' token)

CONVERSION  (mux / demux)
  --mux bin               Convert input (CSV/TXT/BIN) -> usig IR binary container
  --demux csv             Convert usig IR binary container -> CSV
  --infer-meta-from-filename
                          Infer metadata from filename tokens; embed in output BIN
  --embed key=value       Inject metadata field into BIN payload (repeatable)
  --meta-to-filename      Generate output .csv basename from embedded metadata tokens
  --channel-index <n>     For multi-waveform BIN files, select 0-based channel
  --channel <n>           Alias for --channel-index
  --start-sample <n>      0-based first sample index to ingest (inclusive)
  --end-sample <n>        0-based last sample index to ingest (inclusive)

HELP
  -h, --help              Print this help and exit

PARAM PRECEDENCE  (lowest -> highest)
  1. plugin defaultParams
  2. IR / embedded BIN metadata / capturedVars
  3. Filename token inference  (strict token form only)
  4. Plugin-specific regex inference
  5. Explicit -p overrides

  FILENAME TOKEN INFERENCE (strict)
  Allowed token: {param}{number_with_optional_p_decimal}{optional_units}
  Allowed separators: underscore between tokens (e.g. tokenA_tokenB)
  Param/number/unit must not contain underscores (dashes are allowed)
  fs2p25ghz / fs100p00ghz     fsGhz = 2.25 / 100
  fin100mhz / finused599p93mhz  inferred from matching plugin hooks
  adc12                       adcNumBits = 12
  vfs2p0v / vpp1p8v           vfsPeakToPeak = 2.0 / 1.8
  4core                       numberOfCores = 4
  m30c / p85c                 temp = -30 / +85

EXAMPLES
  node usig.mjs -i data.csv -plugin smeas -of json
  node usig.mjs -i cap.csv -plugin sinl,smeas -v results.csv
  node usig.mjs -i prbs2_fs100p00ghz_finused600p00mhz.csv -plugin hsioalpha -v
  node usig.mjs -i data.csv -plugin smeas -p fsGhz=2.25 -p fftLength=8192 -of json
  node usig.mjs -i data.csv --mux bin --infer-meta-from-filename out.bin
  node usig.mjs -i data.bin --demux csv --meta-to-filename out.csv

See CLI.md for full documentation.
`);
}

async function loadPluginModule(tsxPath) {
  const tmpDir = path.join(scriptDir, `.tmp_usig_${Date.now()}`);
  const tmpPath = path.join(tmpDir, 'bundle.mjs');
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    // Use esbuild.build() with bundling to resolve all dependencies
    await esbuild.build({
      entryPoints: [tsxPath],
      bundle: true,
      format: 'esm',
      target: 'es2020',
      jsx: 'automatic',
      loader: { '.tsx': 'tsx', '.ts': 'ts' },
      outfile: tmpPath,
      external: ['react', 'react-dom', 'fft.js', 'recharts'],
      sourcemap: false,
    });

    return await import(pathToFileURL(tmpPath).href + `?t=${Date.now()}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function loadIrEngineModule() {
  const tmpDir = path.join(scriptDir, `.tmp_usig_ir_${Date.now()}`);
  const tmpPath = path.join(tmpDir, 'ir-bundle.mjs');
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    await esbuild.build({
      entryPoints: [path.join(scriptDir, 'app/lib/ir/index.ts')],
      bundle: true,
      format: 'esm',
      target: 'es2020',
      loader: { '.tsx': 'tsx', '.ts': 'ts' },
      outfile: tmpPath,
      external: ['react', 'react-dom', 'fft.js', 'recharts'],
      sourcemap: false,
      absWorkingDir: scriptDir,
      nodePaths: [nodeModulesDir],
    });

    return await import(pathToFileURL(tmpPath).href + `?t=${Date.now()}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function loadBinReaderModule() {
  const tmpDir = path.join(scriptDir, `.tmp_usig_bin_${Date.now()}`);
  const tmpPath = path.join(tmpDir, 'binreader-bundle.mjs');
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    await esbuild.build({
      entryPoints: [path.join(scriptDir, 'app/lib/binReader.ts')],
      bundle: true,
      format: 'esm',
      target: 'es2020',
      loader: { '.tsx': 'tsx', '.ts': 'ts' },
      outfile: tmpPath,
      external: ['react', 'react-dom', 'fft.js', 'recharts'],
      sourcemap: false,
      absWorkingDir: scriptDir,
      nodePaths: [nodeModulesDir],
    });

    return await import(pathToFileURL(tmpPath).href + `?t=${Date.now()}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function pluginExists(pluginId) {
  const pluginPath = path.join(scriptDir, `app/components/plugins/${pluginId}Plugin.tsx`);
  try { await fs.access(pluginPath); return true; } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV I/O
// ─────────────────────────────────────────────────────────────────────────────

function readCsv(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim());
    const row = {};
    for (let i = 0; i < headers.length; i++) {
      const v = values[i] ?? '';
      row[headers[i]] = isNaN(v) || v === '' ? v : Number(v);
    }
    return row;
  });
  return { headers, rows };
}

function writeCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    const values = headers.map(h => {
      const v = row[h];
      if (v == null) return '';
      if (typeof v === 'string' && v.includes(',')) return `"${v.replace(/"/g, '""')}"`;
      return String(v);
    });
    lines.push(values.join(','));
  }
  return lines.join('\n') + '\n';
}

function applyRegexToString(str, pattern, replacements) {
  try {
    const match = str.match(new RegExp(pattern, 'i'));
    if (!match) return '';
    let value = match[2] !== undefined ? `${match[1]}.${match[2]}` : (match[1] ?? match[0] ?? '');
    if (value && replacements?.trim()) {
      for (const pair of replacements.split(',')) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx === -1) continue;
        const from = pair.slice(0, eqIdx);
        const to = pair.slice(eqIdx + 1);
        if (from) value = value.replaceAll(from, to);
      }
    }
    return value;
  } catch {
    return '';
  }
}

function applyRegexToFilename(filename, pattern, replacements) {
  if (!pattern?.trim()) return '';
  // Strict mode: only infer from compact underscore-delimited tokens.
  for (const token of extractStrictInferenceTokens(filename)) {
    const matched = applyRegexToString(token, pattern, replacements);
    if (matched) return matched;
  }
  return '';
}

function extractStrictInferenceTokens(filename) {
  const stem = path.basename(filename)
    .replace(/\.[^.]+$/, '')
    .toLowerCase();

  const rawTokens = stem.split('_').filter(Boolean);
  // // "_" only separates metadata tokens.
  // // "~" remains inside tokens and is handled by the grammar.
  //
  // // Strict filename metadata token grammar:
  // //
  // //   [_]<parameter>[~]<value>[~]<unit>(_|.)
  // //
  // // The optional '_' prefix and terminating '_' or '.' delimit the token
  // // boundary. Inside the token:
  // //
  // //   <parameter>
  // //     - starts with a letter
  // //     - must contain only letters - unless ~ is used explicitly
  // //
  // //   <value> has two forms:
  // //
  // //     1) Compact numeric form (no '~' required):
  // //          <digits>[p<digits>]
  // //
  // //        Examples:
  // //          fs2p25ghz  -> value 2.25, unit ghz
  // //          vfs2v       -> value 2, unit v
  // //
  // //     2) Explicit form (requires '~'):
  // //          ~<value>[~<unit>]
  // //
  // //        Used for:
  // //          - signed values:
  // //              m40 -> -40
  // //              p25 -> +25
  // //          - string values:
  // //              ogp
  // //              butterworth
  // //
  // //   '~' is the escape separator for ambiguous cases. Without '~',
  // //   a leading 'm' or 'p' is interpreted as part of the parameter name,
  // //   because otherwise boundaries cannot be determined reliably.
  // //
  // // Examples:
  // //   _fs2p25ghz_
  // //   _fs2p25~ghz_
  // //   _temperature~m40c_
  // //   _ticorrections~ogp_
  // //   _filter~butterworth~db_
  // //
  // // Ambiguous forms such as:
  // //
  // //   _tempm40c_
  // //
  // // must use the explicit form:
  // //
  // //   _temp~m40c_
  // //
  const strictTokenPattern =
  /^([a-z][a-z-]*?)(?:~([a-z0-9-]+)(?:~([a-z][a-z0-9-]*))?|(\d+(?:p\d+)?)([a-z][a-z0-9-]*)?)$/i;

  const out = [];

  for (const token of rawTokens) {
    const match = strictTokenPattern.exec(token);
    if (!match) continue;

    const [
      ,
      key,
      explicitValue,
      explicitUnit,
      compactValue,
      compactUnit
    ] = match;

    const usedExplicitSeparator = token.includes('~');

    if (!usedExplicitSeparator && !/^[a-z]+$/i.test(key)) {
      continue;
    }

    const value =
      explicitValue !== undefined
        ? explicitValue
        : compactValue;

    const unit =
      explicitUnit !== undefined
        ? explicitUnit
        : compactUnit;

    out.push({
      token,
      key,
      value,
      unit
    });
  }

  return out;
}

function slugifyToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeValueToken(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6))).replace('.', 'p');
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (!isNaN(raw)) {
    const n = Number(raw);
    return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6))).replace('.', 'p');
  }
  return raw.replace(/[^a-z0-9]+/g, '');
}

function fileNameParamKey(key) {
  return { name: key.toLowerCase().replace(/[^a-z0-9]+/g, ''), unit: '' };
}

function buildDerivedParamHints(frame, explicitParams) {
  // Derive fallback hints from metadata/captured vars using exact key matching only.
  const hints = {};
  const meta = frame?.packet?.metadata ?? {};
  const captured = frame?.capturedVars ?? {};
  const merged = { ...captured, ...meta };

  for (const [key, value] of Object.entries(merged)) {
    if (Object.prototype.hasOwnProperty.call(explicitParams, key)) continue;
    if (value === undefined || value === null || value === '') continue;
    hints[key] = { value, source: 'metadata' };
  }

  return hints;
}

function coerceFieldValue(field, rawValue) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return '';
  const normalized = normalizeValueToken(raw);

  if (Array.isArray(field.options) && field.options.length > 0) {
    for (const option of field.options) {
      if (normalizeValueToken(option) === normalized) return option;
    }
  }

  let numericCandidate = raw.trim().toLowerCase().replace(/p(?=\d)/g, '.');
  if (/^m\d/.test(numericCandidate)) numericCandidate = `-${numericCandidate.slice(1)}`;
  else if (/^p\d/.test(numericCandidate)) numericCandidate = numericCandidate.slice(1);
  if (typeof field.defaultValue === 'number' || field.type === 'number') {
    const parsed = Number(numericCandidate);
    if (Number.isFinite(parsed)) return parsed;
  }

  if (typeof field.defaultValue === 'boolean' || field.type === 'boolean') {
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }

  if (typeof field.transform === 'function') {
    const transformed = field.transform(raw);
    if (transformed !== '' && transformed !== undefined && transformed !== null) {
      return transformed;
    }
  }

  return raw;
}

function buildProposedFileName(inputSummary) {
  const parts = [];
  for (const row of inputSummary) {
    if (row.source !== 'override' && row.source !== 'filename') continue;
    const token = normalizeValueToken(row.value);
    if (!token) continue;
    const keyInfo = fileNameParamKey(row.key);
    // If name is empty the value is emitted bare (e.g. signalType → 'prbs2')
    parts.push(`${keyInfo.name}${token}${keyInfo.unit}`);
  }
  return parts.filter(Boolean).join('_');
}

function describeSource(key, detail) {
  if (detail.source === 'override') return `${key}: ${detail.value} << overridden from user input`;
  if (detail.source === 'filename') return `${key}: ${detail.value} << inferred from file name`;
  if (detail.source === 'column') return `${key}: ${detail.value} << inferred from source column`;
  if (detail.source === 'metadata') return `${key}: ${detail.value} << inferred from file metadata / IR`;
  if (detail.source === 'default') return `${key}: ${detail.value} << default applied`;
  return `${key}: ${detail.value}`;
}

// function inferFsGhzFromFilename(filename) {
//   void filename;
//   return '';
// }
function inferStrictMetadataFromFilename(filename) {
  const inferred = {};

  for (const token of extractStrictInferenceTokens(filename)) {
    const {
      token: rawToken,
      key,
      value,
      unit
    } = token;

    const entry = {
      token: rawToken
    };

    if (value !== undefined) {
      entry.valueRaw = value;

      let normalized = value.replace(/p(?=\d)/gi, '.');

      if (/^m\d/.test(normalized)) {
        normalized = `-${normalized.slice(1)}`;
      } else if (/^p\d/.test(normalized)) {
        normalized = normalized.slice(1);
      }

      const n = Number(normalized);
      if (Number.isFinite(n)) {
        entry.valueNum = n;
      } else {
        entry.value = value;
      }
    }

    if (unit !== undefined) {
      entry.unit = unit.toLowerCase();
    }

    inferred[key] = entry;
  }

  return inferred;
}

function collectDisplayFields(plugin) {
  const all = [...(plugin.paramFields ?? []), ...(plugin.inferredParamFields ?? [])];
  const seen = new Set();
  const deduped = [];
  for (const field of all) {
    if (!field?.key || seen.has(field.key)) continue;
    seen.add(field.key);
    deduped.push(field);
  }
  return deduped;
}

function resolveFieldValue(field, explicitParams, fileName, headers, derivedHints = {}) {
  const hasOverride = Object.prototype.hasOwnProperty.call(explicitParams, field.key);
  if (hasOverride) {
    return { value: explicitParams[field.key], source: 'override' };
  }

  if (field.type === 'column-select') {
    // Prefer defaultValue when it names a column that actually exists in the file.
    // This ensures plugins with named signal columns (e.g. voltage_v) land on the
    // right column even when it isn't the first one.
    if (field.defaultValue && headers?.includes(field.defaultValue)) {
      return { value: field.defaultValue, source: 'column' };
    }
    const chosen = headers?.[0] ?? field.defaultValue ?? '';
    if (chosen !== '') return { value: chosen, source: headers?.[0] ? 'column' : 'default' };
    return { value: '', source: 'default' };
  }

  const compactInferred = '';
  if (compactInferred !== '') {
    return { value: compactInferred, source: 'filename' };
  }

  const fromFilename = applyRegexToFilename(fileName, field.defaultRegex, field.defaultReplace);
  if (fromFilename) {
    return { value: field.transform ? field.transform(fromFilename) : fromFilename, source: 'filename' };
  }

  if (Object.prototype.hasOwnProperty.call(derivedHints, field.key)) {
    return derivedHints[field.key];
  }

  if (field.defaultValue !== undefined) {
    return { value: field.defaultValue, source: 'default' };
  }

  return { value: '', source: 'default' };
}

function buildInputSummary(plugin, finalParams, explicitParams, fileName, headers, derivedHints = {}) {
  const fields = collectDisplayFields(plugin);
  const fieldMap = new Map(fields.map(field => [field.key, field]));
  const summary = [];

  for (const field of fields) {
    const resolved = resolveFieldValue(field, explicitParams, fileName, headers, derivedHints);
    const value = resolved.value === '' ? finalParams[field.key] ?? '' : resolved.value;
    if (value === '' || value === undefined) continue;
    summary.push({ key: field.key, value, source: resolved.source });
  }

  for (const key of Object.keys(finalParams ?? {})) {
    if (fieldMap.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(explicitParams, key)) continue;
    const value = finalParams[key];
    if (value === '' || value === undefined) continue;
    summary.push({ key, value, source: 'override' });
  }

  return summary;
}



function formatReport(payload, format) {
  if (format === 'json') {
    return JSON.stringify(payload, null, 2) + '\n';
  }

  if (format === 'csv') {
    const rows = payload.results ?? [];
    if (rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    return writeCsv(headers, rows);
  }

  if (format === 'yaml') {
    const lines = [];
    lines.push('input:');
    lines.push(`  file: ${JSON.stringify(payload.input.file)}`);
    lines.push(`  plugin: ${JSON.stringify(payload.input.plugin)}`);
    lines.push(`  format: ${JSON.stringify(payload.input.format)}`);
    lines.push('  params:');
    for (const [k, v] of Object.entries(payload.input.params || {})) {
      lines.push(`    ${k}: ${JSON.stringify(v)}`);
    }
    lines.push('results:');
    for (const row of payload.results || []) {
      lines.push('  -');
      for (const [k, v] of Object.entries(row)) {
        lines.push(`      ${k}: ${JSON.stringify(v)}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  const lines = [];
  const summaries = payload.input.summaries ?? {};
  const pluginIds = Object.keys(summaries);
  const multi = payload.results.length > 1;

  if (multi) {
    // Show each plugin's inputs labeled by plugin id
    for (const pid of pluginIds) {
      lines.push(`[${pid}] Inputs:`);
      for (const row of summaries[pid] || []) {
        lines.push(`  ${describeSource(row.key, row)}`);
      }
      lines.push('');
    }
  } else {
    lines.push('Inputs:');
    for (const row of payload.input.summary || []) {
      lines.push(`  ${describeSource(row.key, row)}`);
    }
    lines.push('');
  }

  lines.push('Outputs:');
  if (!payload.results || payload.results.length === 0) {
    lines.push('  (no results)');
  } else {
    for (const row of payload.results) {
      if (multi) lines.push(`  [${row._plugin ?? ''}]`);
      for (const [k, v] of Object.entries(row)) {
        if (k === '_plugin') continue;
        lines.push(`  ${multi ? '  ' : ''}${k}: ${v}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}


// function buildMetadataStem(inputFileName, metadata = {}, capturedVars = {}, metadataToEmbed = {}) {
function buildMetadataStem(inputFileName, metadata = {}, capturedVars = {}) {
  const parts = [];
  const merged = {
    ...capturedVars,
    ...metadata,
    // ...metadataToEmbed,
  };

  for (const key of Object.keys(merged).sort()) {
    const value = merged[key];
    if (value === undefined || value === null || value === '') continue;
    const k = slugifyToken(key).replace(/_/g, '');
    const v = normalizeValueToken(value);
    if (!k || !v) continue;
    parts.push(`${k}${v}`);
  }

  if (parts.length === 0) {
    const stem = path.basename(inputFileName).replace(/\.[^.]+$/, '');
    return slugifyToken(stem) || 'converted';
  }
  return parts.join('_');
}

function packSerializedIR(meta, waveform) {
  const magic = Buffer.from('USIGIR1\n', 'ascii');
  const metaBuf = Buffer.from(meta, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(metaBuf.length, 0);
  return Buffer.concat([magic, lenBuf, metaBuf, Buffer.from(waveform)]);
}

function unpackSerializedIR(buf) {
  const magic = Buffer.from('USIGIR1\n', 'ascii');

  if (buf.length < 12 || !buf.subarray(0, 8).equals(magic)) {
    throw new Error('Not a supported usig IR binary container (missing USIGIR1 header).');
  }

  const metaLen = buf.readUInt32LE(8);
  const metaStart = 12;
  const metaEnd = metaStart + metaLen;

  if (metaEnd > buf.length) {
    throw new Error('Corrupt usig IR container: metadata length is out of range.');
  }

  const meta = buf.subarray(metaStart, metaEnd).toString('utf8');
  const waveBytes = buf.subarray(metaEnd);

  return {
    meta,
    waveBytes: waveBytes.buffer.slice(
      waveBytes.byteOffset,
      waveBytes.byteOffset + waveBytes.byteLength
    )
  };
}

function inferMetadataFromFilename(inputFileName, capturedVars = {}) {
  const inferred = {};

  const tokens = inferStrictMetadataFromFilename(inputFileName);

  for (const [key, entry] of Object.entries(tokens)) {
    if (entry.valueNum !== undefined) {
      inferred[key] = entry.valueNum;
      continue;
    }

    if (entry.valueRaw !== undefined) {
      inferred[key] = entry.valueRaw;
      continue;
    }
  }

  // Captured variables are lower priority than filename inference.
  // Preserve them only when filename did not provide a value.
  for (const [key, value] of Object.entries(capturedVars ?? {})) {
    if (
      inferred[key] === undefined &&
      value !== undefined &&
      value !== null &&
      value !== ''
    ) {
      inferred[key] = value;
    }
  }

  return inferred;
}


// ─────────────────────────────────────────────────────────────────────────────
// Probe Metadata Mode
// ─────────────────────────────────────────────────────────────────────────────

function normalizeProbeCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function summarizeUniqueSets(headers, uniqueSets) {
  const singleValueColumns = {};
  const uniqueValueCountByColumn = {};
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const set = uniqueSets[i] ?? new Set();
    uniqueValueCountByColumn[h] = set.size;
    if (set.size === 1) singleValueColumns[h] = Array.from(set)[0];
  }
  return { singleValueColumns, uniqueValueCountByColumn };
}

async function probeCsvColumnsStream(inputFile) {
  const stream = fsRaw.createReadStream(inputFile, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let headers = [];
  let delimiter = ',';
  let uniqueSets = [];

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (headers.length === 0) {
        delimiter = line.includes('\t') ? '\t' : ',';
        headers = line.split(delimiter).map(h => h.trim());
        uniqueSets = headers.map(() => new Set());
        continue;
      }
      const values = line.split(delimiter).map(v => v.trim());
      for (let i = 0; i < headers.length; i++) {
        const v = normalizeProbeCell(values[i] ?? '');
        if (v !== '') uniqueSets[i].add(v);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { headers, ...summarizeUniqueSets(headers, uniqueSets) };
}

async function probeXlsxColumnsStream(inputFile) {
  const excelJsMod = await import('exceljs');
  const ExcelJS = excelJsMod.default ?? excelJsMod;
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(inputFile, {
    entries: 'emit',
    worksheets: 'emit',
    sharedStrings: 'cache',
    styles: 'ignore',
    hyperlinks: 'ignore',
  });
  let headers = [];
  let uniqueSets = [];
  let sawWorksheet = false;

  for await (const worksheet of workbook) {
    sawWorksheet = true;
    for await (const row of worksheet) {
      const values = Array.isArray(row.values) ? row.values.slice(1).map(normalizeProbeCell) : [];
      if (headers.length === 0) {
        headers = values.map((v, idx) => v || `col_${idx}`);
        uniqueSets = headers.map(() => new Set());
        continue;
      }
      for (let i = 0; i < headers.length; i++) {
        const v = normalizeProbeCell(values[i] ?? '');
        if (v !== '') uniqueSets[i].add(v);
      }
    }
    break;
  }

  if (!sawWorksheet) return { headers: [], singleValueColumns: {}, uniqueValueCountByColumn: {} };
  return { headers, ...summarizeUniqueSets(headers, uniqueSets) };
}

async function readSerializedIRMetadata(inputFile) {
  const handle = await fs.open(inputFile, 'r');
  try {
    const head = Buffer.alloc(12);
    const headRead = await handle.read(head, 0, head.length, 0);
    if (headRead.bytesRead < 12) return null;
    if (head.subarray(0, 8).toString('ascii') !== 'USIGIR1\n') return null;
    const metaLen = head.readUInt32LE(8);
    if (!Number.isFinite(metaLen) || metaLen <= 0 || metaLen > 16 * 1024 * 1024) return null;
    const metaBuf = Buffer.alloc(metaLen);
    const metaRead = await handle.read(metaBuf, 0, metaLen, 12);
    if (metaRead.bytesRead !== metaLen) return null;
    const parsed = JSON.parse(metaBuf.toString('utf8'));
    console.log('readUsigContainerMetadata parsed keys:', Object.keys(parsed));
    console.log('readUsigContainerMetadata metadata:', parsed.metadata);
    return parsed?.metadata ?? parsed?.packet?.metadata ?? null;
  } finally {
    await handle.close();
  }
}

function toArrayBuffer(buf, bytesRead = buf.length) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead);
}

async function readExternalBinMetadata(inputFile, inputFileName) {
  const binMod = await loadBinReaderModule();
  const parseBinMetadata = binMod?.parseBinMetadata;
  if (typeof parseBinMetadata !== 'function') throw new Error('parseBinMetadata export not found in app/lib/binReader.ts bundle.');

  const handle = await fs.open(inputFile, 'r');
  try {
    const headerBuf = Buffer.alloc(4096);
    const firstRead = await handle.read(headerBuf, 0, headerBuf.length, 0);
    if (firstRead.bytesRead === 0) return {};
    let meta = parseBinMetadata(toArrayBuffer(headerBuf, firstRead.bytesRead), inputFileName);
    if (meta?.parseError) {
      const full = await fs.readFile(inputFile);
      meta = parseBinMetadata(toArrayBuffer(full), inputFileName);
    }
    return meta ?? {};
  } finally {
    await handle.close();
  }
}

async function runProbeMetadataMode({
  inputFile,
  verbose,
  format,
  channelIndex = null,
}) {
  if (!inputFile) {
    console.error('Usage: node usig.mjs -i <input-file> --probe-metadata [-of json|text|csv|yaml]');
    process.exit(1);
  }

  if (verbose) console.log('[usig] probing metadata from:', inputFile);
  const inputFileName = path.basename(inputFile);
  const ext = path.extname(inputFileName).toLowerCase();

  let irMetadata = {};
  let ingestError = '';
  let availableColumns = [];
  let singleValueColumns = {};
  let uniqueValueCountByColumn = {};

  // Probe with minimal reads: stream tabular files, parse BIN headers first.
  if (ext === '.bin') {
    try {
      const usigMeta = await readSerializedIRMetadata(inputFile);
      irMetadata = usigMeta ?? await readExternalBinMetadata(inputFile, inputFileName);
    } catch (err) {
      ingestError = String(err?.message ?? err);
    }
  } else if (ext === '.csv' || ext === '.txt') {
    try {
      const probed = await probeCsvColumnsStream(inputFile);
      availableColumns = probed.headers;
      singleValueColumns = probed.singleValueColumns;
      uniqueValueCountByColumn = probed.uniqueValueCountByColumn;
    } catch (err) {
      ingestError = String(err?.message ?? err);
    }
  } else if (ext === '.xlsx') {
    try {
      const probed = await probeXlsxColumnsStream(inputFile);
      availableColumns = probed.headers;
      singleValueColumns = probed.singleValueColumns;
      uniqueValueCountByColumn = probed.uniqueValueCountByColumn;
    } catch (err) {
      ingestError = String(err?.message ?? err);
    }
  }

  const tokens = inferStrictMetadataFromFilename(inputFileName);
  const probe = {
    fileType: ext ? ext.slice(1) : 'unknown',
    availableColumns,
    columnCount: availableColumns.length,
    uniqueValueCountByColumn,

    filenameInference: {},
    embeddedBinMetadata: irMetadata,
    columnInference: {},
  };
  for (const [k, v] of Object.entries(tokens)) {
    let value = '';

    if (v?.valueNum !== undefined) {
      value = v.unit ? `${v.valueNum}${v.unit}` : v.valueNum;
    } else if (v?.valueRaw !== undefined) {
      value = v.valueRaw;
    } else {
      value = v?.token ?? '';
    }

    probe.filenameInference[k] = value;
  }


  if (Number.isFinite(irMetadata?.numSamples) && irMetadata.numSamples > 0) {
    probe.embeddedBinMetadata.numSamples = irMetadata.numSamples;
  }

  if (Number.isFinite(irMetadata?.numWaveforms) && irMetadata.numWaveforms > 0) {
    probe.embeddedBinMetadata.numWaveforms = irMetadata.numWaveforms;
    if (availableColumns.length === 0) {
      availableColumns = Array.from({ length: irMetadata.numWaveforms }, (_, i) => `channel_${i}`);
      probe.availableColumns = availableColumns;
      probe.columnCount = availableColumns.length;
    }
    probe.channelIndices = Array.from({ length: irMetadata.numWaveforms }, (_, i) => i);
    if (Number.isInteger(channelIndex) && channelIndex >= 0) probe.selectedChannelIndex = channelIndex;
  }

  for (const [column, value] of Object.entries(singleValueColumns)) {
    probe.columnInference[column] = value;
  }
  const result = {
    file: inputFileName,
    probe,
    singleValueColumns,
    singleValueColumnsCount: Object.keys(singleValueColumns).length,
  };
  if (Object.keys(irMetadata).length > 0) result.binMetadata = irMetadata;
  if (ingestError) result.ingestError = ingestError;

  if (format === 'json') {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (format === 'yaml') {
    const lines = [];
    lines.push(`file: ${JSON.stringify(result.file)}`);
    lines.push('probe:');
    for (const [k, v] of Object.entries(result.probe || {})) lines.push(`  ${k}: ${JSON.stringify(v)}`);
    lines.push(`singleValueColumnsCount: ${JSON.stringify(result.singleValueColumnsCount)}`);
    if (result.ingestError) lines.push(`ingestError: ${JSON.stringify(result.ingestError)}`);
    if (result.binMetadata) {
      lines.push('binMetadata:');
      for (const [k, v] of Object.entries(result.binMetadata)) lines.push(`  ${k}: ${JSON.stringify(v)}`);
    }
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  if (format === 'csv') {
    const rows = ['key,value'];
    for (const [k, v] of Object.entries(result.probe || {})) rows.push(`${JSON.stringify(k)},${JSON.stringify(v)}`);
    rows.push(`${JSON.stringify('singleValueColumnsCount')},${JSON.stringify(result.singleValueColumnsCount)}`);
    if (result.ingestError) rows.push(`${JSON.stringify('ingestError')},${JSON.stringify(result.ingestError)}`);
    process.stdout.write(rows.join('\n') + '\n');
    return;
  }

  process.stdout.write(`\nProbed Metadata: ${inputFileName}\n\n`);
  process.stdout.write('Probe Fields:\n');
  for (const [k, v] of Object.entries(result.probe || {})) {
    if (k === 'filenameInference') {
      process.stdout.write('\nFilename inference:\n');
      for (const [fk, fv] of Object.entries(v)) {
        process.stdout.write(`  ${fk}: ${JSON.stringify(fv)}\n`);
      }
      continue;
    }

    if (k === 'embeddedBinMetadata') {
      process.stdout.write('\nEmbedded BIN metadata:\n');
      for (const [mk, mv] of Object.entries(v)) {
        process.stdout.write(`  ${mk}: ${JSON.stringify(mv)}\n`);
      }
      continue;
    }

    if (k === 'columnInference') {
      process.stdout.write('\nCSV/XLSX single-value column inference:\n');
      for (const [ck, cv] of Object.entries(v)) {
        process.stdout.write(`  ${ck}: ${JSON.stringify(cv)}\n`);
      }
      continue;
    }

    process.stdout.write(`  ${k}: ${JSON.stringify(v)}\n`);
  }
  process.stdout.write(`  singleValueColumnsCount: ${JSON.stringify(result.singleValueColumnsCount)}\n`);
  if (result.ingestError) process.stdout.write(`  ingestError: ${JSON.stringify(result.ingestError)}\n`);
}


async function exportIRFrame({
  irMod,
  frame,
  outputFile,
  outputFormat,
  metaToFilename,
  verbose,
}) {
  const wf = frame.packet.waveform;

  const metadata = frame.packet.metadata ?? {};

  const metadataKeys = Object.keys(metadata)
    .filter(k =>
      typeof metadata[k] !== 'object' &&
      metadata[k] !== undefined &&
      metadata[k] !== null
    );

  const rows = [];

  rows.push([
    'index',
    'value',
    ...metadataKeys
  ]);

  for (let i = 0; i < wf.length; i++) {
    rows.push([
      i,
      wf[i],
      ...metadataKeys.map(k => metadata[k])
    ]);
  }

  let outPath = outputFile;

  if (metaToFilename) {
    const stem = buildMetadataStem(
      path.basename(outputFile),
      metadata,
      frame.capturedVars ?? {},
    );

    outPath = path.join(
      path.dirname(outputFile),
      `${stem}.${outputFormat}`
    );
  }


  if (outputFormat === 'bin') {
    const serializeFrame = irMod?.serializeFrame;

    if (!serializeFrame) {
      throw new Error(
        'serializeFrame export missing in app/lib/ir/index.ts bundle.'
      );
    }

    const { meta, waveform } = serializeFrame(frame);

    const packed = packSerializedIR(meta, waveform);

    await fs.writeFile(outPath, packed);
    return;
  }


  if (outputFormat === 'csv') {
    await fs.writeFile(
      outPath,
      rows.map(r => r.join(',')).join('\n') + '\n',
      'utf8'
    );
    return;
  }


  if (outputFormat === 'xlsx') {
    const excelJsMod = await import('exceljs');
    const ExcelJS = excelJsMod.default ?? excelJsMod;

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('waveform');

    for (const row of rows) {
      worksheet.addRow(row);
    }

    await workbook.xlsx.writeFile(outPath);
    return;
  }


  throw new Error(
    `Unsupported output format: ${outputFormat}`
  );
}

async function runConversionMode({
  inputFile,
  outputFile,
  outputFormat,
  params,
  inferMetaFromFilename,
  metaToFilename,
  verbose,
  startSample,
  endSample,
}) {
  const inputExt = path.extname(inputFile).toLowerCase();
  const outputExt = path.extname(outputFile).toLowerCase();
  // const inputExt = path.extname(inputFile).toLowerCase();
  // console.log({ inputExt, demuxFormat });
  // const packed = await fs.readFile(inputFile);
  // const { meta, waveform } = unpackSerializedIR(packed);
  if (!inputFile) {
    console.error('Usage: node usig.mjs -i <input-file> (--mux bin | --demux csv) [flags] [output_path]');
    process.exit(1);
  }
  if (!outputFile) {
    console.error('[usig] conversion requires an explicit output filename.');
    console.error('Example: usig -i input.csv output.bin');
    process.exit(1);
  }
  if (!outputFormat) {
  throw new Error("No conversion target specified.");
  }

  const irMod = await loadIrEngineModule();
  const {
  frame,
  inputFileName,
} = await ingestInputToIR({
  irMod,
  inputFile,
  startSample,
  endSample,
});

const mergedMetadata = buildConversionMetadata({
  frame,
  params,
  inferMetaFromFilename,
  inputFileName,
});

const frameForExport = {
  ...frame,
  packet: {
    ...frame.packet,
    metadata: mergedMetadata,
  },
};

await exportIRFrame({
  irMod,
  frame: frameForExport,
  outputFile,
  outputFormat,
  metaToFilename,
  verbose,
});

console.log(`[usig] wrote result to ${outputFile}`);
return;
}

function resolvePluginId(pluginId, verbose) {
  if (pluginId === 'hsio') {
    console.warn('[usig] WARNING: plugin "hsio" is deprecated; using "hsioalpha"');
    return 'hsioalpha';
  }
  return pluginId;
}

function inferConversionModeFromOutput(inputFile, outputFile) {
  if (!outputFile) return {};

  const ext = path.extname(outputFile)
    .toLowerCase()
    .replace('.', '');

  if (!['bin','csv','xlsx'].includes(ext)) {
    return {};
  }

  return {
    format: ext,
  };
}

function ingestRawBinaryBuffer(
  buffer,
  inputFileName,
  hints = {}
) {
  const bytesPerSample =
    Number(hints.bytesPerSample ?? 2);

  const encoding =
    hints.encoding ?? 'int16';

  let waveform;

  if (
    encoding === 'int16' &&
    bytesPerSample === 2
  ) {
    waveform = new Int16Array(
      buffer.buffer,
      buffer.byteOffset,
      Math.floor(buffer.byteLength / 2)
    );
  }
  else if (
    encoding === 'float32' &&
    bytesPerSample === 4
  ) {
    waveform = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      Math.floor(buffer.byteLength / 4)
    );
  }
  else {
    throw new Error(
      `Unsupported raw binary encoding: ${encoding}`
    );
  }


  return {
    frame: {
      packet: {
        waveform,
        metadata: {
          sourceFormat: 'raw-bin',

          encoding,
          bytesPerSample,

          endian:
            hints.endian ?? 'little',

          numSamples:
            waveform.length,

          numWaveforms:
            Number(hints.channels ?? 1),

          sampleRateHz:
            hints.sampleRateHz ?? null,

          metadataSources: {
            bin: true
          }
        }
      },

      capturedVars:{}
    },

    inputFileName
  };
}

async function ingestInputToIR({
  irMod,
  inputFile,
  startSample,
  endSample,
}) {
  const IREngine = irMod?.IREngine;

  if (!IREngine) {
    throw new Error(
      'IREngine export missing in app/lib/ir/index.ts bundle.'
    );
  }

  const raw = await fs.readFile(inputFile);
  const inputFileName = path.basename(inputFile);

  const hints = {};

  if (Number.isInteger(startSample))
    hints.startSample = startSample;

  if (Number.isInteger(endSample))
    hints.endSample = endSample;

  const ext = path.extname(inputFile).toLowerCase();

  if (ext === '.bin') {

    if (isUsigBinaryContainer(raw)) {
      const {
        meta,
        waveBytes
      } = unpackSerializedIR(raw);

      const metadata = JSON.parse(meta);

      console.log(JSON.parse(meta));
      console.log("bytes:", waveBytes.byteLength);

      return {
        frame: {
          packet: {
            waveform: deserializeWaveform(waveBytes, metadata),
            metadata
          },
          capturedVars: {}
        },
        inputFileName
      };
    }

    return ingestRawBinaryBuffer(
      raw,
      inputFileName,
      hints
    );
  }

  const file = new File(
    [raw],
    inputFileName,
    {
      type: 'application/octet-stream',
    }
  );

  const irEngine = new IREngine();

  const frame = await irEngine.getOrIngest(
    file,
    Object.keys(hints).length ? hints : undefined
  );

  return {
    frame,
    inputFileName,
  };
}

function buildConversionMetadata({
  frame,
  params,
  inferMetaFromFilename,
  inputFileName,
}) {
  const irMetadata = frame.packet.metadata ?? {};

  const filenameOverrides =
    inferMetaFromFilename
      ? inferMetadataFromFilename(
          inputFileName,
          frame.capturedVars ?? {}
        )
      : {};

  return {
    ...irMetadata,

    ...filenameOverrides,

    ...params,

    metadataSources: {
      ...(irMetadata.metadataSources ?? {}),

      ir: {
        ...(irMetadata.metadataSources?.ir ?? {}),
      },

      filename: {
        ...(irMetadata.metadataSources?.filename ?? {}),
        ...filenameOverrides,
      },

      user: {
        ...(irMetadata.metadataSources?.user ?? {}),
        ...params,
      },
    },

    userOverrides: {
      ...(irMetadata.userOverrides ?? {}),

      ...(inferMetaFromFilename
        ? {
            filenameInferredMetadata: true,
          }
        : {}),
    },

    processingHistory: [
      ...(irMetadata.processingHistory ?? []),
      'converted to usig IR binary container',
    ],
  };
}

function deserializeWaveform(buffer, metadata = {}) {
  const encoding =
    metadata.waveformEncoding ??
    metadata.waveformType ??
    metadata.encoding;

  switch (String(encoding).toLowerCase()) {
    case 'int16array':
    case 'int16':
      return new Int16Array(buffer);

    case 'float32array':
    case 'float32':
      return new Float32Array(buffer);

    case 'float64array':
    case 'float64':
      return new Float64Array(buffer);

    default:
      throw new Error(
        `Unknown waveform encoding in USIG container: ${encoding}`
      );
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const {
    inputFile,
    pluginId,
    pluginIds,
    outputFile,
    params,
    muxFormat,
    demuxFormat,
    inferMetaFromFilename,
    metaToFilename,
    verbose,
    format,
    help,
    probeMetadata,
    startSample,
    endSample,
  } = parseArgs(args);

  // console.log(inferConversionModeFromOutput.toString());

  const inferredConversion =
    inferConversionModeFromOutput(
      inputFile,
      outputFile
    );

  const effectiveConversionFormat =
    muxFormat ??
    demuxFormat ??
    inferredConversion.format;


  if (help || args.length === 0) {
    printHelp();
    process.exit(0);
  }

  if (probeMetadata) {
    await runProbeMetadataMode({
      inputFile,
      verbose,
      format,
    });
    return;
  }

  if (effectiveConversionFormat) {
  await runConversionMode({
    inputFile,
    outputFile,
    outputFormat: effectiveConversionFormat,
    params,
    inferMetaFromFilename,
    metaToFilename,
    verbose,
    startSample,
    endSample,
  });
  return;
}

  if (!inputFile || pluginIds.length === 0) {
    console.error('Usage: node usig.mjs -i <input-file> -plugin <id[,id2]> [-p key=value ...] [-of text|json|csv|yaml]');
    process.exit(1);
  }

  if (!SUPPORTED_FORMATS.has(format)) {
    console.error(`[usig] unsupported format: ${format}. Supported: text, json, csv, yaml`);
    process.exit(1);
  }

  // ── Resolve and validate all requested plugin ids ──────────────────────────
  const resolvedPluginIds = pluginIds.map(id => resolvePluginId(id, verbose));
  for (const id of resolvedPluginIds) {
    if (!(await pluginExists(id))) {
      console.error(`[usig] plugin not found: ${id}`);
      process.exit(1);
    }
  }

  // ── Load IR engine once ──────────────────────────────────────────────────────
  const irMod = await loadIrEngineModule();
  const IREngine = irMod?.IREngine;
  if (!IREngine) throw new Error('IREngine export not found in app/lib/ir/index.ts bundle');
  const irEngine = new IREngine();

  if (verbose) console.log('[usig] reading input:', inputFile);
  const raw = await fs.readFile(inputFile);
  const inputFileName = path.basename(inputFile);
  const file = new File([raw], inputFileName, { type: 'application/octet-stream' });

  // ── Ingest file once through IR (using hints from the first plugin) ──────────
  // All plugin runs below consume this shared frame. This mirrors the web pipeline's
  // "ingest once, analyze many" behavior and avoids repeated file parsing.
  const firstPluginPath = path.join(scriptDir, `app/components/plugins/${resolvedPluginIds[0]}Plugin.tsx`);
  const firstMod = await loadPluginModule(firstPluginPath);
  const firstPlugin = firstMod[`${resolvedPluginIds[0]}Plugin`];
  let sharedHints = firstPlugin && typeof firstPlugin.getIngestHints === 'function'
    ? firstPlugin.getIngestHints({ ...firstPlugin.defaultParams, ...params })
    : undefined;
  if (Number.isInteger(startSample) || Number.isInteger(endSample)) {
    sharedHints = {
      ...sharedHints,
      ...(Number.isInteger(startSample) ? { startSample } : {}),
      ...(Number.isInteger(endSample) ? { endSample } : {}),
    };
  }
  const frame = await irEngine.getOrIngest(file, sharedHints);

  if (verbose) {
    const ns = frame?.packet?.metadata?.numSamples;
    console.log(`[usig] ingested through IR (${ns ?? 'unknown'} samples)`);
  }

  // ── Run each plugin on the shared frame ─────────────────────────────────────
  const allResults = [];
  const allInputSummaries = {};  // keyed by plugin id

  for (const resolvedPluginId of resolvedPluginIds) {
    const pluginPath = path.join(scriptDir, `app/components/plugins/${resolvedPluginId}Plugin.tsx`);
    if (verbose) console.log(`[usig] loading plugin: ${resolvedPluginId}`);
    const mod = resolvedPluginId === resolvedPluginIds[0]
      ? firstMod
      : await loadPluginModule(pluginPath);
    const pluginExport = mod[`${resolvedPluginId}Plugin`];
    if (!pluginExport || (typeof pluginExport.run !== 'function' && typeof pluginExport.runFromWaveform !== 'function')) {
      throw new Error(`${resolvedPluginId}Plugin export not found or invalid in ${pluginPath}`);
    }
    const plugin = pluginExport;

    let finalParams = { ...plugin.defaultParams, ...params };
    const derivedHints = buildDerivedParamHints(frame, params);
    // If fs is unset by hooks/overrides, fall back to IR metadata.
    if ((finalParams.fsGhz === undefined || finalParams.fsGhz === '') && derivedHints.fsGhz) {
      finalParams.fsGhz = derivedHints.fsGhz.value;
    }
    if ((finalParams.adcNumBits === undefined || finalParams.adcNumBits === '') && derivedHints.adcNumBits) {
      finalParams.adcNumBits = derivedHints.adcNumBits.value;
    }
    if ((finalParams.vfsPeakToPeak === undefined || finalParams.vfsPeakToPeak === '') && derivedHints.vfsPeakToPeak) {
      finalParams.vfsPeakToPeak = derivedHints.vfsPeakToPeak.value;
    }

    const inputSummary = buildInputSummary(plugin, finalParams, params, inputFileName, frame.headers ?? [], derivedHints);
    finalParams = { ...finalParams };
    for (const row of inputSummary) finalParams[row.key] = row.value;

    if (verbose) console.log(`[usig] running ${resolvedPluginId} from waveform packet`);

    let scalarResult;
    const originalConsoleLog = console.log;
    try {
      console.log = (...parts) => console.error(...parts);
      if (typeof plugin.runFromWaveform === 'function') {
        scalarResult = await plugin.runFromWaveform(frame.packet, finalParams);
      } else {
        scalarResult = await plugin.run(file, finalParams);
      }
    } catch (err) {
      console.error(`[usig] ${resolvedPluginId}.run() failed:`, err);
      process.exit(1);
    } finally {
      console.log = originalConsoleLog;
    }

    // Tag the result with plugin id so formatReport can label multi-plugin output
    allResults.push({ _plugin: resolvedPluginId, ...scalarResult });
    allInputSummaries[resolvedPluginId] = inputSummary;
  }

  const resolvedPluginId = resolvedPluginIds[0];

  const payload = {
    input: {
      file: inputFile,
      plugin: resolvedPluginIds.length === 1 ? resolvedPluginId : resolvedPluginIds.join('+'),
      format,
      params,
      summary: allInputSummaries[resolvedPluginId] ?? [],
      summaries: allInputSummaries,
    },
    results: allResults,
  };

  const report = formatReport(payload, format);

  // ffprobe-style default: stdout. Keep deprecated positional output for compatibility.
  if (outputFile) {
    if (verbose) console.log('[usig] writing output:', outputFile);
    await fs.writeFile(outputFile, report, 'utf8');
    console.log(`[usig] wrote result to ${outputFile}`);
  } else {
    process.stdout.write(report);
  }

  if (verbose && Object.keys(params ?? {}).length > 0) {
    const suggestion = buildProposedFileName(allInputSummaries[resolvedPluginId] ?? []);
    if (suggestion) {
      console.error(`[usig] proposed file name for current analysis config: ${suggestion}`);
    }
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
