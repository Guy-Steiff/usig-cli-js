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
  type PortableFigureDescription,
  type WaveformPacket,
} from '../../lib/pluginTypes';

interface hsioParams {
  signalColumn: string;
  uiRateGbps: number | string;
  fsGhz: number | string;
  signalType: string;
  vtThreshold: number | string;
  eyeSamples: number | string;
  berTarget: number | string;
  // Informational-only fields captured from golden HSIO filenames
  // (e.g. prbs2_finnoncoh600p00mhz_fin0p59993ghz_fs100p00ghz_nfft4194304_
  //  rjstd0p00ps_pjamp0p00ps_pjfreq1p00Mhz_sscamp0p00ps_sscfreq100p00khz_
  //  noisestd1p0mv). These describe the synthetic jitter/noise injected
  // when the golden file was generated — they are NOT consumed by
  // analyzehsio()/computeJitter() and must never be confused with the
  // real computed jitter outputs (rjSigmaPs, pjFreqMhz, etc.).
  rjStdTargetPs: number | string;
  pjAmpTargetPs: number | string;
  pjFreqTargetMhz: number | string;
  sscAmpTargetPs: number | string;
  sscFreqTargetKhz: number | string;
  noiseStdTargetMv: number | string;
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
  // ── Jitter decomposition / bathtub / SSC (additive; optional — omitted
  // when jitter computation fails or is skipped, see analyzehsio()). ──────
  tieDisplayPs?: number[];
  tieResidualPs?: number[];
  tieBinsPs?: number[];
  tieCounts?: number[];
  tjRmsPs?: number;
  tjPkpkPs?: number;
  rjSigmaPs?: number;
  pjPkpkPs?: number;
  pjFreqMhz?: number;
  dcdPs?: number;
  ujPkpkPs?: number;
  ddjPkpkPs?: number;
  ddjProfileRunLengths?: number[];
  ddjProfileRisingPs?: number[];
  ddjProfileFallingPs?: number[];
  nEdgesJitter?: number;
  // Bathtub
  bathtubXUi?: number[];
  bathtubLogBer?: number[];
  bathtubEmpLogBer?: number[];
  bathtubBerTarget?: number;
  bathtubDdMarginPctUi?: number;
  bathtubEmpMarginPctUi?: number;
  // SSC / wander
  sscWanderTimeUs?: number[];
  sscWanderPs?: number[];
  sscSwingPpm?: number;
  // Set when jitter computation threw and was caught (eye-diagram outputs
  // above remain valid/unaffected).
  jitterStatus?: string;
}

/** Ingestion hints so the pipeline selects the correct CSV/XLSX column
 * (mirrors smeasIngestHints / sinlPlugin's column-select convention). */
function hsioIngestHints(params: hsioParams): import('../../lib/ingest').IngestHints {
  return {
    signalColumn: params.signalColumn?.trim() || undefined,
  };
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
    { key: 'signalColumn', label: 'Signal Column', type: 'column-select', required: true, description: 'CSV column with time-domain voltage samples.', aliases: ['sample', 'samples', 'voltage', 'voltageColumn'] },
    { key: 'uiRateGbps', label: 'Bit Rate (Gbps)', type: 'number', required: true, description: 'Nominal bit rate used for UI folding.', aliases: ['bitRate', 'dataRate', 'uiRate', 'fin'], unit: 'Gbps' },
    { key: 'fsGhz', label: 'Sample Rate (GHz)', type: 'number', required: true, description: 'Acquisition sample rate.', aliases: ['fs', 'samplingFrequency', 'sampleRate'], unit: 'GHz' },
    { key: 'signalType', label: 'Signal Type', type: 'text', required: false, description: 'clock | prbs7 | prbs31 (or similar).', aliases: ['pattern', 'patternType', 'prbs'] },
    { key: 'vtThreshold', label: 'Voltage Threshold (V)', type: 'number', required: false, description: 'Threshold for edge extraction. 0 = auto.', aliases: ['threshold', 'vth'], unit: 'V' },
    { key: 'eyeSamples', label: 'Eye Fold Samples', type: 'number', required: false, description: 'Maximum samples folded into eye grid.', aliases: ['maxFoldSamples', 'nfft'] },
    { key: 'berTarget', label: 'BER Target', type: 'text', required: false, description: 'Target bit-error-rate used for bathtub-curve extrapolation.', aliases: ['ber'] },
    // Informational-only fields captured from golden HSIO filenames.
    // These describe the synthetic jitter/noise injected when the golden
    // file was generated. They are recognized/displayed but never fed
    // into analyzehsio()/computeJitter() as analysis inputs.
    { key: 'rjStdTargetPs', label: 'RJ Std (target, ps)', type: 'number', required: false, description: 'Informational: random-jitter sigma used to synthesize the golden file.', aliases: ['rjstd'], unit: 'ps' },
    { key: 'pjAmpTargetPs', label: 'PJ Amplitude (target, ps)', type: 'number', required: false, description: 'Informational: periodic-jitter amplitude used to synthesize the golden file.', aliases: ['pjamp'], unit: 'ps' },
    { key: 'pjFreqTargetMhz', label: 'PJ Frequency (target, MHz)', type: 'number', required: false, description: 'Informational: periodic-jitter frequency used to synthesize the golden file.', aliases: ['pjfreq'], unit: 'MHz' },
    { key: 'sscAmpTargetPs', label: 'SSC Amplitude (target, ps)', type: 'number', required: false, description: 'Informational: spread-spectrum-clocking wander amplitude used to synthesize the golden file.', aliases: ['sscamp'], unit: 'ps' },
    { key: 'sscFreqTargetKhz', label: 'SSC Frequency (target, kHz)', type: 'number', required: false, description: 'Informational: spread-spectrum-clocking modulation frequency used to synthesize the golden file.', aliases: ['sscfreq'], unit: 'kHz' },
    { key: 'noiseStdTargetMv', label: 'Noise Std (target, mV)', type: 'number', required: false, description: 'Informational: additive-noise sigma used to synthesize the golden file.', aliases: ['noisestd'], unit: 'mV' },
  ],

  // Declarative debug table capabilities. Lightweight metadata only —
  // prepareData() still generates the actual PluginDebugTable objects at
  // runtime (see SMEAS/SINL convention).
  debugTables: [
    {
      id: 'eye_metadata',
      label: 'Eye metadata',
      description: 'Scalar eye-diagram metrics (edge count, UI, height, width) as a key/value table.',
      columns: ['key', 'value'],
    },
    {
      id: 'jitter_metrics',
      label: 'Jitter metrics',
      description: 'Scalar jitter-decomposition metrics (TJ rms/pk-pk, RJ sigma, DJ pk-pk, PJ pk-pk/freq, DCD, UJ, N edges) as a key/value table.',
      columns: ['key', 'value'],
    },
    {
      id: 'jitter_tie_histogram',
      label: 'TIE histogram',
      description: '64-bin TIE (time-interval-error) histogram: bin center (ps) and count.',
      columns: ['tie_bin_ps', 'count'],
    },
    {
      id: 'jitter_tie_series',
      label: 'TIE time series',
      description: 'Downsampled TIE time series (ps) alongside the TIE residual (TIE minus synthesized periodic-jitter component).',
      columns: ['tie_ps', 'tie_residual_ps'],
    },
    {
      id: 'jitter_ddj_profile',
      label: 'DDJ profile',
      description: 'Data-dependent-jitter profile: per bit-history-state (or run-length fallback) mean TIE, rising/falling.',
      columns: ['state_or_run_length', 'tie_rising_ps', 'tie_falling_ps'],
    },
    {
      id: 'bathtub_curve',
      label: 'Bathtub curve',
      description: 'Dual-Dirac and empirical bathtub-curve log10(BER) vs. UI phase.',
      columns: ['x_ui', 'dd_log_ber', 'emp_log_ber'],
    },
    {
      id: 'ssc_wander',
      label: 'SSC / wander',
      description: 'Spread-spectrum-clocking / wander profile: low-pass-filtered TIE (wander, ps) vs. time (us).',
      columns: ['time_us', 'wander_ps'],
    },
  ],

  // Declarative figure capabilities. Safe to enumerate via `-figure list`
  // without ingesting an input.
  figures: [
    {
      id: 'eye',
      label: 'Eye Diagram',
      description: '2D folded eye density diagram (voltage vs. UI phase), with 0/1 UI boundary reference lines.',
    },
    {
      id: 'jitter',
      label: 'Jitter Decomposition',
      description: 'TIE histogram with dual-Dirac/DDJ/PJ scalar jitter metrics in the results panel (see the jitter_tie_series/jitter_ddj_profile debug tables for the full time-series/DDJ data).',
    },
    {
      id: 'bathtub',
      label: 'Bathtub Curve',
      description: 'Dual-Dirac (solid) and empirical (dashed) bathtub curves (log10(BER) vs. UI phase) with BER-target reference line and margins.',
    },
    {
      id: 'ssc',
      label: 'SSC Profile',
      description: 'Spread-spectrum-clocking / wander profile (ps vs. time), with SSC swing (ppm) in the results panel.',
    },
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
    aliases: ['fin'],
    title: 'Nominal bit rate used to fold the eye. Auto-extracted from finused…MHz/GHz in filename, or fin…ghz (e.g. fin0p59993ghz → 0.59993 Gbps).',
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
    aliases: ['fs'],
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
    aliases: ['prbs'],
    title: 'prbs2/clock: rising edges only (1010… pattern). PRBS-N (N≥3): both edges. Auto-extracted from the filename\'s prbsN token (e.g. prbs2 → "prbs2"); analyzehsio() already normalizes prbs2/clock/"prbs2" identically.',
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
    aliases: ['nfft'],
    title: 'Upper bound on folded eye samples. Auto-extracted from nfft… in filename.',
  },
  {
    key: 'berTarget',
    label: 'BER Target',
    defaultScope: 'global',
    defaultRegex: '',
    defaultReplace: '',
    defaultValue: '1e-12',
    aliases: ['ber'],
    title: 'Target bit-error-rate used for dual-Dirac bathtub-curve extrapolation.',
  },
  // ── Informational-only fields extracted from golden HSIO filenames ──────
  // These describe the synthetic jitter/noise injected when the golden
  // file was generated. Recognized/displayed only — never fed into
  // analyzehsio()/computeJitter() as analysis inputs.
  {
    key: 'rjStdTargetPs',
    label: 'RJ Std (target)',
    defaultScope: 'global',
    defaultRegex: '',
    defaultReplace: '',
    defaultValue: 0,
    unit: 'ps',
    aliases: ['rjstd'],
    title: 'Informational: random-jitter sigma used to synthesize the golden file.',
  },
  {
    key: 'pjAmpTargetPs',
    label: 'PJ Amplitude (target)',
    defaultScope: 'global',
    defaultRegex: '',
    defaultReplace: '',
    defaultValue: 0,
    unit: 'ps',
    aliases: ['pjamp'],
    title: 'Informational: periodic-jitter amplitude used to synthesize the golden file.',
  },
  {
    key: 'pjFreqTargetMhz',
    label: 'PJ Frequency (target)',
    defaultScope: 'global',
    defaultRegex: '',
    defaultReplace: '',
    defaultValue: 0,
    unit: 'MHz',
    aliases: ['pjfreq'],
    title: 'Informational: periodic-jitter frequency used to synthesize the golden file.',
  },
  {
    key: 'sscAmpTargetPs',
    label: 'SSC Amplitude (target)',
    defaultScope: 'global',
    defaultRegex: '',
    defaultReplace: '',
    defaultValue: 0,
    unit: 'ps',
    aliases: ['sscamp'],
    title: 'Informational: spread-spectrum-clocking wander amplitude used to synthesize the golden file.',
  },
  {
    key: 'sscFreqTargetKhz',
    label: 'SSC Frequency (target)',
    defaultScope: 'global',
    defaultRegex: '',
    defaultReplace: '',
    defaultValue: 0,
    unit: 'kHz',
    aliases: ['sscfreq'],
    title: 'Informational: spread-spectrum-clocking modulation frequency used to synthesize the golden file.',
  },
  {
    key: 'noiseStdTargetMv',
    label: 'Noise Std (target)',
    defaultScope: 'global',
    defaultRegex: '',
    defaultReplace: '',
    defaultValue: 0,
    unit: 'mV',
    aliases: ['noisestd'],
    title: 'Informational: additive-noise sigma used to synthesize the golden file.',
  },
];

const defaultParams: hsioParams = {
  signalColumn: 'voltage_v',
  uiRateGbps: 10,
  fsGhz: 80,
  signalType: 'prbs2/clock',
  vtThreshold: 0,
  eyeSamples: 200000,
  berTarget: '1e-12',
  rjStdTargetPs: 0,
  pjAmpTargetPs: 0,
  pjFreqTargetMhz: 0,
  sscAmpTargetPs: 0,
  sscFreqTargetKhz: 0,
  noiseStdTargetMv: 0,
};

function median(vals: number[]): number {
  if (vals.length === 0) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

function autoDetectVth(samples: number[]): number {
  if (samples.length < 2) return 0;
  const nBins = 200;
  // Manual min/max loop instead of Math.min(...samples)/Math.max(...samples):
  // spreading large sample arrays into Math.min/max overflows the JS call
  // stack (V8 argument limit). Numerically identical result, just safe for
  // large N.
  let mn = samples[0];
  let mx = samples[0];
  for (const v of samples) {
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
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

/**
 * extractEdgesWithPolarity — same as extractEdges but also returns
 * rising(+1)/falling(-1) polarity per edge. Ported VERBATIM from
 * hsioalphaPlugin.tsx (legacy reference implementation); numerically
 * identical to extractEdges (confirmed by inspection — same threshold
 * crossing / linear-interpolation arithmetic).
 */
function extractEdgesWithPolarity(
  samples: number[], fsHz: number, vth: number, risingOnly: boolean,
): { times: number[]; pols: Int8Array } {
  const times: number[] = [];
  const polsArr: number[] = [];
  const dt = 1 / fsHz;
  for (let i = 1; i < samples.length; i++) {
    const v0 = samples[i - 1], v1 = samples[i];
    const rising  = v0 <  vth && v1 >= vth;
    const falling = !risingOnly && v0 >= vth && v1 < vth;
    if (!(rising || falling)) continue;
    const den  = v1 - v0;
    const frac = Math.abs(den) < 1e-15 ? 0 : (vth - v0) / den;
    times.push((i - 1 + frac) * dt);
    polsArr.push(rising ? 1 : -1);
  }
  return { times, pols: new Int8Array(polsArr) };
}

// ── Jitter analysis helpers (ported VERBATIM from hsioalphaPlugin.tsx) ──────

/**
 * normPpf — inverse normal CDF (probit function).
 * Peter Acklam's rational approximation; max error ~1.15e-9.
 * Matches scipy.stats.norm.ppf used in shio.py _dual_dirac / _compute_uj.
 */
function normPpf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  // Coefficients
  const a = [-3.969683028665376e+01, 2.209460984245205e+02,
             -2.759285104469687e+02, 1.383577518672690e+02,
             -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02,
             -1.556989798598866e+02, 6.680131188771972e+01,
             -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01,
             -2.400758277161838e+00, -2.549732539343734e+00,
              4.374664141464968e+00,  2.938163982698783e+00];
  const d = [ 7.784695709041462e-03,  3.224671290700398e-01,
              2.445134137142996e+00,  3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    const r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
             ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
}

/**
 * erfc — complementary error function, Horner polynomial approximation.
 * Max error ≈ 1.5e-7. Matches scipy.special.erfc used in shio.py bathtub.
 */
function erfc(x: number): number {
  const t = 1.0 / (1.0 + 0.3275911 * Math.abs(x));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const res = poly * Math.exp(-x * x);
  return x >= 0 ? res : 2.0 - res;
}
/** Q(z) = 0.5 * erfc(z / sqrt(2))  — complementary Gaussian CDF */
const qFunc = (z: number) => 0.5 * erfc(z / Math.SQRT2);

/**
 * dualDiracFit — Q-scale tail fitting matching shio.py _dual_dirac.
 *
 * Sorts the TIE array, assigns plotting positions (i+0.5)/N → Q-scale values
 * via normPpf, then fits linear models to the left and right Gaussian tails.
 * The slope average gives RJ sigma; the intercept difference gives DJ pk-pk.
 *
 * Tail selection: data beyond ±2σ_robust from the median (threshold-based),
 * falling back to percentile-based selection when the threshold yields too few points.
 * Exactly mirrors shio.py _dual_dirac(tie, tail_sigma=2.0, min_tail_count=200).
 */
function dualDiracFit(tie: number[]): { rjSigmaPs: number; djPkpkPs: number } {
  const n = tie.length;
  // Fallback to std for tiny arrays
  if (n < 40) {
    let s = 0, s2 = 0;
    for (const v of tie) { s += v; s2 += v * v; }
    const mu = s / n;
    return { rjSigmaPs: Math.sqrt(Math.max(0, s2 / n - mu * mu)) * 1e12, djPkpkPs: 0 };
  }

  // Sort a copy
  const sorted = Float64Array.from(tie).sort();

  // Robust sigma (1.4826 × MAD) to set the tail threshold
  const medIdx1 = (n - 1) >> 1, medIdx2 = n >> 1;
  const med = n % 2 ? sorted[medIdx1] : 0.5 * (sorted[medIdx1] + sorted[medIdx2]);
  const mads = Float64Array.from(sorted, v => Math.abs(v - med)).sort();
  const madVal = n % 2 ? mads[medIdx1] : 0.5 * (mads[medIdx1] + mads[medIdx2]);
  const robustSigma = Math.max(1.4826 * madVal, 1e-30);
  const threshold = 2.0 * robustSigma;  // tail_sigma = 2.0

  // Plotting positions (Hazen) → Q-values
  const qVals = new Float64Array(n);
  for (let i = 0; i < n; i++) qVals[i] = normPpf((i + 0.5) / n);

  // Tail extent by threshold
  let leftEnd = 0, rightStart = n;
  for (let i = 0; i < n; i++) { if (sorted[i] >= med - threshold) { leftEnd = i; break; } }
  for (let i = n - 1; i >= 0; i--) { if (sorted[i] <= med + threshold) { rightStart = i + 1; break; } }

  // Fallback: percentile-based tails when threshold gives too few points
  const minPts = Math.max(5, Math.min(50, Math.floor(n / 20)));
  if (leftEnd < minPts || (n - rightStart) < minPts) {
    const tailN = Math.max(minPts, Math.floor(n * Math.max(0.01, Math.min(0.10, 1000 / n))));
    leftEnd = tailN;
    rightStart = n - tailN;
  }

  // Linear least-squares: t = slope*q + intercept
  const linFit = (start: number, end: number): [number, number] => {
    const cnt = end - start;
    if (cnt < 2) return [0, 0];
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = start; i < end; i++) {
      sx += qVals[i]; sy += sorted[i]; sxx += qVals[i] * qVals[i]; sxy += qVals[i] * sorted[i];
    }
    const det = cnt * sxx - sx * sx;
    if (Math.abs(det) < 1e-40) return [0, sy / cnt];
    return [(cnt * sxy - sx * sy) / det, (sy * sxx - sx * sxy) / det];
  };

  const [lSlope, lIntercept] = linFit(0, leftEnd);
  const [rSlope, rIntercept] = linFit(rightStart, n);

  // RJ sigma = average of tail slopes, capped by std
  let s = 0, s2 = 0;
  for (const v of tie) { s += v; s2 += v * v; }
  const mu = s / n;
  const stdVal = Math.sqrt(Math.max(0, s2 / n - mu * mu));
  const rjSigma = Math.min((Math.abs(lSlope) + Math.abs(rSlope)) / 2.0, stdVal);

  // DJ pk-pk = intercept difference (same as shio.py dj_pkpk = |rfit[1] - lfit[1]|)
  const djPkpk = Math.abs(rIntercept - lIntercept);

  return { rjSigmaPs: rjSigma * 1e12, djPkpkPs: djPkpk * 1e12 };
}

/** Radix-2 Cooley-Tukey FFT in-place.  Length must be a power of 2. */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cRe = 1, cIm = 0;
      for (let k = 0; k < (len >> 1); k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const half = i + k + (len >> 1);
        const vRe = cRe * re[half] - cIm * im[half];
        const vIm = cRe * im[half] + cIm * re[half];
        re[i + k] = uRe + vRe; im[i + k] = uIm + vIm;
        re[half]  = uRe - vRe; im[half]  = uIm - vIm;
        const nr = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe; cRe = nr;
      }
    }
  }
}

/**
 * computeJitter — shio.py-style jitter decomposition in TypeScript.
 * Ported VERBATIM from hsioalphaPlugin.tsx (legacy reference implementation).
 *
 * Pipeline (mirrors shio.py analyze()):
 *   1. TIE = edge_time − (t0 + round(Δt/UI) × UI)
 *   2. Linear detrend (removes frequency offset / slow drift)
 *   3. TJ rms / pk-pk from detrended TIE
 *   4. RJ σ via dual-Dirac Q-scale tail fitting (matches shio.py _dual_dirac)
 *   5. Histogram (64 bins, matches shio.py)
 *   6. PJ via Hann-windowed FFT → dominant spectral tone
 *   7. DCD from rising vs falling TIE means (before de-skewing)
 *   8. DDJ via N-bit history grouping (matches shio.py _estimate_ddj_history style)
 *   9. UJ @ BER=1e-6 via dual-Dirac: 2 × Q⁻¹(BER/2) × RJ + DJ
 *
 * @param rawSamples  optional raw waveform for bit-history DDJ computation
 * @param fsHz        optional sample rate (Hz) for bit-history DDJ computation
 * @param vth         optional voltage threshold for bit-history DDJ computation
 */
function computeJitter(
  edges:      number[],
  pols:       Int8Array | null,
  uiSec:      number,
  isClockSig: boolean,
  edgeRateHz: number,
  rawSamples?: number[],
  fsHz_opt?:   number,
  vth_opt?:    number,
  berTarget?:  number,
): {
  tieDisplayPs: number[]; tieResidualPs: number[];
  tieBinsPs: number[]; tieCounts: number[];
  tjRmsPs: number; tjPkpkPs: number; rjSigmaPs: number;
  pjPkpkPs: number; pjFreqMhz: number;
  dcdPs: number; ujPkpkPs: number; ddjPkpkPs: number;
  ddjProfileRunLengths: number[];
  ddjProfileRisingPs: number[];
  ddjProfileFallingPs: number[];
  bathtubXUi: number[]; bathtubLogBer: number[]; bathtubEmpLogBer: number[];
  bathtubDdMarginPctUi: number; bathtubEmpMarginPctUi: number;
  sscWanderTimeUs: number[]; sscWanderPs: number[]; sscSwingPpm: number;
} {
  const ber = berTarget ?? 1e-12;
  const EMPTY = {
    tieDisplayPs: [], tieResidualPs: [], tieBinsPs: [], tieCounts: [],
    tjRmsPs: 0, tjPkpkPs: 0, rjSigmaPs: 0,
    pjPkpkPs: 0, pjFreqMhz: 0, dcdPs: 0, ujPkpkPs: 0, ddjPkpkPs: 0,
    ddjProfileRunLengths: [] as number[],
    ddjProfileRisingPs:   [] as number[],
    ddjProfileFallingPs:  [] as number[],
    bathtubXUi: [] as number[], bathtubLogBer: [] as number[], bathtubEmpLogBer: [] as number[],
    bathtubDdMarginPctUi: 0, bathtubEmpMarginPctUi: 0,
    sscWanderTimeUs: [] as number[], sscWanderPs: [] as number[], sscSwingPpm: 0,
  };
  if (edges.length < 8) return EMPTY;

  // ── Step 1: TIE (seconds) — USE ROUND-HALF-EVEN to match numpy.round ────────
  // JavaScript's Math.round uses round-half-up: Math.round(0.5) = 1.
  // Python's numpy.round uses banker's rounding: np.round(0.5) = 0.
  // For edges near exactly ±0.5 UI the assignment can differ.
  // Implement round-half-to-even to exactly match shio.py's _compute_tie.
  const roundHalfEven = (x: number): number => {
    const fl = Math.floor(x), frac = x - fl;
    if (frac !== 0.5) return Math.round(x);
    return fl % 2 === 0 ? fl : fl + 1;   // round to even
  };
  const t0 = edges[0];
  const tieRaw = edges.map(t => {
    const nu = roundHalfEven((t - t0) / uiSec);
    return t - (t0 + nu * uiSec);
  });
  const n = tieRaw.length;

  // ── Step 2: Linear detrend ───────────────────────────────────────────────
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += tieRaw[i]; sxx += i*i; sxy += i*tieRaw[i]; }
  const det = n * sxx - sx * sx;
  const slope = det !== 0 ? (n * sxy - sx * sy) / det : 0;
  const inter = (sy - slope * sx) / n;
  const tie = tieRaw.map((v, i) => v - (slope * i + inter));

  // ── Step 3: DCD from raw (pre-correction) polarity split ─────────────────
  let dcdPs = 0;
  let rMeanRaw = 0, fMeanRaw = 0;
  if (!isClockSig && pols && pols.length === n) {
    let rSum = 0, fSum = 0, rN = 0, fN = 0;
    for (let i = 0; i < n; i++) {
      if (pols[i] > 0) { rSum += tie[i]; rN++; } else { fSum += tie[i]; fN++; }
    }
    rMeanRaw = rN > 0 ? rSum / rN : 0;
    fMeanRaw = fN > 0 ? fSum / fN : 0;
    if (rN > 0 && fN > 0) dcdPs = Math.abs(rMeanRaw - fMeanRaw) * 1e12;
  }

  // ── Step 4: Per-polarity de-skewing (shio.py lines 3608–3612) ────────────
  const tieCorrected = tie.slice();
  if (!isClockSig && pols && pols.length === n) {
    for (let i = 0; i < n; i++) {
      tieCorrected[i] -= (pols[i] > 0 ? rMeanRaw : fMeanRaw);
    }
  }

  // ── Step 5: TJ metrics ───────────────────────────────────────────────────
  let sumV = 0, sumV2 = 0, tMin = Infinity, tMax = -Infinity;
  for (const v of tieCorrected) {
    sumV += v; sumV2 += v * v;
    if (v < tMin) tMin = v; if (v > tMax) tMax = v;
  }
  const meanC  = sumV / n;
  const tjRmsPs  = Math.sqrt(Math.max(0, sumV2 / n - meanC * meanC)) * 1e12;
  const tjPkpkPs = (tMax - tMin) * 1e12;

  // ── Step 6: RJ via dual-Dirac Q-scale tail fitting ───────────────────────
  // Matches shio.py _dual_dirac exactly: sort TIE, assign plotting positions,
  // compute Q-scale values via normPpf, fit lines to left/right tails,
  // slope average = RJ sigma, intercept difference = DJ pk-pk.
  const { rjSigmaPs, djPkpkPs } = dualDiracFit(Array.from(tieCorrected));

  // ── Step 7: TIE histogram (64 bins, matches shio.py) ─────────────────────
  const tieCorPs = tieCorrected.map(v => v * 1e12);
  const hMin = tMin * 1e12, hMax = tMax * 1e12;
  const nBins = 64;
  const bw = Math.max(1e-9, (hMax - hMin) / nBins);
  const tieBinsPs = Array.from({ length: nBins }, (_, b) => hMin + (b + 0.5) * bw);
  const tieCounts = new Array<number>(nBins).fill(0);
  for (const v of tieCorPs) {
    tieCounts[Math.min(nBins - 1, Math.max(0, Math.floor((v - hMin) / bw)))]++;
  }

  // ── Step 8: Downsampled TIE for time-series display ──────────────────────
  const step = Math.max(1, Math.floor(n / 2000));
  const tieDisplayPs = tieCorPs.filter((_, i) => i % step === 0);

  // ── Step 9: PJ via Hann-windowed FFT — matching shio.py _extract_pj_tones ──
  // shio.py pipeline:
  //   1. Mean-subtract + Hann window the TIE
  //   2. rfft → one-sided amplitude with coherent-gain correction: amp = |FFT|*2/(N*cg)
  //   3. amp_pkpk = amp * 2*sqrt(2)  (legacy scaling, used throughout shio.py)
  //   4. Floor = median + 1.4826*MAD of spectrum * 10^(floor_db/20), with SNR gate
  // This replaces the previous under-normalized formula that was ~5.6x too small.
  let pjPkpkPs = 0, pjFreqMhz = 0, pjPhaseRad = 0;
  if (n >= 64 && edgeRateHz > 0) {
    let fftLen = 64;
    while (fftLen < Math.min(n, 4096)) fftLen <<= 1;
    const re = new Float64Array(fftLen);
    const im = new Float64Array(fftLen);

    // Compute mean for mean-subtraction (shio.py subtracts mean before windowing)
    let tieMean = 0;
    for (let i = 0; i < n; i++) tieMean += tieCorrected[i];
    tieMean /= n;

    // Hann window — compute coherent gain (mean of window)
    let cgSum = 0;
    for (let i = 0; i < fftLen; i++) {
      const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftLen - 1)));
      cgSum += w;
      re[i] = (i < n ? (tieCorrected[i] - tieMean) : 0) * w;
    }
    const cg = Math.max(cgSum / fftLen, 1e-15);  // ≈ 0.5 for Hann

    fftInPlace(re, im);

    // One-sided amplitude spectrum with coherent-gain correction
    // amp[k] = |FFT[k]| * 2 / (N * cg)  → physical sinusoidal amplitude
    const half = fftLen >> 1;

    // Noise floor estimate (median + 1.4826*MAD of spectrum, same as shio.py)
    const amps = new Float64Array(half - 3);
    for (let k = 3; k < half; k++) {
      amps[k - 3] = Math.sqrt(re[k]*re[k] + im[k]*im[k]) * 2.0 / (fftLen * cg);
    }
    const sortedAmps = amps.slice().sort();
    const nA = sortedAmps.length;
    const medA = nA % 2 ? sortedAmps[(nA-1)>>1] : 0.5*(sortedAmps[(nA>>1)-1]+sortedAmps[nA>>1]);
    const madAmps = new Float64Array(nA);
    for (let i = 0; i < nA; i++) madAmps[i] = Math.abs(sortedAmps[i] - medA);
    madAmps.sort();
    const madA = nA % 2 ? madAmps[(nA-1)>>1] : 0.5*(madAmps[(nA>>1)-1]+madAmps[nA>>1]);
    const floorDb = 10.0;  // matches shio.py default pj_floor_db=10.0
    const noiseFloor = Math.max(medA + 1.4826 * madA, 1e-30);
    const ampFloor = noiseFloor * Math.pow(10, floorDb / 20);

    let peakAmpS = 0, peakBin = 0;
    for (let k = 3; k < half; k++) {
      const ampS = amps[k - 3];
      // Require amplitude above noise floor AND SNR > 2dB (snr_db_min=8 in shio.py, but
      // we use the floor threshold as the primary gate to match default behaviour)
      if (ampS >= ampFloor && ampS >= 1.5 * noiseFloor && ampS > peakAmpS) {
        peakAmpS = ampS; peakBin = k;
      }
    }
    // Fallback: highest bin if nothing passes the floor
    if (peakBin === 0) {
      for (let k = 3; k < half; k++) {
        const ampS = amps[k - 3];
        if (ampS > peakAmpS) { peakAmpS = ampS; peakBin = k; }
      }
    }
    if (peakAmpS > 0 && peakBin > 0) {
      // shio.py: amp_pkpk_s = amp_s * 2 * sqrt(2)  (legacy scaling)
      pjPkpkPs = peakAmpS * 2.0 * Math.SQRT2 * 1e12;
      pjFreqMhz = (peakBin * edgeRateHz / fftLen) / 1e6;
      // Store phase for PJ synthesis (used to build residual TIE)
      pjPhaseRad = Math.atan2(im[peakBin], re[peakBin]);
    }
  }
  // pjPhaseRad is in scope because it was declared with let before the if-block

  // ── Step 10: DDJ profile ─────────────────────────────────────────────────
  // Primary path: N-bit history grouping (mirrors shio.py _estimate_ddj_history).
  //   1. Reconstruct bit sequence by interpolating raw samples at UI centres.
  //   2. For each edge, pack the preceding N bits into an integer state key.
  //   3. Group corrected TIE by state key; compute mean TIE per group.
  //   4. Result: up to 2^N bars, looks like a "continuous line" for PRBS.
  //
  // Fallback (no raw samples): run-length profile from inter-edge intervals.
  //
  const HIST_DEPTH = 8;   // 8-bit history → up to 256 states (same as shio.py default)
  const ddjProfileRunLengths: number[] = [];
  const ddjProfileRisingPs:   number[] = [];
  const ddjProfileFallingPs:  number[] = [];
  let ddjPkpkPs = 0;

  const doBitHistory = rawSamples && rawSamples.length > 0 && fsHz_opt && vth_opt !== undefined;
  if (doBitHistory) {
    const fs = fsHz_opt!;
    const vt = vth_opt!;
    const samps = rawSamples!;
    const nSamp = samps.length;
    const t0 = edges[0];
    // Number of complete UI windows in the capture
    const nUI = Math.floor(((nSamp / fs) - t0) / uiSec) - 1;

    if (nUI > HIST_DEPTH + 4) {
      // Step 1: bit sequence at UI centres
      const bits = new Uint8Array(nUI);
      for (let k = 0; k < nUI; k++) {
        const tCentre = t0 + (k + 0.5) * uiSec;
        const sIdx = tCentre * fs;
        const i0 = Math.max(0, Math.min(nSamp - 2, Math.floor(sIdx)));
        const frac = sIdx - i0;
        const val = samps[i0] * (1 - frac) + samps[i0 + 1] * frac;
        bits[k] = val >= vt ? 1 : 0;
      }

      // Step 2–3: for each edge, build history key and accumulate TIE
      const stateGroups = new Map<number, number[]>();
      for (let i = 0; i < n; i++) {
        const uiIdx = Math.round((edges[i] - t0) / uiSec);
        if (uiIdx < HIST_DEPTH || uiIdx >= nUI) continue;
        // Pack HIST_DEPTH bits into integer key (MSB = oldest bit)
        let key = 0;
        for (let d = 0; d < HIST_DEPTH; d++) {
          key = (key << 1) | bits[uiIdx - HIST_DEPTH + d];
        }
        if (!stateGroups.has(key)) stateGroups.set(key, []);
        stateGroups.get(key)!.push(tieCorPs[i]);
      }

      // Step 4: compute mean TIE per group, collect occupied states
      const minHits = 4;
      const sortedKeys = [...stateGroups.keys()].sort((a, b) => a - b);
      const allMeans: number[] = [];
      for (const key of sortedKeys) {
        const vals = stateGroups.get(key)!;
        if (vals.length < minHits) continue;
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        ddjProfileRunLengths.push(key);
        ddjProfileRisingPs.push(mean);
        ddjProfileFallingPs.push(NaN);  // not used in bit-history mode
        allMeans.push(mean);
      }
      if (allMeans.length > 1) {
        ddjPkpkPs = Math.max(...allMeans) - Math.min(...allMeans);
      }
    }
  }

  // Fallback: run-length profile from inter-edge intervals
  if (ddjProfileRunLengths.length === 0) {
    const MAX_RL = 32;
    const rlR = Array.from({length: MAX_RL + 1}, () => ({sum: 0, cnt: 0}));
    const rlF = Array.from({length: MAX_RL + 1}, () => ({sum: 0, cnt: 0}));
    for (let i = 1; i < n; i++) {
      const rl = Math.min(MAX_RL, Math.max(1, Math.round((edges[i] - edges[i-1]) / uiSec)));
      const ps = tieCorPs[i];
      if (pols && pols.length > i && pols[i] > 0) { rlR[rl].sum += ps; rlR[rl].cnt++; }
      else                                          { rlF[rl].sum += ps; rlF[rl].cnt++; }
    }
    for (let rl = 1; rl <= MAX_RL; rl++) {
      if (rlR[rl].cnt >= 2 || rlF[rl].cnt >= 2) {
        ddjProfileRunLengths.push(rl);
        ddjProfileRisingPs.push(rlR[rl].cnt >= 2 ? rlR[rl].sum / rlR[rl].cnt : NaN);
        ddjProfileFallingPs.push(rlF[rl].cnt >= 2 ? rlF[rl].sum / rlF[rl].cnt : NaN);
      }
    }
    const allMeans = [...ddjProfileRisingPs.filter(isFinite), ...ddjProfileFallingPs.filter(isFinite)];
    ddjPkpkPs = allMeans.length > 1 ? Math.max(...allMeans) - Math.min(...allMeans) : 0;
  }

  // ── Step 11: UJ @ BER=1e-6 ───────────────────────────────────────────────
  const ujBer = 1e-6;
  const qInv = normPpf(1.0 - ujBer / 2.0);  // ≈ 4.753
  const ujPkpkPs = 2.0 * qInv * (rjSigmaPs / 1e12) * 1e12 + djPkpkPs;

  // ── Step 12: Residual TIE = tieCorrected - PJ_synthesised ────────────────
  // mirrors shio.py:  tie_residual = tie_model - pj_component
  // The PJ component is a sine wave at the detected frequency and phase.
  // amp_peak = amp_pkpk / 2 (half of the peak-to-peak, shio.py convention).
  const tieResidual = tieCorrected.slice();
  if (pjPkpkPs > 0 && pjFreqMhz > 0) {
    const pjFreqHz  = pjFreqMhz * 1e6;
    const pjAmpPeak = (pjPkpkPs / 1e12) / 2.0;  // seconds
    for (let i = 0; i < n; i++) {
      tieResidual[i] -= pjAmpPeak * Math.sin(2 * Math.PI * pjFreqHz * i * uiSec + pjPhaseRad);
    }
  }
  const tieResidualPs = tieResidual.map(v => v * 1e12).filter((_, i) => i % Math.max(1, Math.floor(n / 2000)) === 0);

  // ── Step 13: Bathtub curve (Dual-Dirac + Empirical) ───────────────────────
  // shio.py _build_bathtub / _build_bathtub_empirical (lines 3114–3171).
  const N_BATH   = 500;
  const halfUiSec = uiSec / 2.0;
  const rjSec    = Math.max(rjSigmaPs / 1e12, uiSec * 0.001);  // rj_eff
  const halfDj   = Math.min(djPkpkPs / 2e12, halfUiSec * 0.9);

  const bathtubXUi:      number[] = [];
  const bathtubLogBer:   number[] = [];
  const bathtubEmpLogBer: number[] = [];
  const tieUiArr = tieCorrected.map(v => v / uiSec);  // TIE in UI units

  let ddMarginUi = 0, empMarginUi = 0;
  for (let i = 0; i < N_BATH; i++) {
    const xUi  = -0.5 + i / (N_BATH - 1);
    bathtubXUi.push(xUi);

    // Dual-Dirac: Q((half_ui - |x*ui| - half_dj) / rj)
    const margin = halfUiSec - Math.abs(xUi * uiSec) - halfDj;
    const ddBer  = Math.max(1e-40, qFunc(margin / rjSec));
    bathtubLogBer.push(Math.log10(ddBer));
    if (i >= N_BATH / 2 && ddBer < ber) ddMarginUi = xUi;

    // Empirical: fraction of edges with |TIE_ui| > (0.5 - |x|)
    const thr = 0.5 - Math.abs(xUi);
    let empBer: number;
    if (thr <= 0) {
      empBer = 1.0;
    } else {
      let above = 0;
      for (const tv of tieUiArr) if (tv > thr || tv < -thr) above++;
      empBer = Math.max(1e-40, above / Math.max(tieUiArr.length, 1));
    }
    bathtubEmpLogBer.push(Math.log10(empBer));
    if (i >= N_BATH / 2 && empBer < ber) empMarginUi = xUi;
  }
  const bathtubDdMarginPctUi  = ddMarginUi  * 100;
  const bathtubEmpMarginPctUi = empMarginUi * 100;

  // ── Step 14: SSC / Wander profile via box-filter LPF ─────────────────────
  // Box filter with span ≈ 2% of total edges extracts the slow wander component.
  // Converts to PPM: (wander_ps / uiSec_ps) * 1e6.
  const wSpan = Math.max(5, Math.round(n * 0.02));
  const halfSpan = Math.floor(wSpan / 2);
  const sscWanderTimeUs: number[] = [];
  const sscWanderPs:     number[] = [];
  let   wSum = 0;
  // Prime the window
  for (let i = 0; i < Math.min(wSpan, n); i++) wSum += tieCorrected[i];
  const wanderRaw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = i - halfSpan, hi = i + halfSpan;
    if (lo >= 0 && hi < n) {
      if (i === 0) { let s = 0; for (let j = 0; j <= 2*halfSpan && j < n; j++) s += tieCorrected[j]; wSum = s; }
      else { if (lo - 1 >= 0) wSum -= tieCorrected[lo - 1]; if (hi < n) wSum += tieCorrected[hi]; }
    }
    const cnt = Math.min(hi + 1, n) - Math.max(lo, 0);
    wanderRaw[i] = wSum / Math.max(cnt, 1);
  }
  const wStep = Math.max(1, Math.floor(n / 2000));
  const uiSecPs = uiSec * 1e12;
  let wMin = Infinity, wMax = -Infinity;
  for (let i = 0; i < n; i += wStep) {
    const tUs = (i * uiSec) * 1e6;
    const wPs = wanderRaw[i] * 1e12;
    sscWanderTimeUs.push(tUs);
    sscWanderPs.push(wPs);
    if (wPs < wMin) wMin = wPs; if (wPs > wMax) wMax = wPs;
  }
  const sscSwingPpm = uiSecPs > 0 ? ((wMax - wMin) / uiSecPs) * 1e6 : 0;

  return {
    tieDisplayPs, tieResidualPs, tieBinsPs, tieCounts,
    tjRmsPs, tjPkpkPs, rjSigmaPs,
    pjPkpkPs, pjFreqMhz, dcdPs, ujPkpkPs, ddjPkpkPs,
    ddjProfileRunLengths, ddjProfileRisingPs, ddjProfileFallingPs,
    bathtubXUi, bathtubLogBer, bathtubEmpLogBer,
    bathtubDdMarginPctUi, bathtubEmpMarginPctUi,
    sscWanderTimeUs, sscWanderPs, sscSwingPpm,
  };
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

  // extractEdgesWithPolarity is numerically identical to extractEdges (same
  // threshold-crossing / linear-interpolation arithmetic) but additionally
  // returns per-edge polarity, needed by computeJitter for DCD/DDJ.
  const { times: edges, pols: edgePols } = extractEdgesWithPolarity(samples, fsHz, vth, signalType === 'clock');
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

  // ── Jitter decomposition (TIE → RJ/PJ/DDJ/DCD/UJ), bathtub, SSC/wander ──
  // Additive feature — must never break the existing eye-diagram outputs
  // above. Any failure here is caught and the jitter fields are simply
  // omitted from the returned figureData (status note via jitterStatus).
  let jitterFields: Partial<hsioFigureData> = {};
  try {
    // Edge rate for PJ FFT frequency axis = 1/uiSec (bit rate), reusing OUR
    // already-computed capturedRateGbps (median-based CDR) — NOT the
    // reference file's own percentile-based CDR calculation.
    const edgeRateHz = capturedRateGbps * 1e9;
    const berTargetNum = parseFloat(String(params.berTarget ?? '1e-12')) || 1e-12;
    const jitter = computeJitter(edges, edgePols, uiSec, signalType === 'clock', edgeRateHz, samples, fsHz, vth, berTargetNum);
    jitterFields = {
      tieDisplayPs: jitter.tieDisplayPs,
      tieResidualPs: jitter.tieResidualPs,
      tieBinsPs: jitter.tieBinsPs,
      tieCounts: jitter.tieCounts,
      tjRmsPs: jitter.tjRmsPs,
      tjPkpkPs: jitter.tjPkpkPs,
      rjSigmaPs: jitter.rjSigmaPs,
      pjPkpkPs: jitter.pjPkpkPs,
      pjFreqMhz: jitter.pjFreqMhz,
      dcdPs: jitter.dcdPs,
      ujPkpkPs: jitter.ujPkpkPs,
      ddjPkpkPs: jitter.ddjPkpkPs,
      ddjProfileRunLengths: jitter.ddjProfileRunLengths,
      ddjProfileRisingPs: jitter.ddjProfileRisingPs,
      ddjProfileFallingPs: jitter.ddjProfileFallingPs,
      nEdgesJitter: edges.length,
      bathtubXUi: jitter.bathtubXUi,
      bathtubLogBer: jitter.bathtubLogBer,
      bathtubEmpLogBer: jitter.bathtubEmpLogBer,
      bathtubBerTarget: berTargetNum,
      bathtubDdMarginPctUi: jitter.bathtubDdMarginPctUi,
      bathtubEmpMarginPctUi: jitter.bathtubEmpMarginPctUi,
      sscWanderTimeUs: jitter.sscWanderTimeUs,
      sscWanderPs: jitter.sscWanderPs,
      sscSwingPpm: jitter.sscSwingPpm,
      jitterStatus: 'ok',
    };
  } catch (err) {
    jitterFields = { jitterStatus: `jitter computation failed: ${err instanceof Error ? err.message : String(err)}` };
  }

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
    ...jitterFields,
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

/**
 * Portable (renderer-agnostic) description of the eye diagram, consumed by
 * figureRenderSvg.mjs via the generic `heatmap` primitive (see
 * pluginTypes.ts) — no HSIO-specific concepts leak into the renderer; it
 * only ever sees a 2D grid + extent + reference lines/results panel.
 */
function getHsioEyeFigureData(data: hsioFigureData): PortableFigureDescription {
  return {
    figure: 'eye',
    title: `Eye Diagram — H=${(data.eyeHeightV * 1e3).toFixed(1)}mV  W=${data.eyeWidthPctUi.toFixed(1)}%UI`,
    x: { label: 'Phase (UI)', data: [data.eyeExtent[0], data.eyeExtent[1]] },
    series: [],
    y: { label: 'Voltage (V)' },
    legend: { enabled: false },
    grid: { x: false, y: false },
    referenceLines: [
      { axis: 'x', value: 0 },
      { axis: 'x', value: 1 },
      { axis: 'x', value: 0.5, label: 'center' },
    ],
    heatmap: {
      grid: data.eyeGridLog,
      width: data.eyeGridW,
      height: data.eyeGridH,
      extent: data.eyeExtent,
    },
    resultsPanel: [
      { label: 'EYE HEIGHT', value: `${(data.eyeHeightV * 1e3).toFixed(1)} mV` },
      { label: 'EYE WIDTH', value: `${data.eyeWidthPctUi.toFixed(1)} %UI` },
      { label: 'UI', value: `${(data.uiSec * 1e12).toFixed(2)} ps` },
      { label: 'SAMPLE RATE', value: `${(data.fsHz / 1e9).toFixed(4)} GHz` },
      { label: 'FILE', value: data.fileName },
    ],
  };
}

/**
 * getHsioJitterFigureData — portable description of the jitter-decomposition
 * figure.
 *
 * KNOWN VISUAL-FIDELITY TRADE-OFF: the legacy reference implementation
 * (hsioalphaPlugin.tsx's JitterFigure) renders a 3-panel SVG layout (TIE
 * histogram / TIE time-series with residual overlay / DDJ bar profile).
 * PortableFigureDescription currently only supports a single line/dashed-line
 * `series` set over one shared `x.data` array — there is no multi-panel/
 * subplot primitive and no bar-chart series type. Rather than shoehorning
 * three semantically distinct panels into one axis (which would be
 * misleading), this adapter renders ONLY the TIE histogram as the plotted
 * series, and surfaces the scalar jitter metrics via `resultsPanel`. The full
 * TIE time-series (+ residual) and DDJ profile are preserved losslessly via
 * the `jitter_tie_series` / `jitter_ddj_profile` debug tables instead of a
 * second/third visual panel here. If a genuine multi-panel/subplot (and/or
 * bar-series) primitive is ever added to PortableFigureDescription, this
 * adapter should be revisited to restore full 3-panel visual parity.
 */
function getHsioJitterFigureData(data: hsioFigureData): PortableFigureDescription | undefined {
  if (data.jitterStatus !== 'ok' || !data.tieBinsPs || data.tieBinsPs.length === 0) return undefined;
  return {
    figure: 'jitter',
    title: `Jitter Decomposition — TJrms=${(data.tjRmsPs ?? 0).toFixed(2)}ps  TJpk-pk=${(data.tjPkpkPs ?? 0).toFixed(2)}ps`,
    x: { label: 'TIE (ps)', data: data.tieBinsPs },
    series: [
      { name: 'TIE histogram', y: (data.tieCounts ?? []).map((v) => (Number.isFinite(v) ? v : null)) },
    ],
    y: { label: 'Count' },
    legend: { enabled: false },
    grid: { x: true, y: true },
    referenceLines: [{ axis: 'y', value: 0 }],
    resultsPanel: [
      { label: 'TJ RMS', value: `${(data.tjRmsPs ?? 0).toFixed(2)} ps` },
      { label: 'TJ PK-PK', value: `${(data.tjPkpkPs ?? 0).toFixed(2)} ps` },
      { label: 'RJ SIGMA', value: `${(data.rjSigmaPs ?? 0).toFixed(2)} ps` },
      { label: 'PJ PK-PK', value: `${(data.pjPkpkPs ?? 0).toFixed(2)} ps` },
      { label: 'PJ FREQ', value: `${(data.pjFreqMhz ?? 0).toFixed(4)} MHz` },
      { label: 'DCD', value: `${(data.dcdPs ?? 0).toFixed(2)} ps` },
      { label: 'DDJ PK-PK', value: `${(data.ddjPkpkPs ?? 0).toFixed(2)} ps` },
      { label: 'UJ @ BER=1e-6', value: `${(data.ujPkpkPs ?? 0).toFixed(2)} ps` },
      { label: 'N EDGES', value: `${data.nEdgesJitter ?? 0}` },
    ],
  };
}

/**
 * getHsioBathtubFigureData — portable description of the bathtub-curve
 * figure. Fits the existing PortableFigureDescription schema fully (single
 * shared x-axis, two line series, reference lines, results panel) — no
 * compromises needed here.
 */
function getHsioBathtubFigureData(data: hsioFigureData): PortableFigureDescription | undefined {
  if (data.jitterStatus !== 'ok' || !data.bathtubXUi || data.bathtubXUi.length === 0) return undefined;
  const berTarget = data.bathtubBerTarget ?? 1e-12;
  const logBerTarget = Math.log10(berTarget);
  const referenceLines: NonNullable<PortableFigureDescription['referenceLines']> = [
    { axis: 'y', value: logBerTarget, label: `BER=${berTarget.toExponential(0)}` },
  ];
  if (data.bathtubDdMarginPctUi) {
    referenceLines.push({ axis: 'x', value: data.bathtubDdMarginPctUi / 100, label: 'DD margin' });
  }
  if (data.bathtubEmpMarginPctUi) {
    referenceLines.push({ axis: 'x', value: data.bathtubEmpMarginPctUi / 100, label: 'Emp margin' });
  }
  return {
    figure: 'bathtub',
    title: `Bathtub Curve — BER target=${berTarget.toExponential(0)}`,
    x: { label: 'UI', data: data.bathtubXUi },
    series: [
      { name: 'Dual-Dirac log10(BER)', y: (data.bathtubLogBer ?? []).map((v) => (Number.isFinite(v) ? v : null)), style: 'solid' },
      { name: 'Empirical log10(BER)', y: (data.bathtubEmpLogBer ?? []).map((v) => (Number.isFinite(v) ? v : null)), style: 'dashed' },
    ],
    y: { label: 'log10(BER)' },
    legend: { enabled: true },
    grid: { x: true, y: true },
    referenceLines,
    resultsPanel: [
      { label: 'BER TARGET', value: berTarget.toExponential(2) },
      { label: 'DD MARGIN', value: `${(data.bathtubDdMarginPctUi ?? 0).toFixed(2)} %UI` },
      { label: 'EMPIRICAL MARGIN', value: `${(data.bathtubEmpMarginPctUi ?? 0).toFixed(2)} %UI` },
    ],
  };
}

/**
 * getHsioSscFigureData — portable description of the SSC/wander-profile
 * figure. Fits the existing PortableFigureDescription schema fully.
 */
function getHsioSscFigureData(data: hsioFigureData): PortableFigureDescription | undefined {
  if (data.jitterStatus !== 'ok' || !data.sscWanderTimeUs || data.sscWanderTimeUs.length === 0) return undefined;
  return {
    figure: 'ssc',
    title: `SSC / Wander Profile — swing=${(data.sscSwingPpm ?? 0).toFixed(2)} ppm`,
    x: { label: 'Time (us)', data: data.sscWanderTimeUs },
    series: [
      { name: 'Wander (ps)', y: (data.sscWanderPs ?? []).map((v) => (Number.isFinite(v) ? v : null)) },
    ],
    y: { label: 'Wander (ps)' },
    legend: { enabled: false },
    grid: { x: true, y: true },
    resultsPanel: [
      { label: 'SSC SWING', value: `${(data.sscSwingPpm ?? 0).toFixed(2)} ppm` },
    ],
  };
}

const figures: PluginFigure[] = [
  { id: 'eye', label: 'Eye Diagram', draw: drawEyeDiagram, getData: (data) => getHsioEyeFigureData(data as hsioFigureData) },
  {
    id: 'jitter',
    label: 'Jitter Decomposition',
    getData: (data) => getHsioJitterFigureData(data as hsioFigureData),
  },
  {
    id: 'bathtub',
    label: 'Bathtub Curve',
    getData: (data) => getHsioBathtubFigureData(data as hsioFigureData),
  },
  {
    id: 'ssc',
    label: 'SSC Profile',
    getData: (data) => getHsioSscFigureData(data as hsioFigureData),
  },
];

/** Shared core: sample extraction + minimum-length validation, identical
 * for run() and prepareData() — mirrors sinlPlugin's _sinlPrepareCore
 * pattern (single source of truth for the packet -> samples boundary). */
function samplesFromPacket(packet: WaveformPacket): number[] {
  const samples = Array.from(packet.waveform as ArrayLike<number>);
  if (samples.length < 200) {
    throw new Error(`Too few valid samples (${samples.length}). Need at least 200.`);
  }
  return samples;
}

export const hsioPlugin: Plugin<hsioParams> = {
  id: 'hsio',
  name: 'hsio — HSIO Eye Diagram',
  description: manifest.description,
  manifest,
  paramFields,
  defaultParams,
  getIngestHints: (params: hsioParams) => hsioIngestHints(params),
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
  run: async (packet: WaveformPacket, params: hsioParams): Promise<Record<string, string | number>> => {
    // packet is already IR — no file handling, no ingestion, no CSV parsing.
    const samples = samplesFromPacket(packet);
    const fileName = packet.metadata.sourceFile ?? 'waveform';
    const r = await analyzehsio(samples, params, fileName);
    return {
      filename: fileName,
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
  prepareData: async (
    packet: WaveformPacket,
    params: hsioParams,
  ): Promise<{ figureData: hsioFigureData; debugTables: PluginDebugTable[] }> => {
    const samples = samplesFromPacket(packet);
    const fileName = packet.metadata.sourceFile ?? 'waveform';

    const figureData = await analyzehsio(samples, params, fileName);
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

    // Jitter/bathtub/SSC debug tables — only added when jitter computation
    // succeeded (analyzehsio() catches jitter-computation errors internally
    // and simply omits these fields; the eye-diagram table above is always
    // produced regardless).
    if (figureData.jitterStatus === 'ok') {
      debugTables.push(
        {
          id: 'jitter_metrics',
          label: 'Jitter metrics',
          columns: {
            key: ['tj_rms_ps', 'tj_pkpk_ps', 'rj_sigma_ps', 'pj_pkpk_ps', 'pj_freq_mhz', 'dcd_ps', 'ddj_pkpk_ps', 'uj_pkpk_ps', 'n_edges'],
            value: [
              Number((figureData.tjRmsPs ?? 0).toFixed(4)),
              Number((figureData.tjPkpkPs ?? 0).toFixed(4)),
              Number((figureData.rjSigmaPs ?? 0).toFixed(4)),
              Number((figureData.pjPkpkPs ?? 0).toFixed(4)),
              Number((figureData.pjFreqMhz ?? 0).toFixed(6)),
              Number((figureData.dcdPs ?? 0).toFixed(4)),
              Number((figureData.ddjPkpkPs ?? 0).toFixed(4)),
              Number((figureData.ujPkpkPs ?? 0).toFixed(4)),
              figureData.nEdgesJitter ?? 0,
            ],
          },
        },
        {
          id: 'jitter_tie_histogram',
          label: 'TIE histogram',
          columns: {
            tie_bin_ps: (figureData.tieBinsPs ?? []).map((v) => Number(v.toFixed(4))),
            count: figureData.tieCounts ?? [],
          },
        },
        {
          id: 'jitter_tie_series',
          label: 'TIE time series',
          columns: {
            tie_ps: (figureData.tieDisplayPs ?? []).map((v) => Number(v.toFixed(4))),
            tie_residual_ps: (figureData.tieResidualPs ?? []).map((v) => Number(v.toFixed(4))),
          },
        },
        {
          id: 'jitter_ddj_profile',
          label: 'DDJ profile',
          columns: {
            state_or_run_length: figureData.ddjProfileRunLengths ?? [],
            tie_rising_ps: (figureData.ddjProfileRisingPs ?? []).map((v) => (Number.isFinite(v) ? Number(v.toFixed(4)) : null)),
            tie_falling_ps: (figureData.ddjProfileFallingPs ?? []).map((v) => (Number.isFinite(v) ? Number(v.toFixed(4)) : null)),
          },
        },
        {
          id: 'bathtub_curve',
          label: 'Bathtub curve',
          columns: {
            x_ui: (figureData.bathtubXUi ?? []).map((v) => Number(v.toFixed(6))),
            dd_log_ber: (figureData.bathtubLogBer ?? []).map((v) => Number(v.toFixed(4))),
            emp_log_ber: (figureData.bathtubEmpLogBer ?? []).map((v) => Number(v.toFixed(4))),
          },
        },
        {
          id: 'ssc_wander',
          label: 'SSC / wander',
          columns: {
            time_us: (figureData.sscWanderTimeUs ?? []).map((v) => Number(v.toFixed(4))),
            wander_ps: (figureData.sscWanderPs ?? []).map((v) => Number(v.toFixed(4))),
          },
        },
      );
    }
    return { figureData, debugTables };
  },
  figures,
};
