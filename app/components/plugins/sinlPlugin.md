```markdown
# SINL Plugin — Sine INL/DNL Analysis

## Overview

SINL (`-plugin sinl`) performs sine-histogram INL/DNL analysis on ADC captures using the Okawara-T truncated sine-histogram estimator (Okawara equations 27–29, ported from `inl_tool.py`). It is designed for clipped (saturated) sine-wave captures and reports integral non-linearity (INL), differential non-linearity (DNL), and missing-code statistics.

> **Note:** SINL is not intended for ENOB measurement — use SMEAS for that.
>
> **Note:** SINL will undergo a further revision to align its parameter naming, metric definitions, and reporting conventions with USB-IF SigTest methodology. Treat current outputs as baseline/reference until that alignment lands.

## Input Modes

SINL accepts two input modes via the `inputMode` parameter:

| Mode | Input | Description |
|---|---|---|
| `codes` | Raw ADC integer codes | Default. Resolution is derived from the `minCode`/`maxCode` range. |
| `voltage` | Floating-point volts | Samples are normalised to the `minCode`/`maxCode` voltage range and mapped to a fixed 10-bit (1024-code) histogram. |

Auto-seeding: when packet metadata reports `units: 'volts'` and the user left `inputMode` at its default (`codes`), SINL switches to `voltage` mode and derives `minCode`/`maxCode` from the actual sample range, adding a 2% margin so extreme codes are not at the absolute boundary.

## Algorithm

1. **Histogram** — integer code histogram over `2^adcRes` bins.
2. **Reachable-code bounds** — codes with fewer than `minSizeBin` samples are excluded from the integration range.
3. **Truncation** — a peak-search avoidance radius (`avoidanceRadius`) locates the true sine peaks near each end of the histogram; the truncation points define the active analysis window.
4. **Okawara-T estimation** — PDF is computed, CDF accumulated, then `cos(π·CDF)` is formed. The `codeSizeOverAmp` (LSB size relative to sine amplitude) is derived from the cos-CDF difference across the truncated range. DNL and INL follow directly:
   - DNL = `-Δcos(π·CDF) / codeSizeOverAmp − 1`
   - INL = cumulative cos-based deviation from the ideal ramp
5. **Polynomial fit** — a 3rd-order least-squares polynomial is fitted to the measured INL as a trend line (`inl_polynomial`).
6. **Metrics** — INL max/min and peak-to-peak (polynomial-based), DNL max/min/RMS, and missing-code count (DNL below `missingThreshold`, default -0.9 LSB).

## Parameters

| Parameter | Default | Description |
|---|---|---|
| `sampleColumn` | *(auto)* | CSV column containing raw ADC codes or voltages. |
| `inputMode` | `codes` | `codes` (raw ADC integers) or `voltage` (floating-point volts, normalised to minCode/maxCode). |
| `minCode` | `0` | Theoretical minimum code (codes mode) or minimum voltage (voltage mode). |
| `maxCode` | `2047` | Theoretical maximum code (e.g. 2047 for 11-bit) or maximum voltage. Required. |
| `avoidanceRadius` | `40` | Peak-search radius (bins) for truncation-point detection. |
| `minSizeBin` | `2` | Minimum samples for a code to count as reachable. |
| `missingThreshold` | `-0.9` | DNL threshold below which a code is counted as missing. |

## CLI Syntax

### Scalar output only

```bash
node usig.mjs -i capture.csv -plugin sinl
```

### Single debug table

```bash
node usig.mjs -i capture.csv -plugin sinl -debug inl_dnl_series
```

### All debug tables

```bash
node usig.mjs -i capture.csv -plugin sinl -debug all
```

### Single figure

```bash
node usig.mjs -i capture.csv -plugin sinl -figure pdf=/tmp/pdf.svg
```

### Multiple figures

```bash
node usig.mjs -i capture.csv -plugin sinl -figure pdf=/tmp/pdf.svg,dnl=/tmp/dnl.svg,inl=/tmp/inl.svg
```

### Debug tables plus figures (single shared analysis)

```bash
node usig.mjs -i capture.csv -plugin sinl -debug inl_dnl_series -figure pdf=/tmp/pdf.svg,dnl=/tmp/dnl.svg
```

### Full example: 11-bit ADC codes

```bash
node usig.mjs -i adc_11bit_sine.csv -plugin sinl -p inputMode=codes -p minCode=0 -p maxCode=2047 -debug inl_dnl_series -figure pdf=/tmp/pdf.svg,dnl=/tmp/dnl.svg,inl=/tmp/inl.svg
```

### Full example: voltage input (oscilloscope capture)

```bash
node usig.mjs -i scope_sine.csv -plugin sinl -p inputMode=voltage -p minCode=-1.0 -p maxCode=1.0 -debug inl_dnl_series -figure pdf=/tmp/pdf.svg,inl=/tmp/inl.svg
```

### Override truncation / missing-code settings

```bash
node usig.mjs -i capture.csv -plugin sinl -p avoidanceRadius=60 -p minSizeBin=3 -p missingThreshold=-0.8
```

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

## Debug Tables

| Table ID | Columns | Description |
|---|---|---|
| `inl_dnl_series` | `code`, `pdf`, `cdf`, `cos_cdf`, `dnl`, `inl`, `inl_polynomial` | Per-code series: probability density, cumulative distribution, cos(π·CDF), DNL, INL, and the 3rd-order polynomial fit. |

## Figures

| Figure ID | Description |
|---|---|
| `pdf` | PDF vs. code/voltage, with peak-search reference zones and truncation boundaries. |
| `dnl` | DNL per code/voltage, with zero/min/max reference lines and missing-code count in the title. |
| `inl` | Measured INL and 3rd-order polynomial fit per code/voltage, with zero/min/max reference lines. |

## Worked Examples

### 11-bit ADC, code input

```bash
node usig.mjs -i adc_11bit_sine.csv -plugin sinl -p inputMode=codes -p minCode=0 -p maxCode=2047
```

Expected: `adcRes` derived as 11 (2048 codes); INL/DNL computed over the truncated sine range; missing-code count reported.

### Oscilloscope voltage capture

```bash
node usig.mjs -i scope_sine.csv -plugin sinl -p inputMode=voltage -p minCode=-1.0 -p maxCode=1.0
```

Expected: auto-seeded to voltage mode if metadata reports volts; fixed 10-bit (1024-code) histogram; INL/DNL in LSB units relative to the normalised range.

### Tighter missing-code detection

```bash
node usig.mjs -i capture.csv -plugin sinl -p missingThreshold=-0.5
```

Expected: more codes flagged as missing (any DNL below -0.5 LSB counts).

### Wider peak-search radius

```bash
node usig.mjs -i capture.csv -plugin sinl -p avoidanceRadius=80
```

Expected: truncation points searched over a wider window near each histogram edge — useful for very clipped or noisy captures.

## Warnings and Edge Cases

- **Voltage mode resolution:** fixed at 10-bit (1024 codes) regardless of `minCode`/`maxCode` range — chosen to keep the histogram statistically meaningful for typical oscilloscope captures.
- **Truncation bounds:** codes outside `[code_trunclow, code_trunchigh]` are zeroed in DNL/INL output (not analysed) — this is expected Okawara-T behaviour for clipped sines.
- **Polynomial extrapolation:** the 3rd-order fit is restricted to the active INL range in figures to avoid blow-up at inactive codes.
- **Missing codes:** counted only within the active (non-zero) DNL range; codes outside the truncation window are excluded from the count.
- **Auto-seeding:** only triggers when metadata reports volts AND the user left `inputMode` at its default — explicit user selection always wins.
```