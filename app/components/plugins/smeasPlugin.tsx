/**
 * app/components/plugins/smeasPlugin.tsx — SMEAS (Spectrum Measurement) for sine analysis
 *
 * Analyzes single-tone sine waves via FFT, computes SNR, SNDR, ENOB, THD, SFDR.
 * Supports time_domain_codes and time_domain_volts input.
 * v1: Single-tone only, int_number_of_cores=1 (no TI spurs), rectangular windowing + options.
 */

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

import { type Plugin, type PluginManifest, type PluginFigure, type InferredParamField } from '../../lib/pluginTypes';
import smeasDoc from './smeasPlugin.doc';
import { ingestFile } from '../../lib/ingest';
import { useState, useMemo, useRef, useEffect } from 'react';
import FFT from 'fft.js';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ReferenceArea, ResponsiveContainer, Legend,
} from 'recharts';

export interface SmeasParams {
  targetColumn: string;   // CSV column containing signal data - declared in paramFields
  fsGhzColumnRegex?: string;
  fsGhzRegex?: string;
  fsGhzReplace?: string;
  fsGhz?: number | string;
  toneMode?: string;                           // inferred per-file via inferredParamFields
  sfdrLeakageAvoidanceRadiusMhz?: number | string; // inferred per-file via inferredParamFields
  inputMode: 'time_domain_codes' | 'time_domain_volts' | 'single_sided_power_spectrum';
  fftLength: number;
  numAveraging: number;
  adcNumBits: number;
  adcOffsetCode: number;
  vfsPeakToPeak: number;
  window: 'auto' | 'rectangular' | 'hann' | 'hamming' | 'blackman' | 'blackmanharris' | 'flattop' | 'kaiser';
  kaiserBeta: number;   // Kaiser window shape parameter β (default 8). Only used when window='kaiser'.
  winCoherentGain: number;  // Override coherent gain (sum(w)/N)². -1 = use IEEE table default for selected window.
  winEnbw: number;          // Override equivalent noise bandwidth (bins). -1 = use IEEE table default.
  winNHalfBins: number;     // Override lobe integration half-width (bins each side). -1 = use IEEE table default.
  harmonicsToConsider: number;
  numberOfCores: number;
  spursMinThresholdEn: boolean;   // enable spur minimum threshold (default true)
  spursMinCalcFactor: number;     // histogram σ multiplier (default 1.0)
  spursMinDbfs: number;           // manual override threshold; 0 = use histogram auto-calc
  // ── TI mismatch correction ────────────────────────────────────────────────
  tiCorrections: string;            // ordered enabled corrections e.g. 'O,G,P' or 'O,G' or ''
  tiRefPhase: number;               // reference phase index (0-based); all others align to this
  tiOffsetQuantLsb: number;         // offset correction quantization step in LSBs (default 0.25)
  // tiGainQuantBits inherits adcNumBits — no separate param needed
  // legacy fields kept for backward compat — derived from tiCorrections at runtime
  tiCorrectOffset?: boolean;
  tiCorrectGain?: boolean;
  tiCorrectPhase?: boolean;
  tiCorrectionOrder?: string;
}

export interface SmeasFigureData {
  results: any;
  singulars: any;
  fileName: string;
  fftLength: number;
  fsHz: number;
  sfdrLeakageAvoidanceRadiusMhz?: number;
  numberOfCores?: number;
  toneMode?: string;
  spursMinDbfs?: number;
  spursMinActive?: boolean;
  /** Set when fftLength was auto-snapped down due to insufficient samples. */
  warning?: string;
  // ── [EXPERIMENTAL] params needed for live sfdr-radius re-analysis in figure ──
  _liveAnalysisParams?: {
    harmonicsToConsider: number;
    spursMinThresholdEn: boolean;
    spursMinCalcFactor: number;
    spursMinDbfsOverride: number;
  };
}

const manifest: PluginManifest = {
  id: 'smeas',
  name: 'SMEAS — Sine Spectrum Analysis',
  description: 'FFT-based sine analysis: SNR, SNDR, ENOB, THD, SFDR. Supports windowing (Hann, Hamming, Blackman, etc.), dual-tone, and TI de-embedding.',
  version: '1.0.0',
  author: 'Guy Steiff',
  authorEmail: 'guy.steiff-smeassupport@bytz.me',
  github: '',
  linkedin: 'https://www.linkedin.com/in/guysteiff/',
  website: '',
  pythonModule: 'smeas_tool',
  pythonFunction: 'run_smeas',
  reportTitle: 'Sine Spectrum Analysis (FFT)',
  category: 'signal',
   paramSchema: [
     {
       key: 'targetColumn',
       label: 'Sample Column',
       type: 'column-select',
       required: true,
       description: 'Column containing ADC codes or voltages.',
     },
     {
       key: 'fsGhzColumnRegex',
       label: 'Sampling Frequency Column Pattern (Regex)',
       type: 'text',
       required: false,
       description: 'Optional regex to match sampling frequency column name (e.g., "fs.*ghz|freq.*mhz"). Pattern is applied case-insensitively to column headers.',
     },
     {
       key: 'inputMode',
       label: 'Input Mode',
       type: 'text',
       required: false,
       description: '"time_domain_codes" (default) or "time_domain_volts".',
     },
      {
        key: 'fftLength',
        label: 'FFT/DFT Length',
        type: 'number',
        required: true,
        description: 'Number of samples per transform. Power-of-2 values use fast FFT; any other integer falls back to slower O(N²) DFT — a warning is shown in the plot.',
      },
     {
       key: 'numAveraging',
       label: 'Number of Averages',
       type: 'number',
       required: false,
       description: 'Default 1. Total samples = fftLength × numAveraging.',
     },
     {
       key: 'harmonicsToConsider',
       label: 'Harmonics (H2…Hk)',
       type: 'number',
       required: false,
       description: 'Number of harmonics H2…Hk to detect and subtract from noise floor.',
     },
     {
       key: 'adcNumBits',
       label: 'ADC Bits',
       type: 'number',
       required: false,
       description: 'ADC resolution in bits — used for codes↔volts conversion.',
     },
     {
       key: 'adcOffsetCode',
       label: 'ADC Offset Code / Volt',
       type: 'number',
       required: false,
       description: 'Mid-scale offset code. Default 1023 = mid-scale for 11-bit (2^10 − 1).',
     },
     {
       key: 'vfsPeakToPeak',
       label: 'Full-Scale Vpp',
       type: 'number',
       required: true,
       description: 'Full-scale peak-to-peak voltage. Used for noise and power calculations.',
     },
      {
        key: 'window',
        label: 'Window Function',
        type: 'text',
        required: false,
        description: '"rectangular" (default), "hann", "hamming", "blackman", "blackmanharris", "flattop", "kaiser". Use "kaiser" with kaiserBeta for tunable sidelobe control (β=8 per IEEE 1241).',
      },
     {
       key: 'sfdrLeakageAvoidanceRadiusMhz',
       label: 'SFDR Avoidance Radius',
       type: 'number',
       required: false,
       description: 'Frequency radius around the fundamental to exclude when searching for the SFDR spur.',
     },
     {
       key: 'numberOfCores',
       label: 'TI ADC Cores (1 - for disabling TI detections)',
       type: 'number',
       required: false,
       description: 'Number of time-interleaved ADC cores. Set to 1 for non-TI ADCs. Higher values enable TI spur identification and de-embedding.',
     },
     {
       key: 'spursMinThresholdEn',
       label: 'Enable Spur Min. Threshold',
       type: 'boolean',
       required: false,
       description: 'Enable minimum threshold for spur detection (default true).',
     },
     {
       key: 'spursMinCalcFactor',
       label: 'Spur Min. Calc. Factor',
       type: 'number',
       required: false,
       description: 'Histogram σ multiplier for spur min. threshold (default 1.0).',
     },
     {
       key: 'spursMinDbfs',
       label: 'Spur Min. Threshold (dBFS)',
       type: 'number',
       required: false,
       description: 'Manual override for spur min. threshold; 0 = use histogram auto-calc.',
     },
   ],
};

// isPowerOf2 removed — FFT length now auto-snaps to nearest power of 2 in the UI

// deriveAdcOffset is not used but kept as reference for future use
// function deriveAdcOffset(bits: number): number {
//   return Math.pow(2, bits - 1);
// }

/**
 * Normalise the user-supplied fsGhz param value → Hz.
 *
 * Accepts:
 *   • Plain GHz number:   2.25, 1, 0.5
 *   • Scientific in GHz:  2.25e0, 2.25e-0   (< 1e4 → treat as GHz)
 *   • Scientific in Hz:   2.25e9, 1e9        (≥ 1e6 → treat as Hz directly)
 *   • Large integers:     2250 (MHz range) → treated as MHz → Hz
 *   • Empty / NaN → 0
 */
/**
 * Parse an fftLength value that may be:
 *   • A plain number:        8192, 65536
 *   • A power-of-2 expr:     "2^16", "2**16", "2^13"
 *   • A numeric string:      "8192"
 * Returns the parsed integer, or NaN if unparseable.
 */
function parseFftLength(value: unknown): number {
  if (value === undefined || value === null || value === '') return NaN;
  const s = String(value).trim().replace(/\s/g, '');
  // Try "2^N" or "2**N"
  const powMatch = s.match(/^2\^(\d+)$/) ?? s.match(/^2\*\*(\d+)$/);
  if (powMatch) return Math.pow(2, parseInt(powMatch[1], 10));
  return Number(s);
}

function normaliseFsToHz(fsGhz: number | string | undefined): number {
  if (fsGhz === undefined || fsGhz === '') return 0;
  const v = Number(fsGhz);
  if (isNaN(v) || v <= 0) return 0;
  // If the value is already in Hz range (≥ 1 MHz), pass through directly
  if (v >= 1e6) return v;
  // If the value looks like MHz (100..9999), convert MHz→Hz
  if (v >= 100) return v * 1e6;
  // Otherwise treat as GHz
  return v * 1e9;
}

/**
 * smeasIngestHints — translate SmeasParams into IngestHints for the ingestion layer.
 * This is the ONE place smeas tells the ingestion layer what it needs.
 * Plugins never read files themselves — that's ingest's job.
 */
function smeasIngestHints(params: SmeasParams): import('../../lib/ingest').IngestHints {
  const fsHzOverride = normaliseFsToHz(params.fsGhz) || undefined;

  return {
    signalColumn:       params.targetColumn?.trim() || undefined,
    fsGhzColumnRegex:   params.fsGhzColumnRegex?.trim() || undefined,    sampleRateHz:       fsHzOverride,
    preserveBinIndex:   params.inputMode === 'single_sided_power_spectrum',
  };
}

/**
 * Resolve sampling frequency (Hz) for a WaveformPacket, falling back to params.
 * Throws if no source is available.
 */
function resolveFsHz(packet: import('../../lib/ingest').WaveformPacket, params: SmeasParams): number {
  if (packet.metadata.sampleRateHz > 0) return packet.metadata.sampleRateHz;
  const fromParam = normaliseFsToHz(params.fsGhz);
  if (fromParam > 0) return fromParam;
  throw new Error(
    'No sampling frequency available. Set fs in the plugin params or embed it in the file name / a CSV column.'
  );
}

/**
 * Auto-seed smeas params from WaveformPacket metadata.
 * Called before _smeasRunCore when using the runFromWaveform path.
 *
 * Rules (user params ALWAYS win — only fill in when the user left the default):
 *  • If metadata.units === 'volts' and params.inputMode is still the default
 *    'time_domain_codes' → switch to 'time_domain_volts'.
 *  • If metadata.vfsPeakToPeak is set and params.vfsPeakToPeak is still the
 *    built-in default 2.0V → use the computed value from ingest.
 */
function smeasAutoSeedFromPacket(
  params: SmeasParams,
  packet: import('../../lib/ingest').WaveformPacket,
): SmeasParams {
  const meta = packet.metadata as import('../../lib/ingest').WaveformMetadata & { vfsPeakToPeak?: number };
  console.log('[smeas autoSeed] units:', meta.units, 'inputMode:', params.inputMode,
    'vfsPeakToPeak meta:', meta.vfsPeakToPeak, 'params:', params.vfsPeakToPeak,
    'sampleRateHz:', meta.sampleRateHz, 'numSamples:', meta.numSamples);
  let updated = { ...params };

  // Auto-detect volt input mode from oscilloscope captures
  if (meta.units === 'volts' && params.inputMode === 'time_domain_codes') {
    console.log('[smeas autoSeed] → switching to time_domain_volts');
    updated = { ...updated, inputMode: 'time_domain_volts' };
  }

  // Auto-seed vfsPeakToPeak from the ingest-computed range (only if still at default 2.0)
  if (meta.vfsPeakToPeak && meta.vfsPeakToPeak > 0 &&
      Math.abs(Number(params.vfsPeakToPeak) - 2.0) < 0.001) {
    console.log('[smeas autoSeed] → seeding vfsPeakToPeak:', meta.vfsPeakToPeak);
    updated = { ...updated, vfsPeakToPeak: meta.vfsPeakToPeak };
  }

  return updated;
}


function getWindow(type: string, length: number, kaiserBeta = 8): number[] {
  const n = Math.round(+length);
  const w = new Array(n);
  if (type === 'hann') {
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  } else if (type === 'hamming') {
    for (let i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
  } else if (type === 'blackman') {
    for (let i = 0; i < n; i++) {
      w[i] =
        0.42 -
        0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) +
        0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    }
  } else if (type === 'blackmanharris') {
    for (let i = 0; i < n; i++) {
      const pi2 = 2 * Math.PI;
      w[i] =
        0.35875 -
        0.48829 * Math.cos((pi2 * i) / (n - 1)) +
        0.14128 * Math.cos((2 * pi2 * i) / (n - 1)) -
        0.01168 * Math.cos((3 * pi2 * i) / (n - 1));
    }
  } else if (type === 'flattop') {
    // IEEE flat-top coefficients
    for (let i = 0; i < n; i++) {
      const pi2 = 2 * Math.PI;
      w[i] =
        0.21557895 -
        0.41663158 * Math.cos((pi2 * i) / (n - 1)) +
        0.27726316 * Math.cos((2 * pi2 * i) / (n - 1)) -
        0.08357895 * Math.cos((3 * pi2 * i) / (n - 1)) +
        0.00694737 * Math.cos((4 * pi2 * i) / (n - 1));
    }
  } else if (type === 'kaiser') {
    // Kaiser window: w[i] = I0(β·√(1−(2i/(N−1)−1)²)) / I0(β)
    // Modified Bessel function I0 via power series (converges to <1e-10 error for β≤20)
    const i0 = (x: number): number => {
      let s = 1, term = 1;
      const xh = x / 2;
      for (let k = 1; k <= 30; k++) { term *= (xh / k) * (xh / k); s += term; if (term < 1e-12 * s) break; }
      return s;
    };
    const i0b = i0(kaiserBeta);
    for (let i = 0; i < n; i++) {
      const t = (2 * i) / (n - 1) - 1; // t ∈ [-1, 1]
      w[i] = i0(kaiserBeta * Math.sqrt(1 - t * t)) / i0b;
    }
  } else {
    // rectangular
    w.fill(1);
  }
  return w;
}

/**
 * isPowerOf2 — returns true iff n is a positive power of 2.
 */
function isPowerOf2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Window correction tables (IEEE 1057 / Harris 1978)
//
// coherentGain  — sum(w)/N  — divides into the amplitude to undo attenuation.
// enbw          — N·sum(w²)/sum(w)²  — multiply noise power by this to get
//                 the equivalent noise bandwidth relative to rectangular.
// nHalfBins     — half-width of the main lobe (bins on each side of peak) to
//                 include when integrating tone power. Conservative values that
//                 capture ≥99% of lobe energy for a typical ADC record length.
//
// For rectangular: coherentGain=1, enbw=1, nHalfBins=1 (single-bin peak).
// ─────────────────────────────────────────────────────────────────────────────
interface WindowProps {
  /** Coherent power gain: (sum(w)/N)². Signal power is divided by this. */
  coherentGain: number;
  /** Equivalent Noise Bandwidth (bins). Noise power is divided by this. */
  enbw: number;
  /** Half-width in bins for tone lobe integration (each side of peak bin). */
  nHalfBins: number;
}

const WINDOW_PROPS: Record<string, WindowProps> = {
  rectangular:    { coherentGain: 1.000,    enbw: 1.000,  nHalfBins: 0 },
  hann:           { coherentGain: 0.2500,   enbw: 1.500,  nHalfBins: 2 },
  hamming:        { coherentGain: 0.2700,   enbw: 1.363,  nHalfBins: 2 },
  blackman:       { coherentGain: 0.1736,   enbw: 1.727,  nHalfBins: 3 },
  blackmanharris: { coherentGain: 0.1360,   enbw: 2.004,  nHalfBins: 4 },
  flattop:        { coherentGain: 0.04652,  enbw: 3.770,  nHalfBins: 4 },
  // Kaiser β=8: ENBW≈2.39, coherentGain≈0.402 — exact values depend on β;
  // these cover β=8 (IEEE 1241 / ADC characterisation default).
  kaiser:         { coherentGain: 0.4020,   enbw: 2.390,  nHalfBins: 4 },
};

function getWindowProps(type: string): WindowProps {
  return WINDOW_PROPS[type] ?? WINDOW_PROPS['rectangular'];
}

/**
 * Ordered list of windows tried by the 'auto' mode.
 * Rectangular is always run first as the baseline.
 * Kaiser is tried at β=8 (IEEE 1241 default).
 */
const AUTO_WINDOW_CANDIDATES = ['rectangular', 'hann', 'hamming', 'blackman', 'blackmanharris', 'flattop', 'kaiser'] as const;

/**
 * Integrate power in a lobe centred on `peakBin` spanning ±nHalfBins.
 * For rectangular (nHalfBins=0) this is just Ps[peakBin].
 * Bins outside [1, S1len-2] are skipped (DC and Nyquist excluded).
 * Returns { power, peakBin } — peakBin is refined to the highest bin in the group.
 */
function integrateLobePs(
  Ps: Float64Array,
  centerBin: number,
  nHalfBins: number,
  S1len: number,
): { power: number; peakBin: number } {
  let power = 0;
  let peakBin = centerBin;
  let peakVal = -Infinity;
  const lo = Math.max(1, centerBin - nHalfBins);
  const hi = Math.min(S1len - 2, centerBin + nHalfBins);
  for (let b = lo; b <= hi; b++) {
    power += Ps[b];
    if (Ps[b] > peakVal) { peakVal = Ps[b]; peakBin = b; }
  }
  return { power, peakBin };
}

/**
 * dft — O(N²) Discrete Fourier Transform used as fallback when N is not a power of 2.
 * Returns the two-sided magnitude spectrum: |X[k]| / N for k = 0 … N-1.
 * For large N this will be slow — a runtime warning is surfaced to the user.
 */
function dft(signal: number[]): Float64Array {
  const N = signal.length;
  const out = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const angle = (2 * Math.PI * k * n) / N;
      re += signal[n] * Math.cos(angle);
      im -= signal[n] * Math.sin(angle);
    }
    out[k] = Math.sqrt(re * re + im * im) / N;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// TI mismatch characterisation & correction
// Port of Python SpectrumMeas.get_phase_skew_vector() + apply_correction()
// ─────────────────────────────────────────────────────────────────────────────

/** Per-phase mismatch data collected during the characterisation pass. */
export interface TiPhaseEntry {
  nav: number;           // averaging cycle index
  phase: number;         // core/phase index
  // offset
  offsetCodesRaw: number;           // mid_code - mean(sub_signal)
  offsetCodesQuantized: number;     // after quantization
  // gain
  gainRmsCodesRaw: number;          // std of sub-signal (codes)
  gainRmsCodesNormalized: number;   // ratio to reference phase std
  // phase
  epsilonEst: number;               // Quinn-Estrade sub-bin fractional offset ε ∈ (−0.5, +0.5)
  phaseBiasRads: number;            // π·ε·(Lsub−1)/Lsub — the rectangular-window bias that was removed
  rawAngleRads: number;             // bias-corrected FFT phase angle at energetic bin
  properAngleRads: number;          // after π-modulus unwrapping
  offsetAngleRads: number;          // relative to reference phase
  idealAngleRads: number;           // theoretical: phase * 2π * fin/fs_sub
  deltaAngleRads: number;           // offset − ideal  (the correction to apply)
  deltaAngleDegs: number;
  deltaAnglePs: number;
  rotationApplied: boolean;
  // corrected (filled after apply, null if correction not run)
  correctedFundDbfs: number | null;
}

export interface TiCalResult {
  entries: TiPhaseEntry[];
  fundBin: number;       // full-spectrum energetic bin (for reference)
  fundMhz: number;
  fundDbfs: number;
  refPhase: number;
  correctedCodes: number[] | null;  // null if correction was not requested
}

/**
 * measureAndCorrectTi —
 *   1. Always characterises per-phase offset, gain, and phase mismatches.
 *   2. Optionally applies O, G, P corrections (Option B: returns corrected stream).
 *
 * Only meaningful for time-domain inputs (codes or volts).
 * Signal must have length >= fftLength * numAveraging.
 */
function measureAndCorrectTi(
  codes: number[],
  fftLength: number,
  numAveraging: number,
  numCores: number,
  adcOffsetCode: number,
  adcNumBits: number,
  offsetQuantLsb: number,
  refPhase: number,
  correctOffset: boolean,
  correctGain: boolean,
  correctPhase: boolean,
  correctionOrder: string = 'O,G,P',   // e.g. 'O,G,P' | 'G,O,P' etc.
): TiCalResult {
  const L = fftLength;
  const Nav = numAveraging;
  const Np = numCores;

  // ── Step 1: find full-spectrum fundamental ─────────────────────────────────
  // Quick single-average FFT on the first window to find fundBin
  const firstWindow = codes.slice(0, L);
  const fftInst = new FFT(L);
  const cIn = fftInst.createComplexArray();
  const cOut = fftInst.createComplexArray();
  for (let i = 0; i < L; i++) { cIn[2 * i] = firstWindow[i]; cIn[2 * i + 1] = 0; }
  fftInst.transform(cOut, cIn);
  let fundBin = 1, fundMag = -Infinity;
  for (let i = 1; i <= Math.floor(L / 2); i++) {
    const re = cOut[2 * i], im = cOut[2 * i + 1];
    const mag = Math.sqrt(re * re + im * im);
    if (mag > fundMag) { fundMag = mag; fundBin = i; }
  }
  const fundMhz = NaN; // will be filled by caller from full analysis
  const fundDbfs = NaN;

  // Sub-stream length per phase per averaging cycle
  const Lsub = Math.floor(L / Np);
  if (Lsub < 4) throw new Error(`TI cal: sub-stream length ${Lsub} too short (fftLength/numCores must be ≥ 4).`);
  if (!isPowerOf2(Lsub)) throw new Error(`TI cal: sub-stream length ${Lsub} (= fftLength/numCores) must be a power of 2.`);

  // Energetic bin in sub-spectrum is found fresh per sub-stream for accuracy
  const subFftInst = new FFT(Lsub);

  // ── Step 2: collect raw per-phase angles, offset, gain ────────────────────
  const entries: TiPhaseEntry[] = [];

  for (let nn = 0; nn < Nav; nn++) {
    const windowStart = nn * L;
    const windowCodes = codes.slice(windowStart, windowStart + L);

    // Collect std of each phase for gain normalisation
    const phaseStds: number[] = [];
    for (let pp = 0; pp < Np; pp++) {
      const sub = windowCodes.filter((_, i) => i % Np === pp);
      const mean = sub.reduce((s, v) => s + v, 0) / sub.length;
      const std = Math.sqrt(sub.reduce((s, v) => s + (v - mean) ** 2, 0) / sub.length);
      phaseStds.push(std);
    }
    // Reference std is the std of the reference phase (not max — align to ref)
    const refStd = phaseStds[Math.min(refPhase, Np - 1)];

    // Raw angles
    const rawAngles: number[] = [];
    for (let pp = 0; pp < Np; pp++) {
      const sub = windowCodes.filter((_, i) => i % Np === pp);
      const mean = sub.reduce((s, v) => s + v, 0) / sub.length;

      // FFT of sub-stream
      const sCIn = subFftInst.createComplexArray();
      const sCOut = subFftInst.createComplexArray();
      // Sub-stream phase characterisation MUST use rectangular (no window).
      // A window like Hann convolves the spectrum, biasing atan2 at the peak bin
      // and introducing a wrong phase angle. The rectangular bias from incoherency
      // is identical across all cores and cancels when computing deltaAngle =
      // offsetAngle − idealAngle — so rectangular is correct here regardless of
      // whether the main analysis uses a different window.
      for (let i = 0; i < Lsub; i++) { sCIn[2 * i] = sub[i] ?? 0; sCIn[2 * i + 1] = 0; }
      subFftInst.transform(sCOut, sCIn);

      // Find energetic bin in sub-spectrum (exclude DC)
      let eBin = 1, eMag = -Infinity;
      for (let i = 1; i <= Math.floor(Lsub / 2); i++) {
        const re = sCOut[2 * i], im = sCOut[2 * i + 1];
        const mag = re * re + im * im;
        if (mag > eMag) { eMag = mag; eBin = i; }
      }
      const eRe = sCOut[2 * eBin], eIm = sCOut[2 * eBin + 1];

      // ── Quinn-Estrade sub-bin interpolation ─────────────────────────────────
      // For a rectangular window with a tone at fractional bin k₀+ε, the raw
      // atan2 at bin k₀ carries a systematic phase bias of π·ε·(Lsub−1)/Lsub.
      // As long as the bias is the same across all cores (same ε, same Lsub) it
      // cancels in the differential deltaAngle. However we remove it analytically
      // so the absolute phase readings in the debug table are also correct, and so
      // the ideal phase vector (which uses fundBin * Lsub / L as fin_sub) is
      // consistent with the actual fractional-bin position.
      //
      // Quinn 1st estimator for fractional offset ε ∈ (−0.5, +0.5):
      //   α = Re{ X[k+1] · conj(X[k]) } / |X[k]|²
      //   ε ≈ α / (1 − α)   (good for SNR > ~20 dB in the sub-stream)
      // Then unbiased phase = atan2(im, re) − π·ε·(Lsub−1)/Lsub
      let epsilonEst = 0;
      if (eBin > 0 && eBin < Lsub - 1) {
        const re1 = sCOut[2 * (eBin + 1)], im1 = sCOut[2 * (eBin + 1) + 1];
        // α = Re{ X[k+1] · conj(X[k]) } / |X[k]|²
        const alpha = (re1 * eRe + im1 * eIm) / (eRe * eRe + eIm * eIm + 1e-300);
        epsilonEst = alpha / (1 - alpha + 1e-300);
        // Clamp to ±0.5 — estimator breaks down at the edges of the Nyquist zone
        epsilonEst = Math.max(-0.5, Math.min(0.5, epsilonEst));
      }
      const phaseBiasCorrection = Math.PI * epsilonEst * (Lsub - 1) / Lsub;
      const rawAngle = Math.atan2(eIm, eRe) - phaseBiasCorrection;
      rawAngles.push(rawAngle);

      entries.push({
        nav: nn, phase: pp,
        offsetCodesRaw: adcOffsetCode - mean,
        offsetCodesQuantized: Math.round((adcOffsetCode - mean) / offsetQuantLsb) * offsetQuantLsb,
        gainRmsCodesRaw: phaseStds[pp],
        gainRmsCodesNormalized: refStd > 0 ? refStd / phaseStds[pp] : 1,
        epsilonEst,
        phaseBiasRads: phaseBiasCorrection,
        rawAngleRads: rawAngle,
        properAngleRads: 0, offsetAngleRads: 0,
        idealAngleRads: 0, deltaAngleRads: 0, deltaAngleDegs: 0, deltaAnglePs: 0,
        rotationApplied: false,
        correctedFundDbfs: null,
      });
    }

    // ── Step 3: unwrap phases relative to reference phase ───────────────────
    // Determine majority derivative sign (rising or falling)
    const diffs = rawAngles.slice(1).map((a, i) => a - rawAngles[i]);
    const risingCount = diffs.filter(d => d > 0).length;
    const sign = risingCount >= diffs.length - risingCount ? 1 : -1;

    const proper = [...rawAngles];
    if (sign === 1) {
      for (let pp = 1; pp < Np; pp++) {
        while (proper[pp] < proper[pp - 1]) proper[pp] += Math.PI;
      }
    } else {
      for (let pp = Np - 2; pp >= 0; pp--) {
        while (proper[pp] < proper[pp + 1]) proper[pp] += Math.PI;
      }
    }

    // Offset: subtract reference phase so refPhase → 0
    const refAngle = proper[Math.min(refPhase, Np - 1)];
    const offsetAngles = proper.map(a => a - refAngle);

    // Ideal phase vector: phase_pp * 2π * fin_sub / fs_sub
    // fin in sub-spectrum: fundBin * Lsub / L (approximate)
    const finSubBin = fundBin * Lsub / L;
    const idealAngles = Array.from({ length: Np }, (_, pp) =>
      pp * 2 * Math.PI * finSubBin / Lsub
    );
    // Align ideal to reference phase too
    const idealRefAngle = idealAngles[Math.min(refPhase, Np - 1)];
    const idealOffset = idealAngles.map(a => a - idealRefAngle);

    const finMhzApprox = NaN; // not available here without fsHz — deltaAnglePs left as NaN

    for (let pp = 0; pp < Np; pp++) {
      const e = entries[nn * Np + pp];
      e.properAngleRads   = proper[pp];
      e.offsetAngleRads   = offsetAngles[pp];
      e.idealAngleRads    = idealOffset[pp];
      e.deltaAngleRads    = offsetAngles[pp] - idealOffset[pp];
      e.deltaAngleDegs    = e.deltaAngleRads * (180 / Math.PI);
      e.deltaAnglePs      = finMhzApprox > 0 ? e.deltaAngleRads / (2 * Math.PI * finMhzApprox * 1e6) * 1e12 : NaN;
      e.rotationApplied   = proper[pp] !== rawAngles[pp];
    }
  }

  // ── Step 4: apply corrections if requested ────────────────────────────────
  let correctedCodes: number[] | null = null;

  if (correctOffset || correctGain || correctPhase) {
    correctedCodes = [...codes];

    for (let nn = 0; nn < Nav; nn++) {
      const windowStart = nn * L;

      // Compute reference std on (possibly offset-corrected) phase for gain normalisation
      // We use the raw reference-phase std as target
      const refEntry = entries[nn * Np + Math.min(refPhase, Np - 1)];
      const targetStd = refEntry.gainRmsCodesRaw;

      for (let pp = 0; pp < Np; pp++) {
        const e = entries[nn * Np + pp];

        // Gather the original sub-stream indices in the full codes array
        const subIndices: number[] = [];
        for (let i = 0; i < L; i++) {
          if (i % Np === pp) subIndices.push(windowStart + i);
        }
        let sub = subIndices.map(idx => correctedCodes![idx]);

        // Apply corrections in user-specified order
        // Parse order string: 'O,G,P' → ['O','G','P']
        const steps = correctionOrder.toUpperCase().split(/[,\s]+/).filter(s => ['O','G','P'].includes(s));
        // Fallback if empty/invalid
        if (steps.length === 0) steps.push('O', 'G', 'P');

        for (const step of steps) {
          if (step === 'O' && correctOffset) {
            const shift = e.offsetCodesQuantized;
            sub = sub.map(v => v + shift);
          }

          if (step === 'G' && correctGain) {
            const subMean = sub.reduce((s, v) => s + v, 0) / sub.length;
            const subStd = Math.sqrt(sub.reduce((s, v) => s + (v - subMean) ** 2, 0) / sub.length);
            if (subStd > 0 && targetStd > 0) {
              const gainFactor = targetStd / subStd;
              const qStep = 1 / Math.pow(2, adcNumBits);
              const gainQuantized = Math.round(gainFactor / qStep) * qStep;
              sub = sub.map(v => (v - subMean) * gainQuantized + subMean);
            }
          }

          if (step === 'P' && correctPhase) {
            const N = sub.length;
            const halfN = Math.floor(N / 2) + 1;
            const phInst = new FFT(N);
            const pIn = phInst.createComplexArray();
            const pOut = phInst.createComplexArray();
            for (let i = 0; i < N; i++) { pIn[2 * i] = sub[i]; pIn[2 * i + 1] = 0; }
            phInst.transform(pOut, pIn);
            const delta = e.deltaAngleRads;
            const corrected = phInst.createComplexArray();
            corrected[0] = pOut[0]; corrected[1] = pOut[1];
            for (let k = 1; k < halfN; k++) {
              const re = pOut[2 * k], im = pOut[2 * k + 1];
              const mag = Math.sqrt(re * re + im * im);
              const phase = Math.atan2(im, re) - delta;
              corrected[2 * k    ] = mag * Math.cos(phase);
              corrected[2 * k + 1] = mag * Math.sin(phase);
            }
            for (let k = 1; k < N - halfN + 1; k++) {
              corrected[2 * (N - k)    ] =  corrected[2 * k];
              corrected[2 * (N - k) + 1] = -corrected[2 * k + 1];
            }
            const iOut = phInst.createComplexArray();
            const conjIn = corrected.map((v, i) => i % 2 === 1 ? -v : v);
            phInst.transform(iOut, conjIn);
            sub = Array.from({ length: N }, (_, i) => iOut[2 * i] / N);
          }
        }

        // Write corrected sub-stream back
        for (let si = 0; si < subIndices.length; si++) {
          correctedCodes[subIndices[si]] = sub[si];
        }
      }
    }
  }

  return { entries, fundBin, fundMhz, fundDbfs, refPhase, correctedCodes };
}


/**
 * aliasedBinIndex — port of Python aliased_bin_index(x, L).
 * Maps any bin x into the first Nyquist zone [0, L/2].
 * Odd Nyquist zones alias forward; even zones alias backward (mirror).
 */
function aliasedBinIndex(x: number, L: number): number {
  const xMod = ((x % L) + L) % L; // ensure positive
  const zone = Math.floor(x / (L / 2));
  if (zone % 2 === 0) {
    return xMod % (L / 2);
  } else {
    return (L / 2) - (xMod % (L / 2));
  }
}

// Coerce a value that may arrive as boolean, number, or string to a proper boolean.
// Handles: true/false, 1/0, 'true'/'false', '1'/'0'. Falls back to `defaultVal`.
function coerceBool(v: unknown, defaultVal: boolean): boolean {
  if (v == null) return defaultVal;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return defaultVal;
}

function analyzeSpectrum(
  samples: number[],
  fsHz: number,
  vfsPeakToPeak: number,
  adcNumBits: number,
  adcOffsetCode: number,
  fftLength: number,
  numAveraging: number,
  window: string,
  harmonicsToConsider: number,
  sfdrLeakageAvoidanceRadiusMhz: number = 0,
  numberOfCores: number = 1,
  inputMode: 'time_domain_codes' | 'time_domain_volts' | 'single_sided_power_spectrum' = 'time_domain_codes',
  toneMode: 'single' | 'dual' = 'single',
  spursMinThresholdEn: boolean = true,
  spursMinCalcFactor: number = 1.0,
  spursMinDbfs: number = 0,
  kaiserBeta: number = 8,
  winCoherentGainOverride: number = -1,
  winEnbwOverride: number = -1,
  winNHalfBinsOverride: number = -1,
): any {
  const Afs = vfsPeakToPeak / 2;
  const PfsRef = (Afs * Afs) / 2;
  const tableProps = getWindowProps(window);
  // Apply user overrides; -1 (or negative) means "use IEEE table default"
  const winProps: WindowProps = {
    coherentGain: winCoherentGainOverride >= 0 ? winCoherentGainOverride : tableProps.coherentGain,
    enbw:         winEnbwOverride         >= 0 ? winEnbwOverride         : tableProps.enbw,
    nHalfBins:    winNHalfBinsOverride    >= 0 ? Math.round(winNHalfBinsOverride) : tableProps.nHalfBins,
  };

  // ── single_sided_power_spectrum: bypass FFT, restore Ps from dBFS ────────
  if (inputMode === 'single_sided_power_spectrum') {
    const S1len = samples.length;
    const L = 2 * (S1len - 1); // infer two-sided FFT length
    const Ps = new Float64Array(S1len);
    for (let i = 0; i < S1len; i++) {
      Ps[i] = PfsRef * Math.pow(10, samples[i] / 10);
    }
    const freqBin = Array.from({ length: S1len }, (_, i) => i);
    const freqMhz = freqBin.map((b) => (1e-6 * fsHz * b) / L);
    const PsDbfs = new Float64Array(S1len);
    for (let i = 0; i < S1len; i++) {
      PsDbfs[i] = Ps[i] > 0 ? 10 * Math.log10(Ps[i] / PfsRef) : -Infinity;
    }

    const S1 = new Float64Array(S1len);
    for (let i = 0; i < S1len; i++) S1[i] = Math.sqrt(2 * Ps[i]);
    S1[0] = Math.sqrt(Ps[0]);
    S1[S1len - 1] = Math.sqrt(Ps[S1len - 1]);

    const S2 = new Float64Array(L);
    S2[0] = S1[0];
    for (let i = 1; i < S1len - 1; i++) S2[i] = S1[i] / 2;
    S2[S1len - 1] = S1[S1len - 1];
    for (let i = S1len; i < L; i++) S2[i] = S2[L - i];

    const onePeriodVolts = new Float64Array(L);
    if (isPowerOf2(L)) {
      const fftInst = new FFT(L);
      const cIn  = fftInst.createComplexArray();
      const cOut = fftInst.createComplexArray();
      for (let i = 0; i < L; i++) { cIn[2 * i] = S2[i]; cIn[2 * i + 1] = 0; }
      fftInst.transform(cOut, cIn);
      for (let i = 0; i < L; i++) onePeriodVolts[i] = cOut[2 * i] / L;
    } else {
      for (let n = 0; n < L; n++) {
        let re = 0;
        for (let k = 0; k < L; k++) re += S2[k] * Math.cos(2 * Math.PI * k * n / L);
        onePeriodVolts[n] = re / L;
      }
    }

    const Nav = numAveraging;
    const samplesVolts = new Float64Array(L * Nav);
    for (let k = 0; k < Nav; k++) samplesVolts.set(onePeriodVolts, k * L);

    const lsbVolts = vfsPeakToPeak / Math.pow(2, adcNumBits);
    const samplesCodes = new Float64Array(L * Nav);
    for (let i = 0; i < samplesVolts.length; i++) samplesCodes[i] = samplesVolts[i] / lsbVolts;

    // Spectrum input: treat as rectangular (no windowing correction needed)
    return { ...analyzeFromPs(Ps, PsDbfs, freqMhz, freqBin, L, S1len, PfsRef,
      harmonicsToConsider, sfdrLeakageAvoidanceRadiusMhz, numberOfCores,
      samplesVolts, samplesCodes, fsHz, toneMode,
      spursMinThresholdEn, spursMinCalcFactor, spursMinDbfs,
      WINDOW_PROPS['rectangular']), usedDft: false, windowType: 'rectangular' };
  }

  // ── Time-domain path (codes or volts) ─────────────────────────────────────
  let volts: number[];
  if (inputMode === 'time_domain_volts') {
    volts = samples.slice();
  } else {
    volts = samples.map(
      (code) => (code - adcOffsetCode) * (vfsPeakToPeak / Math.pow(2, adcNumBits)),
    );
  }

  const w = getWindow(window, fftLength, kaiserBeta);
  const L = fftLength;
  const Nav = numAveraging;
  const useDft = !isPowerOf2(L);

  // ── Build averaged, windowed magnitude spectrum ───────────────────────────
  // S2[k] = averaged |X[k]| / N  (two-sided, linear amplitude)
  const S2 = new Float64Array(L);
  for (let k = 1; k <= Nav; k++) {
    const chunk = volts.slice((k - 1) * L, k * L);
    if (chunk.length < L) break;
    const windowed = chunk.map((v, i) => v * w[i]);
    let s2Chunk: Float64Array;
    if (useDft) {
      s2Chunk = dft(windowed);
    } else {
      const fftInstance = new FFT(L);
      const complexIn  = fftInstance.createComplexArray();
      const complexOut = fftInstance.createComplexArray();
      for (let i = 0; i < L; i++) { complexIn[2 * i] = windowed[i]; complexIn[2 * i + 1] = 0; }
      fftInstance.transform(complexOut, complexIn);
      s2Chunk = new Float64Array(L);
      for (let i = 0; i < L; i++) {
        const re = complexOut[2 * i]; const im = complexOut[2 * i + 1];
        s2Chunk[i] = Math.sqrt(re * re + im * im) / L;
      }
    }
    for (let i = 0; i < L; i++) S2[i] += s2Chunk[i] / Nav;
  }

  // ── Build single-sided power spectrum with amplitude correction ───────────
  // Step 1: fold into single-sided, factor-of-2 for AC bins
  const S1len = Math.round(L / 2) + 1;
  const S1 = new Float64Array(S1len);
  for (let i = 0; i < S1len; i++) S1[i] = S2[i];
  for (let i = 1; i <= S1len - 3; i++) S1[i] *= 2;

  // Step 2: amplitude correction — undo window coherent gain attenuation.
  // coherentGain = (sum(w)/N)², so amplitude correction = 1/sqrt(coherentGain).
  // We correct S1 (linear amplitude) directly.
  // For rectangular: coherentGain=1 → no-op.
  const ampCorrection = winProps.coherentGain > 0 ? 1.0 / Math.sqrt(winProps.coherentGain) : 1.0;
  if (ampCorrection !== 1.0) {
    for (let i = 0; i < S1len; i++) S1[i] *= ampCorrection;
  }

  const freqBin = Array.from({ length: S1len }, (_, i) => i);
  const freqMhz = freqBin.map((b) => (1e-6 * fsHz * b) / L);

  // Step 3: power spectrum from corrected amplitude
  const Ps = new Float64Array(S1len);
  for (let i = 0; i < S1len; i++) Ps[i] = (S1[i] * S1[i]) / 2;

  const PsDbfs = new Float64Array(S1len);
  for (let i = 0; i < S1len; i++) {
    PsDbfs[i] = Ps[i] > 0 ? 10 * Math.log10(Ps[i] / PfsRef) : -Infinity;
  }

  const samplesVolts = new Float64Array(volts.slice(0, fftLength * numAveraging));
  const samplesCodes = inputMode === 'time_domain_volts'
    ? new Float64Array(volts.map(v => (v / (vfsPeakToPeak / Math.pow(2, adcNumBits))) + adcOffsetCode))
    : new Float64Array(samples.slice(0, fftLength * numAveraging));

  return { ...analyzeFromPs(Ps, PsDbfs, freqMhz, freqBin, L, S1len, PfsRef,
    harmonicsToConsider, sfdrLeakageAvoidanceRadiusMhz, numberOfCores,
    samplesVolts, samplesCodes, fsHz, toneMode,
    spursMinThresholdEn, spursMinCalcFactor, spursMinDbfs,
    winProps), usedDft: useDft, windowType: window };
}

/**
 * analyzeFromPs — shared spectral analysis starting from an amplitude-corrected power spectrum Ps.
 *
 * For windowed inputs (non-rectangular):
 *   • Tone power:  integrated over ±nHalfBins around each peak (lobe grouping).
 *   • Noise power: divided by winProps.enbw to compensate for window spreading.
 *
 * For rectangular (nHalfBins=0, enbw=1): behaviour is identical to the original.
 */
function analyzeFromPs(
  Ps: Float64Array,
  PsDbfs: Float64Array,
  freqMhz: number[],
  freqBin: number[],
  L: number,
  S1len: number,
  PfsRef: number,
  harmonicsToConsider: number,
  sfdrLeakageAvoidanceRadiusMhz: number,
  numberOfCores: number,
  samplesVolts: Float64Array,
  samplesCodes: Float64Array,
  fsHz: number = 0,
  toneMode: 'single' | 'dual' = 'single',
  spursMinThresholdEn: boolean = true,
  spursMinCalcFactor: number = 1.0,
  spursMinDbfsOverride: number = 0,
  winProps: WindowProps = WINDOW_PROPS['rectangular'],
): any {
  const isDual = toneMode === 'dual';
  const nHalf = winProps.nHalfBins;

  // ── Fund1: peak bin then lobe integration ────────────────────────────────
  // Find the peak bin first (single-bin search on uncorrected PsDbfs for location)
  let fundPeakBin = 1;
  let fundDbfsPeak = -Infinity;
  for (let i = 1; i < S1len; i++) {
    if (PsDbfs[i] > fundDbfsPeak) { fundDbfsPeak = PsDbfs[i]; fundPeakBin = i; }
  }
  // Integrate lobe power around the peak
  const { power: fundPs, peakBin: fundBin } = integrateLobePs(Ps, fundPeakBin, nHalf, S1len);
  const fundDbfs = fundPs > 0 ? 10 * Math.log10(fundPs / PfsRef) : -Infinity;
  const fundMhz  = freqMhz[fundBin];

  // ── Fund2 (dual-tone): next highest peak outside fund lobe ───────────────
  let fund2Bin = -1;
  let fund2Dbfs = NaN;
  let fund2Mhz  = NaN;
  let fund2Ps   = 0;
  if (isDual) {
    let f2PeakBin = -1, f2Peak = -Infinity;
    for (let i = 1; i < S1len; i++) {
      if (Math.abs(i - fundBin) <= nHalf) continue; // skip fund lobe
      if (PsDbfs[i] > f2Peak) { f2Peak = PsDbfs[i]; f2PeakBin = i; }
    }
    if (f2PeakBin > 0) {
      const res2 = integrateLobePs(Ps, f2PeakBin, nHalf, S1len);
      fund2Bin  = res2.peakBin;
      fund2Ps   = res2.power;
      fund2Dbfs = fund2Ps > 0 ? 10 * Math.log10(fund2Ps / PfsRef) : NaN;
      fund2Mhz  = freqMhz[fund2Bin];
    }
  }

  const pdcPs = Ps[0];

  // ── IM / Harmonic components ──────────────────────────────────────────────
  // For CW: harmonics H2..Hk of Fund1 (Python get_im_components CW branch)
  // For dual: all m*F1 + n*F2 combinations up to order harmonicsToConsider
  interface ImEntry { symbol: string; order: number; bin: number; mhz: number; dbfs: number; power: number; }
  const imEntries: ImEntry[] = [];
  const seenImBins = new Set<number>();

  const addImEntry = (symbol: string, order: number, rawBin: number) => {
    const bin = Math.round(aliasedBinIndex(rawBin, L));
    if (bin <= 0 || bin >= S1len) return;
    // Skip bins that overlap the fundamental lobe (or fund2 lobe)
    if (Math.abs(bin - fundBin) <= nHalf) return;
    if (isDual && fund2Bin > 0 && Math.abs(bin - fund2Bin) <= nHalf) return;
    if (seenImBins.has(bin)) {
      const existing = imEntries.find(e => e.bin === bin);
      if (existing && !existing.symbol.includes(symbol)) existing.symbol += ' & ' + symbol;
      return;
    }
    seenImBins.add(bin);
    const { power, peakBin } = integrateLobePs(Ps, bin, nHalf, S1len);
    const dbfs = power > 0 ? 10 * Math.log10(power / PfsRef) : -Infinity;
    imEntries.push({ symbol, order, bin: peakBin, mhz: freqMhz[peakBin], dbfs, power });
  };

  if (!isDual) {
    // CW: harmonics H2..Hk
    for (let h = 2; h <= harmonicsToConsider; h++) {
      addImEntry(`H${h}`, h, h * fundBin);
    }
  } else {
    // Two-tone: all m*F1 + n*F2, |m|+|n| = order, order 2..harmonicsToConsider
    for (let order = 2; order <= harmonicsToConsider; order++) {
      for (let m = -order; m <= order; m++) {
        for (const n of Array.from(new Set([order - Math.abs(m), Math.abs(m) - order]))) {
          // fIm = |m|*F1 + |n|*F2 frequency — use absolute signed bin
          const fIm = m * fundMhz + n * fund2Mhz;
          if (fIm <= 0) continue; // ignore negative/DC frequencies
          if (m === 0 && n < 0) continue;
          if (n === 0 && m < 0) continue;
          const rawBin = m * fundBin + n * fund2Bin;
          const p1 = m !== 0 ? `${m}F1` : '';
          const sgn = (m !== 0 && n !== 0) ? (n > 0 ? '+' : '-') : (n < 0 ? '-' : '');
          const p2 = n !== 0 ? `${sgn}${Math.abs(n)}F2` : '';
          const sym = (p1 + p2).replace(/^\+/, '');
          addImEntry(sym, order, rawBin);
        }
      }
    }
  }
  void freqBin; // suppress unused warning

  let harmonicsPs = 0;
  for (const e of imEntries) harmonicsPs += e.power;

  // ── Spur minimum threshold (Python b_spurs_min_threshold_en) ─────────────
  // Computed AFTER fundBin, fund2Bin, and imEntries are known so we can
  // exclude signal bins from the histogram — keeping it stable w.r.t. numberOfCores.
  let spursMinDbfsCalc = 0;
  {
    const excludeBins = new Set<number>([0, fundBin, S1len - 1]);
    if (isDual && fund2Bin > 0) excludeBins.add(fund2Bin);
    for (const e of imEntries) excludeBins.add(e.bin);
    const finiteBins: number[] = [];
    for (let i = 0; i < S1len; i++) {
      if (excludeBins.has(i)) continue;
      const v = PsDbfs[i];
      if (isFinite(v) && !isNaN(v)) finiteBins.push(v);
    }
    if (finiteBins.length > 1) {
      let vMin = finiteBins[0], vMax = finiteBins[0];
      for (const v of finiteBins) { if (v < vMin) vMin = v; if (v > vMax) vMax = v; }
      const numBins = 10;
      const binWidth = (vMax - vMin) / numBins || 1;
      const counts = new Array(numBins).fill(0);
      for (const v of finiteBins) {
        const idx = Math.min(numBins - 1, Math.floor((v - vMin) / binWidth));
        counts[idx]++;
      }
      const total = finiteBins.length;
      const mids = counts.map((_, i) => vMin + (i + 0.5) * binWidth);
      const probs = counts.map(c => c / total);
      const mean = probs.reduce((s, p, i) => s + p * mids[i], 0);
      const sd   = Math.sqrt(probs.reduce((s, p, i) => s + p * (mids[i] - mean) ** 2, 0));
      spursMinDbfsCalc = mean + spursMinCalcFactor * sd;
    }
  }
  const spursMinDbfs = spursMinDbfsOverride !== 0 ? spursMinDbfsOverride : spursMinDbfsCalc;

  // ── TI spur bins ─────────────────────────────────────────────────────────
  interface TiSpurEntry { bin: number; mhz: number; dbfs: number; label: string; }
  const tiSpurEntries:  TiSpurEntry[] = [];
  const tiSpurEntries2: TiSpurEntry[] = []; // dual-tone TI set 2

  if (numberOfCores > 1) {
    const intTiMax = numberOfCores + 1;
    const kMax = Math.floor(intTiMax / 3);
    const seenTi = new Set<number>();

    const addTi = (arr: TiSpurEntry[], rawBin: number, label: string, isSet2 = false) => {
      const bin = Math.round(aliasedBinIndex(rawBin, L));
      if (bin <= 0 || bin >= S1len) return;
      if (bin === fundBin || (isDual && bin === fund2Bin)) return;
      // Do not re-label a bin already claimed as a harmonic/IM component.
      // Without this guard, harmonic energy gets relabelled as TI spurs when
      // numberOfCores > 1, making existing harmonics appear as inflated TI spurs.
      if (seenImBins.has(bin)) return;
      if (seenTi.has(bin)) return;
      seenTi.add(bin);
      arr.push({ bin, mhz: freqMhz[bin], dbfs: PsDbfs[bin], label });
    };

    for (let k = 1; k <= kMax; k++) {
      addTi(tiSpurEntries, (k * L / numberOfCores) - fundBin, `${k}L`);
      addTi(tiSpurEntries, (k * L / numberOfCores),            `${k}C`);
      addTi(tiSpurEntries, (k * L / numberOfCores) + fundBin, `${k}R`);
    }
    addTi(tiSpurEntries, ((kMax + 1) * L / numberOfCores) - fundBin, `${kMax + 1}L`);

    if (isDual) {
      for (let k = 1; k <= kMax; k++) {
        addTi(tiSpurEntries2, (k * L / numberOfCores) - fund2Bin, `${k}L2`, true);
        addTi(tiSpurEntries2, (k * L / numberOfCores) + fund2Bin, `${k}R2`, true);
      }
      addTi(tiSpurEntries2, ((kMax + 1) * L / numberOfCores) - fund2Bin, `${kMax + 1}L2`, true);
    }
  }

  // ── TI spur power (for noise subtraction, matching Python line 769) ─────────
  let tiSpursPs = 0;
  for (const ti of [...tiSpurEntries, ...tiSpurEntries2]) tiSpursPs += Ps[ti.bin];

  // ── Noise power ───────────────────────────────────────────────────────────
  // Python: P_noise = sum(Ps) - (P_dc + P_fund + P_harmonics + P_tispurs)
  // TI spur power IS subtracted from noise (same as Python), so that SNR/ENOB
  // don't change based on numberOfCores when no real performance change occurred.
  let totalPs = 0;
  for (let i = 0; i < S1len; i++) totalPs += Ps[i];
  let noisePs = totalPs - pdcPs - fundPs - harmonicsPs - tiSpursPs;
  if (isDual) noisePs -= fund2Ps;
  if (noisePs < 0) noisePs = 1e-30;
  // NOTE: ENBW correction is NOT applied here. The subtraction method (total - signal - harmonics - TI)
  // gives true noise power directly — the lobe integration already extracted exact signal power and
  // the remainder contains only real noise bins. Dividing by ENBW here would understate noise.

  // Python b_spurs_min_threshold_en logic (lines 775-784):
  //   if spurs_min_dBFS == 0  →  P_noise_wo_spurs = P_noise  (no filtering)
  //   if spurs_min_dBFS != 0  →  sum bins below threshold
  // spursMinDbfsOverride is the *user-supplied* override (0 = use auto-calc display only).
  // The auto-calc value is only used for the threshold marker/display, NOT for SNR filtering —
  // matching Python where the auto-calc doesn't activate filtering unless explicitly passed in.
  let noisePsForSnr = noisePs;
  const imEntriesAboveThreshold: typeof imEntries = [];
  const imEntriesBelowThreshold: typeof imEntries = [];

  if (spursMinThresholdEn && spursMinDbfsOverride !== 0) {
    // Manual override threshold specified: noise = bins below threshold (Python line 781)
    let noiseWoSpurs = 0;
    for (let i = 0; i < S1len; i++) {
      if (PsDbfs[i] < spursMinDbfsOverride) noiseWoSpurs += Ps[i];
    }
    noisePsForSnr = noiseWoSpurs > 0 ? noiseWoSpurs : noisePs;

    // Partition IM entries by threshold for marker display
    for (const e of imEntries) {
      if (e.dbfs >= spursMinDbfsOverride) imEntriesAboveThreshold.push(e);
      else imEntriesBelowThreshold.push(e);
    }
  } else {
    // No threshold filtering on SNR (default Python behaviour when spurs_min_dBFS == 0)
    imEntriesAboveThreshold.push(...imEntries);
  }

  const nrmsVm = 1000 * Math.sqrt(noisePs);

  // ── SNR / SNDR / ENOB / THD ──────────────────────────────────────────────
  // SNR uses noisePsForSnr (threshold-filtered when enabled, else same as noisePs)
  // SNDR uses noisePs (full noise) + harmonicsPs — threshold does not change distortion
  const snrC    = 10 * Math.log10(fundPs / noisePsForSnr);
  const snrFs   = 10 * Math.log10(PfsRef / noisePsForSnr);
  const sndrC   = 10 * Math.log10(fundPs / (noisePs + harmonicsPs));
  const sndrFs  = 10 * Math.log10(PfsRef / (noisePs + harmonicsPs));
  const enobSnrC  = (snrC  - 1.76) / 6.02;
  const enobSnrFs = (snrFs - 1.76) / 6.02;
  const enobSndrC  = (sndrC  - 1.76) / 6.02;
  const enobSndrFs = (sndrFs - 1.76) / 6.02;
  const thdDb = harmonicsPs > 0 ? 10 * Math.log10(harmonicsPs / fundPs) : -200;

  // ── IM3 (dual-tone only) ─────────────────────────────────────────────────
  // Python: IM3_r = PS[fund1] - PS[2*fund2_bin - fund1_bin]
  //         IM3_l = PS[fund1] - PS[2*fund1_bin - fund2_bin]
  //         IM3_dBc = min(IM3_r, IM3_l)
  let im3Dbc = NaN;
  let im3Mhz = NaN;
  let im3Bin = -1;
  if (isDual && fund2Bin > 0) {
    const im3RBin = Math.max(0, Math.min(S1len - 1, 2 * fund2Bin - fundBin));
    const im3LBin = Math.max(0, Math.min(S1len - 1, 2 * fundBin - fund2Bin));
    const im3R = fundDbfs - PsDbfs[im3RBin];
    const im3L = fundDbfs - PsDbfs[im3LBin];
    im3Dbc = Math.min(im3R, im3L);
    im3Bin = im3R <= im3L ? im3RBin : im3LBin;
    im3Mhz = freqMhz[im3Bin];
  }

  // ── SFDR ─────────────────────────────────────────────────────────────────
  const hzPerBin = fsHz / L;

  // Minimum blanking radius around every central point (DC, fund, Nyquist, TI spurs).
  // 0.3% of fs guarantees we clear the main-lobe leakage for all standard windows.
  // For fs=2250 MHz → 6.75 MHz radius.  User-set sfdrLeakageAvoidanceRadiusMhz adds
  // extra margin on top; it never reduces the minimum.
  const minRadiusMhz = (0.003 * fsHz) / 1e6;
  const userRadiusMhz = Number(sfdrLeakageAvoidanceRadiusMhz) || 0;
  const effectiveRadiusMhz = Math.max(minRadiusMhz, userRadiusMhz);
  const avoidBins = hzPerBin > 0 ? Math.ceil((effectiveRadiusMhz * 1e6) / hzPerBin) : 1;

  const blankAround = (arr: number[], center: number, halfBins: number) => {
    for (let b = center - halfBins; b <= center + halfBins; b++)
      if (b >= 0 && b < S1len) arr[b] = -Infinity;
  };

  const PsDbfsSfdr = Array.from(PsDbfs) as number[];

  // Blank DC zone, Nyquist zone, and fundamental lobe(s)
  blankAround(PsDbfsSfdr, 0, avoidBins);
  blankAround(PsDbfsSfdr, S1len - 1, avoidBins);
  blankAround(PsDbfsSfdr, fundBin, avoidBins);
  if (isDual && fund2Bin > 0) blankAround(PsDbfsSfdr, fund2Bin, avoidBins);

  // Find SFDR: highest bin in the blanked spectrum (TI spurs ARE valid SFDR candidates)
  let sfdrBin = 1, sfdrMax = -Infinity;
  for (let i = 1; i < S1len - 1; i++)
    if (PsDbfsSfdr[i] > sfdrMax) { sfdrMax = PsDbfsSfdr[i]; sfdrBin = i; }

  const sfdrDbcs = fundDbfs - PsDbfs[sfdrBin];
  const sfdrMhz  = freqMhz[sfdrBin];

  const labelBin = (bin: number): string => {
    for (const e of imEntries) if (e.bin === bin) return e.symbol;
    for (let i = 0; i < tiSpurEntries.length;  i++) if (tiSpurEntries[i].bin  === bin) return `TI${i}1`;
    for (let i = 0; i < tiSpurEntries2.length; i++) if (tiSpurEntries2[i].bin === bin) return `TI${i}2`;
    return 'undesignated';
  };
  const sfdrLabel = labelBin(sfdrBin);

  // ── SFDR without TI spurs ─────────────────────────────────────────────────
  // Start from PsDbfsSfdr (DC / Nyquist / fund already blanked with avoidBins)
  // then blank every TI spur with the same avoidance radius.
  let sfdrWoTiDbcs = sfdrDbcs, sfdrWoTiMhz = sfdrMhz, sfdrWoTiBin = sfdrBin, sfdrWoTiLabel = sfdrLabel;
  if (numberOfCores > 1 && (tiSpurEntries.length + tiSpurEntries2.length) > 0) {
    const wo = Array.from(PsDbfsSfdr) as number[];
    for (const ti of [...tiSpurEntries, ...tiSpurEntries2])
      blankAround(wo, ti.bin, avoidBins);
    let woMax = -Infinity;
    for (let i = 1; i < S1len - 1; i++)
      if (wo[i] > woMax) { woMax = wo[i]; sfdrWoTiBin = i; }
    sfdrWoTiDbcs  = fundDbfs - PsDbfs[sfdrWoTiBin];
    sfdrWoTiMhz   = freqMhz[sfdrWoTiBin];
    sfdrWoTiLabel = labelBin(sfdrWoTiBin);
  }

  // ── Derived spectra ───────────────────────────────────────────────────────
  const PsDbfsWoTi = Array.from(PsDbfs) as number[];
  for (const ti of [...tiSpurEntries, ...tiSpurEntries2]) PsDbfsWoTi[ti.bin] = NaN;

  const PsDbfsNoise = Array.from(PsDbfsWoTi) as number[];
  PsDbfsNoise[0]        = NaN;
  PsDbfsNoise[fundBin]  = NaN;
  PsDbfsNoise[S1len - 1] = NaN;
  if (isDual && fund2Bin > 0) PsDbfsNoise[fund2Bin] = NaN;
  for (const e of imEntries) PsDbfsNoise[e.bin] = NaN;

  return {
    snrC, snrFs, sndrC, sndrFs,
    enobSnrC, enobSnrFs, enobSndrC, enobSndrFs,
    thdDb, sfdrDbcs, sfdrMhz, sfdrBin, sfdrLabel,
    sfdrWoTiDbcs, sfdrWoTiMhz, sfdrWoTiBin, sfdrWoTiLabel,
    fundMhz, fundDbfs, fundBin,
    fund2Mhz, fund2Dbfs, fund2Bin,
    im3Dbc, im3Mhz, im3Bin,
    nrmsVm,
    imEntries,                          // all IM/harmonic entries (full, for debug/tables)
    imEntriesVisible: imEntriesAboveThreshold, // above threshold → get markers in plots
    imEntriesBelowThreshold,            // below threshold → treated as noise, no marker
    spursMinDbfs,                       // resolved threshold (auto or override)
    spursMinThresholdEn,
    tiSpurEntries,
    tiSpurEntries2,
    numberOfCores,
    isDual,
    effectiveRadiusMhz,                 // actual blanking radius used (max of 0.3%×fs and user value)
    freqMhz: Array.from(freqMhz),
    freqBin,
    PsDbfs: Array.from(PsDbfs),
    PsDbfsWoTi,
    PsDbfsNoise,
    Ps: Array.from(Ps),
    L,
    S1len,       // needed for live re-analysis in figure
    PfsRef,      // needed for live re-analysis in figure
    samplesVolts: Array.from(samplesVolts),
    samplesCodes: Array.from(samplesCodes),
  };
}


// ── Shared dark tooltip ───────────────────────────────────────────────────────
function SmeasTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  // Only show tooltip for the spectrum line (key 'ps'), not marker series
  const specEntry = payload.find((p: any) => p.dataKey === 'ps');
  if (!specEntry || specEntry.value == null) return null;
  return (
    <div className="bg-gray-800 border border-gray-600 rounded px-3 py-2 text-xs shadow-xl">
      <p className="text-gray-400 mb-1"><span className="font-mono text-white">{Number(label).toFixed(3)}</span> MHz</p>
      <p style={{ color: specEntry.color ?? '#6366F1' }}>
        {specEntry.name ?? 'PS'}: <span className="font-mono">{typeof specEntry.value === 'number' ? specEntry.value.toFixed(2) : specEntry.value} dBFS</span>
      </p>
    </div>
  );
}

// ── Custom labeled dot renderer for point annotations ─────────────────────────
// shape: 'circle' (default) | 'triangle' (TI spurs)
// textRotate: true → render label vertically upward (dual-tone IM components)
function MarkerDot(props: any) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || !payload?._markers?.length) return null;
  const entries: { label: string; color: string; shape: string; rotate: boolean; small: boolean }[] = payload._markers;

  // Stack multiple markers at the same bin — each offset upward by 14px
  return (
    <g>
      {entries.map((m, idx) => {
        const dotY = cy - idx * 14;
        const r = m.small ? 5.5 : 6;
        const labelY = dotY - r - 4;
        return (
          <g key={idx}>
            {m.shape === 'triangle' ? (
              <polygon
                points={`${cx},${dotY - 8} ${cx - 6},${dotY + 4} ${cx + 6},${dotY + 4}`}
                fill={m.color} stroke="#111827" strokeWidth={1}
              />
            ) : (
              <circle cx={cx} cy={dotY} r={r} fill={m.color} stroke="#111827" strokeWidth={1} />
            )}
            {m.rotate ? (
              <text
                x={cx} y={labelY}
                textAnchor="start"
                fill={m.color} fontSize={9} fontFamily="monospace"
                transform={`rotate(-90, ${cx}, ${labelY})`}
              >
                {m.label}
              </text>
            ) : (
              <text x={cx} y={labelY} textAnchor="middle" fill={m.color} fontSize={9} fontFamily="monospace">
                {m.label}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

// Stamp marker metadata onto the nearest index in chartData (in-place).
// _markers is an array so multiple markers on the same bin all appear.
function stampMarkers(
  chartData: { f: number; ps: number | null; [k: string]: any }[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targets: any[],
): void {
  if (chartData.length === 0) return;
  for (const t of targets) {
    let lo = 0, hi = chartData.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (chartData[mid].f < t.mhz) lo = mid + 1; else hi = mid;
    }
    const candidates = [lo - 1, lo, lo + 1].filter(i => i >= 0 && i < chartData.length);
    let best = candidates[0];
    for (const i of candidates) {
      if (Math.abs(chartData[i].f - t.mhz) < Math.abs(chartData[best].f - t.mhz)) best = i;
    }
    const pt = chartData[best];
    if (pt.ps == null || !isFinite(pt.ps as number)) continue;
    if (!pt._markers) pt._markers = [];
    pt._markers.push({
      label: t.label,
      color: t.color,
      shape: t.shape ?? 'circle',
      rotate: t.rotate ?? false,
      small: t.small ?? false,
    });
  }
}

// ── Legend strip (HTML, below chart) ──────────────────────────────────────────
// marker: undefined → filled rect; 'triangle' → triangle svg; 'area' → semi-transparent rect (for shaded zones)
function LegendStrip({ items }: { items: { color: string; label: string; marker?: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 px-2 text-xs">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-1.5">
          {it.marker === 'triangle' ? (
            <svg width="12" height="10" viewBox="0 0 12 10" className="shrink-0">
              <polygon points="6,0 0,10 12,10" fill={it.color} />
            </svg>
          ) : it.marker === 'area' ? (
            <svg width="14" height="10" viewBox="0 0 14 10" className="shrink-0">
              <rect x="0" y="0" width="14" height="10" fill={it.color} rx="1" />
              <rect x="0" y="0" width="14" height="10" fill="none" stroke={it.color} strokeWidth="1.5" rx="1" opacity="0.8" />
            </svg>
          ) : (
            <span style={{ background: it.color }} className="inline-block w-3 h-2 rounded-sm shrink-0" />
          )}
          <span className="text-gray-300 font-mono">{it.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Results panel (shared HTML side-panel, replaces canvas box) ───────────────
function ResultsPanel({ r, fsHz, sfdrLeakageAvoidanceRadiusMhz, showWoTi }: {
  r: any; fsHz: number; sfdrLeakageAvoidanceRadiusMhz: number; showWoTi?: boolean;
}) {
  const rows: { label: string; value: string }[] = [
    { label: 'fs (MHz)',       value: (fsHz / 1e6).toFixed(2) },
    { label: 'ENOB(SNR)',      value: `${r.enobSnrC.toFixed(2)} / ${r.enobSnrFs.toFixed(2)} bit` },
    { label: 'ENOB(SNDR)',     value: `${r.enobSndrC.toFixed(2)} / ${r.enobSndrFs.toFixed(2)} bit` },
    { label: 'SNR',            value: `${r.snrC.toFixed(2)} / ${r.snrFs.toFixed(2)} dB` },
    { label: 'SNDR',           value: `${r.sndrC.toFixed(2)} / ${r.sndrFs.toFixed(2)} dB` },
    { label: 'THD',            value: `${r.thdDb.toFixed(2)} dB` },
    { label: 'Nrms',           value: `${r.nrmsVm.toFixed(2)} mV` },
    { label: 'Fund1',          value: `${isFinite(r.fundMhz) ? r.fundMhz.toFixed(4) : r.fundMhz} MHz  ${r.fundDbfs.toFixed(2)} dBFS` },
    ...(r.isDual && isFinite(r.fund2Mhz) ? [
      { label: 'Fund2', value: `${r.fund2Mhz} MHz  ${isFinite(r.fund2Dbfs) ? r.fund2Dbfs.toFixed(2) : 'N/A'} dBFS` },
      { label: 'IM3',   value: `${isFinite(r.im3Dbc) ? r.im3Dbc.toFixed(1) : 'N/A'}dBc  @ ${isFinite(r.im3Mhz) ? r.im3Mhz.toFixed(4) : 'N/A'} MHz` },
    ] : []),
    { label: 'SFDR',           value: `${r.sfdrDbcs.toFixed(2)} dBc  ${r.sfdrLabel ?? ''}  @ ${r.sfdrMhz.toFixed(2)} MHz` },
    ...(sfdrLeakageAvoidanceRadiusMhz > 0 ? [{ label: 'SFDR avoid', value: `±${sfdrLeakageAvoidanceRadiusMhz} MHz` }] : []),
    ...(showWoTi && isFinite(r.sfdrWoTiDbcs) && r.sfdrWoTiBin !== r.sfdrBin ? [
      { label: 'SFDR_woTI', value: `${r.sfdrWoTiDbcs.toFixed(2)} dBc  ${r.sfdrWoTiLabel ?? ''}  @ ${r.sfdrWoTiMhz.toFixed(2)} MHz` },
    ] : []),
    ...(r.spursMinThresholdEn && isFinite(r.spursMinDbfs) && r.spursMinDbfs !== 0
      ? [{ label: 'Spur Thr.', value: `${r.spursMinDbfs.toFixed(1)} dBFS` }] : []),
  ];
  if (r.imEntriesVisible && r.imEntriesVisible.length > 0) {
    for (const h of (r.imEntriesVisible as any[]).slice(0, 7)) {
      rows.push({ label: h.symbol, value: `${(r.fundDbfs - h.dbfs).toFixed(2)} dBc  @ ${h.mhz.toFixed(3)} MHz` });
    }
  }
  if (r.imEntriesBelowThreshold && r.imEntriesBelowThreshold.length > 0) {
    for (const h of (r.imEntriesBelowThreshold as any[]).slice(0, 4)) {
      rows.push({ label: `${h.symbol} (noise)`, value: `${(r.fundDbfs - h.dbfs).toFixed(2)} dBc  @ ${h.mhz.toFixed(3)} MHz` });
    }
  }
  if (r.tiSpurEntries && r.tiSpurEntries.length > 0) {
    for (const ti of r.tiSpurEntries as any[]) {
      if (!isFinite(ti.dbfs)) continue;
      rows.push({ label: `TI ${ti.label}`, value: `${(r.fundDbfs - ti.dbfs).toFixed(2)} dBc  @ ${ti.mhz.toFixed(3)} MHz` });
    }
  }
  return (
    <div className="flex flex-col gap-0.5 bg-amber-900/20 border border-amber-700/40 rounded-lg p-3 w-[420px] shrink-0 text-xs overflow-y-auto overflow-x-auto">
      <div className="text-amber-300 font-semibold text-[10px] uppercase tracking-wider mb-1 border-b border-amber-700/40 pb-1">carrier / FS</div>
      {rows.map((row, i) => (
        <div key={i} className="flex justify-between gap-2 min-w-0">
          <span className="text-amber-200/70 shrink-0 font-mono">{row.label}</span>
          <span className="text-amber-100 font-mono text-right whitespace-nowrap">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main spectrum figure ───────────────────────────────────────────────────────
// [EXPERIMENTAL] Live SFDR avoidance radius knob — wheel + stepper, re-runs analyzeFromPs on change.
//
// TO REMOVE THIS EXPERIMENT one day:
//   1. Remove the `_liveAnalysisParams` field from SmeasFigureData interface.
//   2. Remove the `_liveAnalysisParams: { ... }` block from the figureData object in prepareData().
//   3. Remove { useState, useMemo, useRef, useEffect } from the React import (keep if used elsewhere).
//   4. Replace this entire MainSpectrumFigure with:
//
/**
 * Apply FigureViewer zoom (__xC/__yC/__zoom) to a [fullMin, fullMax] data range.
 * Returns [windowMin, windowMax] in data units.
 */
function applyZoomDomain(
  fullMin: number, fullMax: number,
  controls: Record<string, any>,
  axis: 'x' | 'y',
): [number, number] {
  const zoom = axis === 'x'
    ? ((controls.__zoom  as number) ?? 1)
    : ((controls.__yZoom as number) ?? 1);
  const span   = fullMax - fullMin;
  const cFrac  = axis === 'x' ? ((controls.__xC as number) ?? 0.5) : ((controls.__yC as number) ?? 0.5);
  const center = fullMin + cFrac * span;
  // hw = half the visible window in data units
  const hw = span / (2 * Math.max(zoom, 1));
  // At zoom=1 the window equals the full span; pan only shifts if zoom>1
  if (zoom <= 1) return [fullMin, fullMax];
  return [
    Math.max(fullMin, center - hw),
    Math.min(fullMax, center + hw),
  ];
}

/**
 * Filter a sorted chartData array to points within [xMin, xMax] with 1-point margin
 * on each side (so Recharts can draw lines reaching the edge).
 */
function filterToWindow<T extends { f: number }>(arr: T[], xMin: number, xMax: number): T[] {
  if (arr.length === 0) return arr;
  // Binary search for first index >= xMin - margin
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].f < xMin) lo = mid + 1; else hi = mid; }
  const start = Math.max(0, lo - 1);
  let end = start;
  while (end < arr.length && arr[end].f <= xMax) end++;
  end = Math.min(arr.length - 1, end);
  return arr.slice(start, end + 1);
}

// ─── Fast canvas spectrum renderer ───────────────────────────────────────────
// Replaces Recharts ComposedChart for the spectrum plot.
// Direct canvas 2D is ~100× faster than SVG reconciliation for zoom/pan.

interface SpectrumCanvasProps {
  freqMhz:   number[];
  PsDbfs:    number[];
  xMin:      number;
  xMax:      number;
  yMin:      number;
  yMax:      number;
  xUnit:     string;
  markers:   Array<{ mhz: number; color: string; label: string; rotate?: boolean }>;
  zones:     Array<{ x1: number; x2: number }>;         // yellow avoidance zones
  threshDb?: number;                                     // optional horizontal ref line
}

function drawSpectrumCanvas(
  canvas: HTMLCanvasElement,
  props: SpectrumCanvasProps,
) {
  const { freqMhz, PsDbfs, xMin, xMax, yMin, yMax, xUnit, markers, zones, threshDb } = props;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth  || 800;
  const H = canvas.clientHeight || 400;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  // Layout
  const pad = { top: 12, right: 16, bottom: 36, left: 52 };
  const pw = W - pad.left - pad.right;
  const ph = H - pad.top  - pad.bottom;
  if (pw <= 0 || ph <= 0) return;

  const toX = (f: number) => pad.left + ((f - xMin) / (xMax - xMin)) * pw;
  const toY = (v: number) => pad.top  + ((yMax - v) / (yMax - yMin)) * ph;

  // Background
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, W, H);

  // Avoidance zones
  ctx.fillStyle = 'rgba(251,191,36,0.08)';
  for (const z of zones) {
    const x1 = Math.max(toX(z.x1), pad.left);
    const x2 = Math.min(toX(z.x2), pad.left + pw);
    if (x2 > x1) ctx.fillRect(x1, pad.top, x2 - x1, ph);
  }

  // Grid lines
  ctx.strokeStyle = '#1F2937';
  ctx.lineWidth = 0.5;
  const xSpan = xMax - xMin; const ySpan = yMax - yMin;
  const rawXStep = xSpan / 6;
  const xMag = Math.pow(10, Math.floor(Math.log10(rawXStep)));
  const xNorm = rawXStep / xMag;
  const xStep = (xNorm < 1.5 ? 1 : xNorm < 3.5 ? 2 : xNorm < 7.5 ? 5 : 10) * xMag;
  const yStep = ySpan <= 30 ? 5 : 10;

  for (let v = Math.ceil(xMin / xStep) * xStep; v <= xMax + xStep * 0.01; v += xStep) {
    const x = toX(v); ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + ph); ctx.stroke();
  }
  for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax + 0.1; v += yStep) {
    const y = toY(v); ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + pw, y); ctx.stroke();
  }

  // Threshold line
  if (threshDb !== undefined && threshDb > yMin && threshDb < yMax) {
    ctx.strokeStyle = '#F59E0B'; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
    const y = toY(threshDb); ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + pw, y); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Spectrum line — only render points in view (with 2-point margin)
  let lo = 0, hi = freqMhz.length - 1;
  while (lo < hi - 1 && freqMhz[lo + 1] < xMin) lo++;
  while (hi > lo + 1 && freqMhz[hi - 1] > xMax) hi--;

  ctx.strokeStyle = '#6366F1'; ctx.lineWidth = 1.5; ctx.setLineDash([]);
  ctx.beginPath();
  let penDown = false;
  for (let i = lo; i <= hi; i++) {
    const v = PsDbfs[i];
    if (!isFinite(v) || isNaN(v)) { penDown = false; continue; }
    const x = toX(freqMhz[i]);
    const y = toY(Math.max(yMin, Math.min(yMax, v)));
    if (!penDown) { ctx.moveTo(x, y); penDown = true; } else { ctx.lineTo(x, y); }
  }
  ctx.stroke();

  // Markers — circle at the actual peak + label above it, no vertical line
  ctx.setLineDash([]);
  for (const m of markers) {
    if (m.mhz < xMin - (xMax - xMin) * 0.02 || m.mhz > xMax + (xMax - xMin) * 0.02) continue;
    const x = toX(m.mhz);
    if (x < pad.left - 2 || x > pad.left + pw + 2) continue;

    // Find closest bin to get the actual peak y position
    let bestBin = 0;
    let bestDist = Infinity;
    for (let i = 0; i < freqMhz.length; i++) {
      const d = Math.abs(freqMhz[i] - m.mhz);
      if (d < bestDist) { bestDist = d; bestBin = i; }
      if (freqMhz[i] > m.mhz + bestDist * 2) break;
    }
    const ps = PsDbfs[bestBin];
    const y  = isFinite(ps) ? toY(Math.max(yMin, Math.min(yMax, ps))) : pad.top + 12;

    // Circle marker at the peak
    ctx.fillStyle = m.color;
    ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill();
    // White ring outline for visibility against the spectrum line
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.stroke();

    // Label above the circle — small semi-transparent background for legibility
    const labelY = Math.max(pad.top + 10, y - 10);
    ctx.font = 'bold 8.5px ui-monospace,monospace';
    const tw = ctx.measureText(m.label).width;
    ctx.fillStyle = 'rgba(10,12,18,0.72)';
    ctx.fillRect(x - tw / 2 - 2, labelY - 8, tw + 4, 10);
    ctx.fillStyle = m.color;
    ctx.textAlign = 'center';
    ctx.fillText(m.label, x, labelY);
  }
  ctx.setLineDash([]);

  // Axes
  ctx.strokeStyle = '#4B5563'; ctx.lineWidth = 1; ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, pad.top + ph); ctx.lineTo(pad.left + pw, pad.top + ph); ctx.stroke();

  // X ticks + labels
  ctx.fillStyle = '#9CA3AF'; ctx.font = '10px ui-sans-serif,sans-serif'; ctx.textAlign = 'center';
  for (let v = Math.ceil(xMin / xStep) * xStep; v <= xMax + xStep * 0.01; v += xStep) {
    const x = toX(v);
    const label = xUnit === 'Hz' ? `${(v * 1e6).toFixed(0)}` : xUnit === 'kHz' ? `${(v * 1e3).toFixed(1)}` : v.toFixed(1);
    ctx.fillText(label, x, pad.top + ph + 14);
  }
  ctx.fillText(`Frequency (${xUnit})`, pad.left + pw / 2, H - 4);

  // Y ticks + labels
  ctx.textAlign = 'right';
  for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax + 0.1; v += yStep) {
    const y = toY(v); ctx.fillText(v.toFixed(0), pad.left - 4, y + 3);
  }
  // Y axis label (rotated)
  ctx.save(); ctx.translate(10, pad.top + ph / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.fillText('Power (dBFS)', 0, 0); ctx.restore();
}

function SpectrumCanvas({ freqMhz, PsDbfs, xDomMin, xDomMax, yDomMin, yDomMax, xUnit, markers, zones, threshDb }: {
  freqMhz: number[]; PsDbfs: number[];
  xDomMin: number; xDomMax: number; yDomMin: number; yDomMax: number;
  xUnit: string;
  markers: Array<{ mhz: number; color: string; label: string; rotate?: boolean }>;
  zones:   Array<{ x1: number; x2: number }>;
  threshDb?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef<number | null>(null);

  useEffect(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (!canvasRef.current) return;
      drawSpectrumCanvas(canvasRef.current, {
        freqMhz, PsDbfs, xMin: xDomMin, xMax: xDomMax,
        yMin: yDomMin, yMax: yDomMax, xUnit, markers, zones, threshDb,
      });
    });
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  });  // run every render (props always fresh)

  // Resize observer so canvas redraws if the container resizes
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!canvasRef.current) return;
      drawSpectrumCanvas(canvasRef.current, {
        freqMhz, PsDbfs, xMin: xDomMin, xMax: xDomMax,
        yMin: yDomMin, yMax: yDomMax, xUnit, markers, zones, threshDb,
      });
    });
    ro.observe(el); return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={containerRef} className="flex-1 min-h-0 min-w-0" style={{ minHeight: 300 }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}

// ─── End SpectrumCanvas ───────────────────────────────────────────────────────

function MainSpectrumFigure({ data, controls }: { data: unknown; controls: Record<string, any> }) {
  const fd = data as SmeasFigureData;
  const r = fd.results;
  const yFloor = (controls.yFloor as number) ?? -160;
  const showHarmonics = (controls.showHarmonics as boolean) ?? true;
  const showTiSpurs   = (controls.showTiSpurs   as boolean) ?? true;
  const rmhz = fd.sfdrLeakageAvoidanceRadiusMhz ?? 0;
  const xMax = (fd.fsHz / 1e9 * 1000) / 2;

  // Adaptive tick step — gives ~5-8 ticks regardless of frequency range
  // (works from sub-Hz through GHz without hard-coding 100 MHz steps).
  function adaptiveTickStep(max: number): number {
    if (max <= 0) return 1;
    const raw = max / 6;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
    return step * mag;
  }
  // Axis label formatter: show Hz/kHz when xMax is sub-MHz
  function fmtFreqTick(v: number): string {
    if (xMax < 0.001) return `${(v * 1e6).toFixed(0)}`;
    if (xMax < 1)     return `${(v * 1e3).toFixed(2)}`;
    return v.toFixed(0);
  }
  const xAxisUnit = xMax < 0.001 ? 'Hz' : xMax < 1 ? 'kHz' : 'MHz';
  // Label for a single frequency value in legend / annotations
  function fmtFreqLabel(v: number): string {
    if (xMax < 0.001) return `${(v * 1e6).toFixed(1)}Hz`;
    if (xMax < 1)     return `${(v * 1e3).toFixed(3)}kHz`;
    return `${v.toFixed(4)}MHz`;
  }


  const finiteVals = r.PsDbfs.filter((v: number) => isFinite(v) && !isNaN(v));
  const finiteMin1 = finiteVals.reduce((a: number, b: number) => b < a ? b : a, Infinity);
  const yMinAuto = finiteVals.length > 0 ? Math.floor(finiteMin1 / 10) * 10 : -150;
  const yMin = Math.max(yFloor, yMinAuto);

  // Apply data-zoom from FigureViewer (__xC, __yC, __zoom in controls)
  const [xDomMin, xDomMax] = applyZoomDomain(0, xMax, controls, 'x');
  const [yDomMin, yDomMax] = applyZoomDomain(yMin, 10, controls, 'y');

  const xTickStep = adaptiveTickStep(xDomMax - xDomMin);
  const xTickBase = Math.ceil(xDomMin / xTickStep) * xTickStep;
  const xTicks: number[] = [];
  for (let v = xTickBase; v <= xDomMax + xTickStep * 0.01; v += xTickStep) xTicks.push(+v.toPrecision(10));
  const yTicks: number[] = [];
  for (let v = Math.ceil(yDomMin / 10) * 10; v <= yDomMax + 1; v += 10) yTicks.push(v);

  const markerTargets: any[] = [];
  markerTargets.push({ mhz: r.fundMhz,    label: `${r.isDual ? 'F1' : 'H1'} ${fmtFreqLabel(r.fundMhz)}`,    color: '#EF4444' });
  if (r.isDual && r.fund2Bin > 0 && isFinite(r.fund2Dbfs))
    markerTargets.push({ mhz: r.fund2Mhz,    label: `F2 ${fmtFreqLabel(r.fund2Mhz)}`,    color: '#F97316' });
  if (r.isDual && isFinite(r.im3Dbc))
    markerTargets.push({ mhz: r.im3Mhz,    label: `IM3 ${r.im3Dbc.toFixed(1)}dBc`,    color: '#EAB308', rotate: true });
  if (showHarmonics && r.imEntriesVisible)
    (r.imEntriesVisible as any[]).forEach((h: any) => markerTargets.push({ mhz: h.mhz, label: h.symbol, color: '#A855F7', rotate: true }));
  if (showTiSpurs && r.tiSpurEntries)
    (r.tiSpurEntries as any[]).filter((ti: any) => isFinite(ti.dbfs))
      .forEach((ti: any) => markerTargets.push({ mhz: ti.mhz, label: ti.label, color: '#06B6D4', shape: 'triangle' }));
  if (r.sfdrBin !== undefined && r.sfdrBin >= 0)
    markerTargets.push({ mhz: r.sfdrMhz,    label: 'SFDR',    color: '#22C55E' });
  if (isFinite(r.sfdrWoTiDbcs) && r.sfdrWoTiBin !== r.sfdrBin)
    markerTargets.push({ mhz: r.sfdrWoTiMhz,    label: `SFDR_woTI`,    color: '#2563EB', small: true});


  const imArr: any[] = (showHarmonics && r.imEntriesVisible) ? r.imEntriesVisible as any[] : [];
  const orderSuffix = (n: number) => n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
  const harmLegendStr = imArr.length === 0 ? '' :
  imArr.length === 1
    ? `${orderSuffix(imArr[0].order)} order`
    : `${orderSuffix(imArr[0].order)}…${orderSuffix(imArr[imArr.length - 1].order)} order`;

  const legendItems: { color: string; label: string; marker?: string }[] = [
  { color: '#6366F1', label: 'Spectrum' },
  { color: '#EF4444', label: `${r.isDual ? 'F1' : 'H1'} ${fmtFreqLabel(r.fundMhz)}` },
  ...(r.isDual && isFinite(r.fund2Mhz) ? [{ color: '#F97316', label: `F2 ${fmtFreqLabel(r.fund2Mhz)}` }] : []),
  ...(r.isDual && isFinite(r.im3Dbc)   ? [{ color: '#EAB308', label: `IM3 ${r.im3Dbc.toFixed(1)}dBc` }] : []),
  { color: '#22C55E', label: `SFDR ${r.sfdrDbcs.toFixed(2)}dBc @ ${r.sfdrMhz.toFixed(2)} MHz` },
  ...(isFinite(r.sfdrWoTiDbcs) && r.sfdrWoTiBin !== r.sfdrBin
    ? [{ color: '#2563EB', label: `SFDR_woTI ${r.sfdrWoTiDbcs.toFixed(2)}dBc @ ${r.sfdrWoTiMhz.toFixed(2)}MHz [${r.sfdrWoTiLabel ?? ''}]` }] : []),
  ...(imArr.length > 0 ? [{ color: '#A855F7', label: `Harmonics/IM (${harmLegendStr})` }] : []),
  ...(showHarmonics && r.imEntriesBelowThreshold && r.imEntriesBelowThreshold.length > 0
    ? [{ color: '#6B7280', label: `${r.imEntriesBelowThreshold.length} spur(s) below noise threshold` }] : []),
  ...(showTiSpurs && r.tiSpurEntries && r.tiSpurEntries.length > 0
    ? [{ color: '#06B6D4', label: `TI spurs (${r.numberOfCores} cores)`, marker: 'triangle' }] : []),
  ...(rmhz > 0 ? [{ color: 'rgba(251,191,36,0.35)', label: `SFDR detection forbidden zone (±${rmhz} MHz around fund/DC/Nyquist)`, marker: 'area' }] : []),
  ];

  return (
    <div className="w-full h-full bg-gray-900 rounded-lg p-3 flex flex-col" style={{ minHeight: 480 }}>
      <div className="text-sm text-gray-300 font-semibold mb-2 text-center shrink-0">
        Spectrum — ENOB={r.enobSndrFs.toFixed(2)}bits Fund={fmtFreqLabel(r.fundMhz)}  SFDR={r.sfdrDbcs.toFixed(2)}dBc
        {r._autoWindowUsed && <span className="ml-2 text-teal-400 text-xs font-normal">(auto → {r._autoWindowUsed})</span>}
        {r.usedDft === true && <span className="ml-2 text-amber-400 text-xs font-normal">(⚠ DFT used — N={fd.fftLength} is not a power of 2, analysis is slow)</span>}
      </div>
      {fd.warning && (
        <div className="mb-2 px-3 py-2 bg-amber-900/40 border border-amber-500/60 rounded text-amber-300 text-xs font-mono shrink-0">
          ⚠ {fd.warning}
        </div>
      )}
      <div className="flex gap-3 flex-1 min-h-0">
        <div className="flex-1 min-w-0 flex flex-col" style={{ minHeight: 400 }}>
          <SpectrumCanvas
            freqMhz={r.freqMhz} PsDbfs={r.PsDbfs}
            xDomMin={xDomMin} xDomMax={xDomMax}
            yDomMin={yDomMin} yDomMax={yDomMax}
            xUnit={xAxisUnit}
            markers={markerTargets}
            zones={[
              { x1: 0, x2: Math.min(rmhz, xMax) },
              { x1: Math.max(0, r.fundMhz - rmhz), x2: Math.min(xMax, r.fundMhz + rmhz) },
              ...(r.isDual && r.fund2Mhz > 0 ? [{ x1: Math.max(0, r.fund2Mhz - rmhz), x2: Math.min(xMax, r.fund2Mhz + rmhz) }] : []),
              { x1: Math.max(0, xMax - rmhz), x2: xMax },
              // TI spur avoidance zones — only for windowed captures (non-rectangular)
              ...(r.windowType && r.windowType !== 'rectangular'
                ? [...(r.tiSpurEntries ?? []), ...(r.tiSpurEntries2 ?? [])].map((ti: any) => ({
                    x1: Math.max(0, (r.freqMhz[ti.bin] ?? 0) - rmhz),
                    x2: Math.min(xMax, (r.freqMhz[ti.bin] ?? 0) + rmhz),
                  }))
                : []),
            ]}
            threshDb={r.spursMinThresholdEn && isFinite(r.spursMinDbfs) && r.spursMinDbfs !== 0 ? r.spursMinDbfs : undefined}
          />
          <LegendStrip items={legendItems} />
        </div>
        <ResultsPanel r={r} fsHz={fd.fsHz} sfdrLeakageAvoidanceRadiusMhz={rmhz} showWoTi={true} />
      </div>
    </div>
  );
}

function TiDeembeddedFigure({ data, controls }: { data: unknown; controls: Record<string, any> }) {
  const fd = data as SmeasFigureData;
  const r = fd.results;
  if (!r.numberOfCores || r.numberOfCores <= 1) {
    return (
      <div className="w-full h-64 bg-gray-900 rounded-lg flex items-center justify-center text-gray-400 text-sm">
        TI de-embedded spectrum only available when Number of Cores &gt; 1
      </div>
    );
  }
  const rmhz = fd.sfdrLeakageAvoidanceRadiusMhz ?? 0;
  const xMax = (fd.fsHz / 1e9 * 1000) / 2;

  const MAX_PTS = 4000;
  const step = r.freqMhz.length > MAX_PTS ? Math.ceil(r.freqMhz.length / MAX_PTS) : 1;

  // Pin bins that must always be in chartData so stampMarkers can find them
  const pinnedBins = new Set<number>([
    r.fundBin,
    r.sfdrWoTiBin,
    ...(r.imEntriesVisible ?? []).map((e: any) => e.bin),
    ...(r.tiSpurEntries ?? []).map((e: any) => e.bin),
  ].filter((b: number) => b >= 0 && b < r.freqMhz.length));

  const chartData: { f: number; ps: number | null; [k: string]: any }[] = [];
  for (let i = 0; i < r.freqMhz.length; i += step) {
    const v = r.PsDbfsWoTi[i];
    chartData.push({ f: r.freqMhz[i], ps: (isNaN(v) || !isFinite(v)) ? null : v });
  }
  // Insert pinned bins skipped by the step
  for (const bin of pinnedBins) {
    if (bin % step !== 0) {
      const v = r.PsDbfsWoTi[bin];
      const pt = { f: r.freqMhz[bin], ps: (isNaN(v) || !isFinite(v)) ? null : v };
      let ins = 0;
      while (ins < chartData.length && chartData[ins].f < pt.f) ins++;
      chartData.splice(ins, 0, pt);
    }
  }

  const finiteVals = r.PsDbfsWoTi.filter((v: number) => isFinite(v) && !isNaN(v));
  const finiteMin2 = finiteVals.reduce((a: number, b: number) => b < a ? b : a, Infinity);
  const yMin = finiteVals.length > 0 ? Math.floor(finiteMin2 / 10) * 10 : -150;

  const [xDomMin, xDomMax] = applyZoomDomain(0, xMax, controls, 'x');
  const [yDomMin, yDomMax] = applyZoomDomain(yMin, 10, controls, 'y');

  const xTickStepTi = (() => {
    const span = xDomMax - xDomMin;
    if (span <= 0) return 1;
    const raw = span / 6;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
  })();
  const xTicks: number[] = [];
  for (let v = Math.ceil(xDomMin / xTickStepTi) * xTickStepTi; v <= xDomMax + xTickStepTi * 0.01; v += xTickStepTi) xTicks.push(+v.toPrecision(10));
  const yTicks: number[] = [];
  for (let v = Math.ceil(yDomMin / 10) * 10; v <= yDomMax + 1; v += 10) yTicks.push(v);

  const xAxisUnitTi = xMax < 0.001 ? 'Hz' : xMax < 1 ? 'kHz' : 'MHz';
  const fmtFTi = (v: number) => xMax < 0.001 ? `${(v*1e6).toFixed(1)}Hz` : xMax < 1 ? `${(v*1e3).toFixed(3)}kHz` : `${v.toFixed(4)}MHz`;

  const harmArr: any[] = r.imEntriesVisible ? r.imEntriesVisible as any[] : [];
  const harmLegend = harmArr.length === 0 ? '' :
    harmArr.length === 1 ? `H${harmArr[0].order}` :
    `H${harmArr[0].order}…H${harmArr[harmArr.length - 1].order}`;

  const tiArr: any[] = r.tiSpurEntries ? r.tiSpurEntries as any[] : [];
  const tiLegend = tiArr.length <= 2
    ? tiArr.map((t: any) => t.label).join(', ')
    : `${tiArr[0].label}…${tiArr[tiArr.length - 1].label}`;

  const fmtF = fmtFTi; // alias kept for legend items below

  // ── Stamp markers onto chartData ──────────────────────────────────────────
  // Fund1, SFDR_woTI, harmonics — same as main figure but using PsDbfsWoTi values
  const markerTargetsTi: any[] = [];
  markerTargetsTi.push({ mhz: r.fundMhz,    label: `H1 ${fmtF(r.fundMhz)}`,    color: '#EF4444' });
  if (isFinite(r.sfdrWoTiDbcs))
    markerTargetsTi.push({ mhz: r.sfdrWoTiMhz, label: `SFDR_woTI`, color: '#2563EB' });
  if (harmArr.length > 0)
    harmArr.forEach((h: any) => markerTargetsTi.push({ mhz: h.mhz, label: h.symbol, color: '#A855F7', rotate: true }));
  stampMarkers(chartData, markerTargetsTi);

  const legendItems: { color: string; label: string; marker?: string }[] = [
    { color: '#6366F1', label: 'Spectrum (TI spurs removed)' },
    { color: '#EF4444', label: `H1 @ ${fmtF(r.fundMhz)}` },
    ...(harmArr.length > 0 ? [{ color: '#A855F7', label: `Harmonics (${harmLegend}) — visible, not removed` }] : []),
    ...(isFinite(r.sfdrWoTiDbcs)
      ? [{ color: '#2563EB', label: `SFDR_woTI ${r.sfdrWoTiDbcs.toFixed(2)}dBc @ ${fmtF(r.sfdrWoTiMhz)} [${r.sfdrWoTiLabel ?? ''}]` }] : []),
    ...(tiArr.length > 0 ? [{ color: '#9CA3AF', label: `TI spurs zeroed (${tiLegend})` }] : []),
  ];

  return (
    <div className="w-full h-full bg-gray-900 rounded-lg p-3 flex flex-col" style={{ minHeight: 480 }}>
      <div className="text-sm text-gray-300 font-semibold mb-2 text-center shrink-0">
        Spectrum (TI spurs removed) — SFDR_woTI={r.sfdrWoTiDbcs.toFixed(2)}dBc
      </div>
      <div className="flex gap-3 flex-1 min-h-0">
        <div className="flex-1 min-w-0 flex flex-col" style={{ minHeight: 400 }}>
          <SpectrumCanvas
            freqMhz={r.freqMhz} PsDbfs={r.PsDbfsWoTi}
            xDomMin={xDomMin} xDomMax={xDomMax}
            yDomMin={yDomMin} yDomMax={yDomMax}
            xUnit={xAxisUnitTi}
            markers={markerTargetsTi}
            zones={[
              { x1: 0, x2: Math.min(rmhz, xMax) },
              { x1: Math.max(0, r.fundMhz - rmhz), x2: Math.min(xMax, r.fundMhz + rmhz) },
              ...(r.isDual && r.fund2Mhz > 0 ? [{ x1: Math.max(0, r.fund2Mhz - rmhz), x2: Math.min(xMax, r.fund2Mhz + rmhz) }] : []),
              { x1: Math.max(0, xMax - rmhz), x2: xMax },
              // TI spur avoidance zones (both sets) — only for windowed captures
              ...(r.windowType && r.windowType !== 'rectangular'
                ? ([...(r.tiSpurEntries ?? []), ...(r.tiSpurEntries2 ?? [])].map((ti: any) => ({
                    x1: Math.max(0, (r.freqMhz[ti.bin] ?? 0) - rmhz),
                    x2: Math.min(xMax, (r.freqMhz[ti.bin] ?? 0) + rmhz),
                  })))
                : []),
            ]}
          />
          <LegendStrip items={legendItems} />
        </div>
        <ResultsPanel r={r} fsHz={fd.fsHz} sfdrLeakageAvoidanceRadiusMhz={rmhz} showWoTi={true} />
      </div>
    </div>
  );
}

function NoiseSpectrumFigure({ data, controls }: { data: unknown; controls: Record<string, any> }) {
  const fd = data as SmeasFigureData;
  const r = fd.results;

  if (!r.PsDbfsNoise) {
    return (
      <div className="w-full h-64 bg-gray-900 rounded-lg flex items-center justify-center text-gray-400 text-sm">
        Please re-run analysis to generate the noise spectrum.
      </div>
    );
  }

  const xMax = (fd.fsHz / 1e9 * 1000) / 2;
  const MAX_PTS = 4000;
  const step = r.freqMhz.length > MAX_PTS ? Math.ceil(r.freqMhz.length / MAX_PTS) : 1;
  const chartData: { f: number; ps: number | null }[] = [];
  for (let i = 0; i < r.freqMhz.length; i += step) {
    const v = r.PsDbfsNoise[i];
    chartData.push({ f: r.freqMhz[i], ps: (isNaN(v) || !isFinite(v)) ? null : v });
  }

  const finiteVals = r.PsDbfsNoise.filter((v: number) => isFinite(v) && !isNaN(v));
  const finiteMin3 = finiteVals.reduce((a: number, b: number) => b < a ? b : a, Infinity);
  const yMin = finiteVals.length > 0 ? Math.floor(finiteMin3 / 10) * 10 : -150;

  const [xDomMin, xDomMax] = applyZoomDomain(0, xMax, controls, 'x');
  const [yDomMin, yDomMax] = applyZoomDomain(yMin, 10, controls, 'y');

  const xTickStep2 = (() => {
    const span = xDomMax - xDomMin;
    if (span <= 0) return 1;
    const raw = span / 6;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
  })();
  const xTicks: number[] = [];
  for (let v = Math.ceil(xDomMin / xTickStep2) * xTickStep2; v <= xDomMax + xTickStep2 * 0.01; v += xTickStep2) xTicks.push(+v.toPrecision(10));
  const yTicks: number[] = [];
  for (let v = Math.ceil(yDomMin / 10) * 10; v <= yDomMax + 1; v += 10) yTicks.push(v);

  const xAxisLabel2 = xMax < 0.001 ? 'Hz' : xMax < 1 ? 'kHz' : 'MHz';
  const fmtF = (v: number) => xMax < 0.001 ? `${(v*1e6).toFixed(1)}Hz` : xMax < 1 ? `${(v*1e3).toFixed(3)}kHz` : `${v.toFixed(4)}MHz`;

  const harmArr: any[] = r.harmonicEntries ? r.harmonicEntries as any[] : [];
  const harmLegend = harmArr.length === 0 ? '' :
    harmArr.length === 1 ? `H${harmArr[0].order}` :
    `H${harmArr[0].order}…H${harmArr[harmArr.length - 1].order}`;

  const tiArr: any[] = r.tiSpurEntries ? r.tiSpurEntries as any[] : [];
  const tiLegend = tiArr.length <= 2
    ? tiArr.map((t: any) => t.label).join(', ')
    : `${tiArr[0].label}…${tiArr[tiArr.length - 1].label}`;

  const legendItems: { color: string; label: string; marker?: string }[] = [
    { color: '#34D399', label: 'Noise floor (fund/harm/TI removed)' },
    { color: '#EF4444', label: `H1 removed @ ${fmtF(r.fundMhz)}` },
    ...(harmArr.length > 0 ? [{ color: '#A855F7', label: `Harmonics removed (${harmLegend})` }] : []),
    ...(isFinite(r.sfdrWoTiDbcs)
      ? [{ color: '#2563EB', label: `SFDR_woTI ${r.sfdrWoTiDbcs.toFixed(2)}dBc @ ${fmtF(r.sfdrWoTiMhz)} [${r.sfdrWoTiLabel ?? ''}]` }] : []),
  ];

  return (
    <div className="w-full h-full bg-gray-900 rounded-lg p-3 flex flex-col" style={{ minHeight: 480 }}>
      <div className="text-sm text-gray-300 font-semibold mb-2 text-center shrink-0">
        Noise Spectrum — Nrms={r.nrmsVm.toFixed(2)}mV  SNR={r.snrC.toFixed(2)}dBc
      </div>
      <div className="flex gap-3 flex-1 min-h-0">
        <div className="flex-1 min-w-0 flex flex-col" style={{ minHeight: 400 }}>
          <SpectrumCanvas
            freqMhz={r.freqMhz} PsDbfs={r.PsDbfsNoise}
            xDomMin={xDomMin} xDomMax={xDomMax}
            yDomMin={yDomMin} yDomMax={yDomMax}
            xUnit={xAxisLabel2}
            markers={[]}
            zones={[]}
          />
          <LegendStrip items={legendItems} />
        </div>
        <ResultsPanel r={r} fsHz={fd.fsHz} sfdrLeakageAvoidanceRadiusMhz={0} showWoTi={false} />
      </div>
    </div>
  );
}

// ── Figure declarations ───────────────────────────────────────────────────────
const smeasFigures: PluginFigure[] = [
  {
    id: 'spectrum',
    label: 'Spectrum (main)',
    controls: [
      { key: 'yFloor',        type: 'slider', label: 'Y floor',       min: -200, max: -20, step: 10,  default: -160, unit: 'dBFS' },
      { key: 'showHarmonics', type: 'toggle', label: 'Show harmonics',                                default: true  },
      { key: 'showTiSpurs',   type: 'toggle', label: 'Show TI spurs',                                 default: true  },
    ],
    component: MainSpectrumFigure,
  },
];

// TI and noise figures pushed after
smeasFigures.push({
  id: 'spectrum_ti_deembedded',
  label: 'Spectrum (TI spurs artificially removed)',
  component: TiDeembeddedFigure,
});

smeasFigures.push({
  id: 'spectrum_noise',
  label: 'Noise Spectrum',
  component: NoiseSpectrumFigure,
});

/**
 * _smeasRunCore — shared analysis kernel.
 * Accepts raw samples (ArrayLike<number>) + fsHz directly.
 * No File/CSV I/O — all that lives in the callers.
 * Returns both the scalar result map and the figureData + debugTables.
 */
function _smeasRunCore(
  samplesIn: ArrayLike<number>,
  fsHz: number,
  fileName: string,
  params: SmeasParams,
): {
  scalarResult: Record<string, string | number>;
  figureData: SmeasFigureData;
  debugTables: import('../../lib/pluginTypes').PluginDebugTable[];
} {
  const toneMode = (params.toneMode === 'dual' ? 'dual' : 'single') as 'single' | 'dual';
  const isTimeDomain = params.inputMode !== 'single_sided_power_spectrum';

  // Auto-snap fftLength down when the file has fewer samples than requested.
  // Rather than throwing (which crashes the pipeline entry), we reduce to the
  // largest power-of-2 that fits and record a warning in the scalar output.
  let fftLengthWarning: string | null = null;
  let effectiveFftLength = params.fftLength;
  let effectiveNumAveraging = params.numAveraging;

  if (isTimeDomain) {
    const required = effectiveFftLength * effectiveNumAveraging;
    if (required > samplesIn.length) {
      // First try reducing numAveraging to 1
      if (effectiveFftLength <= samplesIn.length) {
        fftLengthWarning =
          `numAveraging reduced from ${effectiveNumAveraging} to 1 — ` +
          `file only has ${samplesIn.length} samples (needed ${required}).`;
        effectiveNumAveraging = 1;
      } else {
        // Snap fftLength down to largest power-of-2 that fits
        let snapped = 1;
        while (snapped * 2 <= samplesIn.length) snapped *= 2;
        fftLengthWarning =
          `fftLength reduced from ${effectiveFftLength} to ${snapped} — ` +
          `file only has ${samplesIn.length} samples. ` +
          `Results will have limited frequency resolution (${snapped} points ≈ ${(snapped / samplesIn.length * 100).toFixed(0)}% of available data).`;
        effectiveFftLength = snapped;
        effectiveNumAveraging = 1;
      }
      console.warn('[smeas]', fftLengthWarning);
    }
  }

  // Apply snapped values back so the rest of the function sees them consistently
  params = { ...params, fftLength: effectiveFftLength, numAveraging: effectiveNumAveraging };

  // Only copy what is needed — avoids materialising millions of samples for large .bin files.
  const needCount = isTimeDomain ? effectiveFftLength * effectiveNumAveraging : samplesIn.length;
  const samples = Array.from({ length: Math.min(needCount, samplesIn.length) }, (_, i) => (samplesIn as any)[i] as number);

   const canRunTiCal = isTimeDomain && params.numberOfCores > 1;

   // Parse tiCorrections: accept 'OGP', 'O,G,P', or 'O G P' (or any mix)
   const parseTiCorrections = (input: string | unknown): string[] => {
     let s = String(input ?? 'none')
       .replace(/\bnone\b/gi, '')  // Remove 'none' keyword
       .toUpperCase()
       .trim();
     if (!s) return [];
     // Try splitting by comma/space first
     const initial = s.split(/[,\s]+/).filter(t => t.length > 0);
     // If we got items and all of them are in ['O','G','P'], return them
     const valid = initial.filter(t => ['O', 'G', 'P'].includes(t));
     if (valid.length > 0) return valid;
     // Otherwise treat as individual characters (e.g., 'OGP' → ['O','G','P'])
     return s.split('').filter(c => ['O', 'G', 'P'].includes(c));
   };

   const tiSteps = parseTiCorrections(params.tiCorrections);
   const tiCorrectOffset = tiSteps.includes('O');
   const tiCorrectGain   = tiSteps.includes('G');
   const tiCorrectPhase  = tiSteps.includes('P');
   const anyTiCorrection = tiSteps.length > 0;

  const rawInputSamples = isTimeDomain
    ? samples.slice(0, params.fftLength * params.numAveraging)
    : samples;

  let analysisInput: number[] = rawInputSamples;
  let tiCalResult: TiCalResult | null = null;

  if (canRunTiCal) {
    try {
      tiCalResult = measureAndCorrectTi(
        rawInputSamples,
        params.fftLength, params.numAveraging, params.numberOfCores,
        params.adcOffsetCode, params.adcNumBits,
        params.tiOffsetQuantLsb ?? 0.25,
        params.tiRefPhase ?? 0,
        tiCorrectOffset,
        tiCorrectGain,
        tiCorrectPhase,
        tiSteps.join(',') || 'O,G,P',
      );
      if (anyTiCorrection && tiCalResult.correctedCodes) analysisInput = tiCalResult.correctedCodes;
    } catch (e) {
      console.warn('SMEAS TI cal skipped:', e instanceof Error ? e.message : e);
    }
  }

  const results = (() => {
    if (String(params.window) === 'auto') {
      // ── Auto-window mode ──────────────────────────────────────────────────
      //
      // New logic (replaces "always pick highest ENOB"):
      //
      //   1. Run rectangular first — its ENOB is the baseline.
      //   2. Run every other candidate window.
      //   3. If ALL non-rectangular candidates beat rectangular → pick the one
      //      with the highest ENOB (leakage is present and windowing helps).
      //   4. If ANY non-rectangular candidate does NOT beat rectangular → return
      //      rectangular. This pattern means the signal is coherently sampled
      //      (no leakage), so windowing only hurts SNR. It is also a useful
      //      diagnostic signal: if windowing doesn't universally help, the data
      //      is coherent and rectangular is the honest choice.
      //
      const NON_RECT_CANDIDATES = AUTO_WINDOW_CANDIDATES.filter(w => w !== 'rectangular');

      const sharedArgs = [
        analysisInput, fsHz, params.vfsPeakToPeak, params.adcNumBits, params.adcOffsetCode,
        params.fftLength, params.numAveraging,
      ] as const;
      const sharedTailArgs = [
        params.harmonicsToConsider,
        Number(params.sfdrLeakageAvoidanceRadiusMhz ?? 0), params.numberOfCores,
        params.inputMode, toneMode,
        coerceBool(params.spursMinThresholdEn, true),
        params.spursMinCalcFactor ?? 1.0,
        params.spursMinDbfs ?? 0,
        Number(params.kaiserBeta ?? 8),
        -1, -1, -1,   // always use IEEE table defaults in auto mode
      ] as const;

      // Step 1: run rectangular
      let rectResults: any = null;
      try {
        rectResults = analyzeSpectrum(...sharedArgs, 'rectangular', ...sharedTailArgs);
      } catch { /* rectangular failed entirely — fall through to best-of-all */ }

      const rectEnob = rectResults?.enobSndrFs ?? -Infinity;

      // Step 2: run non-rectangular candidates; break as soon as any fails to beat rectangular
      let bestNonRect: any = null;
      let bestNonRectEnob = -Infinity;
      let bestNonRectWindow = '';
      let allNonRectBeatRect = true;

      for (const win of NON_RECT_CANDIDATES) {
        try {
          const candidate = analyzeSpectrum(...sharedArgs, win, ...sharedTailArgs);
          if (candidate.enobSndrFs <= rectEnob) {
            // This window doesn't beat rectangular — no need to try the rest
            allNonRectBeatRect = false;
            break;
          }
          if (candidate.enobSndrFs > bestNonRectEnob) {
            bestNonRectEnob   = candidate.enobSndrFs;
            bestNonRect       = candidate;
            bestNonRectWindow = win;
          }
        } catch {
          // A failing window counts as not beating rectangular — stop here
          allNonRectBeatRect = false;
          break;
        }
      }

      // Step 3/4: decide
      let chosenResults: any;
      let chosenWindow: string;

      if (rectResults && (!bestNonRect || !allNonRectBeatRect)) {
        // Some windowed results didn't beat rectangular → coherent capture; use rectangular.
        chosenResults = rectResults;
        chosenWindow  = 'rectangular';
      } else if (bestNonRect) {
        // All non-rectangular windows beat rectangular → leakage present; use best windowed.
        chosenResults = bestNonRect;
        chosenWindow  = bestNonRectWindow;
      } else if (rectResults) {
        // Nothing else worked; fall back to rectangular.
        chosenResults = rectResults;
        chosenWindow  = 'rectangular';
      } else {
        throw new Error('smeas auto-window: all window candidates failed');
      }

      chosenResults._autoWindowUsed = chosenWindow;
      return chosenResults;
    }

    // ── Normal (explicit) window ──────────────────────────────────────────────
    return analyzeSpectrum(
      analysisInput, fsHz, params.vfsPeakToPeak, params.adcNumBits, params.adcOffsetCode,
      params.fftLength, params.numAveraging, params.window, params.harmonicsToConsider,
      Number(params.sfdrLeakageAvoidanceRadiusMhz ?? 0), params.numberOfCores,
      params.inputMode, toneMode,
      coerceBool(params.spursMinThresholdEn, true),
      params.spursMinCalcFactor ?? 1.0,
      params.spursMinDbfs ?? 0,
      Number(params.kaiserBeta ?? 8),
      Number(params.winCoherentGain ?? -1),
      Number(params.winEnbw ?? -1),
      Number(params.winNHalfBins ?? -1),
    );
  })();

  // Post-analysis: warn when fundamental bin is very low — indicates only a few
  // cycles are present in the window, making SNR/ENOB essentially meaningless.
  if (results.fundBin <= 3 && results.fundBin >= 1) {
    const cycleNote =
      `Only ~${results.fundBin} cycle(s) of the fundamental are captured in ` +
      `the FFT window (${params.fftLength} pts). ` +
      `SNR/ENOB values are not meaningful with so few periods — ` +
      `capture more data or reduce fftLength to fit multiple full cycles.`;
    fftLengthWarning = fftLengthWarning ? fftLengthWarning + ' | ' + cycleNote : cycleNote;
    console.warn('[smeas]', cycleNote);
  }

  // ── Scalar result map ──────────────────────────────────────────────────────
  const sv: number[] = results.samplesVolts?.length ? Array.from(results.samplesVolts) : [];
  const sc: number[] = results.samplesCodes?.length ? Array.from(results.samplesCodes) : [];
  const tdStats = (arr: number[]) => {
    if (!arr.length) return { min: '', max: '', avg: '', vpp: '' };
    let mn = arr[0], mx = arr[0], sum = 0;
    for (const v of arr) { if (v < mn) mn = v; if (v > mx) mx = v; sum += v; }
    return { min: +mn.toFixed(4), max: +mx.toFixed(4), avg: +(sum / arr.length).toFixed(4), vpp: +(mx - mn).toFixed(4) };
  };
  const vsStats = tdStats(sv);
  const csStats = tdStats(sc);

  const scalarResult: Record<string, string | number> = {
    filename:     fileName,
    window_used:  results._autoWindowUsed ?? String(params.window),
    snr_c:        +results.snrC.toFixed(2),
    snr_fs:       +results.snrFs.toFixed(2),
    sndr_c:       +results.sndrC.toFixed(2),
    sndr_fs:      +results.sndrFs.toFixed(2),
    enob_snr_c:   +results.enobSnrC.toFixed(3),
    enob_snr_fs:  +results.enobSnrFs.toFixed(3),
    enob_sndr_c:  +results.enobSndrC.toFixed(3),
    enob_sndr_fs: +results.enobSndrFs.toFixed(3),
    thd_db:       +results.thdDb.toFixed(2),
    sfdr_dbc:     +results.sfdrDbcs.toFixed(2),
    sfdr_mhz:     +results.sfdrMhz.toFixed(4),
    sfdr_label:   results.sfdrLabel,
    ...(params.numberOfCores > 1 ? {
      sfdr_wo_ti_dbc:   +results.sfdrWoTiDbcs.toFixed(2),
      sfdr_wo_ti_mhz:   +results.sfdrWoTiMhz.toFixed(4),
      sfdr_wo_ti_label: results.sfdrWoTiLabel,
    } : {}),
    fund1_mhz:    +results.fundMhz.toFixed(4),
    fund1_dbfs:   +results.fundDbfs.toFixed(2),
    noise_rms_mv: +results.nrmsVm.toFixed(3),
    ...(toneMode === 'dual' ? {
      fund2_mhz:  isFinite(results.fund2Mhz)  ? +results.fund2Mhz.toFixed(4)  : '',
      fund2_dbfs: isFinite(results.fund2Dbfs) ? +results.fund2Dbfs.toFixed(2) : '',
      im3_dbc:    isFinite(results.im3Dbc)    ? +results.im3Dbc.toFixed(2)    : '',
      im3_mhz:    isFinite(results.im3Mhz)    ? +results.im3Mhz.toFixed(4)    : '',
    } : {}),
    vpp_volts:  vsStats.vpp,
    max_volts:  vsStats.max,
    min_volts:  vsStats.min,
    avg_volts:  vsStats.avg,
    vpp_codes:  csStats.vpp,
    max_codes:  csStats.max,
    min_codes:  csStats.min,
    avg_codes:  csStats.avg,
    ...(fftLengthWarning ? { warning: fftLengthWarning } : {}),
  };

  // ── Figure data ──────────────────────────────────────────────────────────
  const figureData: SmeasFigureData = {
    results,
    singulars: {},
    fileName,
    fftLength: params.fftLength,
    ...(fftLengthWarning ? { warning: fftLengthWarning } : {}),
    fsHz,
    sfdrLeakageAvoidanceRadiusMhz: results.effectiveRadiusMhz ?? Number(params.sfdrLeakageAvoidanceRadiusMhz ?? 0),
    numberOfCores: params.numberOfCores,
    toneMode,
    spursMinDbfs: results.spursMinDbfs,
    spursMinActive: results.spursMinThresholdEn && results.spursMinDbfs !== 0,
  };

  const r = results;

  const pd_spectra: import('../../lib/pluginTypes').PluginDebugTable = {
    id: 'spectra',
    label: 'spectra.csv (f_MHz, PS_dBFS, noise spectrum, wo-TI spurs)',
    columns: {
      f_MHz_grid:             r.freqMhz,
      f_bin_grid:             r.freqBin,
      PS_dBFS_samples:        r.PsDbfs,
      PS_dBFS_noise_spectrum: r.PsDbfsNoise.map((v: number) => isNaN(v) ? null : v),
      PS_dBFS_wo_tispurs:     r.PsDbfsWoTi.map((v: number)  => isNaN(v) ? null : v),
    },
  };

  const pd_timedomain: import('../../lib/pluginTypes').PluginDebugTable = {
    id: 'timedomain',
    label: 'time_domain.csv (samples_volts, samples_codes)',
    columns: { samples_volts: r.samplesVolts, samples_codes: r.samplesCodes },
  };

  const imEntries: any[] = r.imEntries ?? [];
  const pd_im_components: import('../../lib/pluginTypes').PluginDebugTable = {
    id: 'im_components',
    label: 'im_components.csv (harmonic / IM components)',
    columns: {
      symbol:    [toneMode === 'dual' ? 'F1' : 'H1', ...imEntries.map((e: any) => e.symbol)],
      f_im_mhz:  [r.fundMhz,  ...imEntries.map((e: any) => e.mhz)],
      f_im_bin:  [r.fundBin,  ...imEntries.map((e: any) => e.bin)],
      f_im_dbfs: [r.fundDbfs, ...imEntries.map((e: any) => e.dbfs)],
      f_im_dbc:  [0,          ...imEntries.map((e: any) => r.fundDbfs - e.dbfs)],
      f1_mhz:    Array(1 + imEntries.length).fill(r.fundMhz),
      f2_mhz:    Array(1 + imEntries.length).fill(toneMode === 'dual' ? r.fund2Mhz : null),
    },
  };

  const tiEntries:  any[] = r.tiSpurEntries  ?? [];
  const tiEntries2: any[] = r.tiSpurEntries2 ?? [];
  const pd_ti_spurs: import('../../lib/pluginTypes').PluginDebugTable = {
    id: 'ti_spurs',
    label: 'ti_spurs.csv (TI spur locations)',
    columns: tiEntries.length > 0 ? {
      TI_SPURS_label: [...tiEntries.map((t: any) => t.label),  ...tiEntries2.map((t: any) => t.label)],
      TI_SPURS_MHz:   [...tiEntries.map((t: any) => t.mhz),    ...tiEntries2.map((t: any) => t.mhz)],
      TI_SPURS_bins:  [...tiEntries.map((t: any) => t.bin),    ...tiEntries2.map((t: any) => t.bin)],
      TI_SPURS_dBFS:  [...tiEntries.map((t: any) => t.dbfs),   ...tiEntries2.map((t: any) => t.dbfs)],
      TI_SPURS_dBc:   [...tiEntries.map((t: any) => r.fundDbfs - t.dbfs),
                       ...tiEntries2.map((t: any) => (isFinite(r.fund2Dbfs) ? r.fund2Dbfs : r.fundDbfs) - t.dbfs)],
    } : {
      TI_SPURS_label: ['N/A (numberOfCores=1)'],
      TI_SPURS_MHz: [0], TI_SPURS_bins: [0], TI_SPURS_dBFS: [0], TI_SPURS_dBc: [0],
    },
  };

  let pd_ti_cal: import('../../lib/pluginTypes').PluginDebugTable | null = null;
  if (canRunTiCal && tiCalResult) {
    const es = tiCalResult.entries;
    pd_ti_cal = {
      id: 'ti_cal',
      label: 'ti_cal.csv (per-phase offset / gain / phase-skew characterisation)',
      columns: {
        nav:                       es.map(e => e.nav),
        phase:                     es.map(e => e.phase),
        epsilon_est:               es.map(e => +e.epsilonEst.toFixed(6)),
        phase_bias_rads:           es.map(e => +e.phaseBiasRads.toFixed(6)),
        offset_codes_raw:          es.map(e => +e.offsetCodesRaw.toFixed(4)),
        offset_codes_quantized:    es.map(e => +e.offsetCodesQuantized.toFixed(4)),
        gain_rms_codes_raw:        es.map(e => +e.gainRmsCodesRaw.toFixed(4)),
        gain_rms_codes_normalized: es.map(e => +e.gainRmsCodesNormalized.toFixed(6)),
        raw_angle_rads:            es.map(e => +e.rawAngleRads.toFixed(6)),
        proper_angle_rads:         es.map(e => +e.properAngleRads.toFixed(6)),
        offset_angle_rads:         es.map(e => +e.offsetAngleRads.toFixed(6)),
        ideal_angle_rads:          es.map(e => +e.idealAngleRads.toFixed(6)),
        delta_angle_rads:          es.map(e => +e.deltaAngleRads.toFixed(6)),
        delta_angle_degs:          es.map(e => +e.deltaAngleDegs.toFixed(4)),
        delta_angle_ps:            es.map(e => isFinite(e.deltaAnglePs) ? +e.deltaAnglePs.toFixed(2) : null),
        rotation_applied:          es.map(e => e.rotationApplied ? 1 : 0),
        ref_phase:                 es.map(_ => tiCalResult!.refPhase),
        correction_O:              es.map(_ => tiCorrectOffset ? 1 : 0),
        correction_G:              es.map(_ => tiCorrectGain   ? 1 : 0),
        correction_P:              es.map(_ => tiCorrectPhase  ? 1 : 0),
        correction_order:          es.map(_ => tiSteps.join(',') || 'none'),
      },
    };
  }

  return {
    scalarResult,
    figureData,
    debugTables: [pd_spectra, pd_timedomain, pd_im_components, pd_ti_spurs, ...(pd_ti_cal ? [pd_ti_cal] : [])],
  };
}


export const smeasPlugin: Plugin<SmeasParams> = {
  id: 'smeas',
  name: 'SMEAS — Sine Spectrum Analysis',
  description: manifest.description,
  manifest,
  doc: smeasDoc,

  /**
   * Declare the fs (GHz) inferred parameter — the platform will:
   *  1. Show a regex/replace input column in the file table header.
   *  2. Seed inferredParams.fsGhz per file from the filename.
   *  3. Inject the value into params.fsGhz before calling run()/prepareData().
   *  regex Breakdown:
   * (?:sample_rate|[Ff][Ss]) → matches sample_rate or fs/FS.
   * [_\-]? → optional _ or -.
   * (\d+(?:p\d+)?) → captures the number:
   * \d+ → mandatory integer part (2250)
   * (?:p\d+)? → optional decimal part (p0)
   * (?:GHz|MHz|Hz)? → optional unit.
   *
   * Examples it matches:
   * Input	Captured
   * fs2250mhz	2250
   * FS120p0MHz	120p0
   * sample_rate_44p1kHz	44p1
   * fs_96000Hz	96000
   */
  paramFields: [    // ── Column selection (type: 'column-select') ───────────────────────────────
    // Auto-seeded with the column having most unique values; falls back to 'data'.
    // Fully malleable: supports global ↔ per-file scope toggle like all params.
    {
      key: 'targetColumn',
      label: 'Signal Column',
      type: 'column-select' as const,
      required: true,
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 'data',
      defaultScope: 'global' as const,
      title: 'CSV column containing ADC codes or voltages.',
      colorClass: 'text-teal-300',
    },
    // ── Per-file: extracted from filename ──────────────────────────────────────
    {
      key: 'fsGhz',
      label: 'Sampling Rate (fs) [GHz]',
      defaultRegex: '(?:sample[_\\-]?rate|[Ff][Ss])[_\\-]?(\\d+(?:p\\d+)?(?:e[+\\-]?\\d+)?(?:GHz|MHz|kHz|Hz)?)',
      defaultReplace: '',
      defaultValue: '',
      defaultScope: 'global' as const,
      unit: 'GHz',
      colorClass: 'text-purple-300',
      title: 'Sampling frequency in GHz. When typed manually, enter the value in GHz (e.g. 2.25 for 2250 MHz). When extracted from the filename, the regex capture group should include the unit suffix (e.g. 2250MHz) — the transform auto-converts to GHz.',
      regexTitle: 'Regex to extract fs from filename. Capture group must include unit suffix for correct normalisation (e.g. 2250MHz → 2.25 GHz).',
      replaceTitle: 'Replacement pairs: from=to,… (e.g. p=. converts 2p25 → 2.25)',
      transform: (raw: string) => {
        if (!raw) return '';
        // Replace decimal encoding (p → .) before parsing
        const normalised = raw.replace(/p(?=\d)/gi, '.');
        const lc = normalised.toLowerCase();
        const parsed = parseFloat(normalised);
        if (isNaN(parsed)) return '';
        if (lc.includes('mhz')) return parsed / 1000;
        if (lc.includes('khz')) return parsed / 1e6;
        if (lc.includes('hz') && !lc.includes('ghz') && !lc.includes('mhz') && !lc.includes('khz')) return parsed / 1e9;
        // No unit or GHz → treat as GHz
        return parsed;
      },
      columnRegexParamKey: 'fsGhzColumnRegex',
      outputColumnName: 'fs_ghz',
    } satisfies InferredParamField,

    // ── Global by default: same for entire batch ───────────────────────────────
    {
      key: 'toneMode',
      label: 'Tone Mode',
      defaultRegex: '\\b(single|dual|two)(?:[_\\-]?tone)?\\b',
      defaultReplace: 'two=dual',
      defaultValue: 'single',
      defaultScope: 'global' as const,
      options: ['single', 'dual'],
      colorClass: 'text-blue-300',
      title: 'Single-tone or dual-tone analysis mode.',
      regexTitle: 'Regex to detect tone mode in filename. Matches "single", "dual", or "two" (→ "dual").',
      replaceTitle: 'Replacement pairs. Default: two=dual.',
      transform: (raw: string) => {
        const lc = raw.toLowerCase().trim();
        if (lc === 'dual' || lc === 'two') return 'dual';
        return 'single';
      },
      outputColumnName: 'tone_mode',
    } satisfies InferredParamField,

    {
      key: 'inputMode',
      label: 'Input Mode',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 'time_domain_codes',
      defaultScope: 'global' as const,
      options: ['time_domain_codes', 'time_domain_volts', 'single_sided_power_spectrum'],
      title: 'Type of data in the selected column: ADC codes, voltages, or a pre-computed dBFS spectrum.',
    } satisfies InferredParamField,

    {
      key: 'fftLength',
      label: 'FFT/DFT Length',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 8192,
      defaultScope: 'global' as const,
      step: 1,
      min: 4,
      title: 'Number of samples per transform window. Power-of-2 (e.g. 4096, 8192) uses fast FFT. Any other integer triggers a slower O(N²) DFT — a warning is shown in the plot.',
      // Warn visually when the value is not a power of 2 — signals the slow DFT path will be used.
      warningIf: (value: unknown) => { const n = Number(value); return n > 0 && (n & (n - 1)) !== 0; },
      outputColumnName: 'fft_length',
    } satisfies InferredParamField,

    {
      key: 'numAveraging',
      label: 'Averages',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 1,
      defaultScope: 'global' as const,
      min: 1,
      step: 1,
      title: 'Number of spectral averaging periods. Total signal consumed = fftLength × numAveraging.',
      outputColumnName: 'num_averaging',
    } satisfies InferredParamField,

    {
      key: 'harmonicsToConsider',
      label: 'Harmonics (H2…Hk)',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 7,
      defaultScope: 'global' as const,
      min: 0,
      max: 20,
      step: 1,
      title: 'Number of harmonics H2…Hk to detect and subtract from noise floor.',
      outputColumnName: 'harmonics',
    } satisfies InferredParamField,

    {
      key: 'adcNumBits',
      label: 'ADC Bits',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 11,
      defaultScope: 'global' as const,
      min: 1,
      max: 32,
      step: 1,
      title: 'ADC resolution in bits — used for codes↔volts conversion.',
      outputColumnName: 'adc_bits',
    } satisfies InferredParamField,

    {
      key: 'adcOffsetCode',
      label: 'ADC Offset Code / Volt',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 1023,
      defaultScope: 'global' as const,
      step: 1,
      title: 'Mid-scale offset code. Default 1023 = mid-scale for 11-bit (2^10 − 1).',
      outputColumnName: 'adc_offset_code',
    } satisfies InferredParamField,

    {
      key: 'vfsPeakToPeak',
      label: 'Full-Scale Vpp',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 2.0,
      defaultScope: 'global' as const,
      unit: 'V',
      title: 'Full-scale peak-to-peak voltage. Used for noise and power calculations.',
      outputColumnName: 'vfs_pp',
    } satisfies InferredParamField,

    {
      key: 'sfdrLeakageAvoidanceRadiusMhz',
      label: 'SFDR Avoidance Radius',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 0,
      defaultScope: 'global' as const,
      unit: 'MHz',
      title: [
        'Extra frequency radius (MHz) blanked around every central point (DC, Nyquist, fundamental(s), TI spurs).',
        'A minimum of 0.3% of fs is always enforced (e.g. 6.75 MHz at fs=2250 MHz) to prevent SFDR markers latching onto lobe leakage.',
        'Set a larger value to widen the exclusion zone further. 0 = use the 0.3% fs minimum only.',
      ].join(' '),
      colorClass: 'text-blue-300',
      regexTitle: 'Optional: regex to extract SFDR leakage radius from filename (MHz).',
      replaceTitle: 'Replacement pairs applied to extracted value.',
      transform: (raw: string) => {
        const val = parseFloat(raw.trim());
        return isNaN(val) ? 0 : val;
      },
      outputColumnName: 'sfdr_leakage_avoid_mhz',
    } satisfies InferredParamField,

    {
      key: 'numberOfCores',
      label: 'TI ADC Cores (1 - for disabling TI detections)',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 1,
      defaultScope: 'global' as const,
      min: 1,
      step: 1,
      title: 'Number of time-interleaved ADC cores. Set to 1 for non-TI ADCs. Higher values enable TI spur identification and de-embedding.',
      outputColumnName: 'num_cores',
    } satisfies InferredParamField,

    {
      key: 'window',
      label: 'Window Function',
      sectionHeader: 'Windowing & Correction Metrics',
      scopeGroup: 'windowing',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 'auto',
      defaultScope: 'global' as const,
      options: ['auto', 'rectangular', 'hann', 'hamming', 'blackman', 'blackmanharris', 'flattop', 'kaiser'],
      selectStyle: 'dropdown' as const,
      recommendedOptions: ['auto', 'rectangular'],
      disabledWhen: (p) => String(p.inputMode) === 'single_sided_power_spectrum',
      title: [
        'Window function applied to each FFT frame.',
        '• auto (default) — tries every window. If ALL windowed results beat rectangular, picks the one with the best ENOB (leakage present → windowing helps). If ANY windowed result does NOT beat rectangular, returns rectangular (coherent capture → no leakage; windowing would only hurt). The chosen window is reported in the "window_used" output column.',
        '• rectangular — no windowing; best SNR for coherent (integer-cycle) captures.',
        '• hann — good sidelobe rejection (−31 dB); IEEE 1241 general-purpose default.',
        '• hamming — slightly narrower lobe than Hann; −43 dB sidelobes.',
        '• blackman — low sidelobes (−58 dB); ENBW 1.73 bins.',
        '• blackman-harris — very low sidelobes (−92 dB); good for harmonic analysis.',
        '• flat-top — IEEE 1241 amplitude-accuracy standard; widest lobe, best amplitude flatness.',
        '• kaiser — tunable β tradeoff; β=8 matches IEEE 1241 ADC characterisation recommendation.',
        '• [greyed out for single_sided_power_spectrum — spectrum is pre-computed, windowing has no effect]',
      ].join('\n'),
    } satisfies InferredParamField,

    {
      key: 'kaiserBeta',
      label: 'Kaiser β',
      scopeGroup: 'windowing',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 8,
      defaultScope: 'global' as const,
      step: 0.5,
      min: 0,
      max: 30,
      title: [
        'Kaiser window shape parameter β (only active when Window = kaiser).',
        '  β = 0     → rectangular (no taper)',
        '  β = 5     → similar to Hamming',
        '  β = 8     → IEEE 1241 / ADC characterisation default (~92 dB sidelobes)',
        '  β = 9.5   → similar to Blackman-Harris',
        '  β = 13.3  → ~140 dB sidelobes; extreme dynamic range work',
        'Higher β = lower sidelobes but wider main lobe (more spectral leakage of signal power across bins).',
      ].join('\n'),
      disabledWhen: (p) => String(p.window) !== 'kaiser' || String(p.inputMode) === 'single_sided_power_spectrum',
    } satisfies InferredParamField,

    // ── Window correction metrics (IEEE 1057 / Harris 1978) ───────────────────
    // Shown next to the window dropdown; default to -1 = "use IEEE table value".
    {
      key: 'winCoherentGain',
      label: 'Coherent Gain',
      scopeGroup: 'windowing',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 1,
      defaultScope: 'global' as const,
      step: 0.0001,
      min: -1,
      disabledWhen: (p) => String(p.window) === 'rectangular' || String(p.window) === 'auto' || String(p.inputMode) === 'single_sided_power_spectrum',
      title: [
        'Coherent power gain = (Σw / N)². Signal amplitude is divided by √(coherentGain) to undo windowing attenuation.',
        '-1 = use IEEE table default for the selected window:',
        '  rectangular    → 1.0000',
        '  hann           → 0.2500',
        '  hamming        → 0.2700',
        '  blackman       → 0.1736',
        '  blackman-harris → 0.1360',
        '  flat-top       → 0.04652',
        '  kaiser (β=8)   → 0.4020',
      ].join('\n'),
      warningIf: (v) => { const n = Number(v); return n !== -1 && (n <= 0 || n > 1); },
    } satisfies InferredParamField,

    {
      key: 'winEnbw',
      label: 'ENBW (bins)',
      scopeGroup: 'windowing',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 1,
      defaultScope: 'global' as const,
      step: 0.001,
      min: -1,
      disabledWhen: (p) => String(p.window) === 'rectangular' || String(p.window) === 'auto' || String(p.inputMode) === 'single_sided_power_spectrum',
      title: [
        'Equivalent Noise Bandwidth (bins) = N·Σw² / (Σw)². Noise power is divided by ENBW to compensate for spectral spreading.',
        '-1 = use IEEE table default for the selected window:',
        '  rectangular    → 1.000',
        '  hann           → 1.500',
        '  hamming        → 1.363',
        '  blackman       → 1.727',
        '  blackman-harris → 2.004',
        '  flat-top       → 3.770',
        '  kaiser (β=8)   → 2.390',
      ].join('\n'),
      warningIf: (v) => { const n = Number(v); return n !== -1 && n <= 0; },
    } satisfies InferredParamField,

    {
      key: 'winNHalfBins',
      label: 'Lobe Half-bins',
      scopeGroup: 'windowing',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 0,
      defaultScope: 'global' as const,
      step: 1,
      min: -1,
      disabledWhen: (p) => String(p.window) === 'rectangular' || String(p.window) === 'auto' || String(p.inputMode) === 'single_sided_power_spectrum',
      title: [
        'Lobe integration half-width (bins each side of the peak bin). Tone power is summed over [peak − n … peak + n].',
        '-1 = use IEEE table default for the selected window:',
        '  rectangular    → 0  (single bin)',
        '  hann           → 2',
        '  hamming        → 2',
        '  blackman       → 3',
        '  blackman-harris → 4',
        '  flat-top       → 4',
        '  kaiser (β=8)   → 4',
      ].join('\n'),
      warningIf: (v) => { const n = Number(v); return n !== -1 && (n < 0 || !Number.isInteger(n)); },
    } satisfies InferredParamField,


    {
      key: 'spursMinThresholdEn',
      label: 'Enable Spur Min. Threshold',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 'true',   // 1 = enabled (boolean stored as number)
      defaultScope: 'global' as const,
      options: ['true', 'false'],
      title: 'Enable minimum threshold for spur detection (default true).',
    } satisfies InferredParamField,

    {
      key: 'spursMinCalcFactor',
      label: 'Spur Min. Calc. Factor',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 1.0,
      defaultScope: 'global' as const,
      step: 0.1,
      min: 0,
      title: 'Histogram σ multiplier for spur min. threshold (default 1.0).',
    } satisfies InferredParamField,

    {
      key: 'spursMinDbfs',
      label: 'Spur Min. Threshold (dBFS)',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 0,
      defaultScope: 'global' as const,
      unit: 'dBFS',
      title: 'Manual override for spur min. threshold; 0 = use histogram auto-calc.',
    } satisfies InferredParamField,

    // ── TI mismatch correction ────────────────────────────────────────────────
    // Separator + master selector for which corrections to apply and in what order.
    // Disabled entirely when inputMode=single_sided_power_spectrum or numberOfCores≤1.
    {
      key: 'tiCorrections',
      label: 'TI Corrections  —  none or O,G,P recommended',
      sectionHeader: 'TI Mismatch Correction',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 'none',
      defaultScope: 'global' as const,
      options: ['none', 'O', 'G', 'P', 'O,G', 'O,P', 'G,P', 'O,G,P', 'G,O,P', 'O,P,G'],
      recommendedOptions: ['none', 'O,G,P'],
      title: 'Select which corrections to apply and their order. O=Offset, G=Gain, P=Phase-skew. Empty = characterise only (no correction applied). Disabled for single_sided_power_spectrum — phase info is lost. Requires numberOfCores > 1.',
      disabledWhen: (p) => String(p.inputMode) === 'single_sided_power_spectrum' || Number(p.numberOfCores ?? 1) <= 1,
    } satisfies InferredParamField,

    {
      key: 'tiRefPhase',
      label: 'TI Reference Phase',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 0,
      defaultScope: 'global' as const,
      min: 0,
      step: 1,
      title: 'Reference phase index (0-based). All other cores align their offset, gain, and phase to this core. Default 0.',
      disabledWhen: (p) => String(p.inputMode) === 'single_sided_power_spectrum' || Number(p.numberOfCores ?? 1) <= 1,
    } satisfies InferredParamField,

    {
      key: 'tiOffsetQuantLsb',
      label: 'TI Offset Quantization',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 0.25,
      defaultScope: 'global' as const,
      step: 0.25,
      min: 0.0625,
      unit: 'LSB',
      title: 'Offset correction quantization step in LSBs. Prevents unrealistically perfect correction (matches real DAC resolution). Default 0.25 LSB.',
      disabledWhen: (p) => String(p.inputMode) === 'single_sided_power_spectrum' || Number(p.numberOfCores ?? 1) <= 1,
    } satisfies InferredParamField,
  ],

  defaultParams: {
    targetColumn: '',   // populated at runtime from columnRequirements selection
    fsGhzColumnRegex: '',
    fsGhzRegex: '(?:sample[_\\-]?rate|[Ff][Ss])[_\\-]?(\\d+(?:p\\d+)?(?:e[+\\-]?\\d+)?(?:GHz|MHz|kHz|Hz)?)',
    fsGhzReplace: '',
    inputMode: 'time_domain_codes' as const,
    fftLength: 8192,
    numAveraging: 1,
    adcNumBits: 11,
    adcOffsetCode: 1023,
    vfsPeakToPeak: 2.0,
    window: 'auto' as const,
    kaiserBeta: 8,
    winCoherentGain: 1,
    winEnbw: 1,
    winNHalfBins: 0,
    harmonicsToConsider: 7,
    numberOfCores: 1,
    spursMinThresholdEn: true,
    spursMinCalcFactor: 1.0,
    spursMinDbfs: 0,
    tiCorrections: 'none',
    tiRefPhase: 0,
    tiOffsetQuantLsb: 0.25,
  },


  outputColumns: [
    'window_used',
    'snr_c', 'snr_fs', 'sndr_c', 'sndr_fs',
    'enob_snr_c', 'enob_snr_fs', 'enob_sndr_c', 'enob_sndr_fs',
    'thd_db', 'sfdr_dbc', 'sfdr_mhz', 'sfdr_label',
    'sfdr_wo_ti_dbc', 'sfdr_wo_ti_mhz', 'sfdr_wo_ti_label',
    'fund1_mhz', 'fund1_dbfs', 'noise_rms_mv',
    'fund2_mhz', 'fund2_dbfs', 'im3_dbc', 'im3_mhz',
    'vpp_volts', 'max_volts', 'min_volts', 'avg_volts',
    'vpp_codes', 'max_codes', 'min_codes', 'avg_codes',
  ],

  getIngestHints: (params: SmeasParams) => smeasIngestHints(params),

  onParamChange: (changedKey: string, params: SmeasParams): Partial<SmeasParams> | null => {
    if (changedKey !== 'window') return null;
    // 'auto' manages its own correction metrics at runtime — don't overwrite them.
    if (String(params.window) === 'auto') return null;
    const p = WINDOW_PROPS[String(params.window)] ?? WINDOW_PROPS['rectangular'];
    // Always return the IEEE table values — never -1 — so per-file cells show
    // the correct metric for the chosen window instead of the sentinel placeholder.
    return {
      winCoherentGain: p.coherentGain,
      winEnbw:         p.enbw,
      winNHalfBins:    p.nHalfBins,
    };
  },

  run: async (file: File, params: SmeasParams): Promise<Record<string, string | number>> => {
    // Thin shim: delegate all I/O to the ingestion layer, then call the pure kernel.
    params = {
      ...params,
      fftLength:     Math.max(4, Math.round(parseFftLength(params.fftLength) || 8192)),
      numAveraging:  Math.max(1, Math.round(Number(params.numAveraging)  || 1)),
      numberOfCores: Math.max(1, Math.round(Number(params.numberOfCores) || 1)),
    };
    const packet = await ingestFile(file, smeasIngestHints(params));
    params = smeasAutoSeedFromPacket(params, packet);
    const fsHz   = resolveFsHz(packet, params);
    const { scalarResult } = _smeasRunCore(packet.waveform, fsHz, file.name, params);
    return scalarResult;
  },

  runFromWaveform: async (packet, params: SmeasParams) => {
    params = smeasAutoSeedFromPacket({
      ...params,
      fftLength:     Math.max(4, Math.round(parseFftLength(params.fftLength) || 8192)),
      numAveraging:  Math.max(1, Math.round(Number(params.numAveraging)  || 1)),
      numberOfCores: Math.max(1, Math.round(Number(params.numberOfCores) || 1)),
    }, packet);
    const fsHz = resolveFsHz(packet, params);
    const { scalarResult } = _smeasRunCore(packet.waveform, fsHz, packet.metadata.sourceFile ?? 'waveform', params);
    return scalarResult;
  },

  prepareDataFromWaveform: async (packet, params: SmeasParams) => {
    params = smeasAutoSeedFromPacket({
      ...params,
      fftLength:     Math.max(4, Math.round(parseFftLength(params.fftLength) || 8192)),
      numAveraging:  Math.max(1, Math.round(Number(params.numAveraging)  || 1)),
      numberOfCores: Math.max(1, Math.round(Number(params.numberOfCores) || 1)),
    }, packet);
    const fsHz = resolveFsHz(packet, params);
    const { figureData, debugTables } = _smeasRunCore(packet.waveform, fsHz, packet.metadata.sourceFile ?? 'waveform', params);
    return { figureData, debugTables };
  },

  prepareData: async (file: File, params: SmeasParams): Promise<{
    figureData?: unknown;
    debugTables?: import('../../lib/pluginTypes').PluginDebugTable[];
  }> => {
    // Thin shim: delegate all I/O to the ingestion layer, then call the pure kernel.
    params = {
      ...params,
      fftLength:     Math.max(4, Math.round(parseFftLength(params.fftLength) || 8192)),
      numAveraging:  Math.max(1, Math.round(Number(params.numAveraging)  || 1)),
      numberOfCores: Math.max(1, Math.round(Number(params.numberOfCores) || 1)),
    };
    const packet = await ingestFile(file, smeasIngestHints(params));
    params = smeasAutoSeedFromPacket(params, packet);
    const fsHz   = resolveFsHz(packet, params);
    const { figureData, debugTables } = _smeasRunCore(packet.waveform, fsHz, file.name, params);
    return { figureData, debugTables };
  },

  figures: smeasFigures,
};

