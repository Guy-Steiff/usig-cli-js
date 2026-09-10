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

import { ComponentType } from 'react';
import type { WaveformPacket } from './ingest';
import type { IngestHints } from './ingest';
export type { WaveformPacket } from './ingest';


/** A JSON-serialisable description of a single plugin parameter. */
export interface ParamSchema {
  key: string;
  label: string;
  type: 'column-select' | 'text' | 'number' | 'boolean';
  required: boolean;
  description?: string;

  aliases?: string[];
  possibleValues?: string[];
  min?: number;
  max?: number;
  unit?: string;
  unitOptions?: string[];
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
  /** Optional declarative debug table capabilities exposed by the plugin. */
  debugTables?: Array<{
    id: string;
    label?: string;
    description?: string;
    columns?: string[];
  }>;
  /**
   * Optional declarative figure capabilities exposed by the plugin.
   * Safe to enumerate via `-figure list` WITHOUT ingesting any input or
   * loading the (browser-only) React figure components — mirrors
   * `debugTables` above.
   */
  figures?: Array<{
    id: string;
    label?: string;
    description?: string;
  }>;
}

/**
 * Portable, renderer-agnostic description of a single figure — enough
 * information for Python/MATLAB (or the CLI's own SVG renderer) to
 * reconstruct the plot, without any React/Recharts/DOM internals.
 *
 * Deliberately excludes: fonts, CSS, component trees, renderer-specific
 * styling. Ticks are intentionally omitted when the plugin does not define
 * explicit ticks — the renderer is expected to derive sensible ticks itself.
 */
export interface PortableFigureDescription {
  /** Figure id, e.g. "dnl" */
  figure: string;
  /** Plain-text title (already resolved to a string — no JSX/markup). */
  title: string;
  x: {
    label: string;
    /** Shared x-axis data — series below reuse this same array by index. */
    data: number[];
    /**
     * Optional explicit tick positions. When provided, the renderer honors
     * these exactly instead of auto-computing "nice" ticks. Omit to fall
     * back to the renderer's default tick derivation.
     */
    ticks?: number[];
  };
  series: Array<{
    /** Series/legend name, e.g. "DNL" or "3rd-order poly". */
    name: string;
    /** y values; NaN/non-finite values are represented as null. */
    y: Array<number | null>;
    /** Visual distinction that carries semantic meaning (e.g. measured vs. fit). */
    style?: 'solid' | 'dashed';
  }>;
  y: {
    label: string;
    /** Optional explicit tick positions (see x.ticks). */
    ticks?: number[];
  };
  legend: {
    enabled: boolean;
    /**
     * Optional explicit legend entries (label + swatch color/shape), used
     * when the auto-derived series-name legend is insufficient — e.g. a
     * legend describing marker categories (spurs, harmonics) rather than
     * plotted series. When present, the renderer draws this as a strip
     * below the figure instead of (or in addition to) the default
     * series-name legend above it.
     */
    items?: Array<{
      label: string;
      color?: string;
      shape?: 'circle' | 'triangle' | 'line' | 'area';
    }>;
  };
  grid: {
    x: boolean;
    y: boolean;
  };
  referenceLines?: Array<{
    axis: 'x' | 'y';
    value: number;
    label?: string;
  }>;
  referenceAreas?: Array<{
    x1: number;
    x2: number;
    label?: string;
    /**
     * Optional semantic hint for analytical warning/constraint regions
     * (e.g. SFDR search-avoidance zones, threshold windows) — NOT a
     * general-purpose styling system. Renderer maps 'warning' to a
     * translucent yellow region. Omit for the default reference-area style.
     */
    style?: 'warning';
  }>;
  /**
   * Discrete point annotations pinned to specific (x, y) data coordinates —
   * e.g. spectral spurs/harmonics. Distinct from referenceLines (which span
   * the full axis): a marker is a single labeled point drawn exactly at its
   * data coordinate, with its label placed immediately above it.
   */
  markers?: Array<{
    x: number;
    y: number;
    label?: string;
    color?: string;
    shape?: 'circle' | 'triangle';
    /**
     * Optional label text rotation, in degrees (e.g. -90 for vertical text).
     * Purely a rendering hint — the renderer only knows how to rotate text
     * around the marker point; it has no idea why a plugin might request it
     * (e.g. long combinational-product labels that would otherwise overlap).
     */
    textRotation?: number;
  }>;
  /**
   * Optional textual results block (e.g. SFDR/SNR summary rows) rendered
   * alongside or below the figure. Purely informational — not plotted data.
   */
  resultsPanel?: Array<{
    label: string;
    value: string;
  }>;
  /**
   * Optional 2D density/raster plot — a generic grid-based visual
   * primitive for any plugin whose figure is fundamentally a 2D grid
   * rather than an x/y line series (e.g. eye diagrams, spectrograms, 2D
   * histograms/heatmaps). Deliberately generic: the renderer only knows
   * how to normalize and colorize a numeric grid onto a data-space
   * extent — it has no idea what the grid values represent.
   *
   * When present, the heatmap is drawn first (as the plot's background
   * raster); series/markers/referenceLines/referenceAreas are layered on
   * top using the same coordinate mapping as the rest of the figure.
   *
   * Row-major layout convention (matches common "origin at bottom-left"
   * scientific-plot / image conventions, e.g. numpy's `origin='lower'`):
   * `grid[0..width-1]` is the FIRST row and maps to `extent[2]` (yMin);
   * the LAST row maps to `extent[3]` (yMax). Renderers must flip rows
   * when rasterizing top-down.
   */
  heatmap?: {
    /** Row-major grid values, length === width * height. Plugins may
     * pre-scale values (e.g. log10) however is meaningful for their data;
     * the renderer only normalizes min→max for colorization. */
    grid: number[];
    /** Number of columns in the grid. */
    width: number;
    /** Number of rows in the grid. */
    height: number;
    /** Data-space extent the grid maps onto: [xMin, xMax, yMin, yMax]. */
    extent: [number, number, number, number];
    /** Optional generic color-scale hint (not domain-specific). Defaults to 'heat'. */
    colorScale?: 'heat' | 'grayscale';
  };
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
  /**
   * Optional portable-data alternative to `component`/`draw`. Produces a
   * renderer-agnostic PortableFigureDescription (see pluginTypes.ts) from the
   * same `data` the component/draw would receive — used by the CLI to
   * generate SVG/PNG/JPEG output and a sibling JSON description without any
   * React/DOM dependency. Does not recompute analysis data; consumes the
   * already-computed figureData produced by prepareData().
   *
   * May return `undefined` when the figure is not meaningful for the given
   * data (e.g. a conditional figure that only applies for certain param
   * combinations). The CLI treats this the same as any other figure
   * generation failure — it reports an error for that figure and continues.
   */
  getData?: (data: unknown, controls: FigureControlValues) => PortableFigureDescription | undefined;
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
   * Optional: alternate names this field is also known by.
   * Mirrors `paramSchema[].aliases` — consulted by the generic CLI
   * filename-token inference (usig.mjs) and unknown-parameter validation
   * so a plugin can declare short/abbreviated filename tokens (e.g. "fin",
   * "nfft") without a second, field-type-specific alias mechanism.
   */
  aliases?: string[];
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
 * Standard output:
 *   run() → receives a canonical WaveformPacket and returns one scalar row.
 *
 * Optional rich output:
 *   prepareData() → receives the same canonical WaveformPacket and returns
 *   figure data and/or debug tables.
 *
 * Plugins operate exclusively on IR frames / WaveformPackets.
 * File ingestion and format detection happen upstream in the pipeline.
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

  /**
   * Standard plugin execution.
   * Receives the canonical IR WaveformPacket — never a File or raw file format.
   * Returns one scalar result row for the input packet.
   */

  run: (
      packet: WaveformPacket,
      params: P,
    ) => Promise<Record<string, string | number>>;

  /**
   * Optional: called whenever any param changes (changedKey = the key that changed).
   * Return a partial params object with fields to override — the platform merges them in.
   * Use this to keep derived/linked fields in sync (e.g. auto-fill window correction
   * metrics when the window type changes).
   */
  onParamChange?: (changedKey: string, params: P) => Partial<P> | null;

  /**
   * Optional canonical prepareData counterpart.
   * Same as prepareData() but receives a WaveformPacket instead of a File.
   */
  prepareData?: (
      packet: WaveformPacket,
      params: P,
    ) => Promise<{
      figureData?: unknown;
      debugTables?: PluginDebugTable[];
    }>;

  /**
   * Declared output column names — keys that run() will produce.
   * Shown in the plugin card's Output Columns panel immediately, without needing a run.
   * List all stable output keys; conditional keys (e.g. multi-core only) can be included too.
   * Falls back to post-run actuals if omitted.
   */
  outputColumns?: string[];

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

  /**
   * Optional: plugin-specific ingestion hints (e.g. which CSV column holds
   * the signal, units, endianness) derived from the current params. Called
   * by the platform/CLI before ingesting an input so format-detection can
   * use plugin knowledge (e.g. a user-selected target column) instead of
   * generic heuristics alone.
   */
  getIngestHints?: (params: P) => IngestHints;
}
