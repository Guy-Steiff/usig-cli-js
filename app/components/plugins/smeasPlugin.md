# SMEAS Plugin — Sine Spectrum Analysis

## Overview

SMEAS (`-plugin smeas`) performs FFT-based sine analysis on ADC captures or voltage waveforms, computing SNR, SNDR, ENOB, THD, SFDR, noise RMS, and — for dual-tone stimuli — IM3. It supports single-tone and dual-tone stimuli, multiple window functions with IEEE 1057/Harris correction tables, and optional time-interleaved (TI) ADC mismatch characterization and de-embedding.

A minimal analysis requires only an input file and the plugin name:

```bash
usig -i capture.csv -plugin smeas
```

This runs a single-tone analysis with default parameters and prints the scalar results to stdout.

## Input Modes

SMEAS accepts three input modes via the `inputMode` parameter:

| Mode | Input | Description |
|---|---|---|
| `time_domain_codes` | ADC integer codes | Default. Codes are converted to volts using `adcNumBits`, `adcOffsetCode`, and `vfsPeakToPeak`. |
| `time_domain_volts` | Floating-point volts | Samples are used directly; codes are derived for reporting. |
| `single_sided_power_spectrum` | dBFS spectrum | Pre-computed spectrum; FFT/windowing are bypassed and the spectrum is reconstructed into a time-domain record for reporting. |

**Auto-seeding:** when packet metadata reports `units: 'volts'` and `inputMode` is left at its default, SMEAS switches to `time_domain_volts` automatically. When metadata carries a computed `vfsPeakToPeak` and the user left the default 2.0 V, that value is seeded as well.

## Parameters

### Signal and Acquisition

| Parameter | Default | Description |
|---|---|---|
| `targetColumn` | `data` | CSV/XLSX column or BIN channel header field identifying the sample data. |
| `fsGhz` | `2.1` | Sampling frequency in GHz. Accepts plain GHz (2.25), MHz-range values (2250), or Hz-range values (2.25e9); auto-normalized. Also auto-extractable from filenames such as `fs2250mhz` or `sample_rate_44p1kHz`. |
| `toneMode` | `single` | `single` or `dual`. Auto-detected from filenames containing `single`, `dual`, or `two`. |
| `inputMode` | `time_domain_codes` | One of the three input modes listed above. |
| `fftLength` | `8192` | Samples per FFT frame. Accepts plain integers or power-of-2 expressions such as `2^16` or `2**13`. Non-power-of-2 lengths fall back to a slow O(N²) DFT with a warning. |
| `numAveraging` | `1` | Number of spectral averages; total samples consumed = `fftLength × numAveraging`. |
| `adcNumBits` | `11` | ADC resolution in bits (codes-to-volts conversion). |
| `adcOffsetCode` | `1023` | Mid-scale offset code (2^10 − 1 for 11-bit). |
| `vfsPeakToPeak` | `2.0` | Full-scale peak-to-peak voltage (V). |
| `harmonicsToConsider` | `7` | Number of harmonics (H2…Hk) or IM order (dual-tone) to detect and subtract from the noise floor. |

### Windowing

| Parameter | Default | Description |
|---|---|---|
| `window` | `auto` | `auto`, `rectangular`, `hann`, `hamming`, `blackman`, `blackmanharris`, `flattop`, `kaiser`. |
| `kaiserBeta` | `8` | Kaiser shape parameter β (only active when `window=kaiser`). |
| `winCoherentGain` | `-1` | Override coherent gain; `-1` uses the IEEE table default for the selected window. |
| `winEnbw` | `-1` | Override ENBW (bins); `-1` uses the IEEE table default. |
| `winNHalfBins` | `-1` | Override lobe-integration half-width (bins each side of peak); `-1` uses the IEEE table default. |

**Window properties (IEEE 1057 / Harris 1978):**

| Window | Coherent Gain | ENBW (bins) | Lobe Half-Bins |
|---|---|---|---|
| rectangular | 1.000 | 1.000 | 0 |
| hann | 0.2500 | 1.500 | 2 |
| hamming | 0.2700 | 1.363 | 2 |
| blackman | 0.1736 | 1.727 | 3 |
| blackmanharris | 0.1360 | 2.004 | 4 |
| flattop | 0.04652 | 3.770 | 4 |
| kaiser (β=8) | 0.4020 | 2.390 | 4 |

### Window Selection: `auto`

The default `window=auto` runs rectangular as the baseline, then re-analyzes the capture with every other candidate window. The verdict logic is:

- **All** windowed results beat rectangular ENOB → the capture is leaking energy (incoherent sampling), and the best windowed result is chosen.
- **Any** windowed result fails to beat rectangular ENOB → the capture is treated as coherent, and the rectangular window is returned.
- **Mixed** (some windowed results beat rectangular, some do not) → the capture is treated as coherent, and the rectangular window is returned.

The decision is reported via `window_used` and the `_autoLeakageDetected` flag, which appears in the figure results panel rather than as a scalar output column.

For a known-coherent capture, forcing `window=rectangular` skips the search entirely and saves computation.

## SFDR Spur Search and Avoidance Radius

`sfdrLeakageAvoidanceRadiusMhz` is designed specifically for captures containing leakage and/or windowed captures, where spectral energy is spread into lobes rather than concentrated in discrete bins. Those lobes must be avoided when searching for the SFDR spur, otherwise a leakage lobe can be misidentified as the largest spur.

- The parameter defines an exact, user-specified frequency radius around DC, Nyquist, the fundamental(s), and detected TI spurs that is excluded from the SFDR spur search.
- It has no implicit default or clamping: `0` means no avoidance zone at all, and the specified value is used exactly as given.
- When a non-rectangular window is in use, the avoidance mechanism works automatically around each spectral lobe, and a translucent yellow warning reference area (spotlight) is rendered around each avoided lobe in the `spectrum` figure.
- In non-rectangular windows, a baseline avoidance radius of 0.3% of the sampling frequency (6.75 MHz at 2250 MHz) is applied automatically to clear main-lobe leakage; the user-specified `sfdrLeakageAvoidanceRadiusMhz` adds to this.

| Parameter | Default | Description |
|---|---|---|
| `sfdrLeakageAvoidanceRadiusMhz` | `0` | Extra frequency radius (MHz) blanked around DC, Nyquist, fundamental(s), and TI spurs when searching for the SFDR spur. |

## Spur Threshold Display

These parameters control whether very small harmonics and IM components are marked on the figure. They are distinct from the SFDR avoidance radius.

| Parameter | Default | Description |
|---|---|---|
| `spursMinThresholdEn` | `true` | Enable the spur minimum-threshold display/reference line. |
| `spursMinCalcFactor` | `1.0` | Histogram σ multiplier for the auto-calculated threshold. |
| `spursMinDbfs` | `0` | Manual threshold override in dBFS; `0` = auto-calc. A non-zero value also affects the SNR/ENOB/noise calculation by filtering components below the threshold from the noise spectrum and IM component list. |

**Threshold semantics:** the auto-calculated threshold (`spursMinCalcFactor` × histogram σ) is display-only. A non-zero `spursMinDbfs` override additionally filters components below the threshold from the noise spectrum and IM component list, affecting SNR/ENOB/noise results.

## Time-Interleaved (TI) Mismatch Correction

SMEAS supports time-interleaved ADC characterization with two independent mechanisms:

- **TI spur detection** — identifies and reports interleaving-related spurs in the spectrum.
- **TI de-embedding** — characterizes per-core offset, gain, and phase-skew mismatch and optionally corrects it.

These mechanisms are independent of each other: spurs can be detected without applying any correction, and correction does not require spur detection to run first.

`numberOfCores=1` disables both TI spur detection and TI de-embedding: no TI spurs are reported, no TI calibration runs, and the `spectrum_ti_deembedded` figure is not produced.

### Correction Parameters

| Parameter | Default | Description |
|---|---|---|
| `tiCorrections` | `none` | `none` applies no correction. Any other combination is order-dependent and non-commutative: `O` (offset), `G` (gain), `P` (phase-skew), applied in the user-specified sequence. |
| `tiRefPhase` | `0` | Zero-based reference phase index; all other cores align to it. `O` matches all sub-ADC offsets to the reference core's offset; `G` and `P` behave analogously. |
| `tiOffsetQuantLsb` | `0.25` | Quantization step (LSB) controlling the rounding of the de-embedding. |

**Correction mechanism:** per-core offset (quantized to `tiOffsetQuantLsb`), gain (normalized to the reference phase), and phase-skew are characterized via rectangular-windowed sub-stream FFTs with Quinn's first-estimator sub-bin interpolation (ε) and analytic bias removal. Corrections apply in the user-specified order (e.g., `O,G,P`); phase correction rotates the sub-spectrum by the per-core delta angle and inverse-FFTs back to the time domain.

## CLI Syntax

### Scalar output only

```bash
usig -i capture.csv -plugin smeas
```

### Debug tables: screen only

```bash
usig -i capture.csv -plugin smeas -debug spectra,im_components
```

Prints the requested tables to the screen without saving files.

### Debug all tables: screen only

```bash
usig -i capture.csv -plugin smeas -debug all
```

### Debug all tables: saved to a folder

```bash
usig -i capture.csv -plugin smeas -debug all=/tmp/folder
```

### Debug a specific table: saved to a file

```bash
usig -i capture.csv -plugin smeas -debug spectra=/tmp/file.bin
```

The output extension matters (`.bin`, `.csv`, etc.) and determines the serialization format.

### Single figure

```bash
usig -i capture.csv -plugin smeas -figure spectrum=/tmp/spec.svg
```

### Multiple figures

```bash
usig -i capture.csv -plugin smeas -figure spectrum=/tmp/spec.svg,spectrum_noise=/tmp/noise.svg
```

### Figures with JSON sidecar (`-fig_as_json`)

```bash
usig -i capture.csv -plugin smeas -figure spectrum=/tmp/spec.svg -fig_as_json
```

Writes a sibling `.json` file — a minimal, portable figure description (series data, markers, legend, ticks, results panel) for replotting in other tools. Without `-fig_as_json`, only the figure file is written.

### Figures and debug tables together

```bash
usig -i capture.csv -plugin smeas -debug spectra,im_components -figure spectrum=/tmp/spec.svg,spectrum_ti_deembedded=/tmp/ti.svg
```

Debug tables and figures share a single analysis pass.

### Listing available figures

```bash
usig -plugin smeas -figure list
```

```text
FIGURES: smeas

  spectrum
    Spectrum
    PS_dBFS vs frequency, with fundamental/harmonic/TI-spur reference lines and SFDR/TI-avoidance reference areas.

  spectrum_ti_deembedded
    Spectrum (TI de-embedded)
    PS_dBFS with TI spurs removed vs frequency (only produced when numberOfCores > 1).

  spectrum_noise
    Noise Spectrum
    Noise-only spectrum vs frequency, with the applied minimum-threshold reference line.
```

### Listing available debug tables

```bash
usig -plugin smeas -debug list
```

```text
DEBUG TABLES: smeas

  spectra
    spectra.csv (f_MHz, PS_dBFS, noise spectrum, wo-TI spurs)
    Columns: f_MHz_grid, f_bin_grid, PS_dBFS_samples, PS_dBFS_noise_spectrum, PS_dBFS_wo_tispurs

  timedomain
    time_domain.csv (samples_volts, samples_codes)
    Columns: samples_volts, samples_codes

  im_components
    im_components.csv (harmonic / IM components)
    Columns: symbol, f_im_mhz, f_im_bin, f_im_dbfs, f_im_dbc, f1_mhz, f2_mhz

  ti_spurs
    ti_spurs.csv (TI spur locations)
    Columns: TI_SPURS_label, TI_SPURS_MHz, TI_SPURS_bins, TI_SPURS_dBFS, TI_SPURS_dBc

  ti_cal
    ti_cal.csv (per-phase offset / gain / phase-skew characterisation)
    Columns: nav, phase, epsilon_est, phase_bias_rads, offset_codes_raw, offset_codes_quantized, gain_rms_codes_normalized, gain_rms_codes_raw, raw_angle_rads, proper_angle_rads, offset_angle_rads, ideal_angle_rads, delta_angle_rads, delta_angle_degs, delta_angle_ps, rotation_applied, ref_phase, correction_O, correction_G, correction_P, correction_order
```

### Multiple independent jobs in one command

```bash
usig -i capture_a.csv -plugin smeas -p fsGhz=2.25 -p fftLength=8192 -figure spectrum=/tmp/job1.svg \
     -i capture_b.csv -plugin smeas -p fsGhz=2.25 -p fftLength=4096 -figure spectrum=/tmp/job2.svg
```

Each job runs independently with its own parameters and outputs. USIG also includes infrastructure for a job-list text file using a `file 'path'` pattern, currently exercised for conversions rather than plugins.

### Full example: dual-tone, windowed, TI-corrected

```bash
usig -i dual_tone_fs2250mhz_capture.csv -plugin smeas -p toneMode=dual -p window=hann -p numberOfCores=4 -p tiCorrections=O,G,P -p sfdrLeakageAvoidanceRadiusMhz=6.75 -debug spectra,im_components,ti_spurs,ti_cal -figure spectrum=/tmp/spec.svg,spectrum_ti_deembedded=/tmp/ti_deembed.svg
```

### Full example: single-tone, auto window

```bash
usig -i single_tone_fs2250mhz.csv -plugin smeas -debug all -figure spectrum=/tmp/spec.svg,spectrum_noise=/tmp/noise.svg
```

## Filename Inference

SMEAS parses filenames and applies extracted values as defaults before user-specified parameters. Explicitly user-specified parameters always take precedence over filename-inferred values.

Example filename:

```text
sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv
```

| Filename token | Parsed parameter | Applied value |
|---|---|---|
| `fs2p25ghz` | `fsGhz` | `2.25` |
| `tonemode~single` | `toneMode` | `single` |
| `fftlength8192` | `fftLength` | `8192` |
| `numaveraging4` | `numAveraging` | `4` |
| `numberofcores8` | `numberOfCores` | `8` |
| `ticorrections~ogp` | `tiCorrections` | `O,G,P` |

## Output Columns

| Column | Description |
|---|---|
| `window_used` | Window actually used (`auto` resolves to the chosen window). |
| `_autoLeakageDetected` | Leakage-detection verdict from the auto-window search. Reported in the figure results panel only; not included in the scalar output columns. |
| `snr_c` / `snr_fs` | SNR referenced to carrier / full-scale (dB). |
| `sndr_c` / `sndr_fs` | SNDR referenced to carrier / full-scale (dB). |
| `enob_snr_c` / `enob_snr_fs` | ENOB from SNR (bits). |
| `enob_sndr_c` / `enob_sndr_fs` | ENOB from SNDR (bits). |
| `thd_db` | Total harmonic distortion (dB). |
| `sfdr_dbc` / `sfdr_mhz` / `sfdr_label` | Spurious-free dynamic range (dBc), spur frequency (MHz), and spur label. |
| `sfdr_wo_ti_dbc` / `sfdr_wo_ti_mhz` / `sfdr_wo_ti_label` | SFDR with TI spurs excluded (only when `numberOfCores > 1`). |
| `sfdr_wo_ti_label` | Identity of the spur if it matches a known spur catalog entry (harmonic / TI component / IM component); otherwise `undesignated`. |
| `fund1_mhz` / `fund1_dbfs` | Fundamental frequency (MHz) and level (dBFS). |
| `noise_rms_mv` | Noise RMS (mV). |
| `fund2_mhz` / `fund2_dbfs` | Second fundamental (dual-tone only). |
| `im3_dbc` / `im3_mhz` | IM3 level (dBc) and frequency (MHz) (dual-tone only). |
| `vpp_volts` / `max_volts` / `min_volts` / `avg_volts` | Time-domain voltage statistics. |
| `vpp_codes` / `max_codes` / `min_codes` / `avg_codes` | Time-domain code statistics. |
| `warning` | Present only when fftLength was auto-snapped or too few fundamental cycles were captured. |

## Debug Tables

| Table ID | Columns | Description |
|---|---|---|
| `spectra` | `f_MHz_grid`, `f_bin_grid`, `PS_dBFS_samples`, `PS_dBFS_noise_spectrum`, `PS_dBFS_wo_tispurs` | Per-bin frequency grid, raw power spectrum, noise-only spectrum, and TI-spur-removed spectrum. |
| `timedomain` | `samples_volts`, `samples_codes` | Time-domain samples used for the analysis, in volts and codes. |
| `im_components` | `symbol`, `f_im_mhz`, `f_im_bin`, `f_im_dbfs`, `f_im_dbc`, `f1_mhz`, `f2_mhz` | Fundamental(s) and detected harmonic/IM components with frequency, level, and relative amplitude. |
| `ti_spurs` | `TI_SPURS_label`, `TI_SPURS_MHz`, `TI_SPURS_bins`, `TI_SPURS_dBFS`, `TI_SPURS_dBc` | TI spur locations, levels, and relative amplitudes. |
| `ti_cal` | *(see `-debug list` output above)* | Per-core TI offset/gain/phase-skew characterization and correction (only present when TI calibration ran). |

## Figures

| Figure ID | Description |
|---|---|
| `spectrum` | PS dBFS vs. frequency with fundamental/harmonic/TI-spur markers, SFDR marker, spur-threshold reference line, and SFDR-avoidance shaded zones. Controls: `yFloor`, `showHarmonics`, `showTiSpurs`. |
| `spectrum_ti_deembedded` | Spectrum with TI spurs zeroed out (only produced when `numberOfCores > 1`). Shows `SFDR_woTI`. In dual-tone analysis, F1/F2/DC are preserved, TI bins are removed, and IM/harmonic markers remain visible. |
| `spectrum_noise` | Noise-only spectrum (fundamental, harmonics, and TI spurs removed), with the spur-threshold reference where active. |

Supported figure output formats: `.svg`, `.png`, and `.jpg` — selected by the output file extension.

## Worked Examples

### Single-tone, coherent capture (rectangular recommended)

```bash
usig -i coherent_sine.csv -plugin smeas -p window=rectangular
```

Expected: high SNR/ENOB; `window_used=rectangular`.

### Single-tone, incoherent capture (windowing helps)

```bash
usig -i leaky_sine.csv -plugin smeas -p window=auto
```

Expected: `window_used` resolves to a windowed candidate, with `_autoLeakageDetected` indicating leakage in the results panel.

### Dual-tone IM3 measurement

```bash
usig -i two_tone.csv -plugin smeas -p toneMode=dual -p harmonicsToConsider=5 -p window=blackmanharris
```

Expected: `fund2_mhz`, `fund2_dbfs`, `im3_dbc`, and `im3_mhz` populated; IM components table lists all m·F1+n·F2 products up to order 5.

### TI ADC de-embedding

```bash
usig -i ti_adc_capture.csv -plugin smeas -p numberOfCores=4 -p tiCorrections=O,G,P -p tiRefPhase=0
```

Expected: `ti_spurs` and `ti_cal` debug tables populated; `spectrum_ti_deembedded` figure available; `sfdr_wo_ti_dbc` reported alongside the raw `sfdr_dbc`.

### Pre-computed spectrum input

```bash
usig -i spectrum_dbfs.csv -plugin smeas -p inputMode=single_sided_power_spectrum
```

Expected: FFT/windowing bypassed; spectrum reconstructed to time domain for reporting; windowing controls disabled.

## Warnings and Edge Cases

- **fftLength auto-snap:** if the file has fewer samples than `fftLength × numAveraging`, SMEAS first reduces `numAveraging` to 1; if `fftLength` still exceeds the sample count, it snaps down to the largest power of 2 that fits, with a warning in the scalar output.
- **Few-cycle capture:** if the fundamental lands at bin 3 or below, a warning notes that SNR/ENOB are not meaningful with so few periods.
- **Non-power-of-2 FFT length:** triggers the slow O(N²) DFT path with a visible warning in the figure.
- **TI spur / IM overlap:** a bin can legitimately carry both a TI spur and an IM/harmonic classification; both are reported independently rather than suppressing one for the other.
- **Conditional figures:** `spectrum_ti_deembedded` is skipped (with a clean "not applicable" error) when `numberOfCores=1`; no file is written.
- **Spur threshold semantics:** the auto-calculated threshold is display-only. A non-zero `spursMinDbfs` override additionally filters components below the threshold from the noise spectrum and IM component list, affecting SNR/ENOB/noise results.

## References

- IEEE Std 1057-2017, "IEEE Standard for Digitizing Waveform Recorders" — window property tables (coherent gain, ENBW, lobe width).
- IEEE Std 1241-2010, "IEEE Standard for Terminology and Test Methods for Analog-to-Digital Converters" — ADC test methods, Kaiser β=8 recommendation, ENOB definition.
- F. J. Harris, "On the Use of Windows for Harmonic Analysis with the Discrete Fourier Transform", Proceedings of the IEEE, vol. 66, no. 1, 1978 — classic window-function properties.
- D. C. Rife and R. R. Boorstyn, "Single-Tone Parameter Estimation from Discrete-Time Observations", IEEE Trans. Inf. Theory, 1974 — foundation for sub-bin interpolation.
- B. G. Quinn, "Estimating Frequency by Interpolation Using Fourier Coefficients", IEEE Trans. Signal Processing, vol. 42, no. 5, 1994 — the first-order Quinn estimator used for fractional-bin offset.
- M. Kuhlmann and K. Parhi, "A Background Frequency and Timing Mismatch Calibration for Time-Interleaved ADCs", IEEE Trans. Circuits Syst. — context for TI skew estimation via sub-stream FFT phase.