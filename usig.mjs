#!/usr/bin/env node
/**
 * usig.mjs
 *
 * Unified Signal Investigation Generator (USIG)
 *
 * Primary command-line entry point.
 *
 * Overview
 * --------
 *
 * usig.mjs orchestrates every high-level workflow supported by the USIG CLI.
 *
 * Rather than implementing DSP itself, it coordinates:
 *
 *   • input ingestion
 *   • metadata collection
 *   • IR construction
 *   • plugin execution
 *   • format conversion
 *   • serialization
 *   • export
 *
 * Individual plugins and mappers remain responsible for domain-specific logic.
 *
 *
 * High-Level Architecture
 * -----------------------
 *
 *                         command line
 *                              │
 *                              ▼
 *                        parse arguments
 *                              │
 *                              ▼
 *                     determine execution mode
 *                              │
 *          ┌───────────────────┼────────────────────┐
 *          │                   │                    │
 *          ▼                   ▼                    ▼
 *     plugin execution    format conversion     metadata probe
 *          │                   │
 *          ▼                   ▼
 *       ingest input      ingest input
 *          │                   │
 *          └───────────────┬───┘
 *                          ▼
 *                    Canonical IR Packet
 *                          │
 *          +---------------+---------------+
 *          |               |               |
 *          ▼               ▼               ▼
 *      plugins        serializers     exporters
 *
 *
 * Canonical IR
 * ------------
 *
 * One of the major architectural goals of USIG is that every supported input
 * format eventually becomes the same internal representation.
 *
 * Examples:
 *
 *      instrument BIN
 *      USIG BIN
 *      CSV
 *      XLSX
 *      legacy text
 *
 * all become:
 *
 *      Canonical IR Packet
 *
 * Plugins therefore operate on IR rather than file formats.
 *
 *
 * Conversion Pipeline
 * -------------------
 *
 * The CLI now supports bidirectional conversion between supported container
 * formats.
 *
 * Current supported workflows include combinations of:
 *
 *      BIN
 *      CSV
 *      XLSX
 *
 * Conversion intentionally passes through IR rather than implementing
 * format-to-format translators.
 *
 * Therefore:
 *
 *      CSV
 *        │
 *        ▼
 *       IR
 *        ▼
 *      XLSX
 *
 * rather than:
 *
 *      CSV ---> XLSX
 *
 * This guarantees that every format shares identical semantics and metadata
 * handling.
 *
 *
 * Metadata Philosophy
 * -------------------
 *
 * Metadata is accumulated throughout ingestion instead of existing as a single
 * authoritative source.
 *
 * Possible contributors include:
 *
 *   • table metadata
 *   • binary mapper
 *   • filename inference
 *   • CLI user overrides
 *   • plugin-generated metadata
 *   • processing history
 *
 * Metadata provenance is preserved using metadataSources whenever possible.
 *
 * User-specified CLI parameters always represent explicit intent and therefore
 * override inferred values while still preserving provenance.
 *
 *
 * Binary Ingestion
 * ----------------
 *
 * Previous revisions maintained separate ingestion paths for:
 *
 *   • instrument-produced binaries
 *   • USIG-produced binaries
 *
 * After extensive testing the hypothesis-based binary mapper demonstrated
 * compatibility with both classes of files.
 *
 * The duplicate ingestion implementations were therefore retired in favor of a
 * single canonical binary ingestion path.
 *
 * Binary ingestion now follows:
 *
 *      binary
 *         │
 *         ▼
 *   hypothesis mapper
 *         │
 *         ▼
 *     canonical IR
 *
 * If the mapper cannot interpret a binary file, the file is considered outside
 * the supported interchange format. This is an expected and acceptable outcome;
 * USIG targets simple and instrument-aligned binary waveform containers rather
 * than arbitrary proprietary formats.
 *
 *
 * Current CLI Features
 * --------------------
 *
 *   • plugin execution
 *   • automatic conversion mode
 *   • metadata probing
 *   • filename metadata generation
 *   • metadata embedding into exported containers
 *   • parameter overrides (-p key=value)
 *   • multiple plugin execution
 *   • waveform subrange extraction
 *
 *
 * Current Limitations
 * -------------------
 *
 * The parser currently assumes a single logical input.
 *
 * Options such as:
 *
 *      --channel-index
 *      --start-sample
 *      --end-sample
 *
 * are stored globally and therefore apply to only one input.
 *
 * The intended future architecture mirrors FFmpeg.
 *
 * Example:
 *
 *      --channel 0 --start-sample 100 -i left.bin
 *      --channel 1 --start-sample 250 -i right.bin
 *
 * should become:
 *
 *      inputs = [
 *          {
 *              file: left.bin,
 *              channelIndex: 0,
 *              startSample: 100
 *          },
 *          {
 *              file: right.bin,
 *              channelIndex: 1,
 *              startSample: 250
 *          }
 *      ]
 *
 * where each "-i" consumes the currently pending input options.
 *
 * This enables future support for:
 *
 *   • multi-file analysis
 *   • synchronized acquisitions
 *   • channel pairing
 *   • per-input trimming
 *   • future merge and comparison plugins
 *
 *
 * Design Philosophy
 * -----------------
 *
 * usig.mjs is intentionally an orchestrator rather than a processing engine.
 *
 * New functionality should preferably be introduced by extending:
 *
 *   • mappers
 *   • plugins
 *   • serializers
 *   • exporters
 *
 * while keeping the CLI responsible primarily for routing data through the
 * canonical IR pipeline.
 */
import fs from 'node:fs/promises';
import fsRaw from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import readline from 'node:readline';
import * as esbuild from 'esbuild';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const nodeModulesDir = path.join(scriptDir, 'node_modules');

const SUPPORTED_FORMATS = new Set(['text', 'json', 'csv', 'yaml']);

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(args) {
  // CLI parsing intentionally follows a forgiving ffmpeg-like style:
  // - repeated flags are accepted
  // - plugin ids can be comma-separated or space-separated after -plugin
  // - a trailing bare token is treated as positional output path

  /*
 * TODO: Extend CLI parser to support multiple input files and per-input options.
 *
 * Current model:
 *   - The parser assumes exactly one input file (`result.inputFile`).
 *   - Options such as:
 *       --channel-index
 *       --start-sample
 *       --end-sample
 *     are stored globally in `result` and therefore apply to only a single input.
 *
 * Proposed model (similar to FFmpeg):
 *
 *   Introduce:
 *
 *     result.inputs = [
 *       {
 *         file: "left.wav",
 *         channelIndex: 0,
 *         startSample: 100,
 *         endSample: 500
 *       },
 *       {
 *         file: "right.wav",
 *         channelIndex: 1,
 *         startSample: 0,
 *         endSample: null
 *       }
 *     ];
 *
 * Parsing strategy:
 *
 *   Maintain a temporary "pending input options" object while parsing.
 *
 *     let pendingInput = {
 *       channelIndex: null,
 *       startSample: null,
 *       endSample: null,
 *     };
 *
 *   As input-related switches are encountered, populate pendingInput instead
 *   of writing directly into result.
 *
 *   When "-i <file>" is encountered:
 *
 *     result.inputs.push({
 *       file: <file>,
 *       ...pendingInput
 *     });
 *
 *     pendingInput = defaultPendingInput();
 *
 *   Thus each "-i" consumes the currently pending input options, exactly as
 *   FFmpeg parses command lines.
 *
 * Example:
 *
 *     mytool \
 *         --channel 0 --start-sample 100 -i left.wav \
 *         --channel 1 --start-sample 250 -i right.wav
 *
 * becomes:
 *
 *     inputs = [
 *       {
 *         file: "left.wav",
 *         channelIndex: 0,
 *         startSample: 100,
 *         endSample: null
 *       },
 *       {
 *         file: "right.wav",
 *         channelIndex: 1,
 *         startSample: 250,
 *         endSample: null
 *       }
 *     ];
 *
 * Backwards compatibility:
 *
 *   During migration, continue exposing:
 *
 *       result.inputFile = result.inputs[0]?.file ?? null;
 *
 *   so existing single-input code continues to function while newer code
 *   iterates over result.inputs.
 *
 * NOTE:
 *   This is a parser architecture change rather than simply adding support
 *   for repeated "-i" flags, since input-related options become associated
 *   with individual inputs rather than being global.
 */
  const result = {
    inputFile: null,
    outputFile: null,
    pluginId: null,   // kept for compat; populated from pluginIds[0] after parse
    pluginIds: [],    // all requested plugin ids (supports -plugin smeas,sinl,hsioalpha)
    params: {},
    verbose: false,
    format: 'text',
    // muxFormat: null,
    // demuxFormat: null,
    inferMetaFromFilename: false,
    metaToFilename: false,
    help: false,
    probeMetadata: false,
    channelIndex: null,
    startSample: null,
    endSample: null,
    overwrite: false,
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
    } else if ((arg === '--start-sample' || arg === 'ss') && i + 1 < args.length) {
      const idx = Number(args[++i]);
      if (Number.isInteger(idx) && idx >= 0) result.startSample = idx;
    } else if ((arg === '--end-sample' || arg === 'to') && i + 1 < args.length) {
      const idx = Number(args[++i]);
      if (Number.isInteger(idx) && idx >= 0) result.endSample = idx;
    } else if ((arg === '-of' || arg === '--format' || arg === '-print_format') && i + 1 < args.length) {
      result.format = String(args[++i]).toLowerCase();
    } else if (arg === '-y') {
      result.overwrite = true;
    } else if (arg === '-v' || arg === 'verbose' || arg === '--verbose') {
      result.verbose = true;
    } else if (arg === '-h' || arg === '--help') {
      result.help = true;
    } else if (!arg.startsWith('-') && result.inputFile && !result.outputFile) {
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
USIG — waveform analysis CLI

USAGE

  usig -i <input-file> -plugin <id> [options]
  usig -i <input-file> -plugin <id[,id2]> [options]
  usig -i <input-file> <output-file> [options]

ANALYSIS

  -i <file>                 Input waveform file
  -plugin <id[,id2]>        Plugin(s) to run
  -p <key=value>            Override an input parameter
  -of <format>              Output format: text | json | csv | yaml

  Multiple plugins may be specified as a comma-separated list.
  All requested plugins run against the same ingested waveform.

INPUTS

  Plugin inputs are resolved automatically.

  Resolution order:

    1. Explicit -p key=value
    2. Filename inference
    3. Input-column inference
    4. Plugin defaults

  Explicit -p values have highest priority.

  For CSV/XLSX input, USIG can infer a sample column from the
  available input columns when the plugin requires one.

  Resolved inputs are always shown in the analysis output,
  including where each value came from.

  Example:

    Inputs:
      sampleColumn = "data" << inferred from source column
      inputMode = "codes" << default applied
      maxCode = 2047 << default applied

  The source annotation is part of the normal analysis output.
  -v does not control whether Inputs are displayed.

  Use -v to additionally show ingestion, inference, parameter,
  frame, and other diagnostic/debug information.

CONVERSION

  Conversion mode is selected from the output filename extension.

  Supported output formats:

    .bin
    .csv
    .xlsx

  Examples:

    usig -i input.csv output.bin
    usig -i input.bin output.csv
    usig -i input.bin output.xlsx

  Conversion uses the same canonical IR representation as analysis.

OPTIONS

  -v                        Show additional diagnostic/debug output
  -y                        Overwrite an existing output file
  -h                        Show this help
  -start-sample <n>         Start at sample index <n>
  -end-sample <n>           End at sample index <n>
  -probe-metadata           Inspect input metadata

METADATA

  Filename metadata can be inferred when enabled.

  -infer-meta-from-filename
                            Infer metadata from the input filename

  -meta-to-filename         Include metadata in the output filename

  Metadata and analysis inputs are separate concepts.

  Inputs control plugin execution.
  Metadata describes the measurement or source file.

EXAMPLES

  Analyze a waveform using a plugin:

    usig -i waveform.csv -plugin sinl

  Show additional diagnostic/debug information:

    usig -i waveform.csv -plugin sinl -v

  Override a plugin input:

    usig -i waveform.csv -plugin sinl -p maxCode=4095

  Override multiple inputs:

    usig -i waveform.csv -plugin sinl \\
      -p sampleColumn=data \\
      -p maxCode=4095

  Run multiple plugins:

    usig -i waveform.csv -plugin sinl,otherplugin

  Analyze a selected sample range:

    usig -i waveform.csv -plugin sinl \\
      -start-sample 1000 \\
      -end-sample 9000

  Convert CSV to USIG binary:

    usig -i waveform.csv output.bin

  Convert USIG binary to CSV:

    usig -i waveform.bin output.csv

  Convert USIG binary to Excel:

    usig -i waveform.bin output.xlsx

  Inspect metadata:

    usig -i waveform.csv -probe-metadata

PLUGIN HELP

  Show the available plugins:

    usig -h

  Show help for a specific plugin:

    usig -h -plugin sinl

  Plugin-specific help includes the plugin's configurable inputs,
  their types, descriptions, required/optional status, possible
  values, aliases, and defaults where available.

  Example:

    usig -h -plugin sinl

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
      platform: 'node',
      loader: { '.tsx': 'tsx', '.ts': 'ts' },
      outfile: tmpPath,
      external: ['react', 'react-dom', 'fft.js', 'recharts', 'fs', 'path'],
      sourcemap: false,
      absWorkingDir: scriptDir,
      nodePaths: [nodeModulesDir],
    });

    return await import(pathToFileURL(tmpPath).href + `?t=${Date.now()}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function loadBinMapperModule() {
  const tmpDir = path.join(scriptDir, `.tmp_usig_bin_mapper_${Date.now()}`);
  const tmpPath = path.join(tmpDir, 'bin-mapper.mjs');

  await fs.mkdir(tmpDir, { recursive: true });

  try {
    await esbuild.build({
      entryPoints: [
        path.join(scriptDir, 'app/lib/ir/binMapper.ts')
      ],
      bundle: true,
      // IMPORTANT:
      // mapper depends on Node APIs through hypothesis_gen_for_ir_from_bin.js
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      loader: {
        '.ts': 'ts',
      },
      outfile: tmpPath.replace('.mjs', '.cjs'),
      sourcemap: false,
      absWorkingDir: scriptDir,
      nodePaths: [nodeModulesDir],
      external: ['fs', 'path'],
    });

    const mod = await import(
        pathToFileURL(tmpPath.replace('.mjs', '.cjs')).href +`?t=${Date.now()}`);
    return mod;

  } finally {
    await fs.rm(tmpDir, {
      recursive: true,
      force: true,
    });
  }
}

async function loadCsvXlsxMapperModule() {
  const tmpDir = path.join(
    scriptDir,
    `.tmp_usig_csvxlsx_mapper_${Date.now()}`
  );

  const tmpPath = path.join(
    tmpDir,
    'csvxlsx-mapper.mjs'
  );

  await fs.mkdir(tmpDir, {
    recursive: true,
  });

  try {
    await esbuild.build({
      entryPoints: [
        path.join(
          scriptDir,
          'app/lib/ir/csvxlsxMapper.ts'
        )
      ],

      bundle: true,

      platform: 'node',

      format: 'esm',

      target: 'node20',

      loader: {
        '.ts': 'ts',
      },

      outfile: tmpPath,

      sourcemap: false,

      absWorkingDir: scriptDir,

      nodePaths: [
        nodeModulesDir
      ],

      external: [
        'fs',
        'path',
        'exceljs'
      ],
    });

    return await import(
      pathToFileURL(tmpPath).href +
      `?t=${Date.now()}`
    );

  } finally {
    await fs.rm(tmpDir, {
      recursive: true,
      force: true,
    });
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
    if (typeof row.value === 'number') {
      parts.push(`${keyInfo.name}${token}${keyInfo.unit}`);
    }
    else if (typeof row.value === 'string') {
      parts.push(`${keyInfo.name}~${token}`);
    }
  }
  return parts.filter(Boolean).join('_');
}

function formatInputValue(value) {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (value === undefined) {
    return 'undefined';
  }

  if (value === null) {
    return 'null';
  }

  return String(value);
}

function describeSource(key, detail) {
  const value = formatInputValue(detail.value);

  if (detail.source === 'override') {
    return `${key} = ${value} << overridden from user input`;
  }

  if (detail.source === 'filename') {
    return `${key} = ${value} << inferred from file name`;
  }

  if (detail.source === 'column') {
    return `${key} = ${value} << inferred from source column`;
  }

  if (detail.source === 'metadata') {
    return `${key} = ${value} << inferred from file metadata / IR`;
  }

  if (detail.source === 'default') {
    return `${key} = ${value} << default applied`;
  }

  return `${key} = ${value}`;
}


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
  const all = [
    ...(plugin.paramFields ?? []),
    ...(plugin.inferredParamFields ?? []),
    ...(plugin.manifest?.paramSchema ?? []),
  ];
  const seen = new Set();
  const deduped = [];
  for (const field of all) {
    if (!field?.key || seen.has(field.key)) continue;
    seen.add(field.key);
    deduped.push(field);
  }
  return deduped;
}

function fieldMatchesFilenameToken(field, token) {
  if (!field?.key || !token?.key) return false;

  const fieldKey = normalizeMetadataKey(field.key);
  if (!fieldKey) return false;

  const candidates = buildFilenameTokenCandidates(token);

  // Direct match:
  //
  // filename: fs2p25ghz
  // token:    fs + 2.25 + ghz
  // field:    fsGhz
  //
  // => fsg hz == fsghz
  if (candidates.has(fieldKey)) {
    return true;
  }

  // Also allow a field key to carry a unit suffix while the filename
  // token supplies that unit separately.
  //
  // This remains generic: no knowledge of "fs", "ghz", "v", etc.
  if (token.unit) {
    const unit = normalizeMetadataKey(token.unit);

    if (
      fieldKey.endsWith(unit) &&
      fieldKey.slice(0, -unit.length) ===
        normalizeMetadataKey(token.key)
    ) {
      return true;
    }
  }

  return false;
}

function resolveFilenameTokenForField(field, filename) {
  const tokens = extractStrictInferenceTokens(filename);

  for (const token of tokens) {
    if (!fieldMatchesFilenameToken(field, token)) continue;

    let value;

    if (token.value !== undefined && token.value !== '') {
      value = token.value;
    } else {
      continue;
    }

    let normalized = String(value);

    if (/^m\d/i.test(normalized)) {
      normalized = `-${normalized.slice(1)}`;
    } else if (/^p\d/i.test(normalized)) {
      normalized = normalized.slice(1);
    }

    normalized = normalized.replace(/p(?=\d)/gi, '.');

    const numeric = Number(normalized);

    if (Number.isFinite(numeric)) {
      return {
        value: numeric,
        source: 'filename',
        token: token.token,
        unit: token.unit ?? '',
      };
    }

    return {
      value,
      source: 'filename',
      token: token.token,
      unit: token.unit ?? '',
    };
  }

  return null;
}

function resolveFieldValue(
  field,
  explicitParams,
  fileName,
  headers,
  derivedHints = {},
  pluginDefaultParams = {}
) {
  const hasOverride =
    Object.prototype.hasOwnProperty.call(
      explicitParams,
      field.key
    );

  // 1. Explicit -p always wins.
  if (hasOverride) {
    return {
      value: explicitParams[field.key],
      source: 'override',
    };
  }

  // 2. Column selector.
  if (field.type === 'column-select') {
    if (
      field.defaultValue &&
      headers?.includes(field.defaultValue)
    ) {
      return {
        value: field.defaultValue,
        source: 'column',
      };
    }

    const chosen =
      headers?.[0] ??
      field.defaultValue ??
      '';

    if (chosen !== '') {
      return {
        value: chosen,
        source:
          headers?.[0]
            ? 'column'
            : 'default',
      };
    }

    return {
      value: '',
      source: 'default',
    };
  }

  // 3. Generic filename inference.
  const filenameInferred =
    resolveFilenameTokenForField(
      field,
      fileName
    );

  if (filenameInferred) {
    return {
      ...filenameInferred,
      value: coerceFieldValue(
        field,
        filenameInferred.value
      ),
    };
  }

  // 4. Legacy field-specific filename regex.
  const filenamePattern =
    field.defaultPattern ??
    pluginDefaultParams?.[
      `${field.key}Regex`
    ] ??
    '';

  const filenameReplacements =
    field.defaultReplacements ??
    pluginDefaultParams?.[
      `${field.key}Replace`
    ] ??
    '';

  if (filenamePattern?.trim()) {
    const fromFilename =
      applyRegexToFilename(
        fileName,
        filenamePattern,
        filenameReplacements
      );

    if (fromFilename) {
      const transformed =
        field.transform
          ? field.transform(fromFilename)
          : fromFilename;

      return {
        value: transformed,
        source: 'filename',
      };
    }
  }

  // 5. Derived IR metadata.
  if (
    Object.prototype.hasOwnProperty.call(
      derivedHints,
      field.key
    )
  ) {
    return derivedHints[field.key];
  }

  // 6. Plugin default.
  if (
    field.defaultValue !== undefined
  ) {
    return {
      value: field.defaultValue,
      source: 'default',
    };
  }

  return {
    value: '',
    source: 'default',
  };
}

function buildInputSummary(
  plugin,
  finalParams,
  explicitParams,
  inputFileName,
  headers,
  derivedHints,
  strictFilenameInference,
  verbose
) {
  if (verbose) console.error(
    '[DEBUG buildInputSummary entry]',
    {
      inputFileName,
      pluginDefaultParams:
        plugin?.defaultParams,
      explicitParams,
      strictFilenameInference,
    }
  );

  const fields =
    collectDisplayFields(plugin);

  const fieldMap =
    new Map(
      fields.map(field => [
        field.key,
        field
      ])
    );

  const summary = [];

    for (const field of fields) {
  const resolved =
    resolveFieldValue(
      field,
      explicitParams,
      inputFileName,
      headers,
      derivedHints,
      plugin?.defaultParams ?? {}
    );

  let value = resolved.value;
  let source = resolved.source;

  if (
    value === '' ||
    value === undefined
  ) {
    if (
      Object.prototype.hasOwnProperty.call(
        finalParams ?? {},
        field.key
      )
    ) {
      value = finalParams[field.key];
      source = 'default';
    }
  }

  if (
    value === '' ||
    value === undefined
  ) {
    continue;
  }

  summary.push({
    key: field.key,
    value,
    source,
    ...(resolved.token
      ? { token: resolved.token }
      : {}),
    ...(resolved.unit
      ? { unit: resolved.unit }
      : {}),
  });
  }

  // Preserve explicit parameters which aren't
  // represented by plugin display fields.
  for (
    const key of Object.keys(
      finalParams ?? {}
    )
  ) {
    if (fieldMap.has(key)) continue;

    if (
      !Object.prototype.hasOwnProperty.call(
        explicitParams,
        key
      )
    ) {
      continue;
    }

    const value =
      finalParams[key];

    if (
      value === '' ||
      value === undefined
    ) {
      continue;
    }

    summary.push({
      key,
      value,
      source: 'override',
    });
  }

  return summary;
}



function formatReport(payload, format, verbose) {
  if (verbose) console.log('[DEBUG formatReport payload]', JSON.stringify(payload, null, 2));
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
    if (!payload.input.summary || payload.input.summary.length === 0) {
      lines.push('  (no inputs)');
    } else {
      for (const row of payload.input.summary) {
        lines.push(`  ${describeSource(row.key, row)}`);
      }
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

function buildMetadataStem(inputFileName, metadata = {}, capturedVars = {}) {
  const parts = [];
  const merged = {
    ...capturedVars,
    ...metadata,
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

function inferMetadataFromFilename(inputFileName, capturedVars = {}) {
  const inferred = {};

  const tokens = inferStrictMetadataFromFilename(inputFileName);

  for (const [key, entry] of Object.entries(tokens)) {
    if (entry.valueNum !== undefined) {
      inferred[key] = entry.valueNum;
    } else if (entry.valueRaw !== undefined) {
      inferred[key] = entry.valueRaw;
    }
  }

  // Captured variables are lower priority than filename inference.
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
      const usigMeta = await deserializeFrame(inputFile);
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
  const packet = frame.packet;
  console.log('[exportIRFrame debug]', {
  hasPacket: !!packet,
  waveformType: packet?.waveform?.constructor?.name,
  waveformLength: packet?.waveform?.length,
  channels: packet?.channels?.length,
  metadata: packet?.metadata,
  });
  const channels =
      packet.channels ??
      packet.arrays ??
      null;
  const wf =
      packet.waveform ??
      channels?.[0]?.waveform;

  const metadata = packet.metadata ?? {};

  const metadataKeys = Object.keys(metadata).filter(k =>
      typeof metadata[k] !== 'object' &&
      metadata[k] !== undefined &&
      metadata[k] !== null
  );

const rows = [];

if (channels && channels.length > 0) {

  rows.push([
    ...channels.map(ch => ch.label),
    ...metadataKeys
  ]);

  const length = Math.max(
    ...channels.map(ch => ch.waveform.length)
  );

  for (let i = 0; i < length; i++) {
    rows.push([
      ...channels.map(ch => ch.waveform[i] ?? ''),
      ...metadataKeys.map(k => metadata[k])
    ]);
  }
} else {
  rows.push([
      ...metadataKeys
  ]);
  for (let i = 0; i < wf.length; i++) {
    rows.push([
        wf[i],
      ...metadataKeys.map(k => metadata[k])
    ]);
  }
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
                                   overwrite
}) {
  const inputExt = path.extname(inputFile).toLowerCase();
  const outputExt = path.extname(outputFile).toLowerCase();
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
    params,
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

if (!overwrite) {
  try {
    await fs.access(outputFile);
    throw new Error(
      `Output exists: ${outputFile}. Use -y to overwrite.`
    );
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

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

function inferConversionModeFromOutput(outputFile) {
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

async function ingestInputToIR({
  irMod,
  inputFile,
  startSample,
  endSample,
  params,
}) {
  const hints = {
    ...(params ?? {}),
  };

  const IREngine = irMod?.IREngine;
  if (!IREngine) {
    throw new Error(
      'IREngine export missing in app/lib/ir/index.ts bundle.'
    );
  }

  const raw = await fs.readFile(inputFile);
  const inputFileName = path.basename(inputFile);

  if (Number.isInteger(startSample)) {
    hints.startSample = startSample;
  }

  if (Number.isInteger(endSample)) {
    hints.endSample = endSample;
  }

  const ext = path.extname(inputFile).toLowerCase();

  if (ext === '.bin') {
    const mapperMod = await loadBinMapperModule();

    const packet = await mapperMod.mapBinaryToIRCandidate({
      inputPath: inputFile,
      filename: inputFileName,
      hints,
    });

    return {
      frame: {
        ...packet,
        headers: [],
        singleValueColumns: {},
        cacheKey: null,
        hintsKey: null,
        ingestedAt: Date.now(),
        schemaVersion: 1,
      },
      inputFileName,
    };
  }

  if (ext === '.csv' || ext === '.xlsx') {
    const mapperMod = await loadCsvXlsxMapperModule();

    const mapped = await mapperMod.mapCsvXlsxToIRCandidate({
      inputPath: inputFile,
      filename: inputFileName,
      hints,
    });

    if (!mapped?.packet) {
      throw new Error(
        'CSV/XLSX mapper returned an invalid IR candidate: missing packet.'
      );
    }

    const packet = mapped.packet;

    const waveform =
      packet.waveform ??
      packet.arrays?.[0]?.waveform ??
      packet.channels?.[0]?.waveform;

    if (!waveform) {
      throw new Error(
        'CSV/XLSX mapper returned an IR packet without waveform or channels.'
      );
    }

    const channels =
      packet.channels ??
      packet.arrays ??
      [{
        label:
          packet.metadata?.signalColumn ??
          packet.metadata?.channelLabels?.[0] ??
          'data',
        units: packet.metadata?.units,
        waveform,
      }];

    const normalizedPacket = {
      ...packet,
      waveform,
      arrays: channels,
      channels,
      metadata: {
        ...(packet.metadata ?? {}),
        channelLabels:
          packet.metadata?.channelLabels ??
          channels.map(ch => ch.label),
      },
    };

    console.log('[DEBUG CSV PACKET NORMALIZATION]', {
      packetKeys: Object.keys(normalizedPacket),
      waveformLength: normalizedPacket.waveform?.length,
      channels: normalizedPacket.channels?.map(ch => ({
        label: ch.label,
        units: ch.units,
        waveformLength: ch.waveform?.length,
      })),
    });

    return {
      frame: {
        packet: normalizedPacket,
        headers:
          packet.metadata?.columnLabels ??
          normalizedPacket.channels.map(ch => ch.label),
        singleValueColumns: {},
        cacheKey: null,
        hintsKey: null,
        ingestedAt: Date.now(),
        schemaVersion: 1,
        capturedVars: mapped.capturedVars ?? {},
      },
      inputFileName,
    };
  }

  // TXT and other legacy formats
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


function buildFilenameParamHints(
  plugin,
  inputFileName
) {
  const hints = {};

  const fields =
    collectDisplayFields(plugin);

  for (const field of fields) {
    const inferred =
      resolveFilenameTokenForField(
        field,
        inputFileName
      );

    if (!inferred) continue;

    hints[field.key] =
      inferred.value;
  }

  return hints;
}

function normalizeMetadataKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function buildFilenameTokenCandidates(token) {
  const key =
    normalizeMetadataKey(token.key);

  const unit =
    normalizeMetadataKey(token.unit);

  const candidates =
    new Set();

  if (key) {
    candidates.add(key);
  }

  if (key && unit) {
    candidates.add(`${key}${unit}`);
  }

  return candidates;
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

function printPluginHelp(pluginId, plugin) {
  console.log(`USIG — ${pluginId} plugin`);
  console.log('');

  const schema =
    plugin?.manifest?.paramSchema ?? [];

  console.log('INPUTS');

  if (schema.length === 0) {
    console.log('  (no configurable inputs)');
  } else {
    for (const field of schema) {
      console.log('');
      console.log(`  ${field.key}`);

      if (field.label) {
        console.log(`    Label: ${field.label}`);
      }

      if (field.description) {
        console.log(`    ${field.description}`);
      }

      if (field.type) {
        console.log(`    Type: ${field.type}`);
      }

      console.log(
        `    Required: ${field.required ? 'yes' : 'no'}`
      );

      if (
        Array.isArray(field.possibleValues) &&
        field.possibleValues.length > 0
      ) {
        console.log(
          `    Values: ${field.possibleValues.join(' | ')}`
        );
      }

      if (
        plugin?.defaultParams &&
        Object.prototype.hasOwnProperty.call(
          plugin.defaultParams,
          field.key
        )
      ) {
        console.log(
          `    Default: ${plugin.defaultParams[field.key]}`
        );
      }

      if (
        Array.isArray(field.aliases) &&
        field.aliases.length > 0
      ) {
        console.log(
          `    Aliases: ${field.aliases.join(', ')}`
        );
      }
    }
  }

  console.log('');
  console.log('INPUT RESOLUTION');
  console.log('');
  console.log('  Explicit -p values override inferred values.');
  console.log('  Otherwise USIG may use filename inference,');
  console.log('  column inference, and plugin defaults.');
  console.log('');
  console.log('EXAMPLE');
  console.log('');
  console.log(`  usig -i waveform.csv -plugin ${pluginId}`);
}


// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2); // split by space starting from index 2, first two are node path
  // process.argv[0] → the Node executable path
  // process.argv[1] → the script path
  // similar to python's [2:] notion
  const {
    inputFile,
    pluginId,
    pluginIds,
    outputFile,
    params,
    inferMetaFromFilename,
    metaToFilename,
    verbose,
    format,
    help,
    probeMetadata,
    startSample,
    endSample,
    overwrite,
  } = parseArgs(args);

  // console.log(inferConversionModeFromOutput.toString());

  const inferredConversion = inferConversionModeFromOutput(outputFile);

  const effectiveConversionFormat = inferredConversion.format;

  if (help) {
  if (pluginIds.length > 0) {
    const resolvedPluginId =
      resolvePluginId(pluginIds[0], false);

    if (!(await pluginExists(resolvedPluginId))) {
      console.error(
        `[usig] plugin not found: ${resolvedPluginId}`
      );
      process.exit(1);
    }

    const pluginPath = path.join(
      scriptDir,
      `app/components/plugins/${resolvedPluginId}Plugin.tsx`
    );

    const pluginMod =
      await loadPluginModule(pluginPath);

    const plugin =
      pluginMod[`${resolvedPluginId}Plugin`];

    if (!plugin) {
      throw new Error(
        `${resolvedPluginId}Plugin export not found in ${pluginPath}`
      );
    }

    printPluginHelp(
      resolvedPluginId,
      plugin
    );
  } else {
    printHelp();
  }

  process.exit(0);
}

if (args.length === 0) {
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
    overwrite
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

  const inputFileName = path.basename(inputFile);

  const raw = await fs.readFile(inputFile);

  const file = new File(
    [raw],
    inputFileName,
    {
      type: 'application/octet-stream'
    }
  );


  const firstPluginPath = path.join(
    scriptDir,
    `app/components/plugins/${resolvedPluginIds[0]}Plugin.tsx`
  );

  const firstMod =
    await loadPluginModule(firstPluginPath);

  const firstPlugin =
    firstMod[`${resolvedPluginIds[0]}Plugin`];

  const filenameParamHints =
    buildFilenameParamHints(
      firstPlugin,
      inputFileName
    );

  const ingestionParams = {
    ...(firstPlugin?.defaultParams ?? {}),
    ...filenameParamHints,
    ...(params ?? {}),
  };

  let sharedHints =
    firstPlugin &&
    typeof firstPlugin.getIngestHints === 'function'
      ? firstPlugin.getIngestHints(ingestionParams)
      : undefined;

  if (Number.isInteger(startSample) || Number.isInteger(endSample)) {
    sharedHints = {
      ...sharedHints,
      ...(Number.isInteger(startSample)
        ? { startSample }
        : {}),
      ...(Number.isInteger(endSample)
        ? { endSample }
        : {}),
    };
  }

   // ── Canonical input ingestion ───────────────────────────────────────────────
  // CSV/XLSX must use the same mapper as conversion mode. This guarantees that
  // plugin execution and conversion receive the same canonical IR packet shape.
  const ext = path.extname(inputFile).toLowerCase();

  let frame;

  if (ext === '.csv' || ext === '.xlsx') {
    const ingested = await irEngine.getOrIngest(
      file,
      sharedHints
    );

    const canonicalFrame = ingested.frame ?? ingested;
    const packet = canonicalFrame?.packet ?? {};

    const waveform =
      packet.waveform ??
      packet.arrays?.[0]?.waveform ??
      packet.channels?.[0]?.waveform;

    if (!waveform) {
      throw new Error(
        'CSV/XLSX ingestion returned an IR packet without waveform.'
      );
    }

    const existingChannels =
      packet.channels ??
      packet.arrays ??
      [];

    const channels =
      existingChannels.length > 0
        ? existingChannels
        : [{
            label:
              packet.metadata?.signalColumn ??
              packet.metadata?.channelLabels?.[0] ??
              canonicalFrame?.headers?.[0] ??
              'data',
            units: packet.metadata?.units,
            waveform,
          }];

    frame = {
      ...canonicalFrame,
      packet: {
        ...packet,
        waveform,
        channels,
        arrays: channels,
        metadata: {
          ...(packet.metadata ?? {}),
          channelLabels:
            packet.metadata?.channelLabels ??
            channels.map(ch => ch.label),
        },
      },
    };

  } else {

    const ingested = await irEngine.getOrIngest(
      file,
      sharedHints
    );

    frame = ingested.frame ?? ingested;

    console.log('[DEBUG getOrIngest RETURN]', {
      type: typeof ingested,
      keys: Object.keys(ingested ?? {}),
      hasFrame: !!ingested?.frame,
      frameKeys: Object.keys(ingested?.frame ?? {}),
    });

  }

  if (verbose) {
    console.error('[DEBUG CANONICAL FRAME]', {
      packetKeys: Object.keys(frame?.packet ?? {}),
      metadata: frame?.packet?.metadata,
      waveformType: frame?.packet?.waveform?.constructor?.name,
      waveformLength: frame?.packet?.waveform?.length,
      channels: frame?.packet?.channels?.map(ch => ({
        label: ch?.label,
        units: ch?.units,
        waveformLength: ch?.waveform?.length,
      })),
      headers: frame?.headers,
      capturedVars: frame?.capturedVars,
    });

    const ns =
      frame?.packet?.metadata?.numSamples ??
      frame?.packet?.waveform?.length ??
      frame?.packet?.channels?.[0]?.waveform?.length;

    console.log(`[usig] ingested through IR (${ns ?? 'unknown'} samples)`);
  }


  // ── Run each plugin on the shared frame ─────────────────────────────────────
  const allResults = [];
  const allInputSummaries = {};  // keyed by plugin id
  const allParamSchemas = {};  // keyed by plugin id


  for (const resolvedPluginId of resolvedPluginIds) {
    const pluginPath = path.join(scriptDir, `app/components/plugins/${resolvedPluginId}Plugin.tsx`);
    if (verbose) console.log(`[usig] loading plugin: ${resolvedPluginId}`);
    const mod = resolvedPluginId === resolvedPluginIds[0]
      ? firstMod
      : await loadPluginModule(pluginPath);
    const pluginExport = mod[`${resolvedPluginId}Plugin`];
    if (!pluginExport || typeof pluginExport.run !== 'function') {
      throw new Error(`${resolvedPluginId}Plugin export not found or invalid in ${pluginPath}`);
    }
    const plugin = pluginExport;
    allParamSchemas[resolvedPluginId] = plugin.manifest?.paramSchema ?? [];

    let finalParams = {
      ...plugin.defaultParams,
      ...filenameParamHints,
      ...params,
    };

    const derivedHints = buildDerivedParamHints(frame, params);
    const strictFilenameInference =
      inferStrictMetadataFromFilename(inputFileName);


    if (verbose) console.error('[DEBUG filename inference]', {
      inputFileName,
      plugin: resolvedPluginId,
      strictFilenameInference,
      pluginDefaultParams: plugin.defaultParams,
      explicitParams: params,
    });

    const inputSummary = buildInputSummary(
      plugin,
      finalParams,
      params,
      inputFileName,
      frame.headers ?? [],
      derivedHints,
      strictFilenameInference,
      verbose
    );

    finalParams = { ...finalParams };
    for (const row of inputSummary) finalParams[row.key] = row.value;

    if (verbose) console.log(`[usig] running ${resolvedPluginId} from waveform packet`);

    let scalarResult;
    const originalConsoleLog = console.log;
    try {
      console.log = (...parts) => console.error(...parts);
      if (verbose) console.error('[DEBUG FINAL PLUGIN PARAMS]', {
        plugin: resolvedPluginId,
        inputFileName,
        finalParams,
      });

      scalarResult = await plugin.run(frame.packet, finalParams);

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
      paramSchema: resolvedPluginIds.length === 1
        ? allParamSchemas[resolvedPluginId] ?? []
        : [],
      format,
      params,
      summary: allInputSummaries[resolvedPluginId] ?? [],
      summaries: allInputSummaries,
    },
    results: allResults,
  };
  if (verbose) {
    console.log('[DEBUG before formatReport] payload =', JSON.stringify(payload, null, 2));
    console.log('[DEBUG before formatReport] payload keys =', Object.keys(payload || {}));
    console.log('[DEBUG before formatReport] payload.input =', JSON.stringify(payload?.input, null, 2));
    console.log('[DEBUG before formatReport] payload.results =', JSON.stringify(payload?.results, null, 2));
  }
  const report = formatReport(payload, format, verbose);

  // ffprobe-style default: stdout. Keep deprecated positional output for compatibility.
  if (outputFile) {
    if (verbose) console.log('[usig] writing output:', outputFile);

  if (fs.existsSync(outputFile) && !args.overwrite) {
      const answer = await askConfirmation(
        `File exists: ${outputFile}. Overwrite? (y/N) `
      );

      if (answer.toLowerCase() !== 'y') {
        throw new Error('Output file exists; operation cancelled');
      }
    }
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
