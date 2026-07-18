# Guy Steiff — ADC & High-Speed IO Validation Platform

A professional engineering platform for rapid post-silicon validation data analysis.
All computation runs locally in the browser — raw data never leaves your machine.
The same core engine also runs headless via the usig CLI (Node.js).

---

## Platform Overview

This platform combines three complementary analysis workflows:

1. PVCJS: Interactive multivariate diagnostics on CSV/XLSX data
2. Raw Data Pipeline: Batch processing of raw ADC/HSIO measurements through modular plugins
3. usig CLI: Headless batch mode — same plugins, same IR cache, no browser required

All three share the same ingestion layer, IR cache, and plugin contract.

---

## PVCJS — Interactive Multivariate Diagnostics

### What It Does

Upload any CSV or XLSX file and instantly explore multivariate relationships. PVCJS
computes R² variance decomposition in real-time, revealing which variables drive your
outcome metric.

### Core Features

- Y variable selector: Choose your metric (ENOB, SNR, jitter, yield, etc.)
- X variable multi-select: Pick drivers (temperature, voltage, frequency, process corner, etc.)
- Live scatter matrix: Distribution plots + box plots updating in <300ms
- R² contribution table: Color-coded by strength (green >50%, yellow 25-50%, gray <25%)
- Correlation heatmap: Pairwise X<->X and X<->Y relationships
- Hierarchical column grouping: Automatically structured when CSV has multi-level names
- Format support: CSV, XLSX, XLS — hierarchical headers flattened transparently

### Typical Workflow

  Problem: ENOB degraded at thermal extremes. Which parameter is responsible?

  Action:  Upload characterization sweep (1000+ rows, 30+ columns)
  Result:  Select ENOB as Y, columns T/V/F/corner as X
           R² table: T=62%, V=24%, F=2%, corner=0%
           Instant insight: Temperature is the dominant driver.

### Entry Points

- Hero upload box (landing page)
- Floating Action Button (quick access, any page)
- Tools section CTA
- Pipeline results handoff (after batch processing)

---

## Raw Data Pipeline — Batch Analysis & Result Assembly

### What It Does

Process many raw measurement files through a plugin, accumulate scalar results into a
CSV, expose rich per-file analytics.

### Pipeline Flow

  Input Files[]
    |
    +--> IREngine.getOrIngestWithColumns()    [file-add time, one read per file]
    |        |
    |        +--> SignalFrame cached (WaveformPacket + metadata + capturedVars)
    |
    +--> IREngine.getOrIngest(file, hints)    [run time, cache HIT if same params]
    |        |
    |        +--> plugin.runFromWaveform()    --> Scalar row (CSV output)
    |        +--> plugin.prepareDataFromWaveform() --> Figures + debug tables
    |
    +--> Results CSV (all files aggregated)
    +--> Interactive UI (figures, debug tables per file)
             |
             +--> [Export CSV/XLSX/JSON OR send to PVCJS]

### Features

- Multi-file batch: Process 10-100+ files in one run
- Plugin-based: Each algorithm is a self-contained module
- IR cache: Each file is ingested at most once per (file, hints) pair — zero re-reads on
  repeat runs with same parameters
- Results CSV: One scalar summary row per input file
- Per-file figures: Interactive charts (Recharts or Canvas)
- Per-file debug tables: Downloadable series data (DNL codes, spectrum bins, harmonics)
- Export formats: CSV, XLSX (with styling), JSON
- Direct PVCJS handoff: Send results CSV straight into PVCJS for aggregation analysis

---

## IR — Intermediate Representation Layer

### Concept

Inspired by FFmpeg's media frame model. Every ingested file is converted once into a
SignalFrame (the IR) and cached. Subsequent plugin runs, re-runs with same parameters,
and figure/debug generation all read from the cache — never from disk again.

  File bytes --> IREngine.getOrIngest() --> SignalFrame --> Plugin --> Outputs

### Architecture

  app/lib/ir/
    types.ts       SignalFrame, IRManifestEntry, SerializedIR
    cache.ts       IRCache — Map<fingerprint x hintsKey, SignalFrame>
    engine.ts      IREngine — orchestrates ingest + cache
    serializer.ts  serializeFrame / deserializeFrame (portable binary exchange)
    index.ts       public re-exports

### Cache Key Design

Every cache entry is uniquely keyed by two components:

- fileFingerprint(file) = "name:size:lastModified"
  Identifies the source file without hashing its content.

- hintsKey(hints) = stable JSON of active IngestHints (sorted keys)
  Distinguishes different column/parameter selections for the same file.
  Empty string '' for the base frame (no hints).

A single file can have multiple cached SignalFrames: one base frame plus one per unique
IngestHints set requested by plugins.

### Performance

  Phase               Old (re-ingest every run)   New (IR cached)
  File add            1 read                       2 reads (cols + base frame)
  Run — base frame    1 read                       0 reads (cache hit)
  Run — per plugin    1 read per plugin             0 reads (cache hit)
  Re-run same params  1 + N reads                  0 reads
  Re-run new params   1 + N reads                  0 + 1 per new hintsKey

### SignalFrame Structure

  interface SignalFrame {
    packet: WaveformPacket;                     // Float32Array waveform + metadata
    headers: string[];                          // all column names from source file
    singleValueColumns: Record<string,string>;  // constant-value columns -> value
    capturedVars: Record<string,number>;        // filename-extracted SI values
    cacheKey: string;                           // "name:size:lastModified"
    hintsKey: string;                           // '' | JSON of active hints
    ingestedAt: number;                         // unix ms
    schemaVersion: string;                      // '1.0.0'
  }

---

## Filename Conventions & Parameter Inference

### Why Filenames Matter

The pipeline automatically extracts numeric parameters from file names using regex
patterns. If your file names follow the conventions below, parameters like sample rate,
input frequency, ADC bits, and signal type are pre-filled without manual entry. Wrong
or missing tokens force manual override and increase the risk of mis-analysis.

### Recommended Filename Format

Use underscore-separated tokens with this pattern for numeric values:

  _{word}{integer}p{decimals}{units}_

Examples:
  _fs2p25ghz_      sample rate = 2.25 GHz
  _fin100p5mhz_    input frequency = 100.5 MHz
  _12bit_          ADC resolution = 12 bits
  _vfs2p0v_        full-scale range = 2.0 V
  _m30_            temperature = -30 C  (m prefix = minus, replace m=-)
  _p85_            temperature = +85 C  (p prefix = plus, replace p=+)
  _4core_          number of TI cores = 4
  _prbs31_         signal type = PRBS-31
  _clock_          signal type = clock

The p-encoding (2p25 instead of 2.25) avoids filesystem issues with decimal points.
Units suffixes (ghz, mhz, khz, hz, v, bit, b) are case-insensitive.

Full example filename:
  TT_chipA_fs2p25ghz_fin100mhz_12bit_vfs2v_m30c_4core_prbs31_run001.csv

This single filename pre-fills: fsGhz=2.25, fin=100MHz, adcNumBits=12,
vfsPeakToPeak=2.0, temp=-30, numberOfCores=4, signalType=prbs31.

### Inference Hooks by Plugin

The pipeline runs extractCapturedVarsFromFilename() on every file at add-time. The
result is stored in SignalFrame.capturedVars and applied to plugin parameters via
capturedVarsRequests before plugin-specific regex runs.

| Token pattern              | Captured key | SI base unit | Example               |
|----------------------------|--------------|-------------|------------------------|
| fs{N}p{M}ghz / fs{N}ghz   | fs_hz        | Hz          | fs2p25ghz -> 2.25e9    |
| fs{N}mhz / fs{N}p{M}mhz   | fs_hz        | Hz          | fs2250mhz -> 2.25e9    |
| fin{N}mhz / fin{N}ghz      | fin_hz       | Hz          | fin100mhz -> 1e8       |
| finused{N}p{M}mhz          | fin_hz       | Hz          | finused599p93mhz->5.9993e8 |
| {N}bit / {N}b / adc{N}     | adc_bits     | bits        | 12bit -> 12            |
| vfs{N}p{M}v / vpp{N}v      | vfs_pp       | V           | vfs2p0v -> 2.0         |

Plugin-specific regex (level 2 inference) can override these. Each InferredParamField
in a plugin declares defaultRegex, defaultReplace, and an optional transform function.
The p-encoding two-capture-group convention joins groups 1 and 2 with '.' automatically:

  regex: 'fs(\\d+)p(\\d+)ghz'
  filename: 'fs2p25ghz_data.csv'
  result: '2.25'

### Plugin Hooks for Filename Inference

Every plugin that uses a numeric parameter which can be filename-inferred must:

1. Declare capturedVarsRequests to consume pipeline-level captured vars:
     capturedVarsRequests: [
       { capturedKey: 'fs_hz', paramKey: 'fsGhz' },
       { capturedKey: 'adc_bits', paramKey: 'adcNumBits' },
     ]

2. Declare InferredParamField.defaultRegex for plugin-specific overrides:
     { key: 'fsGhz', defaultRegex: 'fs(\\d+(?:p\\d+)?(?:ghz|mhz)?)', ... }

3. Implement getIngestHints(params) so the IR engine knows which column to ingest:
     getIngestHints: (params) => ({
       signalColumn: String(params.targetColumn || ''),
       sampleRateHz: Number(params.fsGhz) * 1e9 || 0,
     })

The IR engine calls getIngestHints(params) to compute the hintsKey for cache lookup.
If the same plugin has been run before with the same params, the frame is a cache hit.

---

## Built-in Plugins

### SINL — Sine INL/DNL Analysis

Purpose: Measure INL and DNL from clipped sine-wave ADC captures (Okawara-T method).
File: app/components/plugins/sinlPlugin.tsx
Docs: app/components/plugins/sinlPlugin.md

Inputs: raw ADC codes or voltages, ADC resolution, min/max code, avoidance radius
Outputs: inl_p2p, inl_max, inl_min, dnl_max, dnl_min, dnl_rms, missing_codes_count,
         truncation boundaries
Figures: PDF histogram, DNL per code, INL + 3rd-order polynomial overlay
Filename hooks: {N}bit / adc{N} -> adcRes

Use case: "My ADC saturates at +-1V with a 2V rail. What are the true INL/DNL specs?"

---

### SMEAS — FFT-Based Spectrum Analysis

Purpose: SNR, SNDR, ENOB, THD, SFDR from time-domain or spectrum ADC captures.
File: app/components/plugins/smeasPlugin.tsx
Docs: app/components/plugins/smeasPlugin.md

Key features: Auto-window selection, TI de-embedding, dual-tone IM3, avoidance-radius
SFDR, carrier and full-scale referenced metrics

Outputs: snr_c, snr_fs, sndr_c, sndr_fs, enob_snr_c, enob_snr_fs, enob_sndr_c,
         enob_sndr_fs, thd_db, sfdr_dbc, sfdr_wo_ti_dbc, fund1_mhz, noise_rms_mv,
         window_used, and more
Figures: Full spectrum, TI-removed spectrum, noise-only spectrum
Filename hooks: fs{N}p{M}ghz -> fsGhz, fin{N}mhz -> inferred tone, {N}bit -> adcNumBits,
                vfs{N}p{M}v -> vfsPeakToPeak, {N}core -> numberOfCores

Use case: "My dual-core TI ADC has a mystery spur. Is it TI mismatch or real distortion?"

---

### HSIO — Eye Diagram & Jitter Analysis

Purpose: Time-domain eye diagram, jitter decomposition, bathtub curve for HSIO signals.
File: app/components/plugins/hsioalphaPlugin.tsx
Docs: app/components/plugins/hsioPlugin.md

Key features: Auto Vth, Bresenham rasterization, PRBS2=clock convention,
coherency-aware folding, dual-Dirac RJ, Hann-FFT PJ, DDJ history profiling

Outputs: eye_height_mv, eye_width_pct_ui, n_edges, ui_ps, threshold_v,
         cdr_rate_gbps, signal_swing_mv, and full jitter table in figures
Figures: Eye Diagram (canvas), Jitter Decomposition, Bathtub Curve, SSC Profile
Filename hooks: fs{N}p{M}ghz -> fsGhz, finused{N}p{M}mhz -> uiRateGbps,
                prbs31 / clock -> signalType

Use case: "My SerDes eye is degraded after equalizer tuning. What is the RJ contribution?"

---

### Template Plugins (Reference)

| Plugin       | Purpose                              | Example Output        |
|--------------|--------------------------------------|-----------------------|
| Minimal      | Bare minimum: reads column, returns sum | { filename, sum }  |
| Minimal Plot | Minimal + one figure (line chart)    | Same, plus line figure |

Both serve as reference implementations for custom plugin authorship.
See PLUGINS.md for the complete authorship guide.

---

## Platform Architecture

  Browser / CLI
       |
       v
  IREngine (app/lib/ir/engine.ts)
       |
       +-- getOrIngestWithColumns(file)  --> IngestColumnsResult (UI/param seeding)
       +-- getOrIngest(file, hints)      --> SignalFrame (cached WaveformPacket)
       |
       v
  Plugin (runFromWaveform / prepareDataFromWaveform)
       |
       v
  Results CSV / Figures / Debug Tables / Stream output

For detailed architecture including ingestion layer internals, IR cache design, and
filename inference hooks, see architecture.md.

---

## Tech Stack

| Layer          | Technology                                        |
|----------------|---------------------------------------------------|
| Framework      | Next.js 16.0+ (App Router, Turbopack)             |
| Language       | TypeScript                                        |
| Styling        | Tailwind CSS 4.1+, PostCSS                        |
| Computation    | Native JS (DOM, Canvas, Web APIs)                 |
| Charts (pipeline) | Recharts 3.8+ (React components)              |
| Charts (PVCJS) | Canvas 2D (for performance)                      |
| File parsing   | XLSX (xlsx library), native File API              |
| FFT            | fft.js (power-of-2 radix-2) + fallback DFT       |
| IR cache       | In-memory Map (browser) / module singleton (CLI)  |
| CLI            | Node.js ESM script (usig.mjs)                     |
| Deployment     | Vercel (serverless)                               |
| Contact form   | Formspree (third-party SaaS)                      |
| Video embeds   | Rumble (third-party embed)                        |

---

## File Structure

  app/
    api/upload/route.ts
    components/
      pvcjs/                         Multivariate diagnostic engine
      plugins/
        pluginRegistry.ts            Registry: built-in plugins
        sinlPlugin.tsx               SINL: Sine INL/DNL
        smeasPlugin.tsx              SMEAS: FFT spectrum
        hsioalphaPlugin.tsx          HSIO: Eye diagram + jitter
        minimalPlugin.tsx            Template: bare minimum
        minimalPlotPlugin.tsx        Template: bare + figure
        sinlPlugin.md                SINL documentation
        smeasPlugin.md               SMEAS documentation
        hsioPlugin.md                HSIO documentation
      PipelineBlock.tsx              Batch processing orchestration (React)
      FigureViewer.tsx               Generic canvas/Recharts renderer
      WaveformThumbnail.tsx          Hover waveform preview
    lib/
      pluginTypes.ts                 Plugin interface definitions
      pipelineStorage.ts             localStorage persistence
      resultInterpretation.ts        Plain-English result badges
      statisticsEngine.ts           PVCJS R² engine
      ingest/
        ingest.ts                    ONLY place that reads raw File bytes
        types.ts                     WaveformPacket, WaveformMetadata
        index.ts                     public re-exports
      ir/
        types.ts                     SignalFrame, IRManifestEntry, SerializedIR
        cache.ts                     IRCache (Map-backed, keyed by fingerprint x hintsKey)
        engine.ts                    IREngine (orchestrator)
        serializer.ts                Portable binary exchange
        index.ts                     public re-exports
    layout.tsx, page.tsx             Next.js root layout & home page
  usig.mjs                           CLI entry point (Node.js ESM)
  architecture.md                    Software architecture reference
  PLUGINS.md                         Plugin development guide
  README.md                          This file

---

## Feature Map & Status

### Fully Implemented

PVCJS Foundation:
- Multi-variable selector with global scope
- Live R² variance decomposition (linear OLS)
- Scatter matrix with marginal distributions
- Box plots per X variable
- Correlation heatmap
- CSV/XLSX/XLS import with auto-flattening of hierarchical headers

Pipeline Foundation:
- Plugin registry (built-in + user-uploaded)
- Multi-file batch processing
- IR cache (SignalFrame, zero re-reads on repeat runs)
- Scalar result accumulation (main CSV)
- Per-file figures (Recharts + Canvas)
- Per-file debug table exports
- Global <-> per-file parameter scoping with UI toggle
- Filename regex extraction for auto-parameter inference (two-level system)
- capturedVarsRequests plugin hook for pipeline-level inference
- Results CSV -> PVCJS handoff

Built-in Plugins:
- SINL: Okawara-T sine INL/DNL
- SMEAS: FFT-based spectrum (SNR/SNDR/ENOB/THD/SFDR) with TI, dual-tone, auto-window
- HSIO: Eye diagram, jitter decomposition, bathtub curve
- Template plugins (minimal, minimal-plot)

### Planned (Near Term)

- Report Generation: one-click PDF/DOCX export with per-plugin sections
- Persistent PVCJS session (localStorage: selected Y/X variables)
- Export preset saving for pipeline configs
- User plugin versioning (allow multiple versions per plugin id)
- usig CLI: headless batch mode using same IR engine

### Planned (Medium Term)

- Offline Python script generation: Export as Python script button
- Plugin registry / marketplace with CDN-hosted community plugins
- Binary file format plugins (Keysight .bin, Rigol .wfm direct column plugins)

### Planned (Long Term)

- Measurement Canvas: virtual instrument connection diagram
- Advanced statistics: interaction effects, Bayesian estimation
- Extended analysis plugins: noise density floor, temperature compensation coefficients

---

## Getting Started

### For Analysts / Test Engineers

1. PVCJS Quick Start:
   - Go to home page, click "Upload your data"
   - Drop a CSV/XLSX with characterization data
   - Select your metric (Y) and drivers (X)
   - Instant R² table tells you which factors matter

2. Pipeline Quick Start:
   - Go to "Tools" section
   - Select a plugin (SMEAS for spectrum, SINL for INL/DNL, HSIO for eye diagram)
   - Drop 1-100+ raw data files
   - Review per-file figures and debug tables
   - Export results CSV or send to PVCJS

3. Filename tip: Follow the _{word}{int}p{decimals}{units}_ convention in your filenames
   for automatic parameter extraction. Example: chip_fs2p25ghz_fin100mhz_12bit_m30c.csv
   will auto-fill sample rate, input frequency, ADC bits, and temperature.

### For Developers / Plugin Authors

See PLUGINS.md for:
- Complete plugin authorship guide
- How to write and test plugins locally
- The plugin lifecycle (development -> local testing -> user upload -> marketplace)
- Why parameters appear in 5 locations (manifest, paramFields, localStorage, UI, runtime)
- How to implement capturedVarsRequests and getIngestHints for filename inference

### For Deployment

  npm install
  npm run dev          # http://localhost:3000  (Turbopack, rebuilds on save)
  npm run build
  npm run start
  npx tsc --noEmit     # type checking (should return zero errors)

---

## Diagnostic Problems This Platform Addresses

### 1. ENOB Temperature Degradation
Problem: Calibration circuits saturate at thermal extremes, making ENOB specs invalid.
Solution: SMEAS separates noise floor from carrier, then cross-correlate with temperature
in PVCJS. Use _m30c_ / _p85c_ filename tokens to auto-populate temperature in the sweep.

### 2. Time-Interleaved ADC Spurs
Problem: TI mismatch creates spurs at multiples of fc/(TI_cores). Looks like real
distortion but disappears with TI correction.
Solution: SMEAS auto-detects TI pattern, blanks mismatch spurs, reports SFDR_woTI.
Use _4core_ or _8core_ filename tokens to auto-populate numberOfCores.

### 3. Jitter Measurement Contradictions
Problem: Eye diagram looks open but ENOB is poor, or RJ budget is exceeded.
Solution: HSIO jitter decomposition separates RJ / PJ / DCD / DDJ contributions.
Use _prbs31_ / _clock_ and _fs{N}ghz_ / _finused{N}mhz_ tokens for auto-inference.

### 4. Multi-Parameter Interaction Effects
Problem: Single-variable sweeps show no correlation; production failures appear
multi-causal.
Solution: PVCJS R² table reveals which combinations of variables drive the outcome.

### 5. Report Interpretation Complexity
Problem: Static PDF plots force one viewing angle; different stakeholders draw
different conclusions.
Solution: PVCJS makes data interactive — every viewer can explore their own hypothesis.

---

## Data Privacy & Security

- All computation runs locally in the browser — no backend processing
- Raw files are never uploaded — they stay on your machine
- The CLI (usig) runs entirely on your local machine — no network calls
- Results are optional to save — export CSV/XLSX/JSON if desired
- Session state is ephemeral — cleared on page refresh unless explicitly saved
- Only Formspree (contact form) and Rumble (video embeds) connect to external services

---

## FAQ

Q: Can I use this offline?
A: Yes. The platform runs entirely client-side. Once loaded, it works offline. For
   deployment, use a static CDN or local server.

Q: How do I write my own plugin?
A: See PLUGINS.md. Minimal example: ~50 lines of TypeScript. Templates included.

Q: Can I deploy this on my own infrastructure?
A: Yes. It's a static Next.js build. Deploy to Vercel, Netlify, AWS S3 + CloudFront,
   or any internal server.

Q: What file name format gives the best auto-inference?
A: Use underscore-separated tokens: _fs2p25ghz_fin100mhz_12bit_vfs2v_m30c_4core_prbs31_
   This fills fsGhz, fin, adcNumBits, vfsPeakToPeak, temp, numberOfCores, signalType.

Q: What is the maximum file size?
A: Limited by browser memory (typically 500MB-1GB per file depending on device). For
   larger datasets, use the usig CLI or Python locally.

Q: Can I see source data from figures?
A: Yes. Each figure has a Download debug table option to get the raw series data
   (CSV/JSON).

Q: Does this replace Python analysis workflows?
A: No — it complements them. Export your pipeline results as Python scripts for
   integration with CI/CD or further analysis.

---

## Contact

Guy Steiff
Post-silicon validation · ADC · High-speed IO
LinkedIn: https://linkedin.com/in/guy-steiff
GitHub:   https://github.com/Guy-Steiff/