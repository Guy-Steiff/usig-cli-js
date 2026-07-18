/**
 * Plugin type definitions — shared between the registry and PipelineBlock.
 *
 * ─── PLUGIN LIFECYCLE ────────────────────────────────────────────────────────
 *
 *  1. LOCAL UPLOAD (ephemeral, user-only)
 *     A user uploads a .tsx/.js plugin file.  It is dynamically imported,
 *     wrapped in try/catch so a broken plugin cannot crash the site, and
 *     registered with registerPlugin().  The plugin is persisted to localStorage
 *     so it survives a page refresh until the user clears storage.
 *     All computation runs locally — no data ever leaves the browser.
 *
 *  2. SUBMISSION FOR REVIEW
 *     Once satisfied, the user submits the plugin (initially via a ticket,
 *     later via an automated pipeline).  The submission artifact is
 *     plugin.manifest — a pure-JSON object that can be read without
 *     executing any plugin code (safe for reviewer inspection).
 *
 *  3. REGISTRY APPROVAL
 *     An approved manifest is written to the central registry (JSON/YAML).
 *     The registry entry references the plugin source (bundled or CDN URL).
 *     Approved plugins become available to all users.
 *
 * ─── WHY MANIFEST AND PARAMFIELDS BOTH EXIST ─────────────────────────────────
 *
 *  manifest.paramSchema   ← JSON-safe, executable without running code.
 *                           Travels through the approval pipeline.
 *                           Written to the registry YAML verbatim.
 *                           Think of it as the submission form for each param.
 *
 *  paramFields            ← Runtime UI declaration.  Can contain functions
 *                           (transform, colorClass, etc.).  Only meaningful
 *                           after the plugin is loaded and running.
 *
 *  They describe the same params from different angles — do NOT collapse them.
 */

import { ReactNode, ComponentType } from 'react';

/** A JSON-serialisable description of a single plugin parameter. */
export interface ParamSchema {
  key: string;
  label: string;
  type: 'column-select' | 'text' | 'number' | 'boolean';
  required: boolean;
  description?: string;
}

/** Self-describing metadata about a plugin — safe to serialise & transmit. */
export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;          // semver string, e.g. "1.0.0"
  author: string;           // required — full name of the plugin author
  authorEmail: string;      // required — contact e-mail of the plugin author
  category?: string;        // e.g. "statistics", "aggregation", "transform"
  /** Optional author links — any can be omitted or left as empty string. */
  github?: string;          // e.g. "https://github.com/yourhandle"
  linkedin?: string;        // e.g. "https://linkedin.com/in/yourprofile"
  website?: string;         // e.g. "https://yoursite.com"
  /**
   * Python twin — used by the offline script generator.
   * pythonModule: pip-installable package or local .py filename (e.g. 'sinl_tool' or 'sinl_tool.py')
   * pythonFunction: entry-point function name (e.g. 'run_sinl')
   * When both are set, the platform can auto-generate an equivalent offline Python script.
   */
  pythonModule?: string;
  pythonFunction?: string;
  /**
   * Title used for this plugin's section in PDF/DOCX reports.
   * Defaults to `name` if omitted.
   */
  reportTitle?: string;
  paramSchema: ParamSchema[];
}

/**
 * A single interactive control declared by a figure.
 * FigureViewer renders these generically and passes current values into draw().
 */
export type FigureControl =
  | {
      key: string;
      type: 'slider';
      label: string;
      min: number;
      max: number;
      step: number;
      default: number;
      unit?: string;        // displayed after the value, e.g. "MHz" or "dB"
    }
  | {
      key: string;
      type: 'number';
      label: string;
      min?: number;
      max?: number;
      step?: number;
      default: number;
      unit?: string;
    }
  | {
      key: string;
      type: 'toggle';
      label: string;
      default: boolean;
    }
  | {
      key: string;
      type: 'select';
      label: string;
      options: string[];
      default: string;
    };

/** Values passed into draw() — key matches FigureControl.key, value matches the control type. */
export type FigureControlValues = Record<string, number | boolean | string>;

/** A single drawable figure a plugin can produce. */
export interface PluginFigure {
  /** Short identifier, e.g. "pdf" | "dnl" | "inl" */
  id: string;
  /** Display label on the button, e.g. "PDF", "DNL", "INL with markers" */
  label: string;
  /**
   * Optional interactive controls. FigureViewer renders these as sliders/inputs
   * above the canvas and re-calls draw() on every change — no pipeline re-run needed.
   */
  controls?: FigureControl[];
  /**
   * Draw the figure onto the provided canvas context.
   * `controls` contains the current values of any declared controls (keyed by FigureControl.key).
   * When no controls are declared, `controls` is an empty object.
   * @deprecated Prefer `component` for interactive Recharts-based figures.
   */
  draw?: (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    data: unknown,
    controls: FigureControlValues,
  ) => void;
  /**
   * React component alternative to `draw`. When present, FigureViewer renders
   * this component instead of a canvas. Receives `data` and current control values.
   * Use this for interactive Recharts-based figures.
   */
  component?: ComponentType<{ data: unknown; controls: FigureControlValues }>;
}

/**
 * A non-singular debug table a plugin can expose per processed file.
 *
 * These are NOT written to the main CSV output — they are optional per-file
 * debug artefacts that the user can download on demand (CSV / JSON).
 *
 * Examples:
 *   • SINL: per-code INL / DNL / PDF / CDF arrays
 *   • SMEAS: per-tone spectrum table, per-harmonic detail table
 *
 * Each table is a columnar object: { columnName: values[] }.
 * All columns must have the same length.
 */
export interface PluginDebugTable {
  /** Short identifier used in the dropdown, e.g. "inl_dnl_series" */
  id: string;
  /** Display label shown in the download dropdown, e.g. "INL/DNL per-code series" */
  label: string;
  /** Columnar data: key → array of values (all same length). */
  columns: Record<string, (string | number | null)[]>;
}

/**
 * A unified plugin parameter field declaration.
 *
 * Replaces the old split between "ConfigPanel globals" and "inferredParamFields".
 * Every plugin parameter — whether it lives in the global config section or the
 * per-file table — is declared here.  `defaultScope` controls placement; the user
 * can flip any field between scopes at run time via the 🌐/📄 toggle.
 *
 * The platform reads these at runtime to:
 *   1. Seed `inferredParams[key]` for every loaded file (per-file scope) or
 *      `pluginParams[pluginId][key]` (global scope), using `regex`+`replace`+`defaultValue`.
 *   2. Render UI generically — per-file table column or global config section.
 *   3. Pass the resolved value into `params[key]` when calling `run()` / `prepareData()`.
 *
 * For purely manual parameters (no filename extraction), set `defaultRegex: ''`.
 * `transform` (optional): convert the raw extracted string → the value to store.
 */
export interface InferredParamField {
  /** Key in `params` and `inferredParams`. */
  key: string;
  /** Short label shown in the UI. */
  label: string;
  /**
   * Whether this parameter is required for run() to succeed.
   * Mirrors the same field in manifest.paramSchema.
   * The pipeline can use this for pre-run validation.
   */
  required?: boolean;
  /**
   * Field type — controls how the pipeline seeds and renders this field.
   *
   * - `'column-select'` (NEW): renders a dropdown of the file's CSV column headers.
   *   Auto-seeds by matching `defaultValue` exactly, then falls back to the column
   *   with the most unique values (the smart heuristic). Fully malleable: supports
   *   the same global ↔ per-file scope toggle as all other paramFields.
   *   Set `defaultRegex: ''` for pure manual selection.
   *
   * - `undefined` (default): free-text / numeric / options field as before.
   */
  type?: 'column-select';
  /**
   * Default regex (can contain capture groups). Empty string = no auto-extraction.
   * When empty, the field is purely manual — the user sets the value directly.
   */
  defaultRegex: string;
  /** Default replacement pairs string, e.g. "p=." */
  defaultReplace: string;
  /**
   * Static fallback value used when the regex yields nothing (or defaultRegex is empty).
   * The platform seeds the field with this value for every file where extraction fails.
   */
  defaultValue?: string | number;
  /**
   * Default scope for this field.
   *
   * - `'per-file'` (default): appears as a column in the file table.
   *   Each file has its own independently editable value (auto-seeded from
   *   the filename regex, or from defaultValue if the regex does not match).
   *
   * - `'global'`: appears in the global plugin config section.
   *   A single value is shared across all files.
   *
   * The user can flip any field between scopes at run time via the 🌐/📄 toggle.
   * The plugin author sets this to reflect the most natural UX default.
   */
  defaultScope?: 'global' | 'per-file';
  /**
   * If provided the platform renders a segmented button picker instead of a free-text input.
   * Works in both global and per-file scopes.
   */
  options?: string[];
  /**
   * Controls how `options` are rendered.
   * - `'buttons'` (default): segmented button group — best for 2–4 short options.
   * - `'dropdown'`: native `<select>` — best for 5+ options or long labels.
   */
  selectStyle?: 'buttons' | 'dropdown';
  /**
   * Hint for the generic number input rendered in global scope.
   * Ignored when `options` is set.
   */
  min?: number;
  max?: number;
  /** Step for numeric inputs. */
  step?: number;
  /** Unit label displayed next to numeric inputs (e.g. "GHz", "dB"). */
  unit?: string;
  /**
   * When set, renders a unit selector dropdown next to the input.
   * The first entry is the default unit.
   * The stored param value is a plain number; the selected unit is stored
   * separately in `pluginParamUnits` state and appended before running.
   */
  unitOptions?: string[];
  /** Tooltip shown on the field label / column header. */
  title?: string;
  /** Optional: Tailwind colour theme class for the column header (e.g. "text-purple-300"). */
  colorClass?: string;
  /** Optional: tooltip shown on the regex input. */
  regexTitle?: string;
  /** Optional: tooltip shown on the replace input. */
  replaceTitle?: string;
  /**
   * Optional transform: raw extracted string → stored value.
   * If omitted, the raw string is stored as-is.
   * Not called when the value comes from `defaultValue` directly.
   */
  transform?: (raw: string) => string | number;
  /**
   * Optional: subset of `options` values that should be highlighted as recommended.
   * PipelineBlock renders these with a green tint instead of the default blue.
   */
  recommendedOptions?: string[];
  /**
   * Optional: when this function returns true (given the current global params for
   * this plugin), the field is rendered greyed-out and non-interactive.
   */
  disabledWhen?: (params: Record<string, unknown>) => boolean;
  /**
   * Optional: when this function returns true for the current field value, the
   * input is highlighted in amber/red as a warning (value is valid but suboptimal).
   * Evaluated on both the global input and each per-file cell.
   * Example: fftLength — warn when not a power of 2 (triggers slow DFT path).
   */
  warningIf?: (value: unknown) => boolean;
  /**
   * Optional: renders a labelled separator line above this field in the card.
   * Use to group related fields visually (e.g. "── TI Correction ──").
   */
  sectionHeader?: string;
  /**
   * Optional: when set, flipping the scope (global ↔ per-file) of any field in
   * this group simultaneously flips ALL fields sharing the same scopeGroup string.
   * Use for tightly coupled fields like windowing parameters.
   */
  scopeGroup?: string;
  /**
   * Optional column regex: if provided, the platform will exclude any CSV headers
   * matching this regex from the extra-column suggestions (they are consumed by the plugin).
   * The value is taken from `params[columnRegexParamKey]` at runtime.
   */
  columnRegexParamKey?: string;
  /**
   * Optional: suggested output column name when the user enables "add as column".
   * Defaults to `key` if omitted.
   */
  outputColumnName?: string;
}

/**
 * Generic plugin definition.
 *
 * P  — the shape of the plugin's configuration parameters.
 *
 * Standard output (required):
 *   `run` → one scalar row per input file → written to the main results CSV.
 *
 * Optional debug outputs:
 *   `prepareData` → returns { figureData, debugTables } per file.
 *   `figures`     → canvas plots drawn from figureData.
 *   `debugTables` declared on the plugin → downloaded as CSV/JSON on demand.
 */
export interface Plugin<P = Record<string, string>> {
  id: string;
  name: string;
  description: string;
  manifest?: PluginManifest;   // optional for backward compat; all new plugins must include it
  defaultParams: P;
  paramFields?: InferredParamField[];
  /** @deprecated Use `paramFields` instead. Kept for backward compatibility. */
  inferredParamFields?: InferredParamField[];

  /**
   * REMOVED: ConfigPanel is deprecated.
   * All plugin configuration should be done through:
   *   - columnRequirements (for column selection)
   *   - paramFields (for algorithm parameters)
   *   - figure controls (for display settings)
   *
   * ConfigPanel created conflicting sources of truth and required manual UI code.
   * The declarative approach is simpler, more consistent, and more maintainable.
   */

  /** Standard output: one scalar row per file — written to the main results CSV. */
  run: (file: File, params: P) => Promise<Record<string, string | number>>;

  /**
   * Optional: called whenever any param changes (changedKey = the key that changed).
   * Return a partial params object with fields to override — the platform merges them in.
   * Use this to keep derived/linked fields in sync (e.g. auto-fill window correction
   * metrics when the window type changes).
   */
  onParamChange?: (changedKey: string, params: P) => Partial<P> | null;

  /**
   * Translate resolved params into IngestHints for the ingestion layer.
   *
   * The pipeline calls this BEFORE ingesting each file so that `ingestFile()`
   * uses the correct signal column, fs-column regex, etc. chosen by the user.
   *
   * If omitted, the pipeline falls back to the most-unique-values heuristic
   * which will pick the wrong column in multi-column files.
   *
   * Every plugin that has a column-select parameter MUST implement this.
   */
  getIngestHints?: (params: P) => import('./ingest').IngestHints;

  /**
   * Optional canonical-data-model entry point.
   * When implemented, the pipeline calls this INSTEAD of run() when a WaveformPacket
   * is available (i.e. the file was ingested via the ingestion layer).
   * Plugins that implement this receive Float32Array + metadata and never touch
   * raw file bytes, CSV strings, or binary formats.
   * This is the preferred API for new plugins and the migration target for existing ones.
   */
  runFromWaveform?: (packet: import('./ingest').WaveformPacket, params: P) => Promise<Record<string, string | number>>;
  /**
   * Optional canonical prepareData counterpart.
   * Same as prepareData() but receives a WaveformPacket instead of a File.
   */
  prepareDataFromWaveform?: (packet: import('./ingest').WaveformPacket, params: P) => Promise<{
    figureData?: unknown;
    debugTables?: import('./pluginTypes').PluginDebugTable[];
  }>;
  /**
   * Declared output column names — keys that run() will produce.
   * Shown in the plugin card's Output Columns panel immediately, without needing a run.
   * List all stable output keys; conditional keys (e.g. multi-core only) can be included too.
   * Falls back to post-run actuals if omitted.
   */
  outputColumns?: string[];
  /**
   * Optional: produce rich per-file data alongside the scalar result.
   * Return value shape: { figureData?: unknown; debugTables?: PluginDebugTable[] }
   * figureData is passed to each figure's draw().
   * debugTables are exposed as downloadable CSV/JSON per file.
   */
  prepareData?: (file: File, params: P) => Promise<{
    figureData?: unknown;
    debugTables?: PluginDebugTable[];
  }>;
  /** Figures this plugin can draw — shown as plot buttons after a successful run. */
  figures?: PluginFigure[];
  /**
   * Optional markdown documentation string. When provided, a collapsed "📖 plugin docs"
   * section is shown in the plugin card beneath the standard info block.
   * Load via a generated .doc.ts module (run: npm run docs to regenerate from .md).
   */
  doc?: string;

  /**
   * Declare which pipeline-captured variables this plugin wants auto-populated into
   * its params on file load.
   *
   * The pipeline runs broad regex extraction on every filename and single-value column
   * to populate a `capturedVars` map (keys like 'fs_hz', 'adc_bits', etc.).
   * Each entry here maps one captured variable → one plugin param key.
   *
   * The pipeline will auto-seed `inferredParams[paramKey]` for each file where the
   * captured variable is available and the param has not already been set by a
   * filename-regex match.  Plugin-owned transforms (InferredParamField.transform)
   * are still applied after the value is injected.
   *
   * Plugins that don't declare any requests are unaffected.
   */
  capturedVarsRequests?: Array<{
    /** Key in the pipeline's capturedVars map (e.g. 'fs_hz', 'adc_bits'). */
    capturedKey: string;
    /** Key in this plugin's params (e.g. 'fsGhz'). */
    paramKey: string;
  }>;
}
