# Plugin Architecture & Developer Guide

A complete reference for understanding, writing, and contributing plugins to the image_site platform.

---

## Quick Reference: Plugin Contract

Every plugin must export an object satisfying the `Plugin<P>` interface:

```typescript
export interface Plugin<P = Record<string, string>> {
  id:              string;                                      // Unique identifier
  name:            string;                                      // Display name
  description:     string;                                      // One-line summary
  manifest:        PluginManifest;                              // JSON-safe metadata
  defaultParams:   P;                                           // Initial global-only params
  paramFields?:    InferredParamField[];                        // Malleable global ↔ per-file params
  outputColumns?:  string[];                                    // ★ NEW: Declared output key names

  run:             (file: File, params: P) => Promise<Record<string, string | number>>;
  prepareData?:    (file: File, params: P) => Promise<{ figureData?, debugTables? }>;
  figures?:        PluginFigure[];
}
```

### ★ `outputColumns` — Declared Output Keys (Required for multi-plugin pipelines)

Declare every key your `run()` function returns (except `filename`):

```typescript
outputColumns: [
  'snr', 'thd', 'sfdr', 'enob', 'noise_floor',
],
```

**Why it matters:**
- The pipeline UI shows your columns in the output selector **before the first run**, so users can configure renames/exclusions upfront
- Used for **conflict detection** — if two plugins both declare `snr`, the pipeline will auto-postfix both as `snr_pluginA` / `snr_pluginB` and warn the user
- Users can **rename** your output columns inline; the declared name is the canonical rename key
- Post-run actuals are also tracked as a fallback, but declaring upfront is strongly preferred

**Rules:**
- Names must match the keys returned by `run()` exactly (case-sensitive)
- Use `snake_case` (portable to CSV/Python)
- Do **not** include `filename` (always present, never renamed)
- Keep names globally unique where possible — if two plugins share a common concept (e.g. `snr`), expect auto-postfixing and document it

---

## Understanding the 5-Location Parameter Rule

This is the heart of the architecture and often confuses new authors. Here's why each parameter must appear in exactly 5 places.

> **Still 5 locations** — the count has not changed. What *has* changed is that `defaultScope` is now **effectively required** on every `column-select` paramField (see Location 2 below). Omitting it defaults to `'per-file'`, which hides the field from the plugin card once any file is loaded.

### The Problem It Solves

**Naive approach** (broken):
1. Define a parameter once in some config object
2. Assume it auto-propagates everywhere
3. Result: missing validations, inconsistent UX, impossible to review without running code

**Real world constraints**:
- Some params are purely **global** (shared across all files)
- Some params are **per-file** (one value per input file, extracted from filename via regex)
- Some params can *toggle* between global and per-file at runtime
- The approval pipeline must review parameters **without executing any plugin code**
- Users should be able to understand what a plugin does by reading JSON, not TypeScript

### The 5 Locations

Every parameter lives in exactly 5 places (with different serialization rules):

#### **1. `manifest.paramSchema` (JSON, approval-safe)**

```typescript
const manifest: PluginManifest = {
  // ...
  paramSchema: [
    {
      key: 'sample_column',
      label: 'Sample column',
      type: 'column-select',           // Types: 'column-select' | 'text' | 'number' | 'boolean'
      required: true,
      description: 'CSV column with ADC samples',
    },
    {
      key: 'adc_res',
      label: 'ADC resolution',
      type: 'number',
      required: true,
      description: 'ADC bits (e.g., 12)',
    },
  ],
};
```

**Purpose**: Safe for approval pipeline (pure JSON, no code execution). Travels through review. Becomes the registry entry.

**Rules**:
- Must include **every** parameter the plugin uses
- Type must be one of: `'column-select'`, `'text'`, `'number'`, `'boolean'`
- `required` flag tells the UI which fields must be filled before running
- `description` is shown to users as tooltip

---

#### **2. `paramFields` (Runtime UI declaration)**

```typescript
paramFields: [
  {
    key: 'sample_column',
    label: 'Sample column',
    type: 'column-select',             // NEW: Tells pipeline this is a column selector
    defaultScope: 'per-file',          // Default: appears in file table
    defaultRegex: '',                  // Empty = no auto-extraction (manual selection only)
    defaultValue: '',
    title: 'Select the column with ADC samples',
  },
  {
    key: 'adc_res',
    label: 'ADC resolution (bits)',
    defaultScope: 'global',            // This param is shared across all files
    defaultRegex: '(\\d+)[b-]bit',     // Extract digits after "bit" or "-bit"
    defaultReplace: '$1',              // Keep just the captured group
    defaultValue: '12',                // Fallback if regex fails
    min: 8,
    max: 20,
    step: 1,
    unit: 'bits',
    title: 'ADC resolution in bits',
  },
],
```

**Purpose**: Runtime UI rendering. Pipeline reads this to:
1. Generate form inputs
2. Auto-extract from filename (regex + replace)
3. Place the field in exactly one location: the plugin's **card** (global) or the **per-file table** (per-file) — controlled by `defaultScope`
4. Allow the user to move fields between locations at runtime via the scope toggle

**Key differences from `manifest.paramSchema`**:
- Can include **functions** (not JSON-safe): `transform`, `colorClass` callbacks
- Includes extraction logic: `defaultRegex`, `defaultReplace`, `transform`
- Specifies scope: `defaultScope: 'global' | 'per-file'` (user can toggle)
- Can have UI hints: `min`, `max`, `step`, `unit`, `options`

**`column-select` auto-seeding rules**:

The pipeline seeds `column-select` fields automatically whenever files are loaded or changed, with different behaviour depending on scope:

- **Per-file scope** (`defaultScope: 'per-file'`): each file is seeded independently using **that file's own** column unique-value counts. The pipeline tries an exact `defaultValue` match first, then falls back to the column with the most unique values. Stored in `FileEntry.inferredParams` for that file.

- **Global scope** (`defaultScope: 'global'`): seeded from the **most recently uploaded file's** column counts every time files change. Dropping in a new file always updates the global column selector to the best column from that latest file. Stored in `pluginParams[pluginId][fieldKey]`.

In both cases the user can always override the auto-selected value via the dropdown.

**Rules**:
- Must match keys in `paramFields` with keys in `manifest.paramSchema`
- Can include fewer fields than `manifest.paramSchema` (unmapped fields are manual-only)
- `defaultRegex: ''` means no auto-extraction for that field (purely manual input)
- `defaultValue` is used when regex extraction fails or when no regex is set
- **`defaultScope` is required on every `column-select` field.** Omitting it defaults to `'per-file'`, which hides the field from the plugin card once files are loaded (it would live in the file table instead). Use `'global'` unless you explicitly want per-file independent selection.

---

#### **3. `defaultParams` (TypeScript, plugin defaults)**

```typescript
defaultParams: {
  sample_column: 'ADC_sample',
  adc_res: 12,
  min_code: 0,
  max_code: 4095,
  // ... rest of fields
} as SinlParams;
```

**Purpose**: Initial state for plugin when first loaded. Also defines the TypeScript interface shape.

**Rules**:
- Only **pure global** params go here (not extracted from filename)
- Type-safe counterpart to `manifest.paramSchema`
- Used to initialize the plugin immediately when registry loads it

**Common pitfall**: Some authors put *all* params here and forget about `paramFields`. This breaks the per-file extraction feature.

---

#### **4. Plugin Code: The `run()` Function Signature**

```typescript
run: async (file: File, params: P): Promise<Record<string, string | number>> => {
  const { sample_column, adc_res, min_code, max_code } = params;
  
  // Use the extracted/edited param values
  const data = parseAdcData(file);
  const samples = data[sample_column];
  
  // ... algorithm ...
  
  return { filename: file.name, inl_p2p: 42.3, dnl_max: 1.2 };
};
```

**Purpose**: Defines which keys the Rust/JS runtime will pass into `params`.

**Rules**:
- Every key in `params` must be declared in either:
  - `manifest.paramSchema` (required for approval)
  - `paramFields` (runtime UI extraction)
  - `defaultParams` (global fallback)
- Params are fully resolved before calling `run()` — plugin author doesn't worry about regex/extraction

---

#### **5. localStorage / Browser State**

When a user changes a parameter, the pipeline persists it:

```typescript
// Location 5a: Global para state
{
  "pipeline_config_v1": {
    "inferredParamState": {
      "sinl_plugin_id": {
        "adc_res": { regex: "\\d+[b-]bit", replace: "$1" },
        "sample_column": { regex: "", replace: "" }
      }
    },
    // Location 5b: Per-file state (one entry per file)
    "inferredParams": {
      "file1.csv": { adc_res: "12", sample_column: "ADC" },
      "file2.csv": { adc_res: "12", sample_column: "ADC" }
    }
  }
}
```

**Purpose**: Survive page refresh, allow user to edit and re-run with same settings.

**Rules**:
- Automatically managed by `PipelineBlock` — plugin authors don't touch this directly
- Includes both the regex/replace rules (extractors) and the resolved values (per-file state)

---

## Why This Complexity?

**Q: Can't we just put everything in `manifest.paramSchema` and extract at build time?**

A: No, because:
1. The **approval pipeline** needs to read manifests without executing code
2. Some params are **column-select** (dynamic based on CSV), others are **static** (8/12/16 bits)
3. Users might **toggle** params between global and per-file at runtime
4. The filesystem extraction (regex) must be **editable by the user** — they might rename their files

**Q: Why not put everything in `paramFields`?**

A: Because:
1. `paramFields` contains functions (not JSON-safe) — can't serialize for approval
2. New plugins must supply `manifest` first (approval requirement)
3. The registry serves `manifest.paramSchema` to all users

**Q: What if I only have global params?**

A: That's fine! Set:
- `manifest.paramSchema`: your 3 params
- `paramFields`: [] (empty, or omit)
- `defaultParams`: your 3 params

The pipeline will treat them as pure global, no per-file extraction.

---

## Minimal Example: A Three-Parameter Plugin

Below is a complete "Grade Average" plugin to illustrate the 5-location pattern.

### Plugin Type Interface

```typescript
interface GradeParams {
  schoolName: string;      // Global: free text name of the school
  scoreColumn: string;     // Per-file: extract from CSV header
  threshold: number;       // Global: filter threshold
}
```

### Locations 1–3: Manifest, ParamFields, DefaultParams

```typescript
const manifest: PluginManifest = {
  id: 'grade_average',
  name: 'Grade Average Analyzer',
  description: 'Computes average student scores per school.',
  version: '1.0.0',
  author: 'Test Author',
  authorEmail: 'test@example.com',
  paramSchema: [  // ← Location 1: Registry-safe JSON
    { key: 'schoolName', label: 'School Name', type: 'text', required: true },
    { key: 'scoreColumn', label: 'Score Column', type: 'column-select', required: true },
    { key: 'threshold', label: 'Pass Threshold', type: 'number', required: false },
  ],
};

const paramFields: InferredParamField[] = [  // ← Location 2: Runtime UI
  {
    key: 'schoolName',
    label: 'School Name',
    defaultScope: 'global',
    defaultRegex: '',
    defaultReplace: '',
    defaultValue: 'Lincoln High',
    title: 'Name of the school (global, shared across all files)',
  },
  {
    key: 'scoreColumn',
    label: 'Score Column',
    type: 'column-select',
    defaultScope: 'per-file',
    defaultRegex: '',
    defaultReplace: '',
    defaultValue: 'score',
    title: 'Column header containing scores (manual selection)',
  },
  {
    key: 'threshold',
    label: 'Pass Threshold',
    defaultScope: 'global',
    defaultRegex: '(\\d+)',
    defaultReplace: '$1',
    defaultValue: 70,
    min: 0,
    max: 100,
    title: 'Minimum score to pass (can extract from filename)',
  },
];

const defaultParams: GradeParams = {  // ← Location 3: TypeScript default
  schoolName: 'Lincoln High',
  scoreColumn: 'score',
  threshold: 70,
};
```

### Location 4: The `run()` Function

```typescript
export const gradePlugin: Plugin<GradeParams> = {
  id: 'grade_average',
  name: 'Grade Average Analyzer',
  description: manifest.description,
  manifest,
  paramFields,
  defaultParams,
  
  run: async (file: File, params: GradeParams) => {
    // ← Location 4: `params` keys are fully resolved here
    const { schoolName, scoreColumn, threshold } = params;
    
    const text = await file.text();
    const rows = parseSimpleCsv(text);
    
    const scores = rows
      .map(r => parseFloat(r[scoreColumn]))
      .filter(x => !isNaN(x));
    
    if (scores.length === 0) throw new Error('No valid scores found.');
    
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const passCount = scores.filter(s => s >= threshold).length;
    
    return {
      filename: file.name,
      school: schoolName,
      average_score: parseFloat(avg.toFixed(2)),
      pass_count: passCount,
      pass_rate: parseFloat((100 * passCount / scores.length).toFixed(1)),
    };
  },
};
```

### Location 5: localStorage (Automatic)

When the user runs the pipeline, the platform stores:

```json
{
  "inferredParamState": {
    "grade_average": {
      "schoolName": { "regex": "", "replace": "" },
      "scoreColumn": { "regex": "", "replace": "" },
      "threshold": { "regex": "\\d+", "replace": "$1" }
    }
  },
  "inferredParams": {
    "class_q1_2026.csv": { 
      "schoolName": "Lincoln High",
      "scoreColumn": "score",
      "threshold": "75"
    },
    "class_q2_2026.csv": { 
      "schoolName": "Lincoln High",
      "scoreColumn": "score",
      "threshold": "75"
    }
  }
}
```

---

## Complete Plugin Anatomy

### 1. Type Interfaces

```typescript
// 1a. Params (what run() receives)
interface MyParams {
  inputColumn: string;
  gain: number;
  window: 'hamming' | 'blackman' | 'triangular';
}

// 1b. Figure data (returned by prepareData(), consumed by figures[])
interface MyFigureData {
  frequencies: number[];
  magnitudes: number[];
  noise_floor: number;
}

// 1c. Debug table structure (downloadable per-file data)
interface DebugSpectrum {
  bin: number[];
  frequency_hz: number[];
  magnitude_db: number[];
  phase_rad: number[];
}
```

### 2. Manifest (JSON-safe metadata)

```typescript
const manifest: PluginManifest = {
  id: 'my_spectrum_plugin',
  name: 'My Spectrum Analyzer',
  description: 'FFT-based spectrum analysis with window support.',
  version: '2.1.0',
  author: 'Your Name',
  authorEmail: 'you@example.com',
  category: 'signal_processing',
  
  // Optional author links
  github: 'https://github.com/yourname/my-plugin',
  linkedin: 'https://linkedin.com/in/yourname',
  website: 'https://yoursite.com',
  
  // Python twin metadata (for offline script generation)
  pythonModule: 'my_spectrum_tool',       // pip-installable or .py filename
  pythonFunction: 'analyze_spectrum',     // Entry-point function name
  
  // Report generation title
  reportTitle: 'Spectrum Analysis',
  
  // Registry-safe parameter schema
  paramSchema: [
    {
      key: 'inputColumn',
      label: 'Input Column',
      type: 'column-select',
      required: true,
      description: 'CSV column with time-domain samples',
    },
    {
      key: 'gain',
      label: 'Gain',
      type: 'number',
      required: false,
      description: 'Scaling factor (dB)',
    },
    {
      key: 'window',
      label: 'Window Function',
      type: 'text',
      required: false,
      description: 'hamming | blackman | triangular',
    },
  ],
};
```

### 3. Runtime Parameter Declarations

```typescript
const paramFields: InferredParamField[] = [
  {
    key: 'inputColumn',
    label: 'Input Column',
    type: 'column-select',
    defaultScope: 'per-file',
    defaultRegex: '',
    defaultReplace: '',
    defaultValue: 'voltage',
    title: 'Select the column with time-domain samples (manual)',
  },
  {
    key: 'gain',
    label: 'Gain (dB)',
    defaultScope: 'global',
    defaultRegex: '([-\\d.]+)\\s*dB',  // Extract "-6.5 dB" → "-6.5"
    defaultReplace: '$1',
    defaultValue: 0,
    min: -20,
    max: 20,
    step: 0.5,
    unit: 'dB',
    title: 'Scaling factor; extractable from filename (e.g., "gain_-6.5dB.csv")',
  },
  {
    key: 'window',
    label: 'Window',
    defaultScope: 'global',
    defaultRegex: '(hamming|blackman|triangular)',
    defaultReplace: '$1',
    defaultValue: 'hamming',
    options: ['hamming', 'blackman', 'triangular'],
    title: 'Window function for FFT',
  },
];
```

### 4. Default Parameters

```typescript
const defaultParams: MyParams = {
  inputColumn: 'voltage',
  gain: 0,
  window: 'hamming',
};
```

### 5. Core Computation

```typescript
// Shared logic (called by both run() and prepareData())
function computeSpectrum(samples: number[], window: string, gain: number): MyFigureData {
  const fft_input = applyWindow(samples, window);
  const fft_out = performFFT(fft_input);
  
  const mag_db = fft_out.magnitudes.map(m => 20 * Math.log10(m + 1e-10) + gain);
  const noise_floor = Math.min(...mag_db.slice(-10));
  
  return {
    frequencies: fft_out.frequencies,
    magnitudes: mag_db,
    noise_floor,
  };
}
```

### 6. Plugin Export

```typescript
export const mySpectrumPlugin: Plugin<MyParams> = {
  id: 'my_spectrum_plugin',
  name: 'My Spectrum Analyzer',
  description: manifest.description,
  manifest,
  paramFields,
  defaultParams,
  
  // ── Required: Scalar result row ──
  run: async (file: File, params: MyParams): Promise<Record<string, string | number>> => {
    const { inputColumn, gain, window } = params;
    
    const text = await file.text();
    const { rows } = parseSimpleCsv(text);
    const samples = rows
      .map(r => parseFloat(r[inputColumn]))
      .filter(x => !isNaN(x));
    
    if (samples.length === 0) throw new Error('No valid samples in column.');
    
    const figData = computeSpectrum(samples, window, gain);
    
    return {
      filename: file.name,
      noise_floor_db: parseFloat(figData.noise_floor.toFixed(2)),
      peak_magnitude_db: parseFloat(Math.max(...figData.magnitudes).toFixed(2)),
    };
  },
  
  // ── Optional: Per-file figures + debug tables ──
  prepareData: async (file: File, params: MyParams) => {
    const { inputColumn, gain, window } = params;
    
    const text = await file.text();
    const { rows } = parseSimpleCsv(text);
    const samples = rows
      .map(r => parseFloat(r[inputColumn]))
      .filter(x => !isNaN(x));
    
    const figData = computeSpectrum(samples, window, gain);
    
    // Debug table: raw spectrum data
    const debugTables: PluginDebugTable[] = [
      {
        id: 'spectrum_raw',
        label: 'Raw spectrum (all bins)',
        columns: {
          frequency_hz: figData.frequencies,
          magnitude_db: figData.magnitudes,
        },
      },
    ];
    
    return { figureData: figData, debugTables };
  },
  
  // ── Optional: Per-file figures ──
  figures: [
    {
      id: 'spectrum_plot',
      label: 'Spectrum',
      component: ({ data, controls }: { data: MyFigureData; controls: any }) => {
        const chartData = data.frequencies.map((f, i) => ({
          frequency: f,
          magnitude: data.magnitudes[i],
        }));
        
        return (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="frequency" />
              <YAxis />
              <Line type="monotone" dataKey="magnitude" stroke="#8884d8" />
              <ReferenceLine y={data.noise_floor} stroke="#ff7300" label="Noise floor" />
            </LineChart>
          </ResponsiveContainer>
        );
      },
    },
  ],
};
```

---

## Plugin Lifecycle

### Phase 1: Local Development

1. **Create** a `.tsx` file in `app/components/plugins/`
2. **Export** a `Plugin<YourParams>` object
3. **Test locally** by adding to `BUILTIN_PLUGINS` in `pluginRegistry.ts` (temporary)
4. **Verify** with sample CSV files in browser

Example test locally:
```bash
# In pluginRegistry.ts
import { mySpectrumPlugin } from './mySpectrumPlugin';
const BUILTIN_PLUGINS = [..., mySpectrumPlugin];  // ← Add line
```

### Phase 2: Local User Upload (Ephemeral)

1. **Compile** your plugin: `npx tsc mySpectrumPlugin.tsx --target es2020 --module esnext`
2. **Use Upload Plugin** button in the UI
3. **Plugin runs locally** — stays in localStorage (ephemeral)
4. **No data leaves the browser**

### Phase 3: Submission & Review

1. **Extract** `manifest` from your plugin code
2. **Write** `manifest_myspectrumplugin.json` (pure JSON)
3. **Submit** via GitHub issue/manifest registry
4. **Reviewer reads JSON safely** — no code execution needed
5. **Approved** → written to central registry (YAML/JSON)

### Phase 4: Registry Installation (Future)

1. **Registry serves** approved `PluginManifest[]` entries
2. **UI shows** "Install" button per plugin
3. **User clicks** → plugin loaded from registry URL / CDN
4. **All users** now have access (no platform redeploy needed)

---

## Python Twin & Offline Script Generation (Roadmap)

Plugins can declare a Python twin to enable auto-generated offline scripts:

```typescript
const manifest: PluginManifest = {
  // ...
  pythonModule: 'sinl_tool',         // Can be pip-installable or local .py file
  pythonFunction: 'run_sinl',        // Entry-point function name
};
```

When both are set, after running a batch, users can click "Export as Python script":

```python
# Auto-generated by image_site — 2026-05-11
from sinl_tool import run_sinl
import pandas as pd, glob

params = dict(
    sample_column='ADC_sample',
    adc_res=11,
    min_code=0,
    max_code=2047,
    avoidance_radius=40,
)

# Run on all CSV files in current directory
rows = []
for filepath in glob.glob('*.csv'):
    row = run_sinl(pd.read_csv(filepath), **params)
    rows.append(row)

results_df = pd.DataFrame(rows)
results_df.to_csv('results.csv', index=False)
print(f"Processed {len(results_df)} files. Results saved to results.csv")
```

---

## Best Practices

### Parameter Design

✅ **DO:**
- Keep global parameters <10 (configuration bloat hurts UX)
- Use per-file extraction for column names (auto-select from CSV headers)
- Use regex for filename-derived values (ADC bits, sampling frequency, etc.)
- Provide sensible defaults
- Add `title` descriptions (shown as tooltips)

❌ **DON'T:**
- Create parameters that overlap (avoid both `inputColumn` and `sampleColumn`)
- Require users to manually edit every parameter per file (use `defaultRegex`)
- Mix column-selection with numeric parameters in the same field
- Use regex so complex that users can't understand it

### Return Values

✅ **DO:**
- Always include `filename` as first column
- Round floats to meaningful precision (2–4 decimals)
- Use snake_case column names (portable to CSV/Python)
- Return consistent column count (same keys for every file)
- Declare all returned keys in `outputColumns` (see Quick Reference above)

❌ **DON'T:**
- Return `NaN` or `Infinity` (write `null` or skip the row)
- Use inconsistent types (e.g., `threshold` is string in row 1, number in row 2)
- Return hundreds of columns (use debug tables instead)

### Multi-Plugin Cohabitation

When your plugin runs alongside others in the same pipeline:

- **Conflicting output keys are auto-postfixed** — if both your plugin and another return `snr`, the pipeline writes `snr_yourpluginid` and `snr_otherpluginid`. The user sees a warning and can rename either.
- **`column-select` param keys must be globally unique** — if your plugin has a `column-select` field keyed `data`, and another plugin also has `data`, the pipeline cannot distinguish them. Use a descriptive key like `sampleColumn`, `signalColumn`, `inputColumn`, etc.
- **Declare `outputColumns`** so the conflict detector can warn users at configuration time, before they run anything.
- **Avoid shadowing well-known keys** — `filename`, `snr`, `thd`, `inl`, `dnl` are common; prefix with your plugin id if you expect cohabitation (e.g. `smeas_snr`), or accept that auto-postfixing will occur.

#### Figures in a multi-plugin pipeline

Each plugin's `prepareData()` result is stored **independently per plugin** (keyed by `plugin.id`). The Plot dropdown in the file table aggregates figures from all active figure-capable plugins. When multiple plugins produce figures, each option is prefixed with `[pluginId]` for clarity. Plugin authors don't need to do anything special — the pipeline handles this automatically.

#### Debug tables in a multi-plugin pipeline

Debug tables returned by `prepareData()` are **accumulated across all active plugins** per file. When multiple plugins are active, each table label is automatically prefixed with `[pluginId]` in the download dropdown so the user can distinguish them. The downloaded filename uses the original `id` (without the plugin prefix) for cleanliness. Again, no special handling is required from the plugin author.

### Error Handling

✅ **DO:**
- Throw descriptive errors: `throw new Error('No valid samples found in column "ADC_sample"')`
- Validate params before processing
- Handle missing/empty columns gracefully

❌ **DON'T:**
- Silently return `NaN` (user won't know what went wrong)
- Log to console and continue (breaks batch processing)

### Figures

✅ **DO:**
- Use Recharts for interactive plots (preferred)
- Use Canvas only for performance-critical rendering (e.g., scatter matrix with 10k+ points)
- Make figures responsive (ResponsiveContainer)

❌ **DON'T:**
- Create figures with thousands of data points in Canvas (slow)
- Hardcode colors (use Tailwind/theme classes)

---

## Troubleshooting

### Plugin doesn't load

1. Check browser console for parse errors
2. Ensure the exported object has `{ id, run, defaultParams }`
3. Verify `id` doesn't conflict with built-in plugins

### Parameters not extracted from filename

1. Check `defaultRegex` is correct (test separately)
2. Verify `defaultReplace` references the right capture group
3. Look at localStorage to see what regex was stored

### Results CSV has inconsistent columns

1. Verify `run()` returns the **same keys** for every file
2. Add validation: `if (!params.inputColumn) throw new Error('...')`

### Output columns unexpectedly postfixed (e.g. `snr_smeas`)

1. Another active plugin also outputs a column with the same name
2. The pipeline auto-postfixes both to avoid data loss — this is correct behaviour
3. To resolve: rename one plugin's output key in the UI, or rename the key in `run()` and `outputColumns` to something globally unique
4. The conflict notice appears above the plugin selector when two or more plugins share an output name

### `column-select` param causes false conflict warning

If the pipeline warns about a conflict on a column name that is actually a **parameter key** (e.g. `data`), it means two plugins have a `column-select` field with the same `key`. Fix: rename the `key` in `paramFields` to something unique (e.g. `sampleColumn`, `signalColumn`).

### Figures don't render

1. Check `prepareData()` is returning valid data
2. Verify `figureData` shape matches what the figure expects
3. Use browser DevTools to inspect `figureData` value

---

## Template: Minimal Plugin (Bare Minimum)

```typescript
import { Plugin, PluginManifest } from '../../lib/pluginTypes';

interface MinimalParams {
  valueColumn: string;
}

const manifest: PluginManifest = {
  id: 'minimal_sum',
  name: 'Sum Calculator',
  description: 'Sums a column and returns the total.',
  version: '1.0.0',
  author: 'Your Name',
  authorEmail: 'you@example.com',
  paramSchema: [
    { key: 'valueColumn', label: 'Value Column', type: 'column-select', required: true },
  ],
};

export const minimalPlugin: Plugin<MinimalParams> = {
  id: 'minimal_sum',
  name: 'Sum Calculator',
  description: manifest.description,
  manifest,
  defaultParams: { valueColumn: 'value' },
  paramFields: [
    {
      key: 'valueColumn',
      label: 'Value Column',
      type: 'column-select',
      defaultScope: 'per-file',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 'value',
    },
  ],
  
  run: async (file: File, params: MinimalParams) => {
    const text = await file.text();
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) throw new Error('File too short.');
    
    const headers = lines[0].split(',').map(h => h.trim());
    const colIdx = headers.indexOf(params.valueColumn);
    if (colIdx === -1) throw new Error(`Column "${params.valueColumn}" not found.`);
    
    let sum = 0;
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(',');
      const val = parseFloat(cells[colIdx]);
      if (!isNaN(val)) sum += val;
    }
    
    return { filename: file.name, sum: Math.round(sum * 100) / 100 };
  },
};
```

---

## Common Questions

**Q: Do I need to write a Python twin?**  
A: No — it's optional. Include `pythonModule` and `pythonFunction` only if you have a Python implementation and want offline script generation.

**Q: Can I upload a plugin I wrote locally?**  
A: Yes. Compile it to `.js`, click "Upload Plugin" button, and it runs locally. No data leaves your machine.

**Q: How are plugins reviewed for the marketplace?**  
A: Reviewer reads your `manifest` JSON (pure JSON, safe to read). If approved, it's added to the central registry.

**Q: Can I modify a plugin after uploading?**  
A: Upload a new version with a different `id` or increment `version` in the manifest.

**Q: What if my algorithm is proprietary?**  
A: You can still write a plugin and use it locally. Just don't submit for marketplace approval — keep it private.

---

## Examples

See the built-in plugins for complete, production-ready examples:

- **`sinlPlugin.tsx`** (500+ lines): Okawara sine INL/DNL with Recharts figures
- **`smeasPlugin.tsx`** (700+ lines): FFT spectrum with TI support, canvas rendering
- **`minimalPlugin.tsx`** (50 lines): Bare minimum for reference

---

## File Structure for a New Plugin

```
app/components/plugins/
├── myNewPlugin.tsx          # Plugin implementation (this file)
├── _pluginTemplate.tsx       # Old reference (optional)
├── minimalPlugin.tsx         # Minimal example
├── minimalPlotPlugin.tsx     # Minimal + figures example
├── sinlPlugin.tsx            # Full example: SINL
├── smeasPlugin.tsx           # Full example: SMEAS
├── pluginRegistry.ts         # Add import + BUILTIN_PLUGINS entry here
└── FigureViewer.tsx          # Generic figure renderer (auto-used by pipeline)
```

---

## Next Steps

1. **Copy `minimalPlugin.tsx`** and rename to your algorithm name
2. **Replace the manifest** with your plugin's metadata
3. **Implement `run()`** with your algorithm
4. **Test locally** by adding to `BUILTIN_PLUGINS`
5. **Submit manifest** for marketplace review (optional)

Happy plugin writing! 🚀

