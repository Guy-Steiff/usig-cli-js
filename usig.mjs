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
import sharp from 'sharp';
import { renderFigureToSvg } from './app/lib/figureRenderSvg.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const nodeModulesDir = path.join(scriptDir, 'node_modules');

const SUPPORTED_FORMATS = new Set(['text', 'json', 'csv', 'yaml']);

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(args) {
  // Minimal parser supporting repeated -plugin instances where per-plugin -p and -debug
  // flags attach to the most recently declared plugin. Backwards-compatible fields
  // (pluginIds, params) are preserved for callers that expect the old shape.
  const result = {
    inputFile: null,
    // Canonical ordered list of input specifications, one per -i occurrence
    // (or expanded from a -f concat list later). Each entry:
    //   { file, startSample, endSample, inputFormat }
    inputFiles: [],
    outputFile: null,
    pluginId: null,
    pluginIds: [],
    // Backwards compat top-level global params (rare); prefer per-plugin params.
    params: {},
    // New: array of plugin invocation objects in order of appearance.
    pluginInvocations: [],
    verbose: false,
    format: 'text',
    inferMetaFromFilename: false,
    metaToFilename: false,
    help: false,
    probeMetadata: false,
    channelIndex: null,
    startSample: null,
    endSample: null,
    overwrite: false,
    // Global: when true, every generated figure also emits a sibling
    // PortableFigureDescription JSON file. Off by default (SVG/PNG/JPEG only).
    figAsJson: false,
    inputFormat: null,
    // Set when a positional output arg follows two or more inputs that have
    // no individual output of their own (e.g. "-i A -i B out.xlsx"). This
    // shape is not a supported mass-conversion job list; execution paths
    // must reject it explicitly rather than guessing which input it means.
    multiInputSharedOutputAttempt: null,
    // Set when a positional output arg appears with zero -i declared at all
    // (e.g. "-plugin sinl -debug list output.csv"). An output path without
    // any input is never valid; execution paths must reject it explicitly.
    unattachedPositionalOutput: null,
  };

  let currentInvocation = null;
  // Tracks the most recently declared -i input specification, so that
  // per-input flags (-ss, -to, -f) can attach to the correct input.
  let currentInput = null;
  // -f may appear *before* its corresponding -i (e.g. "-f concat -i list.txt").
  // In that case the format is held here until the next -i creates an input.
  let pendingFormat = null;
  // Input specs declared since the last positional output was consumed.
  // A trailing positional argument attaches to the sole entry here (the
  // "-i <in> <out>" job grammar). If more than one input has accumulated
  // without an intervening output (e.g. "-i A -i B out"), the positional
  // is ambiguous — record it as an explicit unsupported attempt rather
  // than guessing which input it belongs to.
  let unassignedOutputInputs = [];

  const isPluginId = (s) => s && !s.includes('.') && !s.includes('/') && !s.includes('\\');

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-i' && i + 1 < args.length) {
      const file = args[++i];
      const inputSpec = {
        file,
        startSample: null,
        endSample: null,
        inputFormat: pendingFormat,
        // Per-job output (mass-conversion): the positional argument that
        // immediately follows this input (before the next -i) becomes its
        // output. Remains null for plugin/analyzer invocations, which don't
        // use per-input positional outputs.
        output: null,
        // Job-scoped plugin invocations (Option B): every -plugin/-p/-debug/
        // -figure declared while this is the current input is recorded here
        // (in addition to the flat result.pluginInvocations, which remains
        // for single-job backward compatibility). Enables independent jobs
        // such as "-i A -plugin sinl ... -i B -plugin smeas ...".
        pluginInvocations: [],
      };
      pendingFormat = null;
      result.inputFiles.push(inputSpec);
      currentInput = inputSpec;
      unassignedOutputInputs.push(inputSpec);
      // Backwards compat: result.inputFile mirrors the first declared input.
      if (result.inputFile === null) result.inputFile = file;
    } else if (arg === '-plugin' && i + 1 < args.length) {
      // Start one or more plugin invocations. Support comma-separated legacy form
      // by creating multiple invocations, but prefer the repeated -plugin model.
      const token = args[++i];
      for (const id of token.split(',')) {
        const trimmed = id.trim();
        if (!trimmed) continue;
        const invocation = {
          pluginId: trimmed,
          params: {},
          debugRequests: [],
          figureRequests: [],
        };
        result.pluginInvocations.push(invocation);
        result.pluginIds.push(trimmed);
        currentInvocation = invocation;
        // Job-scoped attachment (Option B): bind this invocation to the most
        // recently declared -i, if any. Invocations declared before any -i
        // (no-input discovery, e.g. "-plugin sinl -figure list") remain
        // unbound and are only reachable via the flat result.pluginInvocations.
        if (currentInput) currentInput.pluginInvocations.push(invocation);
      }
      // Consume additional space-separated plugin ids that follow (legacy behavior)
      while (i + 1 < args.length && !args[i + 1].startsWith('-') && isPluginId(args[i + 1])) {
        for (const id of args[++i].split(',')) {
          const trimmed = id.trim();
          if (!trimmed) continue;
          const invocation = {
            pluginId: trimmed,
            params: {},
            debugRequests: [],
            figureRequests: [],
          };
          result.pluginInvocations.push(invocation);
          result.pluginIds.push(trimmed);
          currentInvocation = invocation;
          if (currentInput) currentInput.pluginInvocations.push(invocation);
        }
      }
    } else if (arg === '-p' && i + 1 < args.length) {
      const pair = args[++i];
      let [key, ...valParts] = pair.split('=');
      let val = valParts.join('=');
      if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (!isNaN(val) && val !== '') val = Number(val);
      // Attach to current invocation if present, else fall back to top-level params
      if (currentInvocation) {
        currentInvocation.params[key.trim()] = val;
      } else {
        result.params[key.trim()] = val;
      }
    } else if (arg === '-infer-meta-from-filename') {
      result.inferMetaFromFilename = true;
    } else if (arg === '-meta-to-filename') {
      result.metaToFilename = true;
    } else if (arg === '-probe-metadata') {
      result.probeMetadata = true;
    } else if ((arg === '-channel-index' || arg === '-channel') && i + 1 < args.length) {
      const idx = Number(args[++i]);
      if (Number.isInteger(idx) && idx >= 0) result.channelIndex = idx;
    } else if ((arg === '-start-sample' || arg === '-ss') && i + 1 < args.length) {
      const idx = Number(args[++i]);
      if (!currentInput) {
        throw new Error(`[usig] -ss/-start-sample must follow a -i <input> (no input declared yet)`);
      }
      if (Number.isInteger(idx)) currentInput.startSample = idx;
    } else if ((arg === '-end-sample' || arg === '-to') && i + 1 < args.length) {
      const idx = Number(args[++i]);
      if (!currentInput) {
        throw new Error(`[usig] -to/-end-sample must follow a -i <input> (no input declared yet)`);
      }
      if (Number.isInteger(idx)) currentInput.endSample = idx;
    } else if (arg === '-f' && i + 1 < args.length) {
      const fmt = String(args[++i]).toLowerCase();
      if (currentInput) {
        // -f after -i attaches to that most-recently declared input.
        currentInput.inputFormat = fmt;
      } else if (pendingFormat === null) {
        // -f before any -i (e.g. "-f concat -i list.txt") applies to the
        // next input that gets declared.
        pendingFormat = fmt;
      } else {
        throw new Error(`[usig] -f specified more than once before a -i <input>`);
      }
    } else if ((arg === '-of' || arg === '-format' || arg === '-print_format') && i + 1 < args.length) {
      result.format = String(args[++i]).toLowerCase();
    } else if (arg === '-y') {
      result.overwrite = true;
    } else if (arg === '-fig_as_json') {
      result.figAsJson = true;
    } else if (arg === '-v' || arg === '-verbose') {
      result.verbose = true;
    } else if (arg === '-h' || arg === '-help') {
      result.help = true;
    } else if (arg === '-debug' && i + 1 < args.length) {
      const token = args[++i];
      // split into key and optional path on first '='
      const eqIdx = token.indexOf('=');
      const key = eqIdx === -1 ? token : token.slice(0, eqIdx);
      const pathStr = eqIdx === -1 ? undefined : token.slice(eqIdx + 1);
      const req = { key, path: pathStr };
      if (currentInvocation) {
        currentInvocation.debugRequests.push(req);
      } else {
        // No active plugin — attach to a provisional first invocation container
        if (result.pluginInvocations.length === 0) {
          // create a placeholder invocation to be bound later when plugins are resolved
          const placeholder = { pluginId: null, params: {}, debugRequests: [req], figureRequests: [] };
          result.pluginInvocations.push(placeholder);
          currentInvocation = placeholder;
          if (currentInput) currentInput.pluginInvocations.push(placeholder);
        } else {
          // attach to last invocation
          result.pluginInvocations[result.pluginInvocations.length - 1].debugRequests.push(req);
        }
      }
    } else if (arg === '-figure' && i + 1 < args.length) {
      const token = args[++i];
      // split into key and optional path on first '='
      const eqIdx = token.indexOf('=');
      const key = eqIdx === -1 ? token : token.slice(0, eqIdx);
      const pathStr = eqIdx === -1 ? undefined : token.slice(eqIdx + 1);
      const req = { key, path: pathStr };
      if (currentInvocation) {
        currentInvocation.figureRequests.push(req);
      } else {
        // No active plugin — attach to a provisional first invocation container
        if (result.pluginInvocations.length === 0) {
          const placeholder = { pluginId: null, params: {}, debugRequests: [], figureRequests: [req] };
          result.pluginInvocations.push(placeholder);
          currentInvocation = placeholder;
          if (currentInput) currentInput.pluginInvocations.push(placeholder);
        } else {
          result.pluginInvocations[result.pluginInvocations.length - 1].figureRequests.push(req);
        }
      }
    } else if (!arg.startsWith('-') && result.inputFiles.length > 0) {
      if (unassignedOutputInputs.length === 1) {
        // Standard job grammar: "-i <in> <out>" — the positional attaches
        // to the single input still waiting for its own output.
        unassignedOutputInputs[0].output = arg;
        unassignedOutputInputs = [];
      } else if (unassignedOutputInputs.length > 1) {
        // Ambiguous: multiple inputs declared back-to-back with no
        // intervening output (e.g. "-i A -i B out"). Mass-conversion
        // output ownership is strictly one job = one output, so this
        // shape is unsupported. Record it so callers can reject it
        // explicitly instead of silently guessing which input "out"
        // belongs to.
        if (!result.multiInputSharedOutputAttempt) {
          result.multiInputSharedOutputAttempt = {
            inputs: unassignedOutputInputs.map((s) => s.file),
            output: arg,
          };
        }
        unassignedOutputInputs = [];
      }
      // If unassignedOutputInputs.length === 0, no input is waiting for an
      // output (e.g. a stray extra positional); ignore it, matching the
      // previous behavior of ignoring extra positional args once the
      // (single, legacy) output had already been captured.
    } else if (!arg.startsWith('-') && result.inputFiles.length === 0) {
      // A positional argument appeared but no -i has been declared at all
      // (e.g. "-plugin sinl -debug list output.csv"). An output path
      // without any input is never valid — record it so callers can
      // reject it explicitly rather than silently dropping it.
      if (!result.unattachedPositionalOutput) {
        result.unattachedPositionalOutput = arg;
      }
    }
  }

  // backward compat: single-plugin callers use result.pluginId
  result.pluginId = result.pluginIds[0] ?? null;

  // Backwards-compat mirrors: existing single-input call sites read
  // result.startSample / result.endSample / result.inputFormat directly.
  // Mirror the first declared input's values here so single -i invocations
  // behave exactly as before. Multi-input callers should use inputFiles.
  if (result.inputFiles.length > 0) {
    const first = result.inputFiles[0];
    result.inputFile = first.file;
    result.startSample = first.startSample;
    result.endSample = first.endSample;
    result.inputFormat = first.inputFormat;
    // Mirror the first job's output too, so single -i invocations (with a
    // positional output) continue to populate result.outputFile exactly as
    // before.
    if (first.output !== null) result.outputFile = first.output;
  }

  return result;
}

// Strictly parse an FFmpeg-style concat list file into an ordered array of
// resolved absolute file paths. Only the strict "file 'path'" entry form is
// accepted; anything else (blank lines aside) is a parse error that reports
// the list filename and 1-based line number.
async function parseConcatList(listFile) {
  const listPath = path.resolve(listFile);
  let content;
  try {
    content = await fs.readFile(listPath, 'utf8');
  } catch (err) {
    throw new Error(`[usig] concat list read failed: ${listPath}: ${err?.message ?? err}`);
  }
  const lines = content.split(/\r?\n/);
  const resolved = [];
  const baseDir = path.dirname(listPath);
  const lineRegex = /^\s*file\s+'([^']+)'\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const m = raw.match(lineRegex);
    if (!m) {
      throw new Error(`[usig] concat list parse error: ${listPath}:${i + 1}: expected \"file 'path'\"`);
    }
    const entry = m[1];
    if (!entry) {
      throw new Error(`[usig] concat list parse error: ${listPath}:${i + 1}: empty path`);
    }
    const resolvedPath = path.isAbsolute(entry) ? entry : path.resolve(baseDir, entry);
    resolved.push(resolvedPath);
  }
  if (resolved.length === 0) {
    throw new Error(`[usig] concat list parse error: ${listPath}: no input entries`);
  }
  return resolved;
}

// Expand the canonical, ordered list of parsed input specifications
// (result.inputFiles from parseArgs) into a flat, ordered list of concrete
// input specifications. A "-f concat" entry is replaced in-place by every
// entry it resolves to, preserving overall order. Nested concat lists (an
// entry that is itself a concat list) are not supported and are rejected
// rather than silently expanded recursively.
// Resolve the canonical input list to exactly one input specification,
// exiting the process with a clear error if zero or more than one input
// was ultimately declared/expanded. Used by execution paths (probe-metadata,
// conversion mode) whose semantics have not yet been defined for multiple
// inputs.
async function resolveSingleInputOrExit(inputSpecs, contextLabel) {
  let resolved;
  try {
    resolved = await resolveInputSpecs(inputSpecs);
  } catch (err) {
    console.error(err?.message ?? String(err));
    process.exit(1);
  }
  if (resolved.length > 1) {
    console.error(
      `[usig] multiple inputs are ingested, but ${contextLabel} does not yet support multiple inputs`
    );
    process.exit(1);
  }
  return resolved[0] ?? null;
}

async function resolveInputSpecs(inputSpecs) {
  const resolved = [];
  for (const spec of inputSpecs ?? []) {
    if (spec.inputFormat === 'concat') {
      if (Number.isInteger(spec.startSample) || Number.isInteger(spec.endSample)) {
        throw new Error(
          `[usig] -ss/-to are not supported on -f concat inputs yet (list: ${spec.file})`
        );
      }
      const entries = await parseConcatList(spec.file);
      for (const file of entries) {
        // Propagate the concat spec's own output (if any) to every expanded
        // entry. This does not grant concat any combination/output semantics
        // of its own — it only lets callers detect the "one trailing output
        // shared across multiple expanded entries" shape and reject it
        // explicitly, the same way repeated "-i A -i B out" is rejected.
        resolved.push({ file, startSample: null, endSample: null, inputFormat: null, output: spec.output ?? null, pluginInvocations: spec.pluginInvocations ?? [] });
      }
    } else {
      resolved.push({ ...spec });
    }
  }
  return resolved;
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
-h, -help                 Show this help
  -start-sample <n>         Start at sample index <n>
  -end-sample <n>           End at sample index <n>
  -probe-metadata           Inspect input metadata
-debug <spec>             Request plugin debug output. Spec forms:
                          - "list" (discover plugin-declared tables without an input file)
                          - "all" (produce all tables; requires an input and optional directory with trailing '/')
                          - "<tableId>" (produce specific table; requires input)
                          - "<tableId>=<file|dir>" (explicit filename or directory)
                          Note: -debug all=<path> requires a directory path (use trailing '/').

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

async function askConfirmation(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (ans) => { rl.close(); resolve(ans); });
  });
}

async function confirmOutputOverwrite(outputFile, overwrite) {
  if (overwrite) return true;

  if (!fsRaw.existsSync(outputFile)) return true;

  const answer = await askConfirmation(
    `File "${outputFile}" already exists. Overwrite? [y/N] `
  );

  if (answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes') {
    return true;
  }

  console.log('[usig] Output not overwritten.');
  return false;
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
      external: ['react', 'react-dom', 'fft.js', 'recharts', 'fs', 'path', 'exceljs'],
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

    return await import(
        pathToFileURL(tmpPath.replace('.mjs', '.cjs')).href +`?t=${Date.now()}`);

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

async function pluginExists(pluginId) {
  const pluginPath = path.join(scriptDir, `app/components/plugins/${pluginId}Plugin.tsx`);
  try { await fs.access(pluginPath); return true; } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV I/O
// ─────────────────────────────────────────────────────────────────────────────

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

// Generic structured-rows serializer. Supports csv, json, yaml, xlsx.
async function writeStructuredRowsToFile(headers, rows, targetPath, overwrite) {
  const ext = path.extname(targetPath).toLowerCase().replace('.', '');
  const shouldWrite = await confirmOutputOverwrite(targetPath, overwrite);
  if (!shouldWrite) return;


  if (ext === 'csv') {
    await fs.writeFile(targetPath, writeCsv(headers, rows), 'utf8');
    return;
  }

  if (ext === 'json') {
    await fs.writeFile(targetPath, JSON.stringify(rows.length === 1 ? rows[0] : rows, null, 2), 'utf8');
    return;
  }

  if (ext === 'yaml' || ext === 'yml') {
    // Simple YAML serialization: key: value lines per object, separated by '-'
    const lines = [];
    if (rows.length === 1) {
      for (const [k, v] of Object.entries(rows[0])) lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      for (const row of rows) {
        lines.push('-');
        for (const [k, v] of Object.entries(row)) lines.push(`  ${k}: ${JSON.stringify(v)}`);
      }
    }
    await fs.writeFile(targetPath, lines.join('\n') + '\n', 'utf8');
    return;
  }

  if (ext === 'xlsx') {
    const excelJsMod = await import('exceljs');
    const ExcelJS = excelJsMod.default ?? excelJsMod;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('results');
    sheet.addRow(headers);
    for (const row of rows) {
      const values = headers.map(h => row[h] ?? '');
      sheet.addRow(values);
    }
    await workbook.xlsx.writeFile(targetPath);
    return;
  }

  throw new Error(`Unsupported structured output extension: ${ext}`);
}

// Write structured rows into a USIG IR binary container using irMod.serializeFrame
async function writeStructuredRowsToBin(headers, rows, targetPath, irMod) {
  if (!irMod || typeof irMod.serializeFrame !== 'function') {
    throw new Error('IR module with serializeFrame is required to write .bin');
  }

  const arrays = headers.map((header) => ({
    label: header,
    waveform: new Float32Array(
      rows.map((row) => {
        const value = row[header];

        if (
          value === null ||
          value === undefined ||
          value === ''
        ) {
          return NaN;
        }

        return Number(value);
      })
    ),
  }));

  const frame = {
    packet: {
      waveform:
        arrays[0]?.waveform ??
        new Float32Array(0),

      arrays,

      channels: arrays,

      metadata: {
        channelLabels: headers,
        usig_table: {
          headers,
          rows,
        },
      },
    },

    headers,
    singleValueColumns: {},
    cacheKey: null,
    hintsKey: null,
    ingestedAt: Date.now(),
    schemaVersion: irMod.IR_SCHEMA_VERSION ?? '1.0.0',
  };

  const { meta, waveform } =
    irMod.serializeFrame(frame);

  const packed =
    packSerializedIR(meta, waveform);

  await fs.writeFile(targetPath, packed);

  return true;
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
  const results = payload.results ?? [];

  // Machine-readable JSON: serialize only the scalar results (single object or array)
  if (format === 'json') {
    const out = results.length === 1 ? results[0] : results;
    return JSON.stringify(out, null, 2) + '\n';
  }

  // Machine-readable CSV: deterministic ordering, exclude internal _plugin unless multi-plugin
  if (format === 'csv') {
    if (results.length === 0) return '';
    if (results.length === 1) {
      const row = results[0];
      const headers = Object.keys(row).filter(k => k !== '_plugin');
      const outRow = {};
      for (const h of headers) outRow[h] = row[h];
      return writeCsv(headers, [outRow]);
    }

    // multiple results: include a 'plugin' column first
    const headers = ['plugin', ...Object.keys(results[0]).filter(k => k !== '_plugin')];
    const rows = results.map(r => {
      const obj = { plugin: r._plugin ?? '' };
      for (const h of headers.slice(1)) obj[h] = r[h];
      return obj;
    });
    return writeCsv(headers, rows);
  }

  // Machine-readable YAML: simple serialization of results only
  if (format === 'yaml') {
    const lines = [];
    const out = results.length === 1 ? results[0] : results;
    if (Array.isArray(out)) {
      for (const item of out) {
        lines.push('-');
        for (const [k, v] of Object.entries(item)) lines.push(`  ${k}: ${JSON.stringify(v)}`);
      }
    } else {
      for (const [k, v] of Object.entries(out)) lines.push(`${k}: ${JSON.stringify(v)}`);
    }
    return lines.join('\n') + '\n';
  }

  // Default: human-readable report (unchanged semantics)
  const lines = [];
  const summaries = payload.input.summaries ?? {};
  const pluginIds = Object.keys(summaries);
  const multi = results.length > 1;

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
  if (!results || results.length === 0) {
    lines.push('  (no results)');
  } else {
    for (const row of results) {
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


async function runProbeMetadataMode({
  inputFile,
  verbose,
  format,
  channelIndex = null,
}) {
  if (!inputFile) {
    console.error('Usage: node usig.mjs -i <input-file> -probe-metadata [-of json|text|csv|yaml]');
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
      const frame = await ingestMappedBinary({
        inputPath: inputFile,
        filename: inputFileName,
      });

      irMetadata = frame?.packet?.metadata ?? {};
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
}) {
  const packet = frame.packet;
  let channels =
      packet.channels ??
      packet.arrays ??
      null;
  const wf =
      packet.waveform ??
      channels?.[0]?.waveform;

  const metadata = packet.metadata ?? {};

  // If channels/arrays are not present but the serialized metadata contains
  // column/channel labels, synthesize a minimal channels array so CSV/XLSX
  // exporters can emit a header row and at least the primary waveform.
  if (!channels && Array.isArray(metadata.channelLabels) && metadata.channelLabels.length > 0) {
    channels = metadata.channelLabels.map((lab, idx) => ({
      label: lab,
      waveform: idx === 0 ? wf : Array.from({ length: wf.length }, () => '')
    }));
  } else if (!channels && Array.isArray(metadata.columnLabels) && metadata.columnLabels.length > 0) {
    channels = metadata.columnLabels.map((lab, idx) => ({
      label: lab,
      waveform: idx === 0 ? wf : Array.from({ length: wf.length }, () => '')
    }));
  }

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

  const shouldWrite = await confirmOutputOverwrite(outputFile, overwrite);
  if (!shouldWrite) return;

  await exportIRFrame({
    irMod,
    frame: frameForExport,
    outputFile,
    outputFormat,
    metaToFilename,
  });

  console.log(`[usig] wrote result to ${outputFile}`);
}

function resolvePluginId(pluginId) {
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
          packet.metadata?.channelLabels?.[0] ??
          packet.metadata?.signalColumn ??
          packet.channels?.[0]?.label ??
          packet.arrays?.[0]?.label,
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

// Minimal Levenshtein edit distance, used only for "Did you mean ...?"
// suggestions on unknown -p parameter names. No external dependency needed.
function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// Combines plugin.manifest.paramSchema (typed/validated fields) with
// plugin.paramFields (InferredParamField — also valid -p keys, e.g.
// toneMode, tiCorrections, fsGhz) into a single de-duplicated map keyed by
// field.key. This is the existing declarative param schema; no new
// parameter architecture is introduced here.
function collectKnownParamFields(plugin) {
  const fields = [
    ...(plugin?.manifest?.paramSchema ?? []),
    ...(plugin?.paramFields ?? []),
  ];
  const byKey = new Map();
  for (const field of fields) {
    if (!field?.key || byKey.has(field.key)) continue;
    byKey.set(field.key, field);
  }
  return byKey;
}

// Rejects the command (process.exit(1)) before any analysis/output when an
// explicit -p key does not match any known paramSchema/paramFields key or
// alias for the resolved plugin. Prints the full list of valid parameter
// names (with possible values, when declared) and a closest-match
// suggestion when one is plausible.
function validateKnownParams(pluginId, plugin, explicitParams) {
  const known = collectKnownParamFields(plugin);
  const knownNames = new Set(known.keys());
  for (const field of known.values()) {
    if (Array.isArray(field.aliases)) {
      for (const alias of field.aliases) knownNames.add(alias);
    }
  }

  for (const key of Object.keys(explicitParams ?? {})) {
    if (knownNames.has(key)) continue;

    console.error(`[usig] Unknown parameter: ${key}`);
    console.error('');
    console.error(`Valid parameters for plugin "${pluginId}":`);
    for (const field of known.values()) {
      const values =
        Array.isArray(field.possibleValues) && field.possibleValues.length > 0 ? field.possibleValues
        : Array.isArray(field.options) && field.options.length > 0 ? field.options
        : null;
      const valuesStr = values ? ` (values: ${values.join(' | ')})` : '';
      console.error(`  ${field.key}${valuesStr}`);
    }

    let bestMatch = null;
    let bestDistance = Infinity;
    for (const name of knownNames) {
      const distance = levenshteinDistance(key, name);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestMatch = name;
      }
    }
    if (bestMatch && bestDistance > 0 && bestDistance <= 3 && bestDistance < key.length) {
      console.error('');
      console.error(`Did you mean ${bestMatch}?`);
    }

    process.exit(1);
  }
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

  // DEBUG TABLES section. Prefer static manifest documentation if provided.
  console.log('DEBUG TABLES');
  console.log('');
  const debugDocs = plugin?.manifest?.debugTables ?? null;
  if (Array.isArray(debugDocs) && debugDocs.length > 0) {
    for (const dt of debugDocs) {
      console.log(`  ${dt.id}`);
      if (dt.label) console.log(`    ${dt.label}`);
      if (Array.isArray(dt.columns) && dt.columns.length > 0) console.log(`    Columns: ${dt.columns.join(', ')}`);
      console.log('');
    }
  } else {
    console.log('  (runtime discovery only)');
    console.log('  Use: -debug list');
    console.log('  Example: usig -i file -plugin', pluginId, '-debug list');
    console.log('');
  }

  console.log('EXAMPLE');
  console.log('');
  console.log(`  usig -i waveform.csv -plugin ${pluginId}`);
}

function printDebugTableHead(table) {
  const columns = table.columns ?? {};
  const headers = Object.keys(columns);

  if (headers.length === 0) {
    console.error(`DEBUG TABLE HEAD: ${table.id}`);
    if (table.label) console.error(table.label);
    console.error('(empty table)');
    return;
  }

  const MAX_DISPLAY_COLUMNS = 6;

  // Pandas-like column display:
  // - 6 or fewer columns: show everything
  // - more than 6 columns: first 3, ..., last 3
  const displayHeaders =
    headers.length <= MAX_DISPLAY_COLUMNS
      ? headers
      : [
          ...headers.slice(0, 3),
          '...',
          ...headers.slice(-3),
        ];

  const len = columns[headers[0]]?.length ?? 0;

  const HEAD_ROWS = 3;
  const TAIL_ROWS = 3;

  // Select rows in pandas-like head / tail fashion.
  let indices;

  if (len <= HEAD_ROWS + TAIL_ROWS) {
    indices = Array.from({ length: len }, (_, i) => i);
  } else {
    indices = [
      ...Array.from({ length: HEAD_ROWS }, (_, i) => i),
      ...Array.from(
        { length: TAIL_ROWS },
        (_, i) => len - TAIL_ROWS + i
      ),
    ];
  }

  function isNumeric(value) {
    return (
      typeof value === 'number' &&
      Number.isFinite(value)
    );
  }

  // Compact numeric formatting, similar in spirit to pandas display.
  function formatValue(value) {
    if (value === null || value === undefined) return '';

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        if (Number.isNaN(value)) return 'NaN';
        return value > 0 ? 'Inf' : '-Inf';
      }

      if (Object.is(value, -0)) return '0';

      // Avoid exposing JS's full binary floating-point representation.
      // Use fixed precision for ordinary values, switching to scientific
      // notation for very large/small magnitudes.
      const abs = Math.abs(value);

      if (abs !== 0 && (abs >= 1e8 || abs < 1e-6)) {
        return value.toExponential(6).replace(/\.?0+e/, 'e');
      }

      return Number(value.toPrecision(8)).toString();
    }

    return String(value);
  }

  // Build formatted cells only for displayed columns.
  const rows = indices.map(index => {
    const cells = {};

    for (const header of displayHeaders) {
      if (header === '...') {
        cells[header] = '...';
      } else {
        cells[header] = formatValue(
          columns[header]?.[index]
        );
      }
    }

    return {
      index: String(index),
      cells,
    };
  });

  // Determine alignment from the actual column data.
  const numericColumns = {};

  for (const header of displayHeaders) {
    if (header === '...') {
      numericColumns[header] = false;
      continue;
    }

    numericColumns[header] = true;

    for (const index of indices) {
      const value = columns[header]?.[index];

      if (
        value !== null &&
        value !== undefined &&
        !isNumeric(value)
      ) {
        numericColumns[header] = false;
        break;
      }
    }
  }

  // Calculate display widths.
  const widths = {};

  widths.index = Math.max(
    String(len > 0 ? len - 1 : 0).length,
    1
  );

  for (const header of displayHeaders) {
    widths[header] = header.length;

    for (const row of rows) {
      widths[header] = Math.max(
        widths[header],
        row.cells[header].length
      );
    }
  }

  function formatRow(row) {
    const indexText = row.index.padStart(widths.index);

    const values = displayHeaders.map(header => {
      const value = row.cells[header];

      if (numericColumns[header]) {
        return value.padStart(widths[header]);
      }

      return value.padEnd(widths[header]);
    });

    return `${indexText}  ${values.join('  ')}`;
  }

  console.error('');
  console.error(`DEBUG TABLE HEAD: ${table.id}`);

  if (table.label) {
    console.error(table.label);
  }

  console.error(`rows: ${len}`);
  console.error(`columns: ${headers.join(', ')}`);
  console.error('');

  // Header.
  const headerIndex = ''.padStart(widths.index);

  const headerCells = displayHeaders.map(header =>
    numericColumns[header]
      ? header.padStart(widths[header])
      : header.padEnd(widths[header])
  );

  console.error(
    `${headerIndex}  ${headerCells.join('  ')}`
  );

  // Separator.
  console.error(
    `${'-'.repeat(widths.index)}  ` +
    displayHeaders
      .map(header => '-'.repeat(widths[header]))
      .join('  ')
  );

  // Rows.
  for (let i = 0; i < rows.length; i++) {
    if (
      len > HEAD_ROWS + TAIL_ROWS &&
      i === HEAD_ROWS
    ) {
      console.error(
        `${''.padStart(widths.index)}  ` +
        displayHeaders
          .map(header =>
            '...'.padStart(widths[header])
          )
          .join('  ')
      );
    }

    console.error(formatRow(rows[i]));
  }

  console.error('');
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
    inputFile: parsedInputFile,
    inputFiles: parsedInputFiles,
    pluginIds,
    pluginInvocations,
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
    figAsJson,
    multiInputSharedOutputAttempt,
    unattachedPositionalOutput,
  } = parseArgs(args);

  let inputFile = parsedInputFile;

  if (verbose && (Number.isInteger(startSample) || Number.isInteger(endSample))) {
    console.error(`[usig] parsed sample window: startSample=${startSample} endSample=${endSample}`);
  }

  if (help) {
  if (pluginIds.length > 0) {
    const resolvedPluginId =
      resolvePluginId(pluginIds[0]);

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
    const resolvedSpec = await resolveSingleInputOrExit(parsedInputFiles, 'probe-metadata mode');
    if (resolvedSpec) inputFile = resolvedSpec.file;
    await runProbeMetadataMode({
      inputFile,
      verbose,
      format,
    });
    return;
  }

  // A positional output path with zero inputs declared is never valid,
  // regardless of conversion/plugin mode (e.g. "-plugin sinl -debug list
  // output.csv" or "-plugin sinl -figure list output.csv"). Reject
  // explicitly rather than silently dropping the stray positional arg.
  if (unattachedPositionalOutput && parsedInputFiles.length === 0) {
    console.error(
      `[usig] output path specified but no input file was provided: ${unattachedPositionalOutput}`
    );
    process.exit(1);
  }

  // Independent conversion job(s). Only applies when no plugin/analyzer was
  // requested. Each resolved input owns exactly one output (its own
  // positional argument); this is deliberately NOT concatenation, NOT
  // multi-input->single-output, and NOT a combined/merged conversion — every
  // job independently ingests, converts, and writes, in command-line order.
  if (!pluginIds || pluginIds.length === 0) {
    if (multiInputSharedOutputAttempt) {
      console.error(
        `[usig] multiple inputs (${multiInputSharedOutputAttempt.inputs.join(', ')}) cannot share a single output ` +
        `(${multiInputSharedOutputAttempt.output}); mass conversion requires one output per input, ` +
        `e.g. "-i A.csv A.xlsx -i B.csv B.xlsx"`
      );
      process.exit(1);
    }

    let resolvedForConversion;
    try {
      resolvedForConversion = await resolveInputSpecs(parsedInputFiles);
    } catch (err) {
      console.error(err?.message ?? String(err));
      process.exit(1);
    }

    // A single "-i <concat-list> <out>" can expand into multiple entries
    // that all inherited the same trailing output (concat has no combination
    // semantics of its own). Detect that shape here and reject it explicitly,
    // rather than letting several independent jobs silently overwrite one
    // another's output.
    const outputUseCounts = new Map();
    for (const spec of resolvedForConversion) {
      if (spec.output) outputUseCounts.set(spec.output, (outputUseCounts.get(spec.output) ?? 0) + 1);
    }
    const sharedOutputs = [...outputUseCounts.entries()].filter(([, count]) => count > 1);
    if (resolvedForConversion.length > 1 && sharedOutputs.length > 0) {
      console.error(
        `[usig] conversion mode does not yet support multiple inputs mapping to a single shared output ` +
        `(${sharedOutputs.map(([output]) => output).join(', ')})`
      );
      process.exit(1);
    }

    const conversionJobs = resolvedForConversion.map((spec) => ({
      spec,
      outputFormat: inferConversionModeFromOutput(spec.output).format,
    }));
    const jobsWithFormat = conversionJobs.filter((j) => j.outputFormat);

    if (jobsWithFormat.length > 0) {
      if (jobsWithFormat.length !== conversionJobs.length) {
        const missing = conversionJobs
          .map((j, idx) => ({ idx, spec: j.spec }))
          .filter((j) => !inferConversionModeFromOutput(j.spec.output).format)
          .map((j) => `job ${j.idx} (input=${j.spec.file}, output=${j.spec.output ?? '(none)'})`);
        console.error(
          `[usig] mass conversion requires every input to have its own recognized output (.bin/.csv/.xlsx); ` +
          `missing/unrecognized output for: ${missing.join(', ')}`
        );
        process.exit(1);
      }

      if (conversionJobs.length === 1) {
        // Single job: identical to the pre-existing single-input behavior.
        const spec = conversionJobs[0].spec;
        await runConversionMode({
          inputFile: spec.file,
          outputFile: spec.output,
          outputFormat: conversionJobs[0].outputFormat,
          params,
          inferMetaFromFilename,
          metaToFilename,
          verbose,
          startSample: spec.startSample,
          endSample: spec.endSample,
          overwrite,
        });
        return;
      }

      // Independent mass conversion: run each job in order. Jobs never
      // share frames, data, or output files with one another.
      for (let jobIndex = 0; jobIndex < conversionJobs.length; jobIndex++) {
        const { spec, outputFormat } = conversionJobs[jobIndex];
        if (verbose) {
          console.error(
            `[usig] job ${jobIndex}: input=${spec.file} output=${spec.output} ` +
            `startSample=${spec.startSample} endSample=${spec.endSample} outputFormat=${outputFormat}`
          );
        }
        try {
          await runConversionMode({
            inputFile: spec.file,
            outputFile: spec.output,
            outputFormat,
            params,
            inferMetaFromFilename,
            metaToFilename,
            verbose,
            startSample: spec.startSample,
            endSample: spec.endSample,
            overwrite,
          });
        } catch (err) {
          console.error(
            `[usig] job ${jobIndex} failed: input=${spec.file} output=${spec.output ?? '(none)'}`
          );
          console.error(err?.message ?? String(err));
          process.exitCode = 1;
          return;
        }
      }
      return;
    }
  }

  // No-input declarative discovery ("-debug list" / "-figure list") is valid
  // ONLY when there is no input at all AND every requested debug/figure
  // operation across all invocations is 'list'. If an input IS supplied,
  // normal ingestion/analysis must still run (list does not suppress it) —
  // list printing then happens later, from real prepareData() output.
  const allRawListRequests = (pluginInvocations || []).flatMap(inv => [
    ...(inv.debugRequests || []),
    ...(inv.figureRequests || []),
  ]);
  const isPureListDiscovery = allRawListRequests.length > 0 && allRawListRequests.every(r => r.key === 'list');

  if ((!inputFile && !isPureListDiscovery) || pluginIds.length === 0) {
    console.error('Usage: node usig.mjs -i <input-file> -plugin <id[,id2]> [-p key=value ...] [-of text|json|yaml]');
    process.exit(1);
  }

  // Resolve the canonical, ordered set of inputs (expanding any -f concat
  // lists). Plugin execution below ingests every input into its own frame,
  // but currently only supports running plugins against a single frame; see
  // the explicit multi-input rejection later in this function.
  let resolvedInputs;
  try {
    resolvedInputs = await resolveInputSpecs(parsedInputFiles);
  } catch (err) {
    console.error(err?.message ?? String(err));
    process.exit(1);
  }
  inputFile = resolvedInputs[0]?.file ?? inputFile;

  if (verbose) {
    resolvedInputs.forEach((spec, idx) => {
      console.error(
        `[usig] resolved input[${idx}]: file=${spec.file} startSample=${spec.startSample} endSample=${spec.endSample} inputFormat=${spec.inputFormat}`
      );
    });
  }

  if (!SUPPORTED_FORMATS.has(format)) {
    console.error(`[usig] unsupported format: ${format}. Supported: text, json, csv, yaml`);
    process.exit(1);
  }

  // ── Resolve and validate all requested plugin ids ──────────────────────────
  const resolvedPluginIds = pluginIds.map(id => resolvePluginId(id));
  for (const id of resolvedPluginIds) {
    if (!(await pluginExists(id))) {
      console.error(`[usig] plugin not found: ${id}`);
      process.exit(1);
    }
  }

  // Prepare invocations array for per-invocation handling
  const invocations = (pluginInvocations && pluginInvocations.length > 0)
    ? pluginInvocations.map(p => ({ ...p }))
    : pluginIds.map(id => ({ pluginId: id, params: {}, debugRequests: [], figureRequests: [] }));

  // If any invocation is a placeholder (pluginId === null), bind it to the first resolved plugin id
  if (invocations.length > 0 && (!invocations[0].pluginId || invocations[0].pluginId === null)) {
    if (resolvedPluginIds.length > 0) {
      invocations[0].pluginId = resolvedPluginIds[0];
    }
  }

  // Declarative no-input discovery: only when there is no input at all.
  // (If an input IS supplied, 'list' does not suppress normal analysis —
  // handled later, in the per-invocation debug/figure dispatch below.)
  if (!inputFile && isPureListDiscovery) {
    for (const invocation of invocations) {
      const wantsDebugList = (invocation.debugRequests || []).some(r => r.key === 'list');
      const wantsFigureList = (invocation.figureRequests || []).some(r => r.key === 'list');
      if (!wantsDebugList && !wantsFigureList) continue;
      const requestedPluginId = invocation.pluginId ?? pluginIds[0];
      const resolvedPluginId = resolvePluginId(requestedPluginId);
      const pluginPath = path.join(scriptDir, `app/components/plugins/${resolvedPluginId}Plugin.tsx`);
      if (!(await pluginExists(resolvedPluginId))) {
        console.error(`[usig] plugin not found: ${resolvedPluginId}`);
        process.exit(1);
      }
      const mod = await loadPluginModule(pluginPath);
      const pluginExport = mod[`${resolvedPluginId}Plugin`];
      if (!pluginExport) {
        console.error(`[usig] plugin export not found for: ${resolvedPluginId}`);
        process.exit(1);
      }
      const manifest = pluginExport.manifest ?? {};

      if (wantsDebugList) {
        console.error(`DEBUG TABLES: ${resolvedPluginId}`);
        const declared = manifest.debugTables ?? null;
        if (!declared || declared.length === 0) {
          console.error('  (none declared)');
        } else {
          for (const dt of declared) {
            console.error('');
            console.error(`  ${dt.id}`);
            if (dt.label) console.error(`    ${dt.label}`);
            if (Array.isArray(dt.columns) && dt.columns.length > 0) console.error(`    Columns: ${dt.columns.join(', ')}`);
          }
        }
      }

      if (wantsFigureList) {
        console.error(`FIGURES: ${resolvedPluginId}`);
        const declaredFigures = manifest.figures ?? null;
        if (!declaredFigures || declaredFigures.length === 0) {
          console.error('  (none declared)');
        } else {
          for (const fig of declaredFigures) {
            console.error('');
            console.error(`  ${fig.id}`);
            if (fig.label) console.error(`    ${fig.label}`);
            if (fig.description) console.error(`    ${fig.description}`);
          }
        }
      }
    }
    return; // done; declarative discovery does not ingest
  }

  // ── Load IR engine once ──────────────────────────────────────────────────────
  const irMod = await loadIrEngineModule();
  const IREngine = irMod?.IREngine;
  if (!IREngine) throw new Error('IREngine export not found in app/lib/ir/index.ts bundle');
  const irEngine = new IREngine();

  if (resolvedInputs.length === 0) {
    console.error('[usig] no input to ingest');
    process.exit(1);
  }

  if (verbose) {
    console.log('[usig] reading input(s):', resolvedInputs.map(spec => spec.file).join(', '));
  }

  const firstPluginPath = path.join(
    scriptDir,
    `app/components/plugins/${resolvedPluginIds[0]}Plugin.tsx`
  );

  const firstMod =
    await loadPluginModule(firstPluginPath);

  const firstPlugin =
    firstMod[`${resolvedPluginIds[0]}Plugin`];

  // ── Canonical multi-input ingestion ─────────────────────────────────────────
  // Every resolved input (whether from a repeated -i or an expanded -f concat
  // list) is independently ingested into its own IR frame, in order. CSV/XLSX
  // must use the same mapper as conversion mode, guaranteeing that plugin
  // execution and conversion receive the same canonical IR packet shape.
  const inputFrames = [];

  for (const spec of resolvedInputs) {
    const inputFileNameForSpec = path.basename(spec.file);
    const rawForSpec = await fs.readFile(spec.file);

    const fileForSpec = new File(
      [rawForSpec],
      inputFileNameForSpec,
      {
        type: 'application/octet-stream'
      }
    );

    const filenameParamHintsForSpec =
      buildFilenameParamHints(
        firstPlugin,
        inputFileNameForSpec
      );

    const ingestionParamsForSpec = {
      ...(firstPlugin?.defaultParams ?? {}),
      ...filenameParamHintsForSpec,
      ...(params ?? {}),
    };

    let hintsForSpec =
      firstPlugin &&
      typeof firstPlugin.getIngestHints === 'function'
        ? firstPlugin.getIngestHints(ingestionParamsForSpec)
        : undefined;

    if (Number.isInteger(spec.startSample) || Number.isInteger(spec.endSample)) {
      hintsForSpec = {
        ...hintsForSpec,
        ...(Number.isInteger(spec.startSample)
          ? { startSample: spec.startSample }
          : {}),
        ...(Number.isInteger(spec.endSample)
          ? { endSample: spec.endSample }
          : {}),
      };
    }

    const extForSpec = path.extname(spec.file).toLowerCase();

    let frameForSpec;

    if (extForSpec === '.csv' || extForSpec === '.xlsx') {
      const ingested = await irEngine.getOrIngest(
        fileForSpec,
        hintsForSpec
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

      const channelDefinitions =
        existingChannels.length > 0
          ? existingChannels
          : [{
              label:
                packet.metadata?.channelLabels?.[0] ??
                packet.metadata?.signalColumn ??
                canonicalFrame?.headers?.[0],
              units: packet.metadata?.units,
              waveform,
            }];

      if (!channelDefinitions[0]?.label) {
        throw new Error(
          'CSV/XLSX ingestion produced a waveform without a canonical channel label.'
        );
      }

      frameForSpec = {
        ...canonicalFrame,
        packet: {
          ...packet,
          waveform,
          arrays: channelDefinitions,
          metadata: {
            ...(packet.metadata ?? {}),
            channelLabels:
              packet.metadata?.channelLabels ??
              channelDefinitions.map(ch => ch.label),
          },
        },
      };

    } else {

      const ingested = await irEngine.getOrIngest(
        fileForSpec,
        hintsForSpec
      );

      frameForSpec = ingested.frame ?? (ingested.packet ? {...ingested, packet: ingested.packet,} : ingested);

      console.log('[DEBUG getOrIngest RETURN]', {
        type: typeof ingested,
        keys: Object.keys(ingested ?? {}),
        hasFrame: !!ingested?.frame,
        frameKeys: Object.keys(ingested?.frame ?? {}),
      });

    }

    inputFrames.push({
      frame: frameForSpec,
      inputFileName: inputFileNameForSpec,
      filenameParamHints: filenameParamHintsForSpec,
    });
  }

  // Job-scoped plugin execution (Option B): a single input keeps the exact
  // legacy behavior (one frame, the flat `invocations` list built above).
  // Multiple inputs each run independently, using their own job-scoped
  // plugin invocations (captured per `-i` during parsing) when present, so
  // running several jobs never silently collapses onto the first input.
  const jobs = inputFrames.map((inputFrame, jobIndex) => {
    const jobSpec = resolvedInputs[jobIndex];
    const jobInvocations =
      inputFrames.length > 1 &&
      jobSpec &&
      Array.isArray(jobSpec.pluginInvocations) &&
      jobSpec.pluginInvocations.length > 0
        ? jobSpec.pluginInvocations.map(p => ({ ...p }))
        : invocations;

    // Bind an unbound placeholder invocation (pluginId === null) to this
    // job's own first plugin id, mirroring the flat-invocations binding
    // above, so per-job -debug/-figure requests issued before any -plugin
    // still resolve sensibly.
    if (jobInvocations.length > 0 && !jobInvocations[0].pluginId) {
      const fallbackPluginId =
        jobInvocations.find(inv => inv.pluginId)?.pluginId ?? resolvedPluginIds[0];
      jobInvocations[0].pluginId = fallbackPluginId;
    }

    return { inputFrame, jobInvocations };
  });

  // ── Run each plugin on each job's frame ─────────────────────────────────────
  const allResults = [];
  const allInputSummaries = {};  // keyed by plugin id
  const allParamSchemas = {};  // keyed by plugin id
  const debugTablesToPrint = [];
  // File/figure write confirmations ("WROTE: ...") are collected here and
  // flushed at the very end (after the Inputs/Outputs report and debug
  // table previews), so console verbosity reads top-to-bottom: what was
  // analyzed, then what was produced from it.
  const wroteMessages = [];

  for (const job of jobs) {
  const { frame, inputFileName, filenameParamHints } = job.inputFrame;

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

  for (const invocation of job.jobInvocations) {
    const requestedPluginId = invocation.pluginId;
    const resolvedPluginId = resolvePluginId(requestedPluginId);
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

    // Merge explicit params: global CLI params then per-invocation params override
    const mergedExplicitParams = { ...(params ?? {}), ...(invocation.params ?? {}) };

    // Reject unknown -p parameter names before any analysis/output.
    validateKnownParams(resolvedPluginId, plugin, mergedExplicitParams);

    let finalParams = {
      ...plugin.defaultParams,
      ...filenameParamHints,
      ...mergedExplicitParams,
    };

    const derivedHints = buildDerivedParamHints(frame, mergedExplicitParams);
    const strictFilenameInference = inferStrictMetadataFromFilename(inputFileName);

    if (verbose) console.error('[DEBUG filename inference]', {
      inputFileName,
      plugin: resolvedPluginId,
      strictFilenameInference,
      pluginDefaultParams: plugin.defaultParams,
      explicitParams: mergedExplicitParams,
    });

    const inputSummary = buildInputSummary(
      plugin,
      finalParams,
      mergedExplicitParams,
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

    // If debug or figure output was requested for this invocation, handle
    // prepareData() once and dispatch each independently from the result.
    const debugRequests = invocation.debugRequests ?? [];
    const figureRequests = invocation.figureRequests ?? [];
    if (debugRequests.length === 0 && figureRequests.length === 0) continue;

    if (typeof plugin.prepareData !== 'function') {
      if (debugRequests.length > 0) {
        console.error(`[DEBUG] requested debug output for plugin ${resolvedPluginId}, but plugin has no prepareData()`);
      }
      if (figureRequests.length > 0) {
        console.error(`[FIGURE] requested figure output for plugin ${resolvedPluginId}, but plugin has no prepareData()`);
      }
      process.exitCode = 2;
      continue;
    }

    let prep;
    try {
      console.log = (...parts) => console.error(...parts);
      prep = await plugin.prepareData(frame.packet, finalParams);
    } catch (err) {
      console.error(`[DEBUG] plugin.prepareData failed for ${resolvedPluginId}:`, err?.stack ?? err);
      process.exitCode = 2;
      console.log = originalConsoleLog;
      continue;
    } finally {
      console.log = originalConsoleLog;
    }

    const debugTables = (prep && Array.isArray(prep.debugTables))
      ? prep.debugTables
      : [];
    const figureData = (prep && Object.prototype.hasOwnProperty.call(prep, 'figureData'))
      ? prep.figureData
      : undefined;

    // ── Debug table dispatch (unchanged behavior) ─────────────────────────
    if (debugRequests.length > 0) {
    // Handle discovery request '-debug list'
    if (debugRequests.some(r => r.key === 'list')) {

      console.error(`DEBUG TABLES: ${resolvedPluginId}`);
      if (debugTables.length === 0) {
        console.error('(no debug tables produced)');
      } else {
        for (const t of debugTables) {
          const cols = Object.keys(t.columns || {});
          console.error('');
          console.error(t.id);
          if (t.label) console.error(t.label);
          if (cols.length > 0) console.error(`columns: ${cols.join(', ')}`);
        }
      }
      // continue to handle other write requests if present
    }

    if (debugTables.length === 0) {
      // If user explicitly requested a specific table, this is an error; for 'all' we report.
      for (const req of debugRequests) {
        if (req.key !== 'all' && req.key !== 'list') {
          console.error(`[DEBUG] requested table '${req.key}' not produced by plugin ${resolvedPluginId}`);
          process.exitCode = 3;
        }
      }
      if (debugRequests.some(r => r.key === 'all')) {
        console.error(`[DEBUG] plugin ${resolvedPluginId} produced no debug tables`);
      }
    } else {

    // Helper: find table by id
    const tableById = new Map(debugTables.map(t => [t.id, t]));

    for (const req of debugRequests) {
      if (req.key === 'list') continue; // already handled

      if (req.key === 'all') {
        // Write all tables for this plugin
        // Validate path semantics: if path supplied, it MUST be a directory (trailing '/' or existing dir)
        if (req.path) {
          const p = req.path;
          const looksLikeDir = p.endsWith(path.sep) || p.endsWith('/');
          let existsDir = false;
          try {
            existsDir = fsRaw.existsSync(p) && fsRaw.lstatSync(p).isDirectory();
          } catch (e) { existsDir = false; }
          if (!looksLikeDir && !existsDir) {
            console.error(`ERROR: -debug all requires a directory path (use trailing '/'): ${p}`);
            process.exitCode = 3;
            continue;
          }
        }

        // Determine target directory
        let outDir = req.path ?? null;

        // -debug all without a path means print all tables only.
        // Defer printing until after the normal Inputs/Outputs report.
        if (!outDir) {
          for (const table of debugTables) {
            debugTablesToPrint.push(table);
          }
          continue;
        }

        await fs.mkdir(outDir, { recursive: true });


        for (const table of debugTables) {
          // Path supplied does not suppress the console preview — same
          // "always previewed" contract as the single-table request below.
          debugTablesToPrint.push(table);
          const filename = `${table.id}.csv`;
          const target = path.join(outDir, filename);
          try {
            // Serialize table -> CSV
            const headers = Object.keys(table.columns);
            if (headers.length === 0) continue;
            const len = table.columns[headers[0]].length;
            for (const h of headers) {
              if (table.columns[h].length !== len) throw new Error(`Column lengths differ in table ${table.id}`);
            }
            const rows = [];
            for (let i = 0; i < len; i++) {
              const row = {};
              for (const h of headers) {
                const v = table.columns[h][i];
                row[h] = v === null || v === undefined ? '' : v;
              }
              rows.push(row);
            }
            await writeStructuredRowsToFile(headers, rows, target, true);
            wroteMessages.push(`WROTE: ${target}`);
          } catch (err) {
            console.error(`ERROR: writing ${target}:`, err?.stack ?? err);
            process.exitCode = 4;
          }
        }

      } else {
        // Specific table requested
        const table = tableById.get(req.key);

        if (!table) {
          console.error(
            `[DEBUG] requested table '${req.key}' not produced by plugin ${resolvedPluginId}`
          );
          process.exitCode = 3;
          continue;
        }

        // Always defer printing the debug table head until after
        // the normal Inputs/Outputs report.
        //
        // A path does NOT suppress printing. It only additionally
        // requests that the table be written to a file.
        debugTablesToPrint.push(table);

        if (!req.path) {
          continue;
        }

        // A path was explicitly supplied, so also write the table.
        let target = req.path;


        // If target ends with '/', treat it as a directory.
        if (target.endsWith(path.sep) || target.endsWith('/')) {
          await fs.mkdir(target, { recursive: true });
          target = path.join(target, `${table.id}.csv`);
        } else {
          // If target is an existing directory, write into it.
          try {
            if (
              fsRaw.existsSync(target) &&
              fsRaw.lstatSync(target).isDirectory()
            ) {
              target = path.join(target, `${table.id}.csv`);
            }
          } catch (e) {
            // ignore
          }
        }

        try {
          const headers = Object.keys(table.columns);
          const len =
            headers.length === 0
              ? 0
              : table.columns[headers[0]].length;

          for (const h of headers) {
            if (table.columns[h].length !== len) {
              throw new Error(
                `Column lengths differ in table ${table.id}`
              );
            }
          }

          const rows = [];

          for (let i = 0; i < len; i++) {
            const row = {};

            for (const h of headers) {
              const v = table.columns[h][i];
              row[h] =
                v === null || v === undefined
                  ? ''
                  : v;
            }

            rows.push(row);
          }

          await fs.mkdir(path.dirname(target), { recursive: true });

          const ext =
            path.extname(target)
              .toLowerCase()
              .replace('.', '');

          // Confirm overwrite before doing any actual write.
          const shouldWrite = await confirmOutputOverwrite(
            target,
            overwrite
          );

          if (!shouldWrite) {
            continue;
          }

          if (ext === 'bin') {
            const written =
              await writeStructuredRowsToBin(
                headers,
                rows,
                target,
                irMod,
                true
              );

            if (!written) continue;
          } else {
            await writeStructuredRowsToFile(
              headers,
              rows,
              target,
              true
            );
          }
          wroteMessages.push(`WROTE: ${target}`);

        } catch (err) {
          console.error(
            `ERROR: writing ${target}:`,
            err?.stack ?? err
          );
          process.exitCode = 4;
        }
      }
    }
    } // end else (debugTables.length > 0)
    } // end if (debugRequests.length > 0)

    // ── Figure dispatch ────────────────────────────────────────────────────
    // Reuses the same `prep`/figureData computed above — prepareData() is
    // never called twice, regardless of whether debug was also requested.
    if (figureRequests.length > 0) {
      const runtimeFigures = Array.isArray(plugin.figures) ? plugin.figures : [];
      const manifestFigures = plugin.manifest?.figures ?? [];
      const figureById = new Map(runtimeFigures.map((f) => [f.id, f]));
      const SUPPORTED_FIGURE_EXTS = new Set(['svg', 'png', 'jpg', 'jpeg']);

      if (figureRequests.some((r) => r.key === 'list')) {
        console.error(`FIGURES: ${resolvedPluginId}`);
        if (manifestFigures.length === 0) {
          console.error('  (none declared)');
        } else {
          for (const fig of manifestFigures) {
            console.error('');
            console.error(`  ${fig.id}`);
            if (fig.label) console.error(`    ${fig.label}`);
            if (fig.description) console.error(`    ${fig.description}`);
          }
        }
      }

      if (manifestFigures.length === 0 && figureRequests.some((r) => r.key !== 'list')) {
        console.error(`[FIGURE] plugin ${resolvedPluginId} declares no figures`);
        process.exitCode = 3;
      }

      // Renders + rasterizes (if needed) + writes one figure and its sibling
      // portable-JSON description. `targetPath`'s extension determines the
      // artifact format; defaults to .svg when no extension is present.
      const writeFigureArtifact = async (fig, targetPath) => {
        const desc = fig.getData(figureData, {});
        if (desc === undefined) {
          console.error(`[FIGURE] figure '${fig.id}' produced no data for this input (not applicable) — skipping`);
          process.exitCode = 3;
          return;
        }
        const svg = renderFigureToSvg(desc);
        const ext = (path.extname(targetPath).toLowerCase().replace('.', '')) || 'svg';

        const shouldWrite = await confirmOutputOverwrite(targetPath, overwrite);
        if (!shouldWrite) return;

        await fs.mkdir(path.dirname(targetPath) || '.', { recursive: true });

        if (ext === 'svg') {
          await fs.writeFile(targetPath, svg, 'utf8');
        } else if (ext === 'png') {
          await fs.writeFile(targetPath, await sharp(Buffer.from(svg)).png().toBuffer());
        } else if (ext === 'jpg' || ext === 'jpeg') {
          await fs.writeFile(targetPath, await sharp(Buffer.from(svg)).jpeg().toBuffer());
        } else {
          throw new Error(`unsupported figure output extension: .${ext}`);
        }
        wroteMessages.push(`WROTE: ${targetPath}`);

        if (figAsJson) {
          const jsonPath = targetPath.slice(0, targetPath.length - (ext.length + 1)) + '.json';
          const jsonShouldWrite = await confirmOutputOverwrite(jsonPath, overwrite);
          if (jsonShouldWrite) {
            await fs.writeFile(jsonPath, JSON.stringify(desc, null, 2), 'utf8');
            wroteMessages.push(`WROTE: ${jsonPath}`);
          }
        }
      };

      for (const req of figureRequests) {
        if (req.key === 'list') continue; // already handled

        if (figureData === undefined) {
          console.error(`[FIGURE] requested figure output for plugin ${resolvedPluginId}, but prepareData() produced no figureData`);
          process.exitCode = 3;
          continue;
        }

        if (req.key === 'all') {
          const outDir = req.path ?? '.';
          let existsAsFile = false;
          try {
            existsAsFile = fsRaw.existsSync(outDir) && fsRaw.lstatSync(outDir).isFile();
          } catch (e) { existsAsFile = false; }
          if (existsAsFile) {
            console.error(`ERROR: -figure all requires a directory path, but a file exists at: ${outDir}`);
            process.exitCode = 3;
            continue;
          }
          if (manifestFigures.length === 0) continue; // already reported above

          try {
            await fs.mkdir(outDir, { recursive: true });
          } catch (err) {
            console.error(`ERROR: creating directory ${outDir}:`, err?.stack ?? err);
            process.exitCode = 4;
            continue;
          }

          for (const figDecl of manifestFigures) {
            const fig = figureById.get(figDecl.id);
            if (!fig || typeof fig.getData !== 'function') {
              console.error(`[FIGURE] figure '${figDecl.id}' has no getData() implementation`);
              process.exitCode = 3;
              continue;
            }
            const target = path.join(outDir, `${figDecl.id}.svg`);
            try {
              await writeFigureArtifact(fig, target);
            } catch (err) {
              console.error(`ERROR: writing figure ${figDecl.id}:`, err?.stack ?? err);
              process.exitCode = 4;
            }
          }
          continue;
        }

        // Specific figure requested
        const figDecl = manifestFigures.find((f) => f.id === req.key);
        const fig = figureById.get(req.key);
        if (!figDecl || !fig || typeof fig.getData !== 'function') {
          console.error(
            `[FIGURE] requested figure '${req.key}' not produced by plugin ${resolvedPluginId}` +
            (manifestFigures.length > 0 ? ` (available: ${manifestFigures.map((f) => f.id).join(', ')})` : '')
          );
          process.exitCode = 3;
          continue;
        }

        let targetPath = req.path;
        if (!targetPath) {
          targetPath = `${req.key}.svg`;
        } else {
          const ext = path.extname(targetPath).toLowerCase().replace('.', '');
          if (!ext) {
            targetPath = `${targetPath}.svg`;
          } else if (!SUPPORTED_FIGURE_EXTS.has(ext)) {
            console.error(`ERROR: unsupported figure output extension: .${ext}. Supported: .svg, .png, .jpg, .jpeg`);
            process.exitCode = 3;
            continue;
          }
        }

        try {
          await writeFigureArtifact(fig, targetPath);
        } catch (err) {
          console.error(`ERROR: writing figure ${req.key}:`, err?.stack ?? err);
          process.exitCode = 4;
        }
      }
    }
  }
  } // end of per-job invocation loop (jobs loop)

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
  // Always emit the human-readable report to stdout
  const humanReport = formatReport(payload, 'text', verbose);
  process.stdout.write(humanReport);

  // Debug tables are printed only after the normal Inputs/Outputs report.
  for (const table of debugTablesToPrint) {
    printDebugTableHead(table);
  }

  // File/figure write confirmations are deferred to the very end of console
  // verbosity — after the analysis report and any debug table previews —
  // so output reads as: what was analyzed, then what was produced from it.
  for (const msg of wroteMessages) {
    console.error(msg);
  }

  // If an output file was requested, write a machine-readable serialization

  if (outputFile) {
    if (verbose) console.log('[usig] writing output:', outputFile);

    // Determine machine format: prefer explicit -of (format), else infer from extension
    let machineFormat = format;
    const outExt = outputFile ? path.extname(outputFile).toLowerCase().replace('.', '') : '';

    // Supported plugin output formats
    const SUPPORTED_PLUGIN_FORMATS = new Set(['json', 'csv', 'yaml', 'yml', 'xlsx', 'bin', 'text']);

    // If user specified an output extension that is not supported for plugin results, reject.
    if (outExt && !SUPPORTED_PLUGIN_FORMATS.has(outExt)) {
      console.error(`[usig] unsupported output extension for plugin results: .${outExt}. Supported extensions: .csv, .json, .yaml, .yml, .xlsx, .bin`);
      process.exit(1);
    }

    if ((!machineFormat || machineFormat === 'text') && outExt) {
      machineFormat = outExt;
    }

    if (!SUPPORTED_PLUGIN_FORMATS.has(machineFormat)) {
      console.error(`[usig] unsupported output format for plugin results: ${machineFormat}. Supported: text, json, csv, yaml, xlsx, bin`);
      process.exit(1);
    }

    try {
      const shouldWrite = await confirmOutputOverwrite(outputFile, overwrite);
      if (!shouldWrite) return;

      if (machineFormat === 'csv' || machineFormat === 'json' || machineFormat === 'yaml' || machineFormat === 'yml') {
        const machineReport = formatReport(payload, machineFormat === 'yml' ? 'yaml' : machineFormat, verbose);
        await fs.writeFile(outputFile, machineReport, 'utf8');
        console.error(`[usig] wrote result to ${outputFile}`);
      } else if (machineFormat === 'bin') {
        // Serialize plugin results into a USIG IR binary container
        const results = payload.results ?? [];
        const arrays = headers.map((header) => ({
          label: header,
          waveform: new Float32Array(
            rows.map((row) => {
              const value = row[header];
              return value === null || value === undefined || value === ''
                ? NaN
                : Number(value);
            })
          ),
        }));

        const frame = {
          packet: {
            waveform: arrays[0]?.waveform ?? new Float32Array(0),
            arrays,
            metadata: {
              channelLabels: headers,
            },
          },
          headers,
          singleValueColumns: {},
          cacheKey: null,
          hintsKey: null,
          ingestedAt: Date.now(),
          schemaVersion: irMod.IR_SCHEMA_VERSION ?? '1.0.0',
        };

        const { meta, waveform } = irMod.serializeFrame(frame);
        const packed = packSerializedIR(meta, waveform);
        await fs.writeFile(outputFile, packed);
        console.error(`[usig] wrote result to ${outputFile}`);
      } else if (machineFormat === 'xlsx') {
        const results = payload.results ?? [];
        // Build headers/rows deterministically from first result (exclude _plugin)
        if (!results || results.length === 0) {
          const excelJsMod = await import('exceljs');
          const ExcelJS = excelJsMod.default ?? excelJsMod;
          const wb = new ExcelJS.Workbook();
          wb.addWorksheet('results');
          await wb.xlsx.writeFile(outputFile);
          console.error(`[usig] wrote result to ${outputFile}`);
        } else {
          const first = results[0];
          const headers = Object.keys(first).filter(k => k !== '_plugin');
          const rows = results.map(r => {
            const obj = {};
            for (const h of headers) obj[h] = r[h] ?? '';
            return obj;
          });
          await writeStructuredRowsToFile(headers, rows, outputFile, overwrite);
          console.error(`[usig] wrote result to ${outputFile}`);
        }
      } else if (machineFormat === 'text') {
        // Write the human report to file as text as well
        await fs.writeFile(outputFile, humanReport, 'utf8');
        console.error(`[usig] wrote result to ${outputFile}`);
      } else {
        console.error(`[usig] unsupported plugin result format: ${machineFormat}`);
        process.exit(1);
      }
    } catch (err) {
      console.error('[usig] failed to write output file:', err?.stack ?? err);
      process.exitCode = 4;
    }
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
