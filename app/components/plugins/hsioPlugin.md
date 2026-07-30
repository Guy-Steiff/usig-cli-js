# hsioalphaPlugin — HSIO Eye Diagram & Jitter Analysis

**Plugin ID**: `hsio dev`
**File**: `app/components/plugins/hsioalphaPlugin.tsx`
**Category**: Signal / High-Speed IO
**Author**: Guy Steiff
**Version**: 1.0.0

---

## What It Does

Produces a full eye diagram, jitter decomposition, and bathtub curve from time-domain
voltage captures of high-speed serial signals (PRBS, NRZ, clock). It is a TypeScript
port of `shio.py` — all algorithms match Python behavior on the metrics that matter
(TIE, RJ, PJ, DCD, DDJ, eye height/width).

Key deliverables per file:
- Eye diagram: density grid, height (mV), width (%UI)
- Jitter: TJ rms/pkpk, RJ sigma, PJ pkpk + frequency, DCD, DDJ profile, UJ
- Bathtub curve: dual-Dirac + empirical BER vs. phase offset
- SSC/wander profile: low-frequency period drift in ppm

---

## Parameters

| Parameter         | Key           | Type          | Default   | Description |
|-------------------|---------------|---------------|-----------|-------------|
| Signal Column     | signalColumn  | column-select | voltage_v | CSV column with time-domain voltage samples |
| Bit Rate (Gbps)   | uiRateGbps    | number        | 10        | Nominal bit rate for UI folding. Auto-extracted from finused...MHz/GHz in filename |
| Sample Rate (GHz) | fsGhz         | number        | 100       | Acquisition sample rate. Auto-extracted from fs...GHz or fs...MHz in filename |
| Signal Type       | signalType    | text          | prbs31    | clock, prbs7, prbs15, prbs31. Use clock for repeating 1010 patterns (PRBS-2 maps to clock internally) |
| Threshold (V)     | vtThreshold   | number        | 0         | Crossing threshold. 0 = auto-detect from histogram midpoint |
| Eye Fold Samples  | eyeSamples    | number        | 200000    | Maximum samples folded into the eye grid |
| BER Target        | berTarget     | text          | 1e-12     | Target BER for bathtub margin projection |

### Filename Auto-Extraction

- uiRateGbps: regex finused(\d+)p(\d+)(mhz|ghz) — e.g. finused599p93mhz -> 0.59993 Gbps
- fsGhz:      regex fs(\d+)p(\d+)ghz             — e.g. fs100p00ghz -> 100.0 GHz
- signalType: regex (clock|prbs\d+)              — e.g. prbs31, clock

---

## Architecture

  File
    |
    v
  ingestFile() -> WaveformPacket (Float32Array, metadata)
    |
    v
  autoDetectVth()       [histogram-based threshold]
    |
    v
  extractEdges()        [sub-sample linear interpolation]
    |
    v
  buildEyeDiagram()     [coherency-aware folding + Bresenham rasterization]
    |
    v
  computeJitter()       [TIE -> detrend -> RJ/PJ/DCD/DDJ/bathtub]
    |
    v
  { eyeGrid, eyeHeight, eyeWidth, jitter*, bathtub*, ssc* }

This plugin is ingestion-separated: it never touches raw File bytes. All file reading
is delegated to ingestFile() from app/lib/ingest/. The plugin receives a WaveformPacket
(Float32Array + metadata) and operates only on that.

---

## Algorithm: Step-by-Step

### Step 1 — Threshold Auto-Detection (autoDetectVth)

  Build 200-bin histogram of all samples
  Find the two tallest local maxima (the '0' and '1' voltage rails)
  Vth = midpoint between their bin centres

Matches: shio.py _auto_vth

Pitfall: If the signal has a strong DC offset or unequal rail densities (e.g. very long
run-lengths of one state), the midpoint heuristic can be slightly off. For such cases,
manually set vtThreshold to the known midpoint voltage.

Improvement idea: Use the saddle point of the bimodal PDF (minimize density between the
two peaks) instead of the midpoint — more robust for asymmetric signals.

### Step 2 — Edge Extraction (extractEdges)

  For each adjacent sample pair (v0, v1) that straddles Vth:
    t_crossing = (i - 1 + frac) * dt
    where frac = (Vth - v0) / (v1 - v0)    [sub-sample interpolation]
    polarity = +1 (rising) or -1 (falling)

Matches: shio.py _extract_edges

Why sub-sample: A 100 GHz scope at 10 Gbps NRZ has ~10 samples/UI. Without sub-sample
interpolation, edge jitter is quantized to +-5 ps at 100 GHz, which would overwhelm the
true RJ (<1 ps). Linear interpolation reduces quantization to <<1 ps.

Pitfall: Glitches or noise spikes near Vth create false edges. No de-glitching is applied.
If the signal has significant noise at the threshold level, edge count will be inflated and
TIE will appear noisier than reality. Pre-filter the waveform or use a manual vtThreshold.

Pitfall: Clock signals use rising-only edges (period = 1 UI). For PRBS (NRZ), both edges
are used (period = 1 UI = half symbol in time). If signalType is wrong, the folding period
is incorrect and the eye closes.

### Step 3 — PRBS2 = Clock Convention

  rawSignalType === 'prbs2' ? 'clock' : rawSignalType

Why critical: PRBS-2 is the repeating 1010... pattern. Its fundamental frequency IS the
clock. Folding must use half the nominal period (uiSamples = spu/2). Without this
normalization, the eye is folded at 2x the correct cadence — every trace smears across
two symbol periods and the eye is completely closed.

This is a silent correctness hazard: the plugin runs without error but the eye is meaningless.

### Step 4 — Coherency-Aware Folding (buildEyeDiagram)

  spu = uiSec * fsHz                       [nominal samples per UI]
  N = number of samples

  If round(N / spu) is an integer K:
    use exactSpu = N / K                   [coherent — eliminates phase walk]
  Else:
    use spu directly                       [non-coherent / mission-mode]

Why: When an acquisition captures exactly K symbol periods, using the true period N/K
instead of the nominal spu eliminates accumulated phase drift across the eye. For 1M
samples at 10 Gbps (100k symbols), a 10 ppm period error causes 1 UI of walk — a
completely smeared eye. Coherency detection removes this entirely.

Matches: shio.py _build_eye coherency branch.

### Step 5 — Bresenham Rasterization (bresSegment)

  For each consecutive sample pair (x0, y0) -> (x1, y1) in UI/voltage space:
    draw Bresenham line segment into accumulation grid[gridH][gridW]

The grid is 500x500 integers counting transitions per cell. This reproduces the density
of traces at every phase/voltage cell exactly, including fast edges (which span many pixels)
and slow transitions (which pile up in one pixel).

Why Bresenham: Naive scatter plots (one pixel per sample) miss fast edge transitions — the
rasterizer fills in the connecting line. shio.py _bres_curve_count uses the identical
algorithm.

Pitfall: Very long acquisitions (>500k samples) trigger the eyeSamples cap. The cap
defaults to 200000 samples for eye folding. For full-length processing, raise eyeSamples
explicitly.

### Step 6 — 2-UI Tiling

  Tile the core 0..1 UI grid as:
    [right half of grid | full grid | left half of grid]
  X axis: -0.5 UI to +1.5 UI

This shows one full eye opening in the center plus half-period context on each side —
identical to the Python reference display and standard oscilloscope eye mode.

### Step 7 — Log-Density Colormap

  cell_display = log10(count + 1)
  Colormap: 0 -> black, low -> red, mid -> green, high -> blue

The logarithm compresses the large dynamic range between rare glitch traces (count=1) and
the dense eye rails (count=thousands). Linear scaling makes rare events invisible.

---

## Algorithm: Eye Height

  Samples in the phase window [0.4 UI, 0.6 UI] (center eye):
    cMin = min voltage in window
    cMax = max voltage in window
  eye_height_mv = (cMax - cMin) * 1000

Up to 100k samples are scanned. The window [0.4, 0.6] UI centers on the widest open
region of the eye for NRZ and clock signals.

---

## Algorithm: Eye Width

  Build 200-bin phase histogram of all threshold crossings.
  A bin is "open" if its count is below 2% of the peak count.
  Find the widest consecutive gap of open bins (circular scan).
  eye_width_pct_ui = (bestGap / nBins) * 100

This measures the widest zero-density gap in the crossing phase histogram — matching the
visual eye opening. Up to 500k samples are processed. The circular scan handles eyes that
are not centered at 0.5 UI.

Note: This replaced an older 12-sigma formula which gave a BER=1e-12 estimate rather than
the visual opening width.

---

## Algorithm: Jitter Decomposition (computeJitter)

### Step 1 — TIE Computation

  t0 = edges[0]
  For each edge time t:
    nu = round_half_even((t - t0) / uiSec)   [ideal symbol count]
    TIE[i] = t - (t0 + nu * uiSec)           [time interval error in seconds]

Critical: Uses round-half-to-even (banker's rounding) to match numpy.round behavior.
JavaScript Math.round uses round-half-up, which diverges from Python for edges at exactly
0.5 UI. A custom roundHalfEven() is implemented to guarantee bit-level match.

### Step 2 — Linear Detrend

Removes frequency offset and slow drift (wander). The detrended TIE is the input to all
subsequent jitter metrics.

### Step 3 — TJ (Total Jitter)

  TJ_rms   = std(TIE_detrended)
  TJ_pkpk  = max(TIE) - min(TIE)

Units: picoseconds.

### Step 4 — RJ via Dual-Dirac Q-Scale Tail Fitting

  Sort TIE array ascending
  Assign plotting positions: p[i] = (i + 0.5) / N
  Convert to Q-scale: Q[i] = erfinv(2*p[i] - 1) * sqrt(2)
  Fit linear regression to the two tails (lower 10% and upper 10%)
  RJ_sigma = average of left and right tail slopes (inverse Q/TIE slope)
  DJ_pkpk  = intercept difference between left and right fitted lines

Matches: shio.py _dual_dirac exactly.

Pitfall: Requires at least 20 edges for a meaningful tail fit. For very short acquisitions
(<100 symbols), RJ is unreliable. The plugin caps RJ at std(TIE) to prevent blow-up.

### Step 5 — TIE Histogram

64 bins, covers the full TIE range. Used for visual display and the empirical bathtub curve.

### Step 6 — PJ via Hann-Windowed FFT

  Apply Hann window to TIE array
  Compute FFT
  PJ_frequency = frequency of dominant spectral peak
  PJ_pkpk = 2 * amplitude_at_peak   [peak-to-peak from one-sided amplitude]

Matches: shio.py _extract_pj_tones

Pitfall: If PJ is very weak relative to RJ, the FFT peak may be a noise artifact or a
harmonic of the supply frequency. The pjFreqMhz output helps diagnose this — if it falls
at 50/60 Hz or a known supply harmonic, treat PJ with skepticism.

### Step 7 — DCD (Duty Cycle Distortion)

  Rising TIE mean  = mean(TIE[polarity == +1])
  Falling TIE mean = mean(TIE[polarity == -1])
  DCD = rising_mean - falling_mean    [seconds, converted to ps]

DCD is extracted from the polarity split before de-skewing. This matches shio.py and
gives the true duty-cycle asymmetry in time units.

### Step 8 — DDJ (Data-Dependent Jitter)

  For each run length L = 1..N:
    Collect TIE values for rising edges preceded by L identical bits
    Collect TIE values for falling edges preceded by L identical bits
  DDJ[L] = mean(rising[L]) - mean(falling[L])
  DDJ_pkpk = max(DDJ) - min(DDJ)

DDJ is caused by ISI (inter-symbol interference) — the finite bandwidth of the channel
smears energy from previous symbols into the current edge. The run-length profile shows
which run lengths contribute most. Uses an 8-bit history (up to 256 states), matching
the shio.py default.

### Step 9 — UJ (Uncorrelated Jitter) via Dual-Dirac

  UJ_pkpk = 2 * Q_inv(BER/2) * RJ_sigma + DJ_pkpk
  where Q_inv is the inverse Q-function (erfinv-based)

This is the projected total jitter at the user-specified BER target (default 1e-12).
It combines the Gaussian tail of RJ with the bounded DJ component.

### Bathtub Curve

  Dual-Dirac:
    For each phase offset x in [-0.5, +0.5] UI:
      BER(x) = 0.5 * erfc((x - DJ/2) / (sqrt(2) * RJ))
             + 0.5 * erfc((-x - DJ/2) / (sqrt(2) * RJ))

  Empirical:
    Sort TIE, compute cumulative distribution, mirror to get BER estimate

500 phase points are computed. Eye margin at target BER = width of the bathtub curve at
the BER level.

---

## Output Columns (per file, in results CSV)

| Column              | Description                                    | Unit  |
|---------------------|------------------------------------------------|-------|
| status              | ok or error message                            | --    |
| signal_type         | Resolved signal type (clock, prbs31, etc.)     | --    |
| sample_rate_ghz     | Acquisition sample rate                        | GHz   |
| input_bit_rate_gbps | Configured bit rate (uiRateGbps)               | Gbps  |
| baud_rate_gbaud     | Same as input_bit_rate_gbps for NRZ            | Gbaud |
| cdr_rate_gbps       | CDR-estimated rate from median edge spacing    | Gbps  |
| ui_ps               | Unit interval (1 / bit_rate)                   | ps    |
| threshold_v         | Applied voltage threshold                      | V     |
| signal_swing_mv     | Peak-to-peak voltage swing                     | mV    |
| n_samples           | Total samples in file                          | --    |
| n_edges             | Detected edge count                            | --    |
| eye_height_mv       | Eye opening height at center phase             | mV    |
| eye_width_pct_ui    | Eye opening width at center voltage            | %UI   |

---

## Figures (per file)

### 1. Eye Diagram (id: 'eye')

Type: Canvas-rendered density grid (not Recharts). Implemented as React component
EyeDiagramFigure.

Display: 2-UI tiled 500x500 grid colored by log10(transition count). X axis = phase
[-0.5..1.5 UI], Y axis = voltage.

Controls: zoom slider, X center slider, Y zoom slider, Y center slider. FigureViewer
injects these as controls.__zoom, controls.__xC, controls.__yZoom, controls.__yC.

Overlay: Eye height (horizontal green bar at center phase), eye width (vertical amber
bar at center voltage), threshold line, annotation box with key metrics.

### 2. Jitter Decomposition (id: 'jitter')

Type: Recharts ComposedChart. Multi-panel layout:
- TIE time series (top panel)
- TIE histogram with Gaussian fit overlay (middle panel)
- DDJ profile by run length (bottom panel)

Displays TJ, RJ, PJ, DCD, DDJ annotations on each respective panel.

### 3. Bathtub Curve (id: 'bathtub')

Type: Recharts LineChart. Y axis = log10(BER), X axis = phase offset [%UI].

Two curves: Dual-Dirac (analytical) and empirical (from TIE distribution).
Annotations: BER target line, eye margin markers for both curves.

### 4. SSC Profile (id: 'ssc')

Type: Recharts LineChart. X axis = time (us), Y axis = wander (ps).

Shows low-frequency period drift extracted from the TIE wander component.
Displays SSC swing in ppm.

---

## Debug Tables

| Table ID     | Contents |
|--------------|----------|
| eye_metadata | n_samples, n_edges, input_rate_gbps, captured_rate_gbps, ui_ps, eye_height_mv, eye_width_pct_ui |

---

## Error Handling

| Condition                      | Error                                                    |
|--------------------------------|----------------------------------------------------------|
| CSV empty or malformed         | CSV is empty or malformed.                               |
| Column not found               | Column "X" not found. Available: ...                     |
| Fewer than 200 valid samples   | Too few valid samples (N). Need at least 200.            |
| Fewer than 10 edges detected   | Too few edges (N). Check threshold and signal type.      |

---

## Known Pitfalls & Limitations

| Issue                    | Description                                                                 | Workaround |
|--------------------------|-----------------------------------------------------------------------------|------------|
| PRBS2 = clock            | PRBS-2 maps internally to clock type; wrong signalType closes eye completely | Set signalType to clock explicitly |
| False edges near Vth     | Noise creates phantom crossings; inflates edge count and TIE noise           | Set vtThreshold manually |
| Short acquisitions       | <100 edges: RJ/PJ unreliable                                                | Capture at least 10000 UI |
| Large files slow raster  | >500k samples: eyeSamples cap applies at 200000 by default                  | Raise eyeSamples if full coverage needed |
| DDJ needs raw waveform   | DDJ requires bit-history from raw samples                                   | Use prepareData path (not run only) |
| Coherency detection      | Non-integer N/spu falls back to nominal period                              | For mission-mode data, eye may have slight residual walk |
| PJ identification        | Weak PJ masked by RJ; peak may be a supply harmonic                        | Check pjFreqMhz — if at 50/60 Hz treat with skepticism |

---

## Improvement Ideas (from code comments)

1. Saddle-point Vth: Replace histogram midpoint with saddle-point (minimize density between
   peaks) for more robust threshold on asymmetric signals.
2. De-glitching: Apply minimum run-length filter before edge extraction to suppress
   noise-induced false edges.
3. Multi-tone PJ: Extend PJ extraction to identify the top N spectral peaks, not just
   the dominant one.
4. ISI model: Replace history-grouping DDJ with a proper ISI channel model (FIR filter
   from data pattern autocorrelation).
5. MJSQ extension: Implement unbounded Dual-Dirac tail extrapolation per MJSQ spec for
   BER < 1e-18.
6. SSC demodulation: Improve SSC extraction with a proper bandpass filter around the SSC
   modulation frequency instead of low-pass wander extraction.

---

## File

app/components/plugins/hsioalphaPlugin.tsx (~2344 lines):
- Lines   1-67:   Architecture and algorithm overview (block comments)
- Lines  68-138:  hsioParams interface, hsioFigureData interface
- Lines 139-215:  manifest, paramSchema, paramFields with regex inference
- Lines 216-530:  Math helpers (erfc, erfinv, Q-scale), computeJitter()
- Lines 531-820:  autoDetectVth(), extractEdges(), estimateEyeWidthPctUi(),
                  bresSegment(), buildEyeDiagram()
- Lines 821-1170: analyzehsio() orchestration
- Lines 1171-2213: React figure components (EyeDiagramFigure, JitterFigure,
                   BathtubFigure, SSCFigure)
- Lines 2214-2344: Plugin export object (manifest, defaultParams, outputColumns,
                   getIngestHints, run, runFromWaveform, prepareData, figures)