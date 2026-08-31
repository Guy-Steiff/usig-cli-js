/**
 * sinlPlugin.tsx — SINL (Sine INL/DNL) Analysis Pipeline Plugin
 *
 * Complete, self-contained plugin including:
 *   1. Okawara-T sine-histogram INL/DNL algorithm
 *   2. CSV file parsing with voltage normalization
 *   3. Recharts visualization components (PDF, DNL, INL)
 *   4. Plugin manifest and parameter handling
 *
 * Algorithm Reference: Okawara's paper on ADC sine-wave testing (Equations 27-29)
 * Ported from: inl_tool.py (Python reference implementation)
 */

/*
 * ARCHITECTURAL MIGRATION NOTE — PARAMETER / METADATA INGESTION
 *
 * PURPOSE
 * -------
 * This plugin is being migrated from the original "hooks + defaults + plugin-side
 * inference" model to the USIG architecture in which the plugin declares the
 * parameters it needs and the CLI/framework is responsible for resolving those
 * parameters from available metadata and explicit CLI -p arguments.
 *
 * This comment is intentionally detailed so that, after SINL has been converted
 * and validated, the same architectural migration can be applied to SMEAS without
 * having to reconstruct the design decisions from the implementation history.
 *
 *
 * 1. CURRENT / LEGACY ARCHITECTURE
 * --------------------------------
 *
 * The current plugin contains several overlapping parameter-description systems:
 *
 *   - manifest.paramSchema
 *       Originally describes parameters for the framework/UI. The old UI has been
 *       deprecated in favor of the CLI, so this is not the authoritative mechanism
 *       for CLI parameter resolution.
 *
 *   - plugin.defaultParams
 *       Supplies values such as inputMode="codes", minCode=0, maxCode=2047,
 *       avoidanceRadius=40, etc.
 *
 *   - plugin.paramFields
 *       Contains UI-oriented fields and, historically, defaultRegex,
 *       defaultReplace, defaultValue, defaultScope, etc.
 *
 *   - plugin-specific inference helpers
 *       e.g. sinlAutoSeedFromPacket(), plus ingest-time logic.
 *
 *   - filename inference
 *       USIG can extract information from filenames, but the old architecture
 *       did not reliably convey those inferred parameters to the plugin in a
 *       semantically explicit way.
 *
 * This creates an undesirable split of responsibility:
 *
 *   filename -> USIG inference -> parameter matching
 *                            \
 *                             plugin hooks / defaults / local inference
 *
 * The plugin therefore has knowledge about how USIG happens to represent or
 * discover metadata, rather than simply declaring what it needs.
 *
 *
 * 2. IMPORTANT DESIGN DECISION: NO GLOBAL DEFAULT PARAMETERS
 * -----------------------------------------------------------
 *
 * USIG is intentionally AGNOSTIC about plugin parameter names and values.
 *
 * There must be no framework-level assumption that:
 *
 *   "fs" means sampling frequency
 *   "adcBits" means ADC resolution
 *   "window" means a particular windowing operation
 *   "nfft" means FFT length
 *   etc.
 *
 * The meaning of a parameter belongs to the plugin that consumes it.
 *
 * Consequently, USIG must not manufacture semantic defaults for plugin
 * parameters merely because a value is convenient or historically common.
 *
 * In particular, plugin parameters which materially affect an algorithm must
 * not silently acquire framework defaults.
 *
 * A missing parameter should remain missing unless the plugin itself explicitly
 * defines that the parameter is optional and has an internally meaningful
 * algorithmic default.
 *
 * The long-term rule is:
 *
 *   USIG supplies facts.
 *   The plugin declares meanings and requirements.
 *   The plugin performs the algorithm.
 *
 * USIG must not invent facts.
 *
 *
 * 3. FILENAME INFERENCE FIX
 * --------------------------
 *
 * The repaired USIG filename-inference path now produces inferred metadata and
 * makes it available to plugin parameter resolution instead of merely displaying
 * the inference or keeping it isolated inside the CLI.
 *
 * For example, a filename containing:
 *
 *   sine_fs2p25ghz_...
 *
 * can produce an inferred parameter whose semantic information includes the
 * extracted value and its unit.
 *
 * The important architectural realization is that the filename itself is NOT
 * the contract between USIG and a plugin.
 *
 * The plugin declares what it wants.
 *
 * USIG takes available inferred facts and attempts to satisfy those declared
 * requirements.
 *
 *
 * 4. PLUGIN PARAMETERS BECOME THE AUTHORITATIVE CONTRACT
 * -------------------------------------------------------
 *
 * Each plugin should declare a parameter manifest describing every parameter
 * required or optionally accepted by its algorithm.
 *
 * This manifest is NOT merely a UI description.
 *
 * It is the machine-readable contract between USIG and the plugin.
 *
 * The manifest should describe, for each parameter:
 *
 *   - canonical key
 *   - aliases
 *   - expected semantic type
 *   - expected unit, where applicable
 *   - whether a unit is mandatory / meaningful
 *   - allowed categorical values, where applicable
 *   - numeric constraints, where applicable
 *   - whether the parameter is required
 *   - optionally, documentation intended for CLI disclosure
 *
 * Example conceptual declaration:
 *
 *   {
 *     key: 'fsGhz',
 *     aliases: ['fs', 'samplingFrequency', 'sampleRate'],
 *     type: 'number',
 *     unit: 'GHz',
 *     required: true
 *   }
 *
 * The exact TypeScript representation should follow the existing USIG plugin
 * types rather than introducing a parallel metadata system unnecessarily.
 *
 *
 * 5. ALIASES REPLACE PLUGIN-SIDE REGEX MATCHING
 * ---------------------------------------------
 *
 * Plugin parameters should NOT contain filename regexes.
 *
 * The plugin should not know whether a value originated from:
 *
 *   - filename inference
 *   - future metadata sources
 *   - CLI -p
 *   - another USIG ingestion layer
 *
 * Instead, the plugin declares aliases describing acceptable semantic names.
 *
 * Alias matching is case-insensitive / case-agnostic.
 *
 * For example:
 *
 *   aliases: ['fs', 'samplingFrequency', 'sampleRate']
 *
 * means that all of:
 *
 *   fs
 *   FS
 *   Fs
 *   samplingFrequency
 *   SamplingFrequency
 *   SAMPLE_RATE
 *   sampleRate
 *
 * can be considered candidates after canonical normalization.
 *
 * The alias list is deliberately extensible. As real datasets reveal additional
 * legitimate naming conventions, aliases can be added without changing the
 * plugin algorithm or the USIG inference engine.
 *
 * The plugin therefore says:
 *
 *   "I accept these semantic names."
 *
 * It does NOT say:
 *
 *   "Search filenames using this particular regex."
 *
 *
 * 6. USIG IR / METADATA LAYER
 * ----------------------------
 *
 * The filename inference result should be represented as structured metadata
 * in the USIG intermediate representation / metadata layer before plugin
 * execution.
 *
 * Conceptually, the flow should be:
 *
 *   input file
 *       |
 *       v
 *   ingestion
 *       |
 *       v
 *   filename / source inference
 *       |
 *       v
 *   normalized metadata / IR
 *       |
 *       v
 *   plugin parameter resolver
 *       |
 *       v
 *   resolved plugin parameter object
 *       |
 *       v
 *   plugin execution
 *
 * The plugin should receive resolved parameters, not raw filename syntax.
 *
 * Whether the concrete existing implementation calls this object an IR frame,
 * WaveformPacket metadata, or another name is secondary. The architectural
 * requirement is that inferred facts exist as structured metadata before the
 * plugin consumes them.
 *
 *
 * 7. UNITS BELONG IN THE PARAMETER CONTRACT
 * ------------------------------------------
 *
 * Every inferred variable should carry a unit field.
 *
 * This also applies to categorical / unitless parameters.
 *
 * Example:
 *
 *   nfft4
 *
 * may infer a numeric value of 4 but has no physical unit.
 *
 * The metadata representation should nevertheless contain a unit field whose
 * value represents "no unit".
 *
 * In JavaScript, the intended representation for this absence is NaN where
 * that is consistent with the surrounding IR representation.
 *
 * The important point is that "unit absent" must be represented explicitly,
 * rather than having two structurally different kinds of inferred variables.
 *
 *
 * 8. FREQUENCY UNIT NORMALIZATION
 * -------------------------------
 *
 * Unit conversion should be performed by USIG's parameter-resolution layer,
 * rather than independently by every plugin.
 *
 * For frequency, USIG should understand SI prefixes and normalize the source
 * value to a canonical base unit before satisfying a plugin's requested unit.
 *
 * The initial frequency-prefix dictionary should include:
 *
 *   Q = 1e30
 *   R = 1e27
 *   Y = 1e24
 *   Z = 1e21
 *   E = 1e18
 *   P = 1e15
 *   T = 1e12
 *   G = 1e9
 *   M = 1e6
 *   k = 1e3
 *   h = 1e2
 *   d = 1e-1
 *   c = 1e-2
 *   m = 1e-3
 *   u = 1e-6
 *   n = 1e-9
 *   p = 1e-12
 *   f = 1e-15
 *   a = 1e-18
 *   z = 1e-21
 *   y = 1e-24
 *   r = 1e-27
 *   q = 1e-30
 *
 * "da" / deka is deliberately excluded from the first implementation.
 *
 * Do NOT infer units merely from the first character of an arbitrary unit
 * string. That approach becomes ambiguous very quickly.
 *
 * Instead, frequency units should be recognized through an explicit dictionary.
 *
 * The conversion conceptually has two stages:
 *
 *   source value + source unit
 *       ->
 *   canonical base unit (Hz)
 *       ->
 *   plugin-requested unit (e.g. GHz)
 *
 * Thus:
 *
 *   2250 MHz
 *       -> 2.25e9 Hz
 *       -> 2.25 GHz
 *
 * The plugin should receive 2.25 if its declared unit is GHz.
 *
 * This keeps unit handling out of the algorithm itself.
 *
 *
 * 9. CATEGORICAL PARAMETERS
 * --------------------------
 *
 * Not every parameter is a physical quantity.
 *
 * For categorical parameters, the manifest may declare a finite set of
 * acceptable values.
 *
 * Example for SMEAS:
 *
 *   window:
 *     allowedValues:
 *       ['auto', 'hanning', 'hamming', ...]
 *
 * This is preferable to allowing arbitrary strings through to the algorithm.
 *
 * "auto" has NO universal meaning in USIG.
 *
 * It is simply one legitimate value of SMEAS's "window" parameter.
 *
 * Another plugin may legitimately define a completely different parameter
 * whose value "auto" means something else.
 *
 * Therefore USIG must never assign semantics to the word "auto".
 *
 * The semantic meaning comes entirely from the plugin manifest.
 *
 *
 * 10. STRICT VALUE VALIDATION
 * ---------------------------
 *
 * Parameter resolution should reject values which do not satisfy the plugin's
 * declared contract.
 *
 * There are two major categories:
 *
 *   categorical:
 *       value must belong to allowedValues
 *
 *   numeric:
 *       value must satisfy its declared numeric constraints
 *
 * Numeric constraints may include:
 *
 *   - integer
 *   - float / number
 *   - minimum
 *   - maximum
 *   - finite
 *   - other constraints required by the plugin
 *
 * Do not assume that a parameter named "fftLength" must necessarily be an
 * integer merely because FFT lengths are conventionally integral.
 *
 * The plugin's declared type/constraint is authoritative.
 *
 * If the implementation intentionally permits a numeric value such as 4.0
 * and JavaScript considers it numerically equal to 4, it should not be rejected
 * merely because the textual representation contains a decimal point.
 *
 * Validation should operate on the resolved semantic value, not unnecessarily
 * on its source spelling.
 *
 *
 * 11. CLI -p VALUES
 * -----------------
 *
 * CLI -p parameters and inferred filename parameters must converge on the same
 * resolution path.
 *
 * The user invoking:
 *
 *   -p key=value
 *
 * is assumed to understand the plugin's declared manifest.
 *
 * Therefore the CLI should disclose the plugin manifest / parameter contract so
 * that users can see:
 *
 *   - parameter names
 *   - aliases
 *   - expected type
 *   - expected unit
 *   - allowed categorical values
 *   - numeric ranges / constraints
 *   - required vs optional status
 *
 * Explicit CLI values should be treated as explicit user input.
 *
 * Inferred metadata should be treated as available facts.
 *
 * The resolver combines these sources according to a deterministic precedence
 * policy, with explicit CLI values taking precedence over inference where both
 * attempt to supply the same parameter.
 *
 * The exact precedence policy should remain centralized in USIG rather than
 * implemented separately in plugins.
 *
 *
 * 12. RESOLVED PARAMETERS ENTER THE PLUGIN
 * -----------------------------------------
 *
 * By the time execution reaches the plugin algorithm, the plugin should receive
 * a clean parameter object in the plugin's own canonical vocabulary.
 *
 * For example:
 *
 *   {
 *     sampleColumn: 'data',
 *     fsGhz: 2.25,
 *     window: 'hanning',
 *     fftLength: 8192
 *   }
 *
 * The plugin should NOT have to:
 *
 *   - inspect filenames
 *   - search aliases
 *   - lowercase arbitrary metadata keys
 *   - parse SI prefixes
 *   - convert MHz to GHz
 *   - determine whether a categorical value is valid
 *   - distinguish inferred metadata from CLI metadata
 *   - apply framework defaults
 *
 * Those are USIG parameter-resolution responsibilities.
 *
 *
 * 13. SIMPLIFYING THE PLUGIN
 * --------------------------
 *
 * One of the principal benefits of this migration is that the plugin should
 * become smaller.
 *
 * Remove plugin-side infrastructure whose only purpose was to compensate for
 * the old architecture.
 *
 * In particular, migrate away from:
 *
 *   - filename regex hooks
 *   - defaultRegex
 *   - defaultReplace
 *   - defaultValue as an inference mechanism
 *   - defaultScope
 *   - plugin-side alias matching
 *   - plugin-side unit parsing for metadata
 *   - plugin-side filename parameter discovery
 *   - automatic framework-style parameter seeding
 *
 * Keep code that is genuinely algorithmic.
 *
 * Keep explicit transformations that are part of the algorithm itself.
 *
 * Do not remove legitimate algorithmic behavior merely because it happens to
 * use the word "auto".
 *
 *
 * 14. DEFAULTS VS OPTIONAL PARAMETERS
 * -----------------------------------
 *
 * The old plugin defaultParams object must be reconsidered carefully.
 *
 * A value should not exist merely because the old UI expected every field to
 * display something.
 *
 * If a parameter is algorithmically required and no universal value exists,
 * it should be required and unresolved rather than silently defaulted.
 *
 * If a parameter genuinely has a mathematically / algorithmically intrinsic
 * default, that default may remain a plugin-level algorithmic default, but it
 * must not be confused with USIG metadata inference.
 *
 * In particular, remove historical defaults such as:
 *
 *   inputMode = 'codes'
 *   minCode = 0
 *   maxCode = 2047
 *
 * when those values were merely conveniences of the old UI rather than facts
 * known about the input.
 *
 * The goal is full agnosticism outside the plugin's declared semantic contract.
 *
 *
 * 15. SAMPLE COLUMN
 * -----------------
 *
 * sampleColumn is different from physical inferred parameters.
 *
 * It is fundamentally a selection of an available input column.
 *
 * USIG can expose available columns to the plugin resolver / CLI, and the
 * plugin can declare that sampleColumn is required and column-select-like.
 *
 * If a source contains an obvious signal column, USIG may infer that fact if
 * the existing ingestion architecture already supports such inference.
 *
 * But this must remain distinct from filename parameter inference.
 *
 *
 * 16. SMEAS-SPECIFIC "AUTO"
 * -------------------------
 *
 * SMEAS has a parameter called "window" for which "auto" is a real, intentional
 * algorithmic mode.
 *
 * "auto" is NOT a USIG concept.
 *
 * The SMEAS manifest should declare it as an allowed categorical value.
 *
 * When SMEAS receives:
 *
 *   window = 'auto'
 *
 * the SMEAS algorithm may take its special optimization/evaluation-window
 * path.
 *
 * This behavior belongs entirely to SMEAS.
 *
 * USIG must not assume that:
 *
 *   auto = optimize
 *   auto = infer
 *   auto = choose automatically
 *   auto = missing value
 *
 * Another plugin can define "auto" differently.
 *
 *
 * 17. TARGET ARCHITECTURE
 * -----------------------
 *
 * The desired architecture is:
 *
 *   FILE / CLI INPUT
 *        |
 *        v
 *   INGESTION
 *        |
 *        +----------------------+
 *        |                      |
 *        v                      v
 *   filename inference       waveform/data metadata
 *        |                      |
 *        +----------+-----------+
 *                   |
 *                   v
 *             USIG IR / METADATA
 *                   |
 *                   v
 *          PLUGIN PARAMETER MANIFEST
 *                   |
 *                   v
 *          PARAMETER RESOLUTION
 *                   |
 *          +--------+---------+
 *          |                  |
 *       aliases           unit conversion
 *          |                  |
 *       validation       normalization
 *          |                  |
 *          +--------+---------+
 *                   |
 *                   v
 *          RESOLVED PLUGIN PARAMS
 *                   |
 *                   v
 *                PLUGIN
 *                   |
 *                   v
 *              ALGORITHM
 *                   |
 *                   v
 *               OUTPUT
 *
 *
 * 18. RESPONSIBILITY BOUNDARIES
 * -----------------------------
 *
 * USIG owns:
 *
 *   - ingestion
 *   - metadata extraction
 *   - filename inference
 *   - IR representation
 *   - alias matching
 *   - case-insensitive matching
 *   - unit recognition
 *   - canonical unit conversion
 *   - conversion into plugin-requested units
 *   - categorical validation
 *   - numeric validation
 *   - CLI parameter parsing
 *   - precedence between explicit and inferred values
 *   - exposing the plugin manifest to the CLI/user
 *
 * The plugin owns:
 *
 *   - semantic meaning of its parameters
 *   - parameter names exposed by the plugin
 *   - aliases
 *   - expected units
 *   - allowed values
 *   - parameter constraints
 *   - algorithmic defaults that are genuinely intrinsic to the algorithm
 *   - interpretation of values such as SMEAS's "window='auto'"
 *   - actual algorithm execution
 *   - plugin outputs
 *
 * The plugin should NOT own:
 *
 *   - knowledge of filename syntax
 *   - generic unit conversion
 *   - generic metadata discovery
 *   - generic alias matching
 *   - generic CLI parsing
 *
 *
 * 19. SINL MIGRATION TARGET
 * -------------------------
 *
 * SINL should be converted first because it is substantially shorter and
 * battle-tested.
 *
 * After migration, verify that:
 *
 *   node usig.mjs -i <known-sine-file> -plugin sinl
 *
 * produces the same numerical results as the current implementation when
 * supplied with equivalent explicit parameters.
 *
 * The existing golden sine file is particularly useful because its filename
 * contains parameters such as:
 *
 *   fs2p25ghz
 *   fftlength8192
 *   numaveraging4
 *   numberofcores8
 *   ticorrections~ogp
 *
 * SINL should not consume parameters merely because they happen to exist in
 * the filename.
 *
 * Only parameters declared by SINL's manifest should be resolved for SINL.
 *
 * For example, fsGhz may not be a SINL parameter at all. Its presence in the
 * IR does not mean SINL should receive it.
 *
 *
 * 20. SMEAS MIGRATION AFTER SINL
 * ------------------------------
 *
 * Once SINL is converted and proven, apply the same architecture to SMEAS.
 *
 * SMEAS should then declare parameters such as its sampling frequency and
 * evaluation window through the same manifest mechanism.
 *
 * The filename inference layer should remain completely ignorant of the
 * meaning of those variables.
 *
 * If a filename contains:
 *
 *   fs2p25ghz
 *
 * and SMEAS declares:
 *
 *   key: 'fsGhz'
 *   aliases: ['fs', 'samplingFrequency', 'sampleRate']
 *   unit: 'GHz'
 *
 * USIG should resolve the inferred source value to:
 *
 *   fsGhz = 2.25
 *
 * before invoking SMEAS.
 *
 * If another plugin declares:
 *
 *   key: 'fsHz'
 *   aliases: ['fs', 'samplingFrequency', 'sampleRate']
 *   unit: 'Hz'
 *
 * the same underlying IR fact should resolve to:
 *
 *   fsHz = 2250000000
 *
 * without modifying the filename inference engine.
 *
 *
 * 21. CORE PRINCIPLE FOR FUTURE DEVELOPMENT
 * ------------------------------------------
 *
 * Do not make USIG smarter by teaching it what individual plugin parameters
 * mean.
 *
 * Make USIG smarter by making its generic parameter-resolution machinery better.
 *
 * The plugin manifest is the semantic bridge.
 *
 * Filename inference produces facts.
 *
 * The manifest says which facts a plugin can consume.
 *
 * The resolver matches them, validates them, and converts their units.
 *
 * The plugin receives only the resolved values it declared.
 *
 * This preserves complete agnosticism in USIG while allowing plugins to become
 * increasingly expressive and precise about their own requirements.
 *
 *
 * 22. MIGRATION CHECKLIST
 * -----------------------
 *
 * When converting this plugin:
 *
 *   [ ] Define the plugin's authoritative parameter manifest.
 *   [ ] Add canonical parameter keys.
 *   [ ] Add aliases where useful.
 *   [ ] Make alias matching case-agnostic.
 *   [ ] Declare units explicitly for physical quantities.
 *   [ ] Represent unitless parameters with the established no-unit value.
 *   [ ] Declare allowed categorical values.
 *   [ ] Declare numeric constraints where required.
 *   [ ] Remove filename regex hooks from the plugin.
 *   [ ] Remove plugin-side metadata matching.
 *   [ ] Remove generic unit conversion from the plugin.
 *   [ ] Remove framework/UI-era default inference machinery.
 *   [ ] Reconsider/remove defaultParams values that are not intrinsic algorithmic
 *       defaults.
 *   [ ] Ensure missing required values remain unresolved and are reported.
 *   [ ] Ensure CLI -p values and inferred metadata use the same resolver.
 *   [ ] Ensure explicit CLI values have deterministic precedence.
 *   [ ] Ensure the CLI can disclose the plugin manifest.
 *   [ ] Ensure the resolved parameter object contains canonical plugin keys.
 *   [ ] Verify numerical output against the existing battle-tested SINL output.
 *   [ ] Only after SINL passes, repeat the architecture for SMEAS.
 *
 * The finished plugin should look conceptually like:
 *
 *   manifest / parameter contract
 *          +
 *   algorithm
 *          +
 *   visualization/output
 *
 * rather than:
 *
 *   manifest
 *   + defaults
 *   + UI fields
 *   + regex inference
 *   + metadata inference
 *   + unit conversion
 *   + algorithm
 *   + visualization/output
 *
 * The migration is therefore not merely a refactor of SINL's hooks. It is a
 * deliberate relocation of generic parameter-resolution responsibility from
 * plugins into USIG, leaving each plugin with a clean declaration of what it
 * needs and a clean implementation of what it does.
 */

import {
  Plugin,
  PluginManifest,
  PluginFigure,
  PluginDebugTable,
  type WaveformPacket,
} from '../../lib/pluginTypes';

import sinlDoc from './sinlPlugin.doc';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceLine, ReferenceArea, ResponsiveContainer,
} from 'recharts';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Per-code results table — equivalent to Python pd_results */
export interface InlResults {
  method: 'okawara_t';
  codes: number[];
  pdf: number[];
  cdf: number[];
  cosCdf: number[];
  dnl: number[];
  inl: number[];
  inlPolynomial: number[];
  _intMinbin: number;
  _intMaxbin: number;
  _intTruncLow: number;
  _intTruncHigh: number;
  _codeSizeOverAmp: number;
  _binsAvoidanceRadius: number;
  _avoidedBinLow: number;
  _avoidedBinHigh: number;
}

/** Scalar summary — equivalent to Python pd_singulars */
export interface InlSingulars {
  codeMin: number;
  codeMax: number;
  codeTruncLow: number;
  codeTruncHigh: number;
  lsbCodesOverCodeAmp: number;
  inlCodesP2p: number;
  inlMax: number;
  codeInlMax: number;
  inlMin: number;
  codeInlMin: number;
  missingCodesThreshold: number;
  missingCodesCount: number;
  dnlMax: number;
  codeDnlMax: number;
  dnlMin: number;
  codeDnlMin: number;
  dnlRms: number;
}

export interface InlToolOutput {
  singulars: InlSingulars;
  results: InlResults;
}

export interface SinlFigureData {
  results: InlResults;
  singulars: InlSingulars;
  fileName: string;
  adcRes: number;
  minCode: number;
  maxCode: number;
  /** Whether samples were voltages — drives axis/label display in figures. */
  inputMode: 'codes' | 'voltage';
}

export interface SinlParams {
  sampleColumn: string;
  avoidanceRadius: number;
  minSizeBin: number;
  missingThreshold: number;
  inputMode: 'codes' | 'voltage';
  minCode: number;
  maxCode: number;
}

// ─── Helpers (numpy equivalents) ──────────────────────────────────────────────

/** Build integer histogram over bins [0, 1, …, numBins-1].
 *  bins = range(0, 2^adcRes + 1) → numBins = 2^adcRes buckets */
function histogram(samples: number[], numBins: number): number[] {
  const hist = new Array<number>(numBins).fill(0);
  for (const s of samples) {
    const idx = Math.round(s);
    if (idx >= 0 && idx < numBins) hist[idx]++;
  }
  return hist;
}

/** Element-wise cumulative sum */
function cumsum(arr: number[]): number[] {
  const out = new Array<number>(arr.length);
  let acc = 0;
  for (let i = 0; i < arr.length; i++) { acc += arr[i]; out[i] = acc; }
  return out;
}

/** Element-wise diff (length n-1) */
function diff(arr: number[]): number[] {
  const out = new Array<number>(arr.length - 1);
  for (let i = 0; i < out.length; i++) out[i] = arr[i + 1] - arr[i];
  return out;
}

/** Least-squares polynomial fit, degree 3.
 *  Returns coefficients [a3, a2, a1, a0] (highest degree first, like numpy).
 *  Filters non-finite pairs before solving. */
function polyfit3(x: number[], y: number[]): [number, number, number, number] {
  const xf: number[] = [], yf: number[] = [];
  for (let i = 0; i < x.length; i++) {
    if (isFinite(x[i]) && isFinite(y[i])) { xf.push(x[i]); yf.push(y[i]); }
  }
  const n = xf.length;
  if (n < 4) return [0, 0, 0, 0];

  const deg = 3;
  const cols = deg + 1;
  const S = new Array<number>(2 * deg + 1).fill(0);
  for (const xi of xf) {
    let xpow = 1;
    for (let k = 0; k <= 2 * deg; k++) { S[k] += xpow; xpow *= xi; }
  }
  const M: number[][] = Array.from({ length: cols }, (_, i) =>
    Array.from({ length: cols }, (__, j) => S[2 * deg - i - j])
  );
  const b: number[] = Array.from({ length: cols }, (_, i) => {
    let s = 0;
    for (let k = 0; k < n; k++) {
      let xpow = 1;
      for (let p = 0; p < deg - i; p++) xpow *= xf[k];
      s += xpow * yf[k];
    }
    return s;
  });
  const aug = M.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < cols; col++) {
    let maxRow = col;
    for (let row = col + 1; row < cols; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-15) continue;
    for (let row = 0; row < cols; row++) {
      if (row === col) continue;
      const factor = aug[row][col] / pivot;
      for (let k = col; k <= cols; k++) aug[row][k] -= factor * aug[col][k];
    }
  }
  const coeff = aug.map((row, i) => row[cols] / row[i]) as [number, number, number, number];
  return coeff;
}

/** Evaluate degree-3 polynomial at each x: c[0]*x^3 + c[1]*x^2 + c[2]*x + c[3] */
function polyval3(coeff: [number, number, number, number], x: number[]): number[] {
  return x.map(xi => coeff[0] * xi ** 3 + coeff[1] * xi ** 2 + coeff[2] * xi + coeff[3]);
}

// ─── Volt-display helpers ─────────────────────────────────────────────────────

/**
 * Build a code→volt converter for voltage-mode figures.
 * When inputMode='codes', returns identity (just the code number as string).
 */
function makeCodeToVolt(
  inputMode: 'codes' | 'voltage',
  minCode: number,
  maxCode: number,
  numCodes: number,
): (code: number) => number {
  if (inputMode !== 'voltage') return (c) => c;
  return (c) => minCode + (c / (numCodes - 1)) * (maxCode - minCode);
}

/** Format a single axis / label value in the correct unit. */
function fmtX(
  inputMode: 'codes' | 'voltage',
  codeToVolt: (c: number) => number,
  code: number,
  decimals = 4,
): string {
  if (inputMode !== 'voltage') return String(Math.round(code));
  const v = codeToVolt(code);
  return `${v.toFixed(decimals)}V`;
}

// ─── Core Algorithm ────────────────────────────────────────────────────────────

/** Okawara-T: Truncated sine-histogram INL/DNL estimator */
function okawaraT(
  adcSamples: number[],
  adcRes = 11,
  binsAvoidanceRadius = 40,
  minSizeBin = 2,
): InlResults {
  const numCodes = 2 ** adcRes;

  const hist = histogram(adcSamples, numCodes);
  const totalSamples = hist.reduce((a, b) => a + b, 0);

  let intMinbin = 0;
  let avoidedBinLow = -1;
  for (let i = 0; i < hist.length; i++) {
    if (hist[i] >= minSizeBin) { intMinbin = i; break; }
    if (hist[i] > 0 && avoidedBinLow === -1) avoidedBinLow = i;
  }
  let intMaxbin = hist.length - 1;
  let avoidedBinHigh = -1;
  for (let i = hist.length - 1; i > 0; i--) {
    if (hist[i] >= minSizeBin) { intMaxbin = i; break; }
    if (hist[i] > 0 && avoidedBinHigh === -1) avoidedBinHigh = i;
  }

  let intTruncLow = intMinbin;
  {
    let maxVal = -Infinity;
    const lo = intMinbin, hi = Math.min(intMinbin + binsAvoidanceRadius, hist.length - 1);
    for (let i = lo; i <= hi; i++) {
      if (hist[i] > maxVal) { maxVal = hist[i]; intTruncLow = i; }
    }
  }
  let intTruncHigh = intMaxbin;
  {
    let maxVal = -Infinity;
    const lo = Math.max(intMaxbin - binsAvoidanceRadius, 0), hi = intMaxbin;
    for (let i = lo; i <= hi; i++) {
      if (hist[i] > maxVal) { maxVal = hist[i]; intTruncHigh = i; }
    }
  }
  const intTruncBins = intTruncHigh - intTruncLow + 1;

  const pdf = hist.map(h => h / totalSamples);
  const cdf = cumsum(pdf);
  const cosCdf = cdf.map(c => Math.cos(Math.PI * c));

  let sumLow = 0;
  for (let i = intMinbin; i <= intTruncLow; i++) sumLow += pdf[i];
  const C1 = Math.cos(Math.PI * sumLow);

  let sumHigh = 0;
  for (let i = 0; i < intTruncHigh; i++) sumHigh += pdf[i];
  const C2 = Math.cos(Math.PI * sumHigh);

  const codeSizeOverAmp = (C1 - C2) / intTruncBins;

  const dnl = new Array<number>(numCodes).fill(NaN);
  {
    const sliceCos = cosCdf.slice(intTruncLow, intTruncHigh);
    const d = diff(sliceCos);
    for (let i = 0; i < d.length; i++) {
      dnl[intTruncLow + i] = -d[i] / codeSizeOverAmp - 1;
    }
  }

  const inl = new Array<number>(numCodes).fill(NaN);
  {
    const baseSum = sumLow;
    const inner = pdf.slice(intTruncLow + 1, intTruncHigh);
    const innerCumsum = cumsum(inner);
    for (let i = 0; i < innerCumsum.length; i++) {
      const cosTerm = Math.cos(Math.PI * (baseSum + innerCumsum[i]));
      inl[intTruncLow + 1 + i] = (C1 - cosTerm) / codeSizeOverAmp - (i + 1);
    }
  }

  for (let i = 0; i < intTruncLow; i++) dnl[i] = 0;
  for (let i = intTruncHigh; i < numCodes; i++) dnl[i] = 0;
  for (let i = 0; i < intTruncLow; i++) inl[i] = 0;
  for (let i = intTruncHigh; i < numCodes; i++) inl[i] = 0;

  const codes = Array.from({ length: numCodes }, (_, i) => i);
  const polyCoeff = polyfit3(codes, inl);
  const inlPolynomial = polyval3(polyCoeff, codes);

  return {
    method: 'okawara_t',
    codes,
    pdf,
    cdf,
    cosCdf,
    dnl,
    inl,
    inlPolynomial,
    _intMinbin: intMinbin,
    _intMaxbin: intMaxbin,
    _intTruncLow: intTruncLow,
    _intTruncHigh: intTruncHigh,
    _codeSizeOverAmp: codeSizeOverAmp,
    _binsAvoidanceRadius: binsAvoidanceRadius,
    _avoidedBinLow: avoidedBinLow,
    _avoidedBinHigh: avoidedBinHigh,
  };
}

/** Analyze: Compute scalar summary metrics from okawaraT results */
function analyze(
  results: InlResults,
  missingCodeThreshold = -0.9,
): InlSingulars {
  const { codes, inl, dnl, inlPolynomial, _intTruncLow, _intTruncHigh } = results;

  let polyMax = -Infinity, polyMin = Infinity;
  for (let i = _intTruncLow; i <= _intTruncHigh; i++) {
    const v = inlPolynomial[i];
    if (isFinite(v)) {
      if (v > polyMax) polyMax = v;
      if (v < polyMin) polyMin = v;
    }
  }
  const inlP2p = polyMax - polyMin;

  let inlMax = -Infinity, inlMin = Infinity;
  let codeInlMax = 0, codeInlMin = 0;
  for (let i = 0; i < inl.length; i++) {
    if (isFinite(inl[i])) {
      if (inl[i] > inlMax) { inlMax = inl[i]; codeInlMax = codes[i]; }
      if (inl[i] < inlMin) { inlMin = inl[i]; codeInlMin = codes[i]; }
    }
  }

  let dnlMax = -Infinity, dnlMin = Infinity;
  let codeDnlMax = 0, codeDnlMin = 0;
  let missingCodesCount = 0;
  let dnlSumSq = 0, dnlCount = 0;

  for (let i = 0; i < dnl.length; i++) {
    if (isFinite(dnl[i])) {
      if (dnl[i] > dnlMax) { dnlMax = dnl[i]; codeDnlMax = codes[i]; }
      if (dnl[i] < dnlMin) { dnlMin = dnl[i]; codeDnlMin = codes[i]; }
      if (dnl[i] < missingCodeThreshold) missingCodesCount++;
      dnlSumSq += dnl[i] ** 2;
      dnlCount++;
    }
  }
  const dnlRms = dnlCount > 0 ? Math.sqrt(dnlSumSq / dnlCount) : 0;

  return {
    codeMin: results._intMinbin,
    codeMax: results._intMaxbin,
    codeTruncLow: results._intTruncLow,
    codeTruncHigh: results._intTruncHigh,
    lsbCodesOverCodeAmp: results._codeSizeOverAmp,
    inlCodesP2p: inlP2p,
    inlMax,
    codeInlMax,
    inlMin,
    codeInlMin,
    missingCodesThreshold: missingCodeThreshold,
    missingCodesCount,
    dnlMax,
    codeDnlMax,
    dnlMin,
    codeDnlMin,
    dnlRms,
  };
}

/** Run INL tool: calls okawaraT then analyze */
function runInlTool(
  adcSamples: number[],
  adcRes = 11,
  binsAvoidanceRadius = 40,
  minSizeBin = 2,
  missingCodeThreshold = -0.9,
): InlToolOutput {
  const results = okawaraT(adcSamples, adcRes, binsAvoidanceRadius, minSizeBin);
  const singulars = analyze(results, missingCodeThreshold);
  return { singulars, results };
}

// ─── Plugin Helpers ──────────────────────────────────────────────────────────

/** Derive adcRes from the full-scale code range */
function deriveAdcRes(minCode: number, maxCode: number): number {
  const mn = Number(minCode) || 0;
  const mx = Number(maxCode) || 2047;
  const range = mx - mn + 1;
  return Math.max(1, Math.ceil(Math.log2(Math.max(range, 2))));
}

/** Convert raw waveform samples to integer ADC codes using inputMode/voltage normalisation. */
function samplesToCodes(
  raw: ArrayLike<number>,
  inputMode: 'codes' | 'voltage',
  minCode: number,
  maxCode: number,
  voltageAdcBits = 10,    // resolution to use when mapping voltages → codes
): number[] {
  const numCodes = inputMode === 'voltage'
    ? Math.pow(2, voltageAdcBits)
    : Math.pow(2, deriveAdcRes(Math.round(minCode), Math.round(maxCode)));
  const codes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (isNaN(v)) continue;
    codes.push(inputMode === 'voltage'
      ? Math.round((v - minCode) / (maxCode - minCode) * (numCodes - 1))
      : Math.round(v));
  }
  if (codes.length === 0) throw new Error('No numeric samples found in the specified column.');
  return codes;
}


/**
 * Auto-seed sinl params from WaveformPacket metadata.
 * If metadata.units === 'volts' and inputMode is still the default 'codes',
 * switch to 'voltage' and seed minCode/maxCode from the actual sample range.
 * The effective ADC resolution is fixed at 10-bit (1024 codes) for voltage mode
 * so the histogram has enough bins to be meaningful.
 */
function inferSinlParamsFromPacket(
  params: SinlParams,
  packet: import('../../lib/ingest').WaveformPacket,
): SinlParams {
  if (packet.metadata.units !== 'volts') return params;
  if (params.inputMode !== 'codes') return params; // user already chose

  // Compute min/max from the actual samples
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < packet.waveform.length; i++) {
    const v = packet.waveform[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }

  if (!isFinite(mn) || !isFinite(mx)) return params;

  // Add a small margin so the extreme codes are not at the absolute boundary
  const margin = (mx - mn) * 0.02;
  return {
    ...params,
    inputMode: 'voltage',
    minCode:   mn - margin,
    maxCode:   mx + margin,
  };
}

/** Normalize plugin params into effective numeric values used by the SINL algorithm. */
function normalizeSinlParams(params: SinlParams) {
  const minCode = params.inputMode === 'voltage'
    ? Number(params.minCode)
    : Math.round(Number(params.minCode) ?? 0);

  const maxCode = params.inputMode === 'voltage'
    ? Number(params.maxCode)
    : Math.round(Number(params.maxCode) ?? 2047);

  return {
    minCode,
    maxCode,
    adcRes: params.inputMode === 'voltage'
      ? 10
      : deriveAdcRes(minCode, maxCode),
    avoidanceRadius: Math.max(
      0,
      Math.round(Number(params.avoidanceRadius) ?? 40),
    ),
    minSizeBin: Math.max(
      1,
      Math.round(Number(params.minSizeBin) ?? 2),
    ),
    missingThreshold: Number(params.missingThreshold) ?? -0.9,
  };
}

function singularsToOutput(
  singulars: InlSingulars,
  fileName: string,
): Record<string, string | number> {
  return {
    filename: fileName,
    inl_codes_p2p: +singulars.inlCodesP2p.toFixed(4),
    inl_max: +singulars.inlMax.toFixed(4),
    code_inl_max: singulars.codeInlMax,
    inl_min: +singulars.inlMin.toFixed(4),
    code_inl_min: singulars.codeInlMin,
    missing_codes_threshold: singulars.missingCodesThreshold,
    missing_codes_count: singulars.missingCodesCount,
    dnl_max: +singulars.dnlMax.toFixed(4),
    code_dnl_max: singulars.codeDnlMax,
    dnl_min: +singulars.dnlMin.toFixed(4),
    code_dnl_min: singulars.codeDnlMin,
    dnl_rms: +singulars.dnlRms.toFixed(4),
    code_min: singulars.codeMin,
    code_max: singulars.codeMax,
    code_trunclow: singulars.codeTruncLow,
    code_trunchigh: singulars.codeTruncHigh,
    lsb_codes_over_code_amp: +singulars.lsbCodesOverCodeAmp.toFixed(6),
  };
}


const manifest: PluginManifest = {
  id: 'sinl',
  name: 'SINL — Sine INL/DNL',
  description: 'Sine-histogram INL/DNL for clipped (saturated) sine waves — not for ENOB.',
  version: '1.0.0',
  author: 'Guy Steiff',
  authorEmail: 'guy.steiff-sinlsuppport@bytz.me',
  github: '',
  linkedin: 'https://www.linkedin.com/in/guysteiff/',
  website: '',
  pythonModule: 'sinl_tool',
  pythonFunction: 'run_sinl',
  reportTitle: 'Sine INL/DNL Analysis (Okawara-T)',
  category: 'signal',
  paramSchema: [
  {
    key: 'sampleColumn',
    label: 'Sample Column',
    type: 'column-select',
    required: true,
    description: 'CSV column containing raw ADC codes or voltages.',
    aliases: ['sample', 'samples', 'adcCode', 'adcCodes', 'voltage'],
  },
  {
    key: 'inputMode',
    label: 'Input Mode',
    type: 'text',
    required: false,
    description: 'Input representation: "codes" (default) for raw ADC codes, or "voltage" for voltage samples normalised using minCode and maxCode.',
    aliases: ['mode', 'inputType'],
    possibleValues: ['codes', 'voltage'],
  },

  {
    key: 'minCode',
    label: 'Min code / voltage',
    type: 'number',
    required: false,
    description: 'Theoretical minimum code (default 0) or minimum voltage.',
  },
  {
    key: 'maxCode',
    label: 'Max code / voltage',
    type: 'number',
    required: true,
    description: 'Theoretical maximum code (e.g. 2047 for 11-bit) or maximum voltage.',
  },
  {
    key: 'avoidanceRadius',
    label: 'Avoidance Radius',
    type: 'number',
    required: false,
    description: 'Peak search radius for truncation (default 40).',
    min: 0,
  },
  {
    key: 'minSizeBin',
    label: 'Min Bin Size',
    type: 'number',
    required: false,
    description: 'Min samples for a code to count as reachable (default 2).',
    min: 1,
  },
  {
    key: 'missingThreshold',
    label: 'Missing Code Threshold',
    type: 'number',
    required: false,
    description: 'DNL threshold below which a code is missing (default -0.9).',
    max: 0,
  },
],

};



// ── Recharts interactive figure components ────────────────────────────────────

const CHART_COLORS = {
  line:   '#6366F1',
  poly:   '#F59E0B',
  marker: '#EF4444',
  grid:   '#1F2937',
  text:   '#9CA3AF',
  zoneLow:  'rgba(251,191,36,0.12)',
  zoneHigh: 'rgba(99,102,241,0.12)',
};

/** Custom tooltip styled for dark theme */
function DarkTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-gray-800 border border-gray-600 rounded px-3 py-2 text-xs shadow-xl">
      <p className="text-gray-400 mb-1">code: <span className="text-white font-mono">{label}</span></p>
      {payload.map((p: any) => (
        <p key={p.dataKey} style={{ color: p.color }}>
          {p.name}: <span className="font-mono">{typeof p.value === 'number' ? p.value.toFixed(5) : p.value}</span>
        </p>
      ))}
    </div>
  );
}

// ── PDF figure component ──────────────────────────────────────────────────────

// PROBLEM — magic pixel offset for rotated reference-line labels:
//   Recharts' ReferenceLine `label.offset` is always in SVG pixels relative to
//   the `position` anchor (e.g. 'insideTop' = pixels downward from the chart top
//   edge).  It has NO awareness of data coordinates — the x data value is
//   completely irrelevant to vertical label placement.
//
//   We cannot express it as "1% of the x value" because the two things live in
//   orthogonal spaces: x is a data coordinate, offset is a layout pixel.
//
// SOLUTION — tie the offset to the chart height constant instead:
//   PDF_CHART_H is the single source of truth for the chart's pixel height.
//   All label offsets are expressed as inline fractions of it:
//     * 0.07 × h ≈ 25 px  — insideTop rotated labels (down from top edge)
//     * 0.04 × h ≈ 15 px  — insideBottom / insideLeft nudge labels
//   This makes each offset self-documenting at the call site: the fraction
//   shows intent, the constant ties it to the chart size, and if PDF_CHART_H
//   ever changes every label moves proportionally.
const PDF_CHART_H = 380;

/**
 * Apply FigureViewer zoom (__xC/__yC/__zoom) to a [fullMin, fullMax] data range.
 */
function applyZoomDomain(
  fullMin: number, fullMax: number,
  controls: Record<string, any>,
  axis: 'x' | 'y',
): [number, number] {
  const zoom = axis === 'x'
    ? ((controls.__zoom  as number) ?? 1)
    : ((controls.__yZoom as number) ?? 1);
  if (zoom <= 1) return [fullMin, fullMax];
  const span = fullMax - fullMin;
  const hw   = span / (2 * zoom);
  const cFrac = axis === 'x' ? ((controls.__xC as number) ?? 0.5) : ((controls.__yC as number) ?? 0.5);
  const center = fullMin + cFrac * span;
  return [Math.max(fullMin, center - hw), Math.min(fullMax, center + hw)];
}

/** Filter sorted points array to the visible x window (with 1-point margin each side). */
function filterToWindow<T extends { code: number }>(arr: T[], xMin: number, xMax: number): T[] {
  if (arr.length === 0) return arr;
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].code < xMin) lo = mid + 1; else hi = mid; }
  const start = Math.max(0, lo - 1);
  let end = start;
  while (end < arr.length && arr[end].code <= xMax) end++;
  end = Math.min(arr.length - 1, end);
  return arr.slice(start, end + 1);
}

function PdfFigure({ data, controls }: { data: unknown; controls: Record<string, any> }) {
  const { results: r, singulars: s, adcRes, inputMode, minCode, maxCode } = data as SinlFigureData;
  const isVolt = inputMode === 'voltage';
  const avoidR = r._binsAvoidanceRadius;
  const numCodes = Math.pow(2, adcRes);
  const xMax = numCodes - 1;
  const c2v = makeCodeToVolt(inputMode, minCode, maxCode, numCodes);
  const fx = (c: number) => fmtX(inputMode, c2v, c, 3);

  const points = r.codes.map((c: number, i: number) => ({ code: c, pdf: r.pdf[i] ?? 0 }));
  const xLabel = isVolt ? 'voltage (V)' : 'code';
  const minLabel = isVolt ? c2v(s.codeMin).toFixed(3) + 'V' : String(s.codeMin);
  const maxLabel = isVolt ? c2v(s.codeMax).toFixed(3) + 'V' : String(s.codeMax);

  return (
    <div className="w-full bg-gray-900 rounded-lg p-4">
      <div className="text-sm text-gray-300 font-semibold mb-3 text-center">
        PDF vs {isVolt ? 'Voltage' : 'Codes'} <span className="text-gray-500 font-normal ml-2">min={minLabel} max={maxLabel}</span>
      </div>
      <ResponsiveContainer width="100%" height={PDF_CHART_H}>
        <LineChart data={filterToWindow(points, (applyZoomDomain(0, xMax, controls, 'x')[0]), (applyZoomDomain(0, xMax, controls, 'x')[1]))} margin={{ top: 10, right: 30, left: 10, bottom: 30 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
          <XAxis dataKey="code" stroke={CHART_COLORS.text} tick={{ fill: CHART_COLORS.text, fontSize: 11 }}
            label={{ value: xLabel, position: 'insideBottom', offset: -15, fill: CHART_COLORS.text, fontSize: 12 }}
            domain={applyZoomDomain(0, xMax, controls, 'x')} type="number"
            tickFormatter={isVolt ? (c: number) => c2v(c).toFixed(3) : undefined} />
          <YAxis stroke={CHART_COLORS.text} tick={{ fill: CHART_COLORS.text, fontSize: 11 }}
            label={{ value: 'PDF [probability]', angle: -90, position: 'insideLeft', offset: 10, fill: CHART_COLORS.text, fontSize: 12 }} />
          <Tooltip content={<DarkTooltip />} labelFormatter={isVolt ? ((c: any) => `${c2v(c).toFixed(4)}V`) as any : undefined} />
          {/* Search zone shading */}
          <ReferenceArea x1={s.codeMin} x2={s.codeMin + avoidR} fill={CHART_COLORS.zoneLow} label={{ value: 'peak search', angle: +90, fill: '#FCD34D', fontSize: 12, position: 'top', offset: -Math.round(PDF_CHART_H * 0.09) }} />
          <ReferenceArea x1={s.codeMax - avoidR} x2={s.codeMax} fill={CHART_COLORS.zoneHigh} label={{ value: 'peak search', angle: +90, fill: '#A5B4FC', fontSize: 12, position: 'top', offset: -Math.round(PDF_CHART_H * 0.09) }} />
          {/* Boundary vertical lines */}
          <ReferenceLine x={s.codeMin}      stroke="#6B7280" strokeDasharray="4 4" label={{ value: `minbin(${fx(s.codeMin)})`, angle: 0, fill: '#9CA3AF', fontSize: 12, position: 'insideBottom', offset: -Math.round(PDF_CHART_H * 0.04) }} />
          <ReferenceLine x={s.codeMin + avoidR} stroke="#6B7280" strokeDasharray="4 4" label={{ value: `+r(${avoidR})`, angle: -90, fill: '#9CA3AF', fontSize: 12, position: 'insideTop', offset: Math.round(PDF_CHART_H * 0.08) }} />
          <ReferenceLine x={s.codeMax - avoidR} stroke="#6B7280" strokeDasharray="4 4" label={{ value: `-r(${avoidR})`, angle: -90, fill: '#9CA3AF', fontSize: 12, position: 'insideTopRight', offset: Math.round(PDF_CHART_H * 0.04) }} />
          <ReferenceLine x={s.codeMax}      stroke="#6B7280" strokeDasharray="4 4" label={{ value: `maxbin(${fx(s.codeMax)})`, angle: 0, fill: '#9CA3AF', fontSize: 12, position: 'insideBottom', offset: -Math.round(PDF_CHART_H * 0.04) }} />
          {/* Truncation boundaries */}
          <ReferenceLine x={s.codeTruncLow}  stroke="#EF4444" strokeWidth={1.5} label={{ value: `trunclow(${fx(s.codeTruncLow)})`, angle: -90,  fill: '#EF4444', fontSize: 12, position: 'insideLeft', offset: -Math.round(PDF_CHART_H * 0.04) }} />
          <ReferenceLine x={s.codeTruncHigh} stroke="#EF4444" strokeWidth={1.5} label={{ value: `trunchigh(${fx(s.codeTruncHigh)})`, angle: -90, fill: '#EF4444', fontSize: 12, position: 'insideLeft',  offset: +Math.round(PDF_CHART_H * 0.04) }} />
          <Line type="monotone" dataKey="pdf" dot={false} stroke={CHART_COLORS.line} strokeWidth={1.5} name="PDF" isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── DNL figure component ──────────────────────────────────────────────────────
function DnlFigure({ data, controls }: { data: unknown; controls: Record<string, any> }) {
  const { results: r, singulars: s, adcRes, inputMode, minCode, maxCode } = data as SinlFigureData;
  const isVolt = inputMode === 'voltage';
  const numCodes = Math.pow(2, adcRes);
  const xMax = numCodes - 1;
  const c2v = makeCodeToVolt(inputMode, minCode, maxCode, numCodes);
  const fx = (c: number) => fmtX(inputMode, c2v, c, 3);

  // Compute yMin/yMax directly from the finite data — immune to stale/corrupt singulars.
  const finiteDnl = r.codes.map((_, i) => r.dnl[i]).filter(v => isFinite(v));
  const dataMin = finiteDnl.length > 0 ? Math.min(...finiteDnl) : -1;
  const dataMax = finiteDnl.length > 0 ? Math.max(...finiteDnl) : 1;
  const yPad = Math.max((dataMax - dataMin) * 0.15, 0.2);
  const yMin = dataMin - yPad;
  const yMax = dataMax + yPad;

  const points = r.codes
    .map((c: number, i: number) => {
      const v = r.dnl[i];
      return { code: c, dnl: (isFinite(v) && v >= yMin && v <= yMax) ? v : null };
    })
    .filter(p => p.dnl !== null);

  return (
    <div className="w-full bg-gray-900 rounded-lg p-4">
      <div className="text-sm text-gray-300 font-semibold mb-1 text-center">
        DNL <span className="text-green-400">+{s.dnlMax.toFixed(2)}</span> / <span className="text-red-400">{s.dnlMin.toFixed(2)}</span> LSB
        <span className="text-gray-500 font-normal ml-2">({s.missingCodesCount} missing codes)</span>
      </div>
      <ResponsiveContainer width="100%" height={380}>
        <LineChart data={filterToWindow(points, (applyZoomDomain(0, xMax, controls, 'x')[0]), (applyZoomDomain(0, xMax, controls, 'x')[1]))} margin={{ top: 10, right: 30, left: 10, bottom: 30 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
          <XAxis dataKey="code" stroke={CHART_COLORS.text} tick={{ fill: CHART_COLORS.text, fontSize: 11 }}
            label={{ value: isVolt ? 'voltage (V)' : 'code', position: 'insideBottom', offset: -15, fill: CHART_COLORS.text, fontSize: 12 }}
            domain={applyZoomDomain(0, xMax, controls, 'x')} type="number"
            tickFormatter={isVolt ? (c: number) => c2v(c).toFixed(3) : undefined} />
          <YAxis stroke={CHART_COLORS.text} tick={{ fill: CHART_COLORS.text, fontSize: 11 }}
            label={{ value: 'DNL [LSB]', angle: -90, position: 'insideLeft', offset: 10, fill: CHART_COLORS.text, fontSize: 12 }}
            domain={applyZoomDomain(yMin, yMax, controls, 'y') as [number,number]} allowDataOverflow={true}
            tickFormatter={(v: number) => v.toFixed(2)} />
          <Tooltip content={<DarkTooltip />} labelFormatter={isVolt ? ((c: any) => `${c2v(c).toFixed(4)}V`) as any : undefined} />
          <ReferenceLine y={0} stroke="#4B5563" strokeWidth={1} />
          <ReferenceLine y={s.dnlMin} stroke={CHART_COLORS.marker} strokeDasharray="4 4"
            label={{ value: `min(${fx(s.codeDnlMin)}, ${s.dnlMin.toFixed(2)})`, fill: CHART_COLORS.marker, fontSize: 9, position: 'insideBottomRight' }} />
          <ReferenceLine y={s.dnlMax} stroke="#10B981" strokeDasharray="4 4"
            label={{ value: `max(${fx(s.codeDnlMax)}, ${s.dnlMax.toFixed(2)})`, fill: '#10B981', fontSize: 9, position: 'insideTopRight' }} />
          <Line type="monotone" dataKey="dnl" dot={false} stroke={CHART_COLORS.line} strokeWidth={1.5} name="DNL" isAnimationActive={false} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── INL + polynomial figure component ────────────────────────────────────────
function InlFigure({ data, controls }: { data: unknown; controls: Record<string, any> }) {
  const { results: r, singulars: s, adcRes, inputMode, minCode, maxCode } = data as SinlFigureData;
  const isVolt = inputMode === 'voltage';
  const numCodes = Math.pow(2, adcRes);
  const xMax = numCodes - 1;
  const c2v = makeCodeToVolt(inputMode, minCode, maxCode, numCodes);
  const fx = (c: number) => fmtX(inputMode, c2v, c, 3);
  const hasPoly = r.inlPolynomial && r.inlPolynomial.length === r.codes.length;

  // Compute yMin/yMax from the finite INL values only — immune to stale singulars
  // or polynomial extrapolation blow-up at non-active codes.
  const finiteInl = r.codes.map((_: number, i: number) => r.inl[i]).filter(v => isFinite(v));
  const dataMin = finiteInl.length > 0 ? Math.min(...finiteInl) : -1;
  const dataMax = finiteInl.length > 0 ? Math.max(...finiteInl) : 1;
  const yPad = Math.max((dataMax - dataMin) * 0.15, 0.5);
  const yMin = dataMin - yPad;
  const yMax = dataMax + yPad;

  // Clamp: null out any value outside the visible domain so Recharts never expands the axis.
  // Poly is additionally restricted to codes where measured INL is active (no extrapolation blow-up).
  const points = r.codes.map((c: number, i: number) => {
    const inlV = r.inl[i];
    const inlActive = isFinite(inlV);
    const inlClamped = (inlActive && inlV >= yMin && inlV <= yMax) ? inlV : null;
    const polyV = hasPoly ? r.inlPolynomial[i] : NaN;
    const polyClamped = (inlActive && isFinite(polyV) && polyV >= yMin && polyV <= yMax) ? polyV : null;
    return { code: c, inl: inlClamped, poly: polyClamped };
  }).filter(p => p.inl !== null || p.poly !== null);

  return (
    <div className="w-full bg-gray-900 rounded-lg p-4">
      <div className="text-sm text-gray-300 font-semibold mb-1 text-center">
        INL <span className="text-green-400">+{s.inlMax.toFixed(2)}</span> / <span className="text-red-400">{s.inlMin.toFixed(2)}</span> LSB
        <span className="text-gray-500 font-normal ml-2">poly p2p: {s.inlCodesP2p.toFixed(2)}</span>
      </div>
      <ResponsiveContainer width="100%" height={380}>
        <LineChart data={filterToWindow(points, (applyZoomDomain(0, xMax, controls, 'x')[0]), (applyZoomDomain(0, xMax, controls, 'x')[1]))} margin={{ top: 10, right: 30, left: 10, bottom: 30 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
          <XAxis dataKey="code" stroke={CHART_COLORS.text} tick={{ fill: CHART_COLORS.text, fontSize: 11 }}
            label={{ value: isVolt ? 'voltage (V)' : 'code', position: 'insideBottom', offset: -15, fill: CHART_COLORS.text, fontSize: 12 }}
            domain={applyZoomDomain(0, xMax, controls, 'x')} type="number"
            tickFormatter={isVolt ? (c: number) => c2v(c).toFixed(3) : undefined} />
          <YAxis stroke={CHART_COLORS.text} tick={{ fill: CHART_COLORS.text, fontSize: 11 }}
            label={{ value: 'INL [LSB]', angle: -90, position: 'insideLeft', offset: 10, fill: CHART_COLORS.text, fontSize: 12 }}
            domain={applyZoomDomain(yMin, yMax, controls, 'y') as [number,number]} allowDataOverflow={true}
            tickFormatter={(v: number) => v.toFixed(2)} />
          <Tooltip content={<DarkTooltip />} labelFormatter={isVolt ? ((c: any) => `${c2v(c).toFixed(4)}V`) as any : undefined} />
          <Legend wrapperStyle={{ color: CHART_COLORS.text, fontSize: 11 }} verticalAlign="top" height={5} />
          <ReferenceLine y={0} stroke="#4B5563" strokeWidth={1} />
          <ReferenceLine y={s.inlMin} stroke={CHART_COLORS.marker} strokeDasharray="4 4"
            label={{ value: `min(${fx(s.codeInlMin)}, ${s.inlMin.toFixed(2)})`, fill: CHART_COLORS.marker, fontSize: 9, position: 'insideBottomRight' }} />
          <ReferenceLine y={s.inlMax} stroke="#10B981" strokeDasharray="4 4"
            label={{ value: `max(${fx(s.codeInlMax)}, ${s.inlMax.toFixed(2)})`, fill: '#10B981', fontSize: 9, position: 'insideTopRight' }} />
          <Line type="monotone" dataKey="inl" dot={false} stroke={CHART_COLORS.line} strokeWidth={1.5} name="INL measured" isAnimationActive={false} connectNulls={false} />
          {hasPoly && (
            <Line type="monotone" dataKey="poly" dot={false} stroke={CHART_COLORS.poly} strokeWidth={1.5} strokeDasharray="6 3" name="3rd-order poly" isAnimationActive={false} connectNulls={false} />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Shared figure/debug-table preparation kernel — used by prepareData and prepareDataFromWaveform. */
function _sinlPrepareCore(
  samples: number[], adcRes: number, avoidanceRadius: number,
  minSizeBin: number, missingThreshold: number,
  fileName: string, minCode: number, maxCode: number,
  inputMode: 'codes' | 'voltage' = 'codes',
): { figureData: SinlFigureData; debugTables: PluginDebugTable[] } {
  const { results, singulars } = runInlTool(samples, adcRes, avoidanceRadius, minSizeBin, missingThreshold);
  const figureData: SinlFigureData = { results, singulars, fileName, adcRes, minCode, maxCode, inputMode };
  const nanToNull = (v: number) => (isFinite(v) ? v : null);
  const debugTables: PluginDebugTable[] = [{
    id: 'inl_dnl_series',
    label: 'INL / DNL per-code series',
    columns: {
      code:           results.codes,
      pdf:            results.pdf.map(nanToNull),
      cdf:            results.cdf.map(nanToNull),
      cos_cdf:        results.cosCdf.map(nanToNull),
      dnl:            results.dnl.map(nanToNull),
      inl:            results.inl.map(nanToNull),
      inl_polynomial: results.inlPolynomial.map(nanToNull),
    },
  }];
  return { figureData, debugTables };
}

const sinlFigures: PluginFigure[] = [
  { id: 'pdf', label: 'PDF',            component: PdfFigure },
  { id: 'dnl', label: 'DNL',            component: DnlFigure },
  { id: 'inl', label: 'INL + polynomial', component: InlFigure },
];


// ── Plugin ────────────────────────────────────────────────────────────────────
export const sinlPlugin: Plugin<SinlParams> = {
  id: 'sinl',
  name: 'SINL — Sine INL/DNL',
  description: manifest.description,
  manifest,
  doc: sinlDoc,

  defaultParams: {
    sampleColumn: '',
    avoidanceRadius: 40,
    minSizeBin: 2,
    missingThreshold: -0.9,
    inputMode: 'codes',
    minCode: 0,
    maxCode: 2047,
  },

  outputColumns: [
    'inl_codes_p2p', 'inl_max', 'code_inl_max', 'inl_min', 'code_inl_min',
    'missing_codes_threshold', 'missing_codes_count',
    'dnl_max', 'code_dnl_max', 'dnl_min', 'code_dnl_min', 'dnl_rms',
    'code_min', 'code_max', 'code_trunclow', 'code_trunchigh',
    'lsb_codes_over_code_amp',
  ],

  run: async (packet, params: SinlParams) => {
    // packet is already IR
    // no file handling
    // no ingestion
    // no format detection
    params = inferSinlParamsFromPacket(params, packet);
    const isVolt           = params.inputMode === 'voltage';
    const minCode          = isVolt ? Number(params.minCode) : Math.round(Number(params.minCode) ?? 0);
    const maxCode          = isVolt ? Number(params.maxCode) : Math.round(Number(params.maxCode) ?? 2047);
    const adcRes           = isVolt ? 10 : deriveAdcRes(Math.round(minCode), Math.round(maxCode));
    const avoidanceRadius  = Math.max(0, Math.round(Number(params.avoidanceRadius) ?? 40));
    const minSizeBin       = Math.max(1, Math.round(Number(params.minSizeBin)      ?? 2));
    const missingThreshold = Number(params.missingThreshold) ?? -0.9;
    const samples          = samplesToCodes(packet.waveform, params.inputMode, minCode, maxCode, 10);
    const { singulars }    = runInlTool(samples, adcRes, avoidanceRadius, minSizeBin, missingThreshold);
    const fileName         = packet.metadata.sourceFile ?? 'waveform';
    return singularsToOutput(singulars, fileName);
  },

  prepareData: async (
    packet: WaveformPacket,
    params: SinlParams,
  ): Promise<{
    figureData: SinlFigureData;
    debugTables: PluginDebugTable[];
  }> => {
    params = inferSinlParamsFromPacket(params, packet);

    const {
      minCode,
      maxCode,
      adcRes,
      avoidanceRadius,
      minSizeBin,
      missingThreshold,
    } = normalizeSinlParams(params);

    const samples = samplesToCodes(
      packet.waveform,
      params.inputMode,
      minCode,
      maxCode,
      adcRes,
    );

    return _sinlPrepareCore(
      samples,
      adcRes,
      avoidanceRadius,
      minSizeBin,
      missingThreshold,
      packet.metadata.sourceFile ?? 'waveform',
      minCode,
      maxCode,
      params.inputMode,
    );
  },


  figures: sinlFigures,
};
