# hsio Plugin — HSIO Eye-Diagram & Jitter Analysis

## Overview

`hsioPlugin.tsx` implements the **hsio** analysis plugin for USIG-CLI. It
performs time-domain eye-diagram analysis of high-speed serial waveforms
(PRBS or clock patterns) and provides additive jitter decomposition, bathtub-
curve extrapolation, and SSC/wander profiling.

The plugin consumes an IR `WaveformPacket` (no CSV/XLSX parsing inside the
plugin), computes a single shared analysis result per `(packet, params)` pair,
and serves that result to three entry points:

- `run()` — scalar output columns only
- `prepareDebugTables()` — cherry-picked debug tables via `requestedTableIds`
- `prepareFigureData()` — full figure data for rendering

A cached single-analysis kernel (`getHsioAnalysis`) guarantees that only one
analysis pass runs per invocation, regardless of how many outputs are requested.

> **Note:** This plugin will undergo a further revision to align its parameter
> naming, jitter-metric definitions, and reporting conventions with USB-IF
> SigTest methodology. Treat current metric outputs as a baseline/reference
> until that alignment lands.

---

## Theory

### Eye-Diagram Folding

The eye diagram is built by folding the waveform into a 500×500 density grid
of voltage versus UI phase, tiled across a 2-UI display window spanning
[-0.5, 1.5] UI.

- **Coherent capture:** if `total_samples / samples_per_UI` is (near-)integer,
  the capture is coherent and the fold cadence uses `total_samples / K` to
  eliminate phase walk.
- **Non-coherent capture:** the nominal `samples_per_UI` is used directly.
- **Bresenham segment stamping** preserves trace continuity between adjacent
  samples, so steep transitions are not lost between grid cells.
- For clock/PRBS2 signals, the effective UI is half the bit period (rising
  edges only).

### Bang-Bang PLL CDR Trick

Edge times are extracted by threshold crossing with linear interpolation. The
**median inter-edge interval** yields the *captured* bit rate — a bang-bang-
PLL-style timing recovery that locks onto the actual edge spacing rather than
trusting the nominal rate alone.

- The **nominal (input) rate** folds the eye.
- The **captured rate** drives the jitter frequency axis (PJ FFT).
- The ratio between captured and nominal rates is a useful diagnostic of
  frequency offset or mis-parameterization.

### TIE Construction

Time Interval Error (TIE) is computed as:

    TIE[i] = edge_time[i] − (t0 + round_half_even((edge_time[i] − t0) / UI) × UI)

Round-half-to-even (banker's rounding) is used to exactly match NumPy's
`np.round`, avoiding off-by-one UI assignments at exact half-UI boundaries.

A linear detrend is then applied to remove residual frequency offset and slow
drift before any jitter decomposition.

### Jitter Separation

| Component | Method |
|---|---|
| **RJ (Random Jitter)** | Dual-Dirac Q-scale tail fit. TIE is sorted, Hazen plotting positions are converted to Q-values via `normPpf`, and linear fits to the left/right tails yield RJ σ (average slope, capped by TIE std) and DJ pk-pk (intercept difference). Tail selection uses a robust 2σ_MAD threshold with a percentile fallback. |
| **PJ (Periodic Jitter)** | Hann-windowed FFT of the mean-subtracted TIE, with coherent-gain correction. A noise floor (median + 1.4826·MAD of the spectrum, raised by 10 dB) gates candidate tones; the dominant passing tone's amplitude (× 2√2 legacy scaling) and frequency are reported. |
| **DCD (Duty-Cycle Distortion)** | Absolute difference between rising-edge and falling-edge mean TIE, computed *before* per-polarity de-skewing. |
| **DDJ (Data-Dependent Jitter)** | Primary: 8-bit history grouping of TIE by preceding bit pattern (requires raw samples). Fallback: run-length profiling from inter-edge intervals. DDJ pk-pk is the range of group means. |
| **UJ (Uncorrelated Jitter)** | At BER = 1e-6: `UJ = 2 · Q⁻¹(BER/2) · RJ + DJ`. |
| **TJ (Total Jitter)** | RMS and peak-to-peak of the detrended, de-skewed TIE. |

### Bathtub Curves

Two bathtub curves are computed over [-0.5, 0.5] UI:

- **Dual-Dirac (analytic):** `BER(x) = Q((half_UI − |x·UI| − half_DJ) / RJ_eff)`
- **Empirical:** fraction of TIE samples exceeding `±(0.5 − |x|)` UI.

Both are reported as `log10(BER)`, with the BER-target reference line and
left/right margins in %UI.

### SSC / Wander

A box-filter low-pass (span ≈ 2% of total edges) extracts the slow wander
component of TIE. The result is reported as:

- Wander (ps) vs. time (µs)
- SSC swing in ppm: `(wander_pkpk / UI_ps) × 1e6`

---

## Architecture

### Single-Analysis Kernel

```text
getHsioAnalysis(packet, params)
  ├── samplesFromPacket(packet)     — sample extraction + min-length check
  ├── analyzehsio(samples, params)  — full analysis (eye + jitter + bathtub + SSC)
  └── debugTables                   — all 7 tables built unconditionally
```

Results are cached in a `WeakMap<WaveformPacket, { paramsKey, analysis }>`.
The cache key is `JSON.stringify(params)`, so any parameter change invalidates
the cache and triggers a fresh analysis.

### Data Flow

```text
WaveformPacket
      │
      ▼
getHsioAnalysis (cached)
      │
      ├──► run()                → Record<string, string|number> (scalars)
      ├──► prepareDebugTables() → PluginDebugTable[] (filtered by requestedTableIds)
      └──► prepareFigureData()  → hsioFigureData (full object for rendering)
```

### Debug Tables

| Table ID | Columns | Description |
|---|---|---|
| `eye_metadata` | `key`, `value` | Scalar eye metrics (n_samples, n_edges, rates, UI, height, width) |
| `jitter_metrics` | `key`, `value` | Scalar jitter metrics (TJ, RJ, PJ, DCD, DDJ, UJ, n_edges) |
| `jitter_tie_histogram` | `tie_bin_ps`, `count` | 64-bin TIE histogram |
| `jitter_tie_series` | `tie_ps`, `tie_residual_ps` | Downsampled TIE and PJ-subtracted residual |
| `jitter_ddj_profile` | `state_or_run_length`, `tie_rising_ps`, `tie_falling_ps` | DDJ profile (bit-history states or run lengths) |
| `bathtub_curve` | `x_ui`, `dd_log_ber`, `emp_log_ber` | Dual-Dirac and empirical bathtub curves |
| `ssc_wander` | `time_us`, `wander_ps` | SSC/wander profile |

### Figures

| Figure ID | Description |
|---|---|
| `eye` | 2D folded eye density heatmap (canvas-drawn or SVG-rendered) |
| `jitter` | TIE histogram with scalar jitter metrics in the results panel |
| `bathtub` | Dual-Dirac (solid) and empirical (dashed) log10(BER) vs. UI |
| `ssc` | Wander (ps) vs. time (µs) with SSC swing in the results panel |

### Rendering — Sharp-Primary / JS-Fallback

The embedded SVG renderer (`renderHsioFigureToSvg`) handles the eye heatmap:

- **Sharp path (Node):** the heatmap grid is rasterized to a PNG data-URI via
  Sharp (libvips) and embedded as an SVG `<image>` element.
- **JS fallback (browser / no Sharp):** the same grid is emitted as individual
  SVG `<rect>` cells — identical data, no native dependency.

Sharp is loaded via an eval-guarded `require` so the bundler (esbuild) never
statically resolves it, keeping the browser bundle clean.

---

## Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `targetColumn` | column-select | `voltage_v` | CSV column with time-domain voltage samples |
| `uiRateGbps` | number | 10 | Nominal bit rate (Gbps) for UI folding; auto-extracted from `finused…MHz/GHz` or `fin…GHz` in filename |
| `fsGhz` | number | 80 | Acquisition sample rate (GHz); auto-extracted from `fs…GHz` |
| `signalType` | text/dropdown | `prbs2/clock` | `clock`, `prbs2`, or `prbsN` (N ≥ 3); auto-extracted from `prbsN` token |
| `vtThreshold` | number | 0 | Voltage threshold (V); 0 = auto-detect from histogram midpoint |
| `eyeSamples` | number | 200000 | Max samples folded into the eye grid; auto-extracted from `nfft…` |
| `berTarget` | text | `1e-12` | BER target for bathtub extrapolation |
| `rjStdTargetPs` | number | 0 | Informational: RJ σ used to synthesize the golden file |
| `pjAmpTargetPs` | number | 0 | Informational: PJ amplitude used to synthesize the golden file |
| `pjFreqTargetMhz` | number | 0 | Informational: PJ frequency used to synthesize the golden file |
| `sscAmpTargetPs` | number | 0 | Informational: SSC wander amplitude used to synthesize the golden file |
| `sscFreqTargetKhz` | number | 0 | Informational: SSC modulation frequency used to synthesize the golden file |
| `noiseStdTargetMv` | number | 0 | Informational: additive-noise σ used to synthesize the golden file |

The six `*Target*` parameters are informational only — they describe the
synthetic jitter/noise injected when the golden HSIO file was generated and are
never fed into `analyzehsio()` or `computeJitter()` as analysis inputs.

---

## CLI Syntax

### Scalar output only

```bash
node usig.mjs -i <waveform.csv> -plugin hsio
```

### Single debug table

```bash
node usig.mjs -i <waveform.csv> -plugin hsio -debug eye_metadata
```

### Multiple debug tables

```bash
node usig.mjs -i <waveform.csv> -plugin hsio -debug eye_metadata,jitter_metrics
```

### All debug tables

```bash
node usig.mjs -i <waveform.csv> -plugin hsio -debug all
```

### Single figure

```bash
node usig.mjs -i <waveform.csv> -plugin hsio -figure eye=/tmp/eye.svg
```

### Multiple figures

```bash
node usig.mjs -i <waveform.csv> -plugin hsio -figure eye=/tmp/eye.svg,bathtub=/tmp/bathtub.svg
```

### Debug tables + figures (single analysis, cache-shared)

```bash
node usig.mjs -i <waveform.csv> -plugin hsio -debug eye_metadata -figure eye=/tmp/eye.svg
```

### Full example

```bash
node usig.mjs \
  -i /path/to/prbs2_finnoncoh600p00mhz_fin0p6ghz_fs100p00ghz_nfft4194304_rjstd0p00ps_pjamp0p00ps_pjfreq1p00Mhz_sscamp0p00ps_sscfreq100p00khz_noisestd1p0mv.csv \
  -plugin hsio \
  -debug eye_metadata,jitter_metrics,bathtub_curve \
  -figure eye=/tmp/eye.svg,bathtub=/tmp/bathtub.svg,ssc=/tmp/ssc.svg
```

---

## Output Columns

| Column | Description |
|---|---|
| `filename` | Source file name |
| `status` | `"ok"` or error message |
| `signal_type` | Normalized signal type (`clock`, `prbs2`, `prbsN`) |
| `sample_rate_ghz` | Nominal sample rate (GHz) |
| `input_rate_gbps` | Nominal bit rate (Gbps) |
| `captured_rate_gbps` | Median-based CDR bit rate (Gbps) |
| `ui_ps` | Unit interval (ps) |
| `threshold_v` | Voltage threshold used (V) |
| `n_samples` | Total waveform samples |
| `n_edges` | Extracted edge count |
| `eye_height_mv` | Eye height (mV) |
| `eye_width_pct_ui` | Eye width (%UI) |

---

## Known Trade-offs and Future Work

- **PJ amplitude scaling** uses the legacy `2√2` convention (matching shio.py);
  this is documented as-is for reference parity.
- **DDJ bit-history mode** requires raw waveform samples; the run-length
  fallback is used otherwise.
- **Portable figure schema** currently supports a single shared x-axis; the
  jitter figure renders only the TIE histogram (the full TIE time-series and
  DDJ profile are preserved via debug tables).
- **USB-IF SigTest alignment** is planned as a follow-up revision to harmonize
  parameter naming, jitter-metric definitions, and reporting conventions.