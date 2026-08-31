// app/components/plugins/hsioPlugin.tsx

/*
 * ═══════════════════════════════════════════════════════════════════════════════
 * MIGRATION NOTE: OLD FILE-BASED PLUGIN ARCHITECTURE → IR/WAVEFORM ARCHITECTURE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PURPOSE
 * -------
 * This plugin must operate on the canonical IR WaveformPacket. The old plugin
 * architecture passed a File into run(), and the plugin itself performed file
 * ingestion, format detection, column selection, etc. That is no longer the
 * architecture.
 *
 * OLD ARCHITECTURE
 * ----------------
 *
 *     CLI / UI
 *        |
 *        v
 *     plugin.run(file, params)
 *        |
 *        +--> plugin reads File
 *        +--> plugin calls ingestFile()
 *        +--> plugin selects a column
 *        +--> plugin performs format-specific handling
 *        +--> plugin analyzes samples
 *
 * NEW ARCHITECTURE
 * ----------------
 *
 *     CLI / UI
 *        |
 *        v
 *     IREngine.getOrIngest(file, hints)
 *        |
 *        +--> ingestAllColumns()        [metadata / headers / captured vars]
 *        |
 *        +--> ingestFile(file, hints)   [canonical waveform]
 *        |
 *        v
 *     SignalFrame
 *        |
 *        +--> frame.packet
 *        |       |
 *        |       +--> waveform: Float32Array
 *        |       +--> metadata: WaveformMetadata
 *        |
 *        +--> frame.headers
 *        +--> frame.singleValueColumns
 *        +--> frame.capturedVars
 *        |
 *        v
 *     plugin.run(frame.packet, params)
 *
 *
 * IMPORTANT: THE CANONICAL API IS run(packet, params)
 * --------------------------------------------------
 *
 * pluginTypes.ts now defines:
 *
 *     run: (
 *       packet: WaveformPacket,
 *       params: P,
 *     ) => Promise<Record<string, string | number>>;
 *
 * Therefore the plugin's run() must NOT expect a File.
 *
 * Correct:
 *
 *     run: async (packet, params) => {
 *       const samples = packet.waveform;
 *       ...
 *     }
 *
 * Incorrect:
 *
 *     run: async (file, params) => {
 *       const packet = await ingestFile(file);
 *       ...
 *     }
 *
 * Also incorrect:
 *
 *     run: async (packet, params) => {
 *       const packet = await ingestFile(packet);
 *       ...
 *     }
 *
 * The packet has ALREADY been ingested by the pipeline.
 *
 *
 * DO NOT REINTRODUCE runFromWaveform()
 * ------------------------------------
 *
 * During migration it is tempting to preserve both:
 *
 *     run(file, params)
 *
 * and:
 *
 *     runFromWaveform(packet, params)
 *
 * That creates two competing plugin APIs and is unnecessary.
 *
 * The final architecture should use:
 *
 *     run(packet, params)
 *
 * The CLI/pipeline should call:
 *
 *     plugin.run(frame.packet, finalParams)
 *
 * not:
 *
 *     plugin.runFromWaveform(...)
 *
 * and not:
 *
 *     plugin.run(file, ...)
 *
 * The temporary compatibility check in the CLI may accept an old
 * runFromWaveform export while migrating plugins, but new/migrated plugins
 * should expose the standard run(packet, params) API.
 *
 *
 * THE MOST IMPORTANT MIGRATION PITFALL
 * ------------------------------------
 *
 * DO NOT ASSUME THAT packet IS THE SAME OBJECT AS THE OLD INGESTION RESULT.
 *
 * The canonical packet has this shape conceptually:
 *
 *     {
 *       waveform: Float32Array,
 *       metadata: {
 *         ...
 *       }
 *     }
 *
 * Therefore:
 *
 *     packet.waveform
 *
 * is the sample array.
 *
 * Metadata is accessed through:
 *
 *     packet.metadata
 *
 * For example:
 *
 *     packet.metadata.units
 *
 *     packet.metadata.sourceFile
 *
 *     packet.metadata.numSamples
 *
 * NEVER write code that assumes:
 *
 *     packet.units
 *
 *     packet.sourceFile
 *
 *     packet.numSamples
 *
 * when those values are actually inside packet.metadata.
 *
 *
 * A PARTICULAR MIGRATION PITFALL: undefined metadata
 * --------------------------------------------------
 *
 * If code is executed with the wrong object, this:
 *
 *     packet.metadata.units
 *
 * can fail with:
 *
 *     TypeError: Cannot read properties of undefined (reading 'units')
 *
 * This happened during migration when inferSinlParamsFromPacket() was called
 * with something that was not the canonical WaveformPacket.
 *
 * The correct call is:
 *
 *     params = inferSinlParamsFromPacket(params, packet);
 *
 * where packet is the actual:
 *
 *     frame.packet
 *
 * returned by:
 *
 *     irEngine.getOrIngest(...)
 *
 * Do not "fix" this by randomly adding optional chaining everywhere. First
 * verify that the object being passed is actually the canonical packet.
 *
 * Optional chaining can hide an architectural error if the wrong object is
 * being passed.
 *
 *
 * WHERE INGESTION NOW BELONGS
 * ---------------------------
 *
 * File ingestion belongs upstream in IREngine:
 *
 *     const frame = await irEngine.getOrIngest(file, hints);
 *
 * The engine does:
 *
 *     ingestAllColumns(file)
 *
 * when necessary for column/header/captured-variable information, and then:
 *
 *     ingestFile(file, hints)
 *
 * to construct the canonical WaveformPacket.
 *
 * The plugin receives the result:
 *
 *     frame.packet
 *
 * The plugin must not call ingestFile().
 *
 *
 * COLUMN SELECTION PITFALL
 * ------------------------
 *
 * Old plugins often had logic resembling:
 *
 *     ingestFile(file, ...)
 *
 * followed by:
 *
 *     selectColumn(...)
 *
 * or direct parsing of a particular CSV column.
 *
 * That logic must NOT simply be copied into the new run().
 *
 * Column selection is now part of ingestion / parameter resolution.
 *
 * If a plugin needs a column selection parameter, declare it through the
 * declarative plugin parameter system, normally using:
 *
 *     paramFields
 *
 * and/or:
 *
 *     manifest.paramSchema
 *
 * The ingestion layer / pipeline resolves the selected signal into the
 * canonical packet.
 *
 * The plugin then analyzes:
 *
 *     packet.waveform
 *
 * not the original CSV.
 *
 *
 * DO NOT USE File APIs INSIDE THE ANALYSIS PATH
 * ---------------------------------------------
 *
 * A migrated plugin should not contain analysis-time code such as:
 *
 *     file.text()
 *     file.arrayBuffer()
 *     FileReader
 *     Papa.parse(...)
 *     ingestFile(...)
 *     ingestAllColumns(...)
 *     format detection
 *     CSV parsing
 *     XLSX parsing
 *
 * Those responsibilities belong upstream.
 *
 * The plugin should be format-independent.
 *
 * A CSV file, TXT file, XLSX-derived signal, binary-derived signal, etc. should
 * all arrive at the plugin as the same canonical WaveformPacket abstraction.
 *
 *
 * PRESERVE THE ALGORITHM; CHANGE THE INPUT BOUNDARY
 * -------------------------------------------------
 *
 * The safest migration strategy is:
 *
 *     1. Leave the core algorithm alone.
 *     2. Remove file ingestion from the plugin.
 *     3. Change the algorithm's input from the old parsed representation to
 *        packet.waveform.
 *     4. Move any required file/format knowledge into the ingestion layer.
 *     5. Move column-selection UI/parameter declarations into paramFields and
 *        manifest.paramSchema.
 *     6. Use packet.metadata for signal metadata.
 *
 * In other words, do NOT rewrite the mathematical algorithm merely because
 * the architecture changed.
 *
 *
 * EXAMPLE OF THE DESIRED PATTERN
 * ------------------------------
 *
 *     run: async (packet, params) => {
 *       const samples = packet.waveform;
 *
 *       // Analysis only.
 *       const result = runSomeAlgorithm(samples, params);
 *
 *       const fileName = packet.metadata.sourceFile ?? 'waveform';
 *
 *       return {
 *         filename: fileName,
 *         ...
 *       };
 *     },
 *
 *
 * PREPAREDATA MUST FOLLOW THE SAME RULE
 * -------------------------------------
 *
 * If the plugin has prepareData(), it receives the same canonical packet:
 *
 *     prepareData: async (packet, params) => {
 *       const samples = packet.waveform;
 *       ...
 *     }
 *
 * It must NOT ingest the File again.
 *
 * Correct:
 *
 *     prepareData(packet, params)
 *
 * Incorrect:
 *
 *     prepareData(file, params)
 *
 * Incorrect:
 *
 *     prepareData(packet, params) {
 *       return ingestFile(packet);
 *     }
 *
 *
 * METADATA PITFALL
 * ----------------
 *
 * Old code may have obtained metadata from the file parser, for example:
 *
 *     parsed.units
 *     parsed.filename
 *     parsed.sampleRate
 *
 * After migration, check the WaveformMetadata definition and use the canonical
 * location.
 *
 * Typical access is:
 *
 *     packet.metadata.units
 *     packet.metadata.sourceFile
 *
 * Do not invent new top-level packet properties just to make old code work.
 *
 *
 * PARAMETER INFERENCE PITFALL
 * ---------------------------
 *
 * Filename-derived and captured-variable parameters are resolved by the
 * pipeline before plugin.run().
 *
 * The CLI currently constructs:
 *
 *     let finalParams = { ...plugin.defaultParams, ...params };
 *
 * then builds the input summary and finally applies the resolved input-summary
 * values:
 *
 *     for (const row of inputSummary) {
 *       finalParams[row.key] = row.value;
 *     }
 *
 * Therefore plugin.run() should consume the resolved params.
 *
 * Do not duplicate the entire filename-inference / captured-variable pipeline
 * inside the plugin.
 *
 * Plugin-specific parameter declarations belong in:
 *
 *     paramFields
 *
 * and/or:
 *
 *     manifest.paramSchema
 *
 *
 * PARAMETER TYPES AND VALUES
 * --------------------------
 *
 * Be careful during migration because CLI-derived parameters can arrive as
 * strings even when the logical parameter is numeric.
 *
 * Existing plugins commonly normalize explicitly:
 *
 *     Number(params.someValue)
 *
 *     Math.round(Number(params.someValue))
 *
 *     Math.max(...)
 *
 * Preserve the existing normalization semantics when migrating.
 *
 * Do not assume that TypeScript's declared type guarantees the runtime value's
 * representation at the CLI boundary.
 *
 *
 * DEFAULTS MUST REMAIN CONSISTENT
 * -------------------------------
 *
 * Keep:
 *
 *     defaultParams
 *
 * consistent with:
 *
 *     manifest.paramSchema
 *
 * and:
 *
 *     paramFields
 *
 * In particular, do not accidentally remove a parameter from defaultParams
 * because it is now declared in paramFields.
 *
 * The declarative parameter system describes the UI/inference behavior;
 * defaultParams still provides the plugin's baseline parameter object.
 *
 *
 * MULTI-PLUGIN / CLI PITFALL
 * -------------------------
 *
 * The CLI now obtains one shared IR frame and runs multiple plugins against
 * that frame.
 *
 * Conceptually:
 *
 *     const frame = await irEngine.getOrIngest(file, sharedHints);
 *
 *     for (const plugin of plugins) {
 *       const result = await plugin.run(frame.packet, finalParams);
 *     }
 *
 * Therefore a plugin MUST NOT mutate packet.waveform or packet.metadata in a
 * way that changes the input for another plugin.
 *
 * Treat the packet as read-only.
 *
 * If the algorithm needs a mutable working array, make a copy:
 *
 *     const samples = new Float32Array(packet.waveform);
 *
 * or otherwise use a non-mutating algorithm.
 *
 *
 * HINTS PITFALL
 * -------------
 *
 * Ingestion hints are an upstream concern.
 *
 * If the plugin requires a particular column, the plugin should DECLARE the
 * requirement so the pipeline can construct the correct packet.
 *
 * Do not solve a missing-column problem by reopening and reparsing the File
 * inside run().
 *
 * The intended flow is:
 *
 *     plugin declaration
 *          |
 *          v
 *     pipeline determines hints
 *          |
 *          v
 *     IREngine.getOrIngest(file, hints)
 *          |
 *          v
 *     canonical packet
 *          |
 *          v
 *     plugin.run(packet, params)
 *
 *
 * CACHE PITFALL
 * -------------
 *
 * IREngine caches frames by file + ingestion hints.
 *
 * This means:
 *
 *     getOrIngest(file)
 *
 * and:
 *
 *     getOrIngest(file, hints)
 *
 * can represent different cached frames.
 *
 * Do not bypass the engine and perform ad-hoc ingestion in the plugin. Doing
 * so defeats the IR cache and can cause repeated file reads.
 *
 *
 * DO NOT CONFUSE COLUMNAR DATA WITH THE WAVEFORM PACKET
 * -----------------------------------------------------
 *
 * The engine exposes both:
 *
 *     frame.headers
 *     frame.singleValueColumns
 *     frame.capturedVars
 *
 * and:
 *
 *     frame.packet
 *
 * These have different purposes.
 *
 * frame.packet is the canonical signal consumed by the analysis algorithm.
 *
 * frame.headers / singleValueColumns / capturedVars are pipeline metadata used
 * for parameter resolution, UI, inference, etc.
 *
 * Do not reconstruct the signal from frame.headers or capturedVars inside the
 * plugin.
 *
 *
 * CLI COMPATIBILITY CHECK PITFALL
 * -------------------------------
 *
 * During migration the CLI may contain a compatibility check such as:
 *
 *     if (
 *       !pluginExport ||
 *       (
 *         typeof pluginExport.run !== 'function' &&
 *         typeof pluginExport.runFromWaveform !== 'function'
 *       )
 *     ) {
 *       throw new Error(...);
 *     }
 *
 * This DOES NOT mean a migrated plugin should implement both APIs.
 *
 * It merely allows the CLI to recognize plugins during the transition.
 *
 * The desired migrated plugin API is:
 *
 *     run(packet, params)
 *
 * The actual execution path for the migrated architecture should be:
 *
 *     scalarResult = await plugin.run(frame.packet, finalParams);
 *
 * If compatibility code still references runFromWaveform, do not use that as
 * a reason to reintroduce runFromWaveform into the plugin. Remove the
 * compatibility branch once all plugins have migrated.
 *
 *
 * SEARCH/VERIFY CHECKLIST AFTER MIGRATION
 * ---------------------------------------
 *
 * After converting a plugin, search for old file-based execution and ingestion.
 *
 * Useful checks:
 *
 *     grep -RIn --exclude-dir=node_modules --exclude-dir=.git \
 *       "ingestFile" app/components/plugins/<plugin>Plugin.tsx
 *
 *     grep -RIn --exclude-dir=node_modules --exclude-dir=.git \
 *       "ingestAllColumns" app/components/plugins/<plugin>Plugin.tsx
 *
 *     grep -RIn --exclude-dir=node_modules --exclude-dir=.git \
 *       "\.run(file" app usig.mjs
 *
 *     grep -RIn --exclude-dir=node_modules --exclude-dir=.git \
 *       "runFromWaveform" app usig.mjs
 *
 * For a fully migrated plugin, ingestion should not appear in the plugin's
 * implementation, and the plugin should expose:
 *
 *     run: async (packet, params) => ...
 *
 *
 * VERIFY THE CLI EXECUTION SITE
 * -----------------------------
 *
 * The critical CLI line should be equivalent to:
 *
 *     scalarResult = await plugin.run(frame.packet, finalParams);
 *
 * NOT:
 *
 *     scalarResult = await plugin.run(file, finalParams);
 *
 * The distinction is crucial. If the CLI passes File while the plugin expects
 * WaveformPacket, the plugin may fail later with misleading errors such as:
 *
 *     Cannot read properties of undefined (reading 'units')
 *
 * because File does not have the canonical packet structure.
 *
 *
 * VERIFY THE FRAME CONSTRUCTION
 * -----------------------------
 *
 * The CLI should obtain the frame through:
 *
 *     const frame = await irEngine.getOrIngest(
 *       file,
 *       Object.keys(hints).length ? hints : undefined
 *     );
 *
 * Then:
 *
 *     frame.packet
 *
 * is what gets passed to the plugin.
 *
 * A useful debug check during migration is:
 *
 *     console.error({
 *       hasFrame: !!frame,
 *       hasPacket: !!frame?.packet,
 *       hasWaveform: !!frame?.packet?.waveform,
 *       hasMetadata: !!frame?.packet?.metadata,
 *       units: frame?.packet?.metadata?.units,
 *       numSamples: frame?.packet?.metadata?.numSamples,
 *     });
 *
 * Remove temporary debugging once migration is verified.
 *
 *
 * SINL MIGRATION LESSON
 * ---------------------
 *
 * SINL demonstrated the intended final pattern:
 *
 *     run: async (packet, params) => {
 *       params = inferSinlParamsFromPacket(params, packet);
 *
 *       ...
 *
 *       const samples = samplesToCodes(
 *         packet.waveform,
 *         params.inputMode,
 *         minCode,
 *         maxCode,
 *         10,
 *       );
 *
 *       ...
 *
 *       const fileName =
 *         packet.metadata.sourceFile ?? 'waveform';
 *
 *       return singularsToOutput(singulars, fileName);
 *     }
 *
 * The important part is not the SINL-specific algorithm. The important part is
 * the boundary:
 *
 *     packet.waveform
 *     packet.metadata
 *
 * The algorithm is now completely independent of the original file format.
 *
 *
 * FINAL MIGRATION RULE
 * --------------------
 *
 * When converting an old plugin, think:
 *
 *     "Move ingestion OUT of the plugin, not INTO a differently named function."
 *
 * Old:
 *
 *     File
 *       -> plugin
 *       -> ingest
 *       -> parse
 *       -> select column
 *       -> analyze
 *
 * New:
 *
 *     File
 *       -> IREngine
 *       -> ingest
 *       -> select/resolve signal
 *       -> WaveformPacket
 *       -> plugin
 *       -> analyze
 *
 * The plugin begins at the final arrow.
 *
 * The plugin receives:
 *
 *     packet: WaveformPacket
 *
 * and should principally operate on:
 *
 *     packet.waveform
 *
 * with signal metadata from:
 *
 *     packet.metadata
 *
 * and resolved algorithm parameters from:
 *
 *     params
 *
 * If code inside the plugin needs to reopen the File, parse CSV/XLSX/TXT,
 * detect the format, or call ingestFile(), the migration is incomplete.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  type Plugin,
  type PluginManifest,
  type InferredParamField,
  type PluginFigure,
  type PluginDebugTable,
} from '../../lib/pluginTypes';

interface hsioParams {
  signalColumn: string;
  uiRateGbps: number | string;
  fsGhz: number | string;
  signalType: string;
  vtThreshold: number | string;
  eyeSamples: number | string;
}

interface hsioFigureData {
  eyeGridLog: number[];
  eyeGridW: number;
  eyeGridH: number;
  eyeExtent: [number, number, number, number];
  eyeHeightV: number;
  eyeWidthPctUi: number;
  uiSec: number;
  fsHz: number;
  fileName: string;
  status: string;
}

const manifest: PluginManifest = {
  id: 'hsio',
  name: 'hsio — HSIO Eye Diagram',
  description: 'Time-domain eye diagram analysis (release baseline with eye view enabled).',
  version: '1.0.0',
  author: 'Guy Steiff',
  authorEmail: 'guy.steiff-hsio@bytz.me',
  linkedin: 'https://www.linkedin.com/in/guysteiff/',
  reportTitle: 'hsio Eye Diagram Analysis',
  category: 'signal',
  paramSchema: [
    { key: 'signalColumn', label: 'Signal Column', type: 'column-select', required: true, description: 'CSV column with time-domain voltage samples.' },
    { key: 'uiRateGbps', label: 'Bit Rate (Gbps)', type: 'number', required: true, description: 'Nominal bit rate used for UI folding.' },
    { key: 'fsGhz', label: 'Sample Rate (GHz)', type: 'number', required: true, description: 'Acquisition sample rate.' },
    { key: 'signalType', label: 'Signal Type', type: 'text', required: false, description: 'clock | prbs7 | prbs31 (or similar).' },
    { key: 'vtThreshold', label: 'Voltage Threshold (V)', type: 'number', required: false, description: 'Threshold for edge extraction. 0 = auto.' },
    { key: 'eyeSamples', label: 'Eye Fold Samples', type: 'number', required: false, description: 'Maximum samples folded into eye grid.' },
  ],
};

const paramFields: InferredParamField[] = [
  {
    key: 'signalColumn',
    label: 'Signal Column',
    type: 'column-select',
    required: true,
    defaultScope: 'per-file',
    defaultRegex: '',
    defaultReplace: '',
    defaultValue: 'voltage_v',
    title: 'CSV column containing time-domain samples',
  },
  {
    key: 'uiRateGbps',
    label: 'Bit Rate',
    defaultScope: 'global',
    // finused599p93mhz → two groups "599"+"93" → joined "599.93" → transform ÷1000 → 0.59993 Gbps
    // Also handles non-p-decimal: finused10ghz → group "10" → transform: GHz branch
    defaultRegex: 'finused(\\d+)p(\\d+)(mhz|ghz)',
    defaultReplace: '',
    defaultValue: 10,
    min: 0.1,
    max: 224,
    step: 0.1,
    unit: 'Gbps',
    title: 'Nominal bit rate used to fold the eye. Auto-extracted from finused…MHz/GHz in filename.',
    transform: (raw: string) => {
      // raw is "digits.digits unit" e.g. "599.93mhz" or "10.00ghz"
      // applyRegexToFilename joins group1.group2 then appends group3 if available
      // Actually with 3 capture groups, applyRegexToFilename only uses groups 1 and 2.
      // So raw = "599.93" (MHz). We divide by 1000 to get Gbps.
      const n = parseFloat(raw);
      if (isNaN(n)) return raw;
      // If the value looks like it's in MHz range (< 1000), divide by 1000
      return n < 1000 ? String(n / 1000) : String(n);
    },
  },
  {
    key: 'fsGhz',
    label: 'Sample Rate',
    defaultScope: 'global',
    // fs100p00ghz → two groups "100"+"00" → joined "100.00"
    defaultRegex: 'fs(\\d+)p(\\d+)ghz',
    defaultReplace: '',
    defaultValue: 80,
    min: 1,
    max: 500,
    step: 1,
    unit: 'GHz',
    title: 'Acquisition sample rate. Auto-extracted from fs…GHz in filename.',
  },
  {
    key: 'signalType',
    label: 'Signal Type',
    defaultScope: 'global',
    defaultRegex: '(clock|prbs\\d+)',
    defaultReplace: '$1',
    defaultValue: 'prbs2/clock',
    options: [
      'prbs2/clock',
      ...Array.from({ length: 29 }, (_, i) => `prbs${i + 3}`),
    ],
    selectStyle: 'dropdown' as const,
    title: 'prbs2/clock: rising edges only (1010… pattern). PRBS-N (N≥3): both edges.',
    transform: (raw: string) => {
      const s = raw.trim().toLowerCase();
      if (s === 'clock' || s === 'prbs2') return 'prbs2/clock';
      return s;
    },
  },
  {
    key: 'vtThreshold',
    label: 'Threshold',
    defaultScope: 'global',
    defaultRegex: '',
    defaultReplace: '',
    defaultValue: 0,
    unit: 'V',
    title: '0 enables auto-threshold from histogram midpoint',
  },
  {
    key: 'eyeSamples',
    label: 'Eye Samples',
    defaultScope: 'global',
    defaultRegex: '',
    defaultReplace: '',
    defaultValue: 200000,
    min: 1000,
    max: 2000000,
    step: 10000,
    title: 'Upper bound on folded eye samples',
  },
];

const defaultParams: hsioParams = {
  signalColumn: 'voltage_v',
  uiRateGbps: 10,
  fsGhz: 80,
  signalType: 'prbs2/clock',
  vtThreshold: 0,
  eyeSamples: 200000,
};

function parseSimpleCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const rows = lines.slice(1).map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')));
  return { headers, rows };
}

function median(vals: number[]): number {
  if (vals.length === 0) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

function autoDetectVth(samples: number[]): number {
  if (samples.length < 2) return 0;
  const nBins = 200;
  const mn = Math.min(...samples);
  const mx = Math.max(...samples);
  const span = mx - mn;
  if (span <= 1e-15) return mn;
  const w = span / nBins;
  const counts = new Array<number>(nBins).fill(0);
  for (const v of samples) {
    const idx = Math.max(0, Math.min(nBins - 1, Math.floor((v - mn) / w)));
    counts[idx] += 1;
  }
  let p1 = -1;
  let p2 = -1;
  for (let i = 1; i < nBins - 1; i++) {
    if (counts[i] > counts[i - 1] && counts[i] > counts[i + 1]) {
      if (p1 < 0 || counts[i] > counts[p1]) {
        p2 = p1;
        p1 = i;
      } else if (p2 < 0 || counts[i] > counts[p2]) {
        p2 = i;
      }
    }
  }
  if (p1 < 0 || p2 < 0) return 0.5 * (mn + mx);
  const lo = Math.min(p1, p2);
  const hi = Math.max(p1, p2);
  return mn + 0.5 * (lo + hi) * w;
}

function extractEdges(samples: number[], fsHz: number, vth: number, risingOnly: boolean): number[] {
  const out: number[] = [];
  const dt = 1 / fsHz;
  for (let i = 1; i < samples.length; i++) {
    const v0 = samples[i - 1];
    const v1 = samples[i];
    const rising = v0 < vth && v1 >= vth;
    const falling = !risingOnly && v0 >= vth && v1 < vth;
    if (!(rising || falling)) continue;
    const den = v1 - v0;
    const frac = Math.abs(den) < 1e-15 ? 0 : (vth - v0) / den;
    out.push((i - 1 + frac) * dt);
  }
  return out;
}

function estimateEyeWidthPctUi(samples: number[], fsHz: number, uiSec: number, t0: number, vth: number): number {
  const dt = 1 / fsHz;
  const crossingUiErr: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const v0 = samples[i - 1];
    const v1 = samples[i];
    const crossing = (v0 - vth) * (v1 - vth) <= 0;
    if (!crossing) continue;
    const den = v1 - v0;
    const frac = Math.abs(den) < 1e-15 ? 0 : (vth - v0) / den;
    const t = (i - 1 + frac) * dt;
    const ui = (t - t0) / uiSec;
    const nearest = Math.round(ui);
    crossingUiErr.push(ui - nearest);
  }
  if (crossingUiErr.length < 20) return 0;
  const sigma = Math.sqrt(crossingUiErr.reduce((s, x) => s + x * x, 0) / crossingUiErr.length);
  const closedFrac = Math.min(0.95, 12 * sigma); // ~6 sigma on each side
  return Math.max(0, (1 - closedFrac) * 100);
}

function bresSegment(x0: number, y0: number, x1: number, y1: number, grid: Float32Array, gridH: number, gridW: number): void {
  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    if (x0 >= 0 && x0 < gridH && y0 >= 0 && y0 < gridW) grid[x0 * gridW + y0] += 1;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
}

function buildEyeDiagram(
  samples: number[],
  fsHz: number,
  uiSec: number,
  gridSize: number,
  maxFoldSamples: number,
  _edgeTimes: number[],   // kept for API compat; not used (global_phase_ui = 0)
  signalType: string,
): { gridLog: number[]; gridW: number; gridH: number; extent: [number, number, number, number] } {
  // Mirror hsio.py _build_eye exactly.
  const s = samples;          // use the FULL dataset — no upfront slice
  const nTotal = s.length;
  const nominalSpu = uiSec * fsHz;

  // Coherency-aware folding cadence (mirrors Python logic):
  // If N/spu is (near-)integer the capture is coherent → use N/K to eliminate phase walk.
  // Otherwise (mission-mode / non-coherent) use nominalSpu directly.
  const ratio = nTotal / Math.max(nominalSpu, 1e-15);
  const K = Math.max(1, Math.round(ratio));
  const isCoherent = Math.abs(ratio - K) < 1e-6;
  const periodSamplesExact = isCoherent ? nTotal / K : nominalSpu;
  const uiSamples = signalType === 'clock' ? periodSamplesExact / 2 : periodSamplesExact;

  // Fixed display rails — identical to Python reference visuals.
  const vMin = -0.5;
  const vMax =  1.5;
  const vRange = vMax - vMin;

  const gridH = gridSize;
  const gridW = gridSize;
  const grid = new Float32Array(gridH * gridW);

  // global_phase_ui = 0 → phaseShiftSamples = 0
  const phaseShiftSamples = 0;
  const numUis = Math.min(
    Math.floor(nTotal / Math.max(uiSamples, 1)),
    Math.max(1, maxFoldSamples),
  );

  for (let uiIdx = 0; uiIdx < numUis; uiIdx++) {
    const startF  = uiIdx * uiSamples + phaseShiftSamples;
    const endF    = (uiIdx + 1) * uiSamples + phaseShiftSamples;
    const startIdx = Math.floor(startF);
    const endIdx   = Math.ceil(endF);
    if (endIdx >= nTotal) break;
    const segLen = endIdx - startIdx;
    if (segLen < 2) continue;

    // x_grid (col) = linspace(0,1,segLen)*(gridW-1)  → time axis → columns
    // y_grid (row) = (v - vMin)/vRange*(gridH-1)      → voltage  → rows
    let prevRow = -1;
    let prevCol = -1;
    for (let j = 0; j < segLen; j++) {
      const col = Math.max(0, Math.min(gridW - 1, Math.round((j / (segLen - 1)) * (gridW - 1))));
      const v   = s[startIdx + j];
      const row = Math.max(0, Math.min(gridH - 1, Math.round(((v - vMin) / vRange) * (gridH - 1))));
      if (j === 0) {
        // Stamp first point (mirrors Python's explicit last-point stamp)
        grid[row * gridW + col] += 1;
      } else {
        bresSegment(prevRow, prevCol, row, col, grid, gridH, gridW);
      }
      prevRow = row;
      prevCol = col;
    }
    // Stamp final point of segment (mirrors Python _bres_curve_count tail stamp)
    if (prevRow >= 0 && prevRow < gridH && prevCol >= 0 && prevCol < gridW) {
      grid[prevRow * gridW + prevCol] += 1;
    }
  }

  // 2-UI tiling: [right_half | full | left_half]  → x axis spans [-0.5, 1.5]
  const half   = Math.floor(gridW / 2);
  const tiledW = gridW * 2;
  const tiled  = new Float32Array(gridH * tiledW);
  for (let r = 0; r < gridH; r++) {
    for (let c = 0; c < half; c++)   tiled[r * tiledW + c]                 = grid[r * gridW + (half + c)];
    for (let c = 0; c < gridW; c++)  tiled[r * tiledW + (half + c)]        = grid[r * gridW + c];
    for (let c = 0; c < half; c++)   tiled[r * tiledW + (half + gridW + c)] = grid[r * gridW + c];
  }

  return {
    gridLog: Array.from(tiled).map((v) => Math.log10(v + 1)),
    gridW: tiledW,
    gridH,
    extent: [-0.5, 1.5, vMin, vMax],
  };
}

async function analyzehsio(samples: number[], params: hsioParams, fileName: string): Promise<hsioFigureData & {
  capturedRateGbps: number;
  inputRateGbps: number;
  nEdges: number;
  nSamples: number;
  uiPs: number;
  vthV: number;
}> {
  const inputRateGbps = Number(params.uiRateGbps);
  const fsHz = Number(params.fsGhz) * 1e9;
  const uiSec = 1 / (inputRateGbps * 1e9);
  const rawSignalType = String(params.signalType || 'prbs2/clock').toLowerCase();
  const signalType = (rawSignalType === 'prbs2' || rawSignalType === 'prbs2/clock' || rawSignalType === 'clock')
    ? 'clock'
    : rawSignalType;

  let vth = Number(params.vtThreshold ?? 0);
  if (!isFinite(vth) || vth === 0) vth = autoDetectVth(samples);

  const edges = extractEdges(samples, fsHz, vth, signalType === 'clock');
  if (edges.length < 10) {
    throw new Error(`Too few edges (${edges.length}). Check threshold and signal type.`);
  }

  const dts: number[] = [];
  for (let i = 1; i < edges.length; i++) dts.push(edges[i] - edges[i - 1]);
  const capturedRateGbps = dts.length > 0 ? (1 / Math.max(median(dts), 1e-18)) / 1e9 : 0;

  const eye = buildEyeDiagram(
    samples,
    fsHz,
    uiSec,
    500,
    Number(params.eyeSamples ?? 200000),
    edges,
    signalType,
  );

  const t0 = edges[0] ?? 0;
  const dt = 1 / fsHz;
  let cMin = Infinity;
  let cMax = -Infinity;
  const nLim = Math.min(samples.length, 100000);
  for (let i = 0; i < nLim; i++) {
    const phase = ((i * dt - t0) / uiSec) % 1;
    const p = phase < 0 ? phase + 1 : phase;
    if (p >= 0.4 && p <= 0.6) {
      const v = samples[i];
      if (v < cMin) cMin = v;
      if (v > cMax) cMax = v;
    }
  }

  const eyeHeightV = cMax > cMin ? cMax - cMin : 0;
  const eyeWidthPctUi = estimateEyeWidthPctUi(samples, fsHz, uiSec, t0, vth);

  return {
    eyeGridLog: eye.gridLog,
    eyeGridW: eye.gridW,
    eyeGridH: eye.gridH,
    eyeExtent: eye.extent,
    eyeHeightV,
    eyeWidthPctUi,
    uiSec,
    fsHz,
    fileName,
    status: 'ok',
    capturedRateGbps,
    inputRateGbps,
    nEdges: edges.length,
    nSamples: samples.length,
    uiPs: uiSec * 1e12,
    vthV: vth,
  };
}

function drawEyeDiagram(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  rawData: unknown,
): void {
  const d = rawData as hsioFigureData;
  const pad = { l: 56, r: 20, t: 34, b: 44 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;

  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, width, height);

  if (!d.eyeGridLog || d.eyeGridLog.length === 0) {
    ctx.fillStyle = '#9ca3af';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No eye data', width / 2, height / 2);
    return;
  }

  const gW = d.eyeGridW;
  const gH = d.eyeGridH;
  const grid = d.eyeGridLog;
  let maxLog = 0;
  for (const v of grid) if (v > maxLog) maxLog = v;
  const floor = maxLog * 0.05;

  const img = ctx.createImageData(gW, gH);
  for (let r = 0; r < gH; r++) {
    for (let c = 0; c < gW; c++) {
      const val = grid[r * gW + c];
      if (val <= floor) continue;
      const t = Math.min((val - floor) / Math.max(maxLog - floor, 1e-12), 1);
      const rr = Math.min(255, Math.floor(255 * (t * 3)));
      const gg = Math.min(255, Math.floor(255 * Math.max(0, t * 3 - 1)));
      const bb = Math.min(255, Math.floor(255 * Math.max(0, t * 3 - 2)));
      const fr = gH - 1 - r;
      const idx = (fr * gW + c) * 4;
      img.data[idx] = rr;
      img.data[idx + 1] = gg;
      img.data[idx + 2] = bb;
      img.data[idx + 3] = 220;
    }
  }

  const tmp = Object.assign(document.createElement('canvas'), { width: gW, height: gH });
  const tctx = tmp.getContext('2d');
  if (!tctx) return;
  tctx.putImageData(img, 0, 0);
  ctx.drawImage(tmp, pad.l, pad.t, plotW, plotH);

  ctx.strokeStyle = '#4b5563';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.l, pad.t, plotW, plotH);

  const [xMin, xMax, vMin, vMax] = d.eyeExtent;
  const xSpan = xMax - xMin;
  const ySpan = vMax - vMin;
  const toX = (ui: number) => pad.l + ((ui - xMin) / Math.max(xSpan, 1e-12)) * plotW;

  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const x = pad.l + (i / 4) * plotW;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + plotH);
    ctx.stroke();
  }
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (i / 4) * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
    ctx.stroke();
  }

  ctx.strokeStyle = '#f8fafc';
  ctx.setLineDash([3, 4]);
  for (const ui of [0, 1]) {
    const x = toX(ui);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + plotH);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 1;
  const cx = toX(0.5);
  ctx.beginPath();
  ctx.moveTo(cx, pad.t);
  ctx.lineTo(cx, pad.t + plotH);
  ctx.stroke();

  ctx.fillStyle = '#cbd5e1';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`Eye  H=${(d.eyeHeightV * 1000).toFixed(1)}mV  W=${d.eyeWidthPctUi.toFixed(1)}%UI  ${d.fileName}`, pad.l, 18);

  ctx.fillStyle = '#9ca3af';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  for (const ui of [-0.5, 0, 0.5, 1.0, 1.5]) {
    ctx.fillText(ui.toFixed(1), toX(ui), pad.t + plotH + 14);
  }
  ctx.fillText('Phase (UI)', pad.l + plotW / 2, pad.t + plotH + 30);

  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = vMax - (i / 4) * ySpan;
    ctx.fillText(v.toFixed(2), pad.l - 4, pad.t + (i / 4) * plotH + 4);
  }
  ctx.save();
  ctx.translate(14, pad.t + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText('Voltage (V)', 0, 0);
  ctx.restore();
}

const PlaceholderFigure = ({ label }: { label: string }) => (
  <div className="w-full h-full min-h-[220px] flex items-center justify-center text-sm text-gray-400">
    {label}: placeholder (planned in next release)
  </div>
);

const figures: PluginFigure[] = [
  { id: 'eye', label: 'Eye Diagram', draw: drawEyeDiagram },
  {
    id: 'jitter',
    label: 'Jitter Decomposition',
    component: () => <PlaceholderFigure label="Jitter Decomposition" />,
  },
  {
    id: 'bathtub',
    label: 'Bathtub Curve',
    component: () => <PlaceholderFigure label="Bathtub Curve" />,
  },
  {
    id: 'ssc',
    label: 'SSC Profile',
    component: () => <PlaceholderFigure label="SSC Profile" />,
  },
];

export const hsioPlugin: Plugin<hsioParams> = {
  id: 'hsio',
  name: 'hsio — HSIO Eye Diagram',
  description: manifest.description,
  manifest,
  paramFields,
  defaultParams,
  outputColumns: [
    'status',
    'signal_type',
    'sample_rate_ghz',
    'input_rate_gbps',
    'captured_rate_gbps',
    'ui_ps',
    'threshold_v',
    'n_samples',
    'n_edges',
    'eye_height_mv',
    'eye_width_pct_ui',
  ],
  run: async (file: File, params: hsioParams): Promise<Record<string, string | number>> => {
    const text = await file.text();
    const { headers, rows } = parseSimpleCsv(text);
    if (headers.length === 0 || rows.length === 0) {
      throw new Error('CSV is empty or malformed.');
    }

    const col = String(params.signalColumn || headers[0]);
    const idx = headers.indexOf(col);
    if (idx < 0) throw new Error(`Column "${col}" not found. Available: ${headers.join(', ')}`);

    const samples: number[] = [];
    for (const r of rows) {
      const v = parseFloat(r[idx]);
      if (!Number.isNaN(v)) samples.push(v);
    }
    if (samples.length < 200) throw new Error(`Too few valid samples (${samples.length}). Need at least 200.`);

    const r = await analyzehsio(samples, params, file.name);
    return {
      filename: file.name,
      status: r.status,
      signal_type: String(params.signalType || 'prbs31'),
      sample_rate_ghz: Number(params.fsGhz),
      input_rate_gbps: Number(r.inputRateGbps.toFixed(6)),
      captured_rate_gbps: Number(r.capturedRateGbps.toFixed(6)),
      ui_ps: Number(r.uiPs.toFixed(4)),
      threshold_v: Number(r.vthV.toFixed(6)),
      n_samples: r.nSamples,
      n_edges: r.nEdges,
      eye_height_mv: Number((r.eyeHeightV * 1e3).toFixed(3)),
      eye_width_pct_ui: Number(r.eyeWidthPctUi.toFixed(3)),
    };
  },
  prepareData: async (file: File, params: hsioParams) => {
    const text = await file.text();
    const { headers, rows } = parseSimpleCsv(text);
    if (headers.length === 0 || rows.length === 0) {
      throw new Error('CSV is empty or malformed.');
    }
    const col = String(params.signalColumn || headers[0]);
    const idx = headers.indexOf(col);
    if (idx < 0) throw new Error(`Column "${col}" not found.`);

    const samples: number[] = [];
    for (const r of rows) {
      const v = parseFloat(r[idx]);
      if (!Number.isNaN(v)) samples.push(v);
    }
    if (samples.length < 200) throw new Error(`Too few valid samples (${samples.length}). Need at least 200.`);

    const figureData = await analyzehsio(samples, params, file.name);
    const debugTables: PluginDebugTable[] = [
      {
        id: 'eye_metadata',
        label: 'Eye metadata',
        columns: {
          key: ['n_samples', 'n_edges', 'input_rate_gbps', 'captured_rate_gbps', 'ui_ps', 'eye_height_mv', 'eye_width_pct_ui'],
          value: [
            figureData.nSamples,
            figureData.nEdges,
            Number(figureData.inputRateGbps.toFixed(6)),
            Number(figureData.capturedRateGbps.toFixed(6)),
            Number((figureData.uiSec * 1e12).toFixed(4)),
            Number((figureData.eyeHeightV * 1e3).toFixed(3)),
            Number(figureData.eyeWidthPctUi.toFixed(3)),
          ],
        },
      },
    ];
    return { figureData, debugTables };
  },
  figures,
};
