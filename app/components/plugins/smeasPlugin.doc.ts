// Auto-generated from smeasPlugin.md — do not edit directly, edit the .md file then re-run: node scripts/md-to-ts.js
const doc = `# smeasPlugin.md — SMEAS Plugin Documentation

## Overview

SMEAS (Sine Measurement and Analysis Spectrum) is a frequency-domain ADC characterisation plugin.
It accepts either raw time-domain ADC samples (codes or volts) or pre-computed power spectra (dBFS),
and produces standard ADC dynamic performance metrics: SNR, SNDR, ENOB, THD, SFDR, harmonics, and
optional two-channel interleaving (TI) correction.

---

## Input Parameters

### targetColumn
- **Type**: column selector (autocomplete)
- **Inferred**: yes — first numeric column in the file
- **Description**: The data column to analyse. For time-domain input this is the raw ADC sample
  column (codes or volts). For spectrum input this is the magnitude column in dBFS.

---

### fsGhz (Sampling Frequency)
- **Type**: numeric, GHz
- **Inferred**: yes — parsed from filename tokens such as \`2p4G\`, \`1.8GHz\`, \`500M\`
- **Description**: ADC sampling clock frequency. Used to convert FFT bin indices to Hz, compute
  Nyquist frequency, and place harmonic markers. Must be set correctly; an incorrect value shifts
  all frequency-domain results.

---

### toneMode
- **Type**: select — \`'single'\` | \`'dual'\`
- **Inferred**: yes — \`'dual'\` when two distinct tone-frequency tokens are found in the filename,
  otherwise \`'single'\`
- **Description**: Selects single-tone or dual-tone analysis.
  - \`single\`: Reports SNR, SNDR, ENOB, THD, SFDR relative to one fundamental.
  - \`dual\`: Reports IM3 (third-order intermodulation) in addition to the standard metrics.
    The two fundamentals are detected as the two largest spectral peaks.

---

### inputMode
- **Type**: select — \`'codes'\` | \`'volts'\` | \`'spectrum_dbfs'\`
- **Default**: \`'codes'\`
- **Description**: Declares the physical meaning of the input column.
  - \`codes\`: Integer ADC output codes. Converted to volts using \`adcNumBits\`, \`adcOffsetCode\`,
    and \`vfsPeakToPeak\` before windowing/FFT.
  - \`volts\`: Already-scaled voltage samples. No code-to-volt conversion applied.
  - \`spectrum_dbfs\`: Pre-computed single-sided power spectrum in dBFS per bin. FFT step is
    skipped; the plugin reconstructs a one-sided linear power vector directly.

---

### fftLength
- **Type**: numeric (integer)
- **Inferred**: yes — largest power of 2 ≤ available samples
- **Warning**: amber highlight when the entered value is not a power of 2 (non-power-of-2 FFTs
  are valid but may lose the exact coherence and leakage properties of radix-2 transforms)
- **Description**: Number of samples (or spectrum bins for spectrum input) used per FFT frame.
  For time-domain input, each averaging frame consumes exactly \`fftLength\` samples.
  \`fftLength × numAveraging\` must not exceed the total samples in the file; if it does the
  plugin returns a controlled error: *"Analysis window (fftLength × averages = N) exceeds
  available samples (M)"*.

---

### numAveraging
- **Type**: numeric (integer ≥ 1)
- **Default**: \`1\`
- **Description**: Number of non-overlapping FFT frames to incoherently average (power averaging).
  Averaging reduces the noise floor variance and gives a smoother spectrum estimate.
  The total sample consumption is \`fftLength × numAveraging\`.

---

### harmonicsToConsider
- **Type**: numeric (integer ≥ 2)
- **Default**: \`5\`
- **Description**: How many harmonic orders (H2 … Hn) to search for when computing THD and
  identifying spurs. Harmonics that alias back into the first Nyquist zone are mapped with
  \`aliasedBinIndex\` before comparison.

---

### adcNumBits
- **Type**: numeric (integer)
- **Inferred**: yes — parsed from filename tokens such as \`12b\`, \`14bit\`, \`16B\`
- **Description**: ADC resolution in bits. Used in two ways:
  1. Code-to-volt conversion: \`volt = (code − adcOffsetCode) × vfsPeakToPeak / 2^adcNumBits\`
  2. Full-scale reference for dBFS: \`dBFS = 20·log10(|amplitude| / (2^(adcNumBits−1)))\`

---

### adcOffsetCode
- **Type**: numeric
- **Default**: \`0\`
- **Description**: DC offset subtracted from every raw code before conversion to volts.
  Set to \`2^(adcNumBits−1)\` for offset-binary ADCs (e.g. 2048 for a 12-bit device whose
  mid-scale is 2048 rather than 0).

---

### vfsPeakToPeak
- **Type**: numeric, volts
- **Default**: \`2.0\`
- **Description**: Full-scale peak-to-peak voltage range of the ADC. Together with \`adcNumBits\`
  and \`adcOffsetCode\` this defines the complete code-to-volt mapping.

---

### window
- **Type**: select — \`'hann'\` | \`'blackman'\` | \`'blackman-harris'\` | \`'flattop'\` | \`'rect'\`
- **Default**: \`'hann'\`
- **Description**: Time-domain window applied to each FFT frame before the transform.
  - \`rect\` (rectangular): no windowing; use only when the input is exactly coherent
    (integer number of cycles in the frame).
  - \`hann\`, \`blackman\`, \`blackman-harris\`: good sidelobe rejection; standard choices for
    non-coherent sinusoidal measurements.
  - \`flattop\`: maximum amplitude accuracy at the expense of wider main lobe; preferred when
    the exact tone amplitude must be measured rather than the noise floor.
  Windowing is skipped entirely for \`spectrum_dbfs\` input because the spectrum is already formed.

---

### sfdrLeakageAvoidanceRadiusMhz
- **Type**: numeric, MHz
- **Inferred**: yes — \`3 × binWidthMHz\` (three-bin guard band)
- **Description**: Exclusion radius around each identified spur (fundamental + harmonics) when
  searching for the SFDR spur. Bins within this radius of any harmonic are not considered as
  SFDR candidates. Increase this value if window leakage is masking nearby spurs; decrease it
  in high-spur-count spectra.

---

### numberOfCores (TI — Number of Interleaved Channels)
- **Type**: numeric (integer ≥ 1)
- **Default**: \`1\`
- **Description**: Number of time-interleaved ADC sub-channels. When > 1, the plugin activates
  TI-mismatch analysis. The sub-stream length per channel is \`fftLength / numberOfCores\`, which
  must itself be a power of 2.

---

### spursMinThresholdEn
- **Type**: boolean toggle
- **Default**: \`false\`
- **Description**: Enables a minimum-power threshold for spur detection. When enabled, only
  spectral bins whose power exceeds the threshold are considered as noise bins for SNR
  calculation, while those above the threshold are excluded as spurs. This prevents large
  harmonic energy from being counted as noise.

---

### spursMinCalcFactor
- **Type**: numeric (σ multiplier)
- **Default**: \`3.0\`
- **Description**: Active when \`spursMinThresholdEn = true\` and \`spursMinDbfs\` is not manually
  overridden. The automatic threshold is computed from the noise floor histogram:
  \`threshold_dBFS = mean(finite bins) + spursMinCalcFactor × std(finite bins)\`.
  Higher values reduce false spur detections; lower values catch weaker spurs.

---

### spursMinDbfs
- **Type**: numeric, dBFS (negative)
- **Default**: auto (computed from \`spursMinCalcFactor\`)
- **Description**: Manual override for the spur minimum threshold. When set, overrides the
  auto-calculated value. Leave blank to use the automatic histogram-based calculation.

---

### tiCorrections
- **Type**: multi-select — any combination of \`'offset'\` | \`'gain'\` | \`'phase'\`
- **Default**: \`[]\` (no correction)
- **Description**: Selects which TI-mismatch error types to measure and correct.
  Applied only when \`numberOfCores > 1\`.
  - \`offset\`: per-channel DC offset mismatch — corrected by subtracting per-channel mean.
  - \`gain\`: per-channel gain mismatch — corrected by normalising per-channel RMS.
  - \`phase\`: per-channel timing (phase-skew) mismatch — corrected by fractional-sample
    delay in the frequency domain.
  Corrections are applied in the order: offset → gain → phase (regardless of selection order).

---

### tiRefPhase
- **Type**: numeric, degrees
- **Default**: \`0\`
- **Description**: Reference phase used during TI phase-skew correction. The ideal sub-channel
  phases are \`[0, 360/N, 2×360/N, …]\` plus \`tiRefPhase\`. Adjust if the first sub-channel has
  a known non-zero phase.

---

### tiOffsetQuantLsb
- **Type**: numeric, LSB
- **Default**: \`0\`
- **Description**: Quantisation step for the TI offset correction. When non-zero, the computed
  per-channel offset correction is rounded to the nearest multiple of this value before being
  applied. Useful when the correction must be expressed in integer codes.

---

## Algorithms

### 1. Code-to-Volt Conversion (inputMode = 'codes')`;
export default doc;
