# SINL Plugin — Sine INL/DNL Analysis

## Before you start

Install USIG and expose it as `usig` (see [Installation](/installation)), or try the analysis directly in your browser with [Try USIG Online](/try-usig-online).

## Overview

SINL (`-plugin sinl`) performs sine-histogram INL/DNL analysis on ADC captures using the **Okawara-T truncated sine-histogram estimator**. It is designed for clipped (saturated) sine-wave captures and reports integral non-linearity (INL), differential non-linearity (DNL), and missing-code statistics.

> **Note:** SINL is not intended for ENOB measurement — use SMEAS for that.

## Reference

The estimation method follows:

> Hideo Okawara, *Mixed Signal Lecture Series — DSP-Based Testing, Fundamentals 18: Histogram Method in ADC Linearity Test*, Verigy Japan, October 2009.

Specifically, SINL implements Okawara's equations 27–29: the truncated sine-histogram PDF/CDF construction, the `cos(π·CDF)` transform, and the derivation of `codeSizeOverAmp` (LSB size relative to sine amplitude) from the cos-CDF difference across the truncated range. This reference is cited both for mathematical justification and attribution.

## Input Modes

SINL accepts two input modes via the `inputMode` parameter:

| Mode | Input | Description |
|---|---|---|
| `codes` | Raw ADC integer codes | Default. Resolution is derived from the `minCode`/`maxCode` range. |
| `voltage` | Floating-point volts | Samples are normalised to the `minCode`/`maxCode` voltage range and mapped to a fixed 10-bit (1024-code) histogram. |

**Voltage-mode resolution is intentionally fixed at 10 bits (1024 codes)** regardless of the `minCode`/`maxCode` range — chosen so the histogram has enough bins to remain statistically meaningful for typical oscilloscope captures.

**Auto-seeding:** when packet metadata reports `units: 'volts'` and the user left `inputMode` at its default (`codes`), SINL switches to `voltage` mode and derives `minCode`/`maxCode` from the actual sample range, adding a 2% margin so extreme codes are not at the absolute boundary.

## Parameters

| Parameter | Default | Description |
|---|---|---|
| `targetColumn` | *(auto)* | CSV column containing raw ADC codes or voltages. Aliases: `sample`, `samples`, `adcCode`, `adcCodes`, `voltage`. |
| `inputMode` | `codes` | `codes` (raw ADC integers) or `voltage` (floating-point volts, normalised to minCode/maxCode). |
| `minCode` | `0` | Theoretical minimum code (codes mode) or minimum voltage (voltage mode). |
| `maxCode` | `2047` | Theoretical maximum code (e.g. 2047 for 11-bit) or maximum voltage. Required. |
| `avoidanceRadius` | `40` | Peak-search radius (bins) for truncation-point detection. |
| `minSizeBin` | `2` | Minimum samples for a code to count as reachable. |
| `missingThreshold` | `-0.9` | DNL threshold below which a code is counted as missing. |

> **Note:** `sampleColumn` is a legacy alias for `targetColumn` — prefer `targetColumn` (matches SMEAS convention).

## Algorithm

1. **Histogram** — integer code histogram over `2^adcRes` bins.
2. **Reachable-code bounds** — codes with fewer than `minSizeBin` samples are excluded from the integration range.
3. **Truncation** — a peak-search avoidance radius (`avoidanceRadius`) locates the true sine peaks near each end of the histogram; the truncation points define the active analysis window.
4. **Okawara-T estimation** (Okawara eqs. 27–29) — PDF is computed, CDF accumulated, then `cos(π·CDF)` is formed. The `codeSizeOverAmp` (LSB size relative to sine amplitude) is derived from the cos-CDF difference across the truncated range:
   - `codeSizeOverAmp = (C1 − C2) / intTruncBins`
   - DNL = `−Δcos(π·CDF) / codeSizeOverAmp − 1`
   - INL = `(C1 − cos(π·CDF)) / codeSizeOverAmp − (i+1)` (cumulative cos-based deviation from the ideal ramp)
5. **Polynomial fit** — a 3rd-order least-squares polynomial is fitted to the measured INL as a trend line (`inl_polynomial`).
6. **Metrics** — INL max/min (from measured INL) and peak-to-peak (from the polynomial fit), DNL max/min/RMS, and missing-code count (DNL below `missingThreshold`, default -0.9 LSB).

## CLI Syntax

### Scalar output only

```bash
usig -i capture.csv -plugin sinl
```

### Single debug table

```bash
usig -i capture.csv -plugin sinl -debug inl_dnl_series
```

### All debug tables

```bash
usig -i capture.csv -plugin sinl -debug all
```

### Single figure

```bash
usig -i capture.csv -plugin sinl -figure pdf=/tmp/pdf.svg
```

### Multiple figures

```bash
usig -i capture.csv -plugin sinl -figure pdf=/tmp/pdf.svg,dnl=/tmp/dnl.svg,inl=/tmp/inl.svg
```

### Debug tables plus figures (single shared analysis)

```bash
usig -i capture.csv -plugin sinl -debug inl_dnl_series -figure pdf=/tmp/pdf.svg,dnl=/tmp/dnl.svg
```

### Full example: 11-bit ADC codes

```bash
usig -i adc_11bit_sine.csv -plugin sinl -p inputMode=codes -p minCode=0 -p maxCode=2047 -debug inl_dnl_series -figure pdf=/tmp/pdf.svg,dnl=/tmp/dnl.svg,inl=/tmp/inl.svg
```

### Full example: voltage input (oscilloscope capture)

```bash
usig -i scope_sine.csv -plugin sinl -p inputMode=voltage -p minCode=-1.0 -p maxCode=1.0 -debug inl_dnl_series -figure pdf=/tmp/pdf.svg,inl=/tmp/inl.svg
```

### Override truncation / missing-code settings

```bash
usig -i capture.csv -plugin sinl -p avoidanceRadius=60 -p minSizeBin=3 -p missingThreshold=-0.8
```

## Available Debug Tables

Listing debug tables:

```bash
usig -plugin sinl -debug list
```

Verbatim output:

```text
DEBUG TABLES: sinl

  inl_dnl_series
    INL / DNL per-code series
    Columns: code, pdf, cdf, cos_cdf, dnl, inl, inl_polynomial
```

| Table ID | Columns | Description |
|---|---|---|
| `inl_dnl_series` | `code`, `pdf`, `cdf`, `cos_cdf`, `dnl`, `inl`, `inl_polynomial` | Per-code series: probability density, cumulative distribution, cos(π·CDF), DNL, INL, and the 3rd-order polynomial fit. |

## Available Figures

Listing figures:

```bash
usig -plugin sinl -figure list
```

Verbatim output:

```text
FIGURES: sinl

  pdf
    PDF
    PDF vs code/voltage, with peak-search reference zones and truncation boundaries.

  dnl
    DNL
    DNL per code/voltage, with zero/min/max reference lines.

  inl
    INL + polynomial
    INL (measured) and 3rd-order polynomial fit per code/voltage, with zero/min/max reference lines.
```

| Figure ID | Description |
|---|---|
| `pdf` | PDF vs. code/voltage, with peak-search reference zones and truncation boundaries. |
| `dnl` | DNL per code/voltage, with zero/min/max reference lines and missing-code count in the title. |
| `inl` | Measured INL and 3rd-order polynomial fit per code/voltage, with zero/min/max reference lines. |

## Output Columns

| Column | Description |
|---|---|
| `inl_codes_p2p` | INL peak-to-peak from the 3rd-order polynomial fit (LSB). |
| `inl_max` / `code_inl_max` | Maximum measured INL (LSB) and the code where it occurs. |
| `inl_min` / `code_inl_min` | Minimum measured INL (LSB) and the code where it occurs. |
| `missing_codes_threshold` | DNL threshold used for missing-code detection. |
| `missing_codes_count` | Number of codes with DNL below the threshold. |
| `dnl_max` / `code_dnl_max` | Maximum DNL (LSB) and the code where it occurs. |
| `dnl_min` / `code_dnl_min` | Minimum DNL (LSB) and the code where it occurs. |
| `dnl_rms` | RMS of DNL across active codes (LSB). |
| `code_min` / `code_max` | Reachable-code bounds (first/last code with at least `minSizeBin` samples). |
| `code_trunclow` / `code_trunchigh` | Truncation boundaries used for the Okawara-T integration. |
| `lsb_codes_over_code_amp` | Derived LSB size relative to sine amplitude (codeSizeOverAmp). |

## Worked Example: 11-bit ADC, code input

```bash
usig -i adc_11bit_sine.csv -plugin sinl -p inputMode=codes -p minCode=0 -p maxCode=2047
```

Expected: `adcRes` derived as 11 (2048 codes); INL/DNL computed over the truncated sine range; missing-code count reported.

**Golden regression values** (from the SINL regression test, `sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv`):

| KPI | Golden value |
|---|---|
| `inl_codes_p2p` | 0.1843 |
| `inl_max` | 3.307 |
| `code_inl_max` | 1171 |
| `inl_min` | -2.4758 |
| `code_inl_min` | 874 |
| `missing_codes_threshold` | -0.9 |
| `missing_codes_count` | 0 |
| `dnl_max` | 1.0015 |
| `code_dnl_max` | 957 |
| `dnl_min` | -0.8174 |
| `code_dnl_min` | 982 |
| `dnl_rms` | 0.1614 |
| `code_min` | 779 |
| `code_max` | 1273 |
| `code_trunclow` | 787 |
| `code_trunchigh` | 1264 |
| `lsb_codes_over_code_amp` | 0.004137 |

These values serve as the regression baseline — any deviation beyond 1% tolerance flags a regression.

## Worked Example: Oscilloscope voltage capture

```bash
usig -i scope_sine.csv -plugin sinl -p inputMode=voltage -p minCode=-1.0 -p maxCode=1.0
```

Expected: auto-seeded to voltage mode if metadata reports volts; fixed 10-bit (1024-code) histogram; INL/DNL in LSB units relative to the normalised range.

## Worked Example: Tighter missing-code detection

```bash
usig -i capture.csv -plugin sinl -p missingThreshold=-0.5
```

Expected: more codes flagged as missing (any DNL below -0.5 LSB counts).

## Worked Example: Wider peak-search radius

```bash
usig -i capture.csv -plugin sinl -p avoidanceRadius=80
```

Expected: truncation points searched over a wider window near each histogram edge — useful for very clipped or noisy captures.

## `-fig_as_json` (global CLI flag)

`-fig_as_json` is a **global CLI flag**, not a SINL parameter — it must be stated before the plugin commands (and typically after the input declaration) and applies uniformly to all tasks in a single command. When enabled, every generated figure also emits a sibling `PortableFigureDescription` JSON file (same basename, `.json` extension). Off by default; applies to SVG/PNG/JPEG figures.

```bash
usig -i capture.csv -fig_as_json -plugin sinl -figure pdf=/tmp/pdf.svg
# writes /tmp/pdf.svg and /tmp/pdf.json
```

## Multi-job and `-debug`/`-figure` semantics

Like SMEAS, SINL inherits the following **global CLI features** (not plugin-specific):

- **Multi-job** — multiple `-i ... -plugin ...` groups in one command, each with independent `-p`/`-debug`/`-figure` flags.
- **`-debug` screen-vs-save** — bare table ID prints to screen; `table=path` saves to file; `all=/tmp/folder` saves all tables to a folder.
- **`-figure` filename inference** — same as SMEAS (input-side global flags, not plugin-specific).

## Warnings and Edge Cases

- **Voltage mode resolution:** fixed at 10-bit (1024 codes) regardless of `minCode`/`maxCode` range — chosen to keep the histogram statistically meaningful for typical oscilloscope captures.
- **Truncation bounds:** codes outside `[code_trunclow, code_trunchigh]` are zeroed in DNL/INL output (not analysed) — this is expected Okawara-T behaviour for clipped sines.
- **Polynomial extrapolation:** the 3rd-order fit is restricted to the active INL range in figures to avoid blow-up at inactive codes.
- **Missing codes:** counted only within the active (non-zero) DNL range; codes outside the truncation window are excluded from the count.
- **Auto-seeding:** only triggers when metadata reports volts AND the user left `inputMode` at its default — explicit user selection always wins.
- **Single-analysis caching:** scalar output, debug tables, and figure data share one analysis per `(packet, params)` per invocation — no duplicate computation when requesting multiple outputs.

## Help output issue (known bug)

`usig -plugin sinl -h` currently crashes after printing the first parameter (`targetColumn`) with `ReferenceError: schemaEntry is not defined` in `printPluginHelp` — same root cause as SMEAS (consolidation of `paramFields` into `paramSchema`). This is a known issue to fix separately; the MD documents the intended parameter set regardless.