# SMEAS Plugin — Sine Spectrum Analysis

## Overview

SMEAS (`-plugin smeas`) performs FFT-based sine analysis on ADC captures or voltage waveforms, computing SNR, SNDR, ENOB, THD, SFDR, noise RMS, and (for dual-tone) IM3. It supports single-tone and dual-tone stimuli, multiple window functions with IEEE 1057/Harris correction tables, and optional time-interleaved (TI) ADC mismatch characterisation and de-embedding.

> **Note:** SMEAS will undergo a further revision to align its parameter naming, metric definitions, and reporting conventions with USB-IF SigTest methodology. Treat current outputs as baseline/reference until that alignment lands.

## Input Modes

SMEAS accepts three input modes via the `inputMode` parameter:

| Mode | Input | Description |
|---|---|---|
| `time_domain_codes` | ADC integer codes | Default. Codes are converted to volts using `adcNumBits`, `adcOffsetCode`, and `vfsPeakToPeak`. |
| `time_domain_volts` | Floating-point volts | Samples are used directly; codes are derived for reporting. |
| `single_sided_power_spectrum` | dBFS spectrum | Pre-computed spectrum; FFT/windowing are bypassed and the spectrum is reconstructed into a time-domain record for reporting. |

Auto-seeding: when packet metadata reports `units: 'volts'` and the user left `inputMode` at its default, SMEAS switches to `time_domain_volts` automatically. When metadata carries a computed `vfsPeakToPeak` and the user left the default 2.0 V, that value is seeded as well.

## Parameters

### Signal and Acquisition

| Parameter | Default | Description |
|---|---|---|
| `targetColumn` | `data` | CSV column containing ADC codes or voltages. |
| `fsGhz` | `2.1` | Sampling frequency in GHz. Accepts plain GHz (2.25), MHz-range values (2250), or Hz-range values (2.25e9); auto-normalised. Also auto-extractable from filenames such as `fs2250mhz` or `sample_rate_44p1kHz`. |
| `toneMode` | `single` | `single` or `dual`. Auto-detected from filenames containing `single`, `dual`, or `two`. |
| `inputMode` | `time_domain_codes` | One of the three modes listed above. |
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

**Auto-window logic:** `auto` runs rectangular as the baseline, then every other candidate. If *all* windowed results beat rectangular ENOB, leakage is present and the best windowed result is chosen. If *any* windowed result fails to beat rectangular, the capture is treated as coherent and rectangular is returned. The decision is reported via `window_used` and the leakage-detection flag in the results panel.

### SFDR and Spur Threshold

| Parameter | Default | Description |
|---|---|---|
| `sfdrLeakageAvoidanceRadiusMhz` | `0` | Extra frequency radius (MHz) blanked around DC, Nyquist, fundamental(s), and TI spurs when searching for the SFDR spur. |
| `spursMinThresholdEn` | `true` | Enable the spur minimum-threshold display/reference line. |
| `spursMinCalcFactor` | `1.0` | Histogram σ multiplier for the auto-calculated threshold. |
| `spursMinDbfs` | `0` | Manual threshold override in dBFS; `0` = auto-calc (display only, no SNR filtering). |

### TI Mismatch Correction

| Parameter | Default | Description |
|---|---|---|
| `numberOfCores` | `1` | Number of TI ADC cores. `1` disables TI detection and de-embedding. |
| `tiCorrections` | `none` | Ordered corrections: `none`, `O`, `G`, `P`, `O,G`, `O,P`, `G,P`, `O,G,P`, `G,O,P`, `O,P,G`. `O` = offset, `G` = gain, `P` = phase-skew. |
| `tiRefPhase` | `0` | Zero-based reference phase index; all other cores align to it. |
| `tiOffsetQuantLsb` | `0.25` | Offset-correction quantization step (LSB), preventing unrealistically perfect correction. |

TI correction requires `numberOfCores > 1` and a time-domain input mode; it is disabled automatically for `single_sided_power_spectrum`.

## CLI Syntax

### Scalar output only

```bash
node usig.mjs -i capture.csv -plugin smeas
```

### Single debug table

```bash
node usig.mjs -i capture.csv -plugin smeas -debug spectra
```

### Multiple debug tables

```bash
node usig.mjs -i capture.csv -plugin smeas -debug spectra,im_components
```

### All debug tables

```bash
node usig.mjs -i capture.csv -plugin smeas -debug all
```

### Single figure

```bash
node usig.mjs -i capture.csv -plugin smeas -figure spectrum=/tmp/spec.svg
```

### Multiple figures

```bash
node usig.mjs -i capture.csv -plugin smeas -figure spectrum=/tmp/spec.svg,spectrum_noise=/tmp/noise.svg
```

### Debug tables plus figures (single shared analysis)

```bash
node usig.mjs -i capture.csv -plugin smeas -debug spectra,im_components -figure spectrum=/tmp/spec.svg,spectrum_ti_deembedded=/tmp/ti.svg
```

### Full example: dual-tone, windowed, TI-corrected

```bash
node usig.mjs -i dual_tone_fs2250mhz_capture.csv -plugin smeas -p toneMode=dual -p window=hann -p numberOfCores=4 -p tiCorrections=O,G,P -p sfdrLeakageAvoidanceRadiusMhz=6.75 -debug spectra,im_components,ti_spurs,ti_cal -figure spectrum=/tmp/spec.svg,spectrum_ti_deembedded=/tmp/ti_deembed.svg
```

### Full example: single-tone, auto window

```bash
node usig.mjs -i single_tone_fs2250mhz.csv -plugin smeas -debug all -figure spectrum=/tmp/spec.svg,spectrum_noise=/tmp/noise.svg
```

## Output Columns

| Column | Description |
|---|---|
| `window_used` | Window actually used (`auto` resolves to the chosen window). |
| `snr_c` / `snr_fs` | SNR referenced to carrier / full-scale (dB). |
| `sndr_c` / `sndr_fs` | SNDR referenced to carrier / full-scale (dB). |
| `enob_snr_c` / `enob_snr_fs` | ENOB from SNR (bits). |
| `enob_sndr_c` / `enob_sndr_fs` | ENOB from SNDR (bits). |
| `thd_db` | Total harmonic distortion (dB). |
| `sfdr_dbc` / `sfdr_mhz` / `sfdr_label` | Spurious-free dynamic range (dBc), spur frequency (MHz), and spur label. |
| `sfdr_wo_ti_dbc` / `sfdr_wo_ti_mhz` / `sfdr_wo_ti_label` | SFDR with TI spurs excluded (only when `numberOfCores > 1`). |
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
| `ti_spurs` | `TI_SPURS_label`, `TI_SPURS_MHz`, `TI_SPURS_bins`, `TI_SPURS_dBFS`, `TI_SPURS_dBc` | TI spur locations, levels, and relative amplitudes (numberOfCores > 1 only). |
| `ti_cal` | `nav`, `phase`, `epsilon_est`, `phase_bias_rads`, `offset_codes_raw`, `offset_codes_quantized`, `gain_rms_codes_raw`, `gain_rms_codes_normalized`, `raw_angle_rads`, `proper_angle_rads`, `offset_angle_rads`, `ideal_angle_rads`, `delta_angle_rads`, `delta_angle_degs`, `delta_angle_ps`, `rotation_applied`, `ref_phase`, `correction_O`, `correction_G`, `correction_P`, `correction_order` | Per-core TI offset/gain/phase-skew characterisation and correction (only present when TI calibration ran). |

## Figures

| Figure ID | Description |
|---|---|
| `spectrum` | PS dBFS vs. frequency with fundamental/harmonic/TI-spur markers, SFDR marker, spur-threshold reference line, and SFDR-avoidance shaded zones. Controls: `yFloor`, `showHarmonics`, `showTiSpurs`. |
| `spectrum_ti_deembedded` | Spectrum with TI spurs zeroed out (only produced when `numberOfCores > 1`). Shows `SFDR_woTI`. |
| `spectrum_noise` | Noise-only spectrum (fundamental, harmonics, and TI spurs removed), with the spur-threshold reference where active. |

## Worked Examples

### Single-tone, coherent capture (rectangular recommended)

```bash
node usig.mjs -i coherent_sine.csv -plugin smeas -p window=rectangular
```

Expected: high SNR/ENOB; `window_used=rectangular`.

### Single-tone, incoherent capture (windowing helps)

```bash
node usig.mjs -i leaky_sine.csv -plugin smeas -p window=auto
```

Expected: `window_used` resolves to a windowed candidate (for example `hann` or `kaiser`), with `Leakage detection: true` in the results panel.

### Dual-tone IM3 measurement

```bash
node usig.mjs -i two_tone.csv -plugin smeas -p toneMode=dual -p harmonicsToConsider=5 -p window=blackmanharris
```

Expected: `fund2_mhz`, `fund2_dbfs`, `im3_dbc`, and `im3_mhz` populated; IM components table lists all m·F1+n·F2 products up to order 5.

### TI ADC de-embedding

```bash
node usig.mjs -i ti_adc_capture.csv -plugin smeas -p numberOfCores=4 -p tiCorrections=O,G,P -p tiRefPhase=0
```

Expected: `ti_spurs` and `ti_cal` debug tables populated; `spectrum_ti_deembedded` figure available; `sfdr_wo_ti_dbc` reported alongside the raw `sfdr_dbc`.

### Pre-computed spectrum input

```bash
node usig.mjs -i spectrum_dbfs.csv -plugin smeas -p inputMode=single_sided_power_spectrum
```

Expected: FFT/windowing bypassed; spectrum reconstructed to time domain for reporting; windowing controls disabled.

## Warnings and Edge Cases

- **fftLength auto-snap:** if the file has fewer samples than `fftLength × numAveraging`, SMEAS first reduces `numAveraging` to 1; if `fftLength` still exceeds the sample count, it snaps down to the largest power of 2 that fits, with a warning in the scalar output.
- **Few-cycle capture:** if the fundamental lands at bin 3 or below, a warning notes that SNR/ENOB are not meaningful with so few periods.
- **Non-power-of-2 FFT length:** triggers the slow O(N²) DFT path with a visible warning in the figure.
- **TI spur / IM overlap:** a bin can legitimately carry both a TI spur and an IM/harmonic classification; both are reported independently rather than suppressing one for the other.
- **Spur threshold semantics:** the auto-calculated threshold is display-only; SNR filtering activates only when an explicit non-zero `spursMinDbfs` override is supplied.