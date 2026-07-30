# smeasPlugin — SMEAS Sine Spectrum Analysis

**Plugin ID**: `smeas`
**File**: `app/components/plugins/smeasPlugin.tsx`
**Category**: Signal / ADC Characterisation
**Author**: Guy Steiff
**Version**: 1.0.0

---

## What It Does

SMEAS (Sine Measurement and Analysis Spectrum) is a frequency-domain ADC characterisation
plugin. It accepts either raw time-domain ADC samples (codes or volts) or pre-computed
power spectra (dBFS), and produces standard ADC dynamic performance metrics: SNR, SNDR,
ENOB, THD, SFDR, harmonics, and optional Time-Interleaved (TI) mismatch correction.

Key capabilities:
- Auto-window selection (detects coherent vs. leaky captures automatically)
- TI mismatch de-embedding (offset, gain, phase correction for multi-core ADCs)
- Dual-tone IM3 detection
- Avoidance-radius SFDR (blanks fund + DC + Nyquist before searching for the worst spur)
- Multiple input modes: raw codes, volts, pre-computed spectrum

---

## Input Parameters

### targetColumn
- Type: column-select
- Scope: per-file
- Inferred: yes — column with most unique values heuristic, or exact match on defaultValue
- Description: The data column to analyse. For time-domain input: raw ADC samples (codes
  or volts). For spectrum input: the dBFS magnitude column.

---

### fsGhz (Sampling Frequency)
- Type: numeric, GHz
- Scope: global
- Inferred: yes — parsed from filename tokens: fs2p25ghz, fs_2250MHz, sample_rate_1e9,
  samplerate44p1kHz, fs2.25e9
- Description: ADC sampling clock frequency in GHz. Used to convert FFT bin indices to
  Hz, compute Nyquist, and place harmonic/TI spur markers. An incorrect value shifts all
  frequency-domain results.

---

### toneMode
- Type: select — 'single' | 'dual'
- Inferred: yes — 'dual' when two distinct tone-frequency tokens are found in the filename
- Description: Single-tone: reports SNR/SNDR/ENOB/THD/SFDR. Dual-tone: additionally
  reports IM3. The two fundamentals are detected as the two largest spectral peaks.

---

### inputMode
- Type: select — 'time_domain_codes' | 'time_domain_volts' | 'single_sided_power_spectrum'
- Default: 'time_domain_codes'
- Description:
  - time_domain_codes: Integer ADC codes. Converted to volts using adcNumBits,
    adcOffsetCode, vfsPeakToPeak before windowing/FFT.
  - time_domain_volts: Pre-scaled voltage samples. No code-to-volt conversion applied.
  - single_sided_power_spectrum: Pre-computed single-sided power spectrum in dBFS per bin.
    FFT step is skipped; the plugin reconstructs a one-sided linear power vector directly.
    Windowing is also skipped.

---

### fftLength
- Type: numeric (integer)
- Default: 8192
- Scope: global or per-file
- Inferred: yes — largest power of 2 <= available samples (divided by numAveraging)
- Warning: amber highlight when not a power of 2 (valid but may lose radix-2 FFT properties)
- Description: Number of samples per FFT frame. fftLength * numAveraging must not exceed
  total samples. For single_sided_power_spectrum: number of bins.

---

### numAveraging
- Type: numeric (integer >= 1)
- Default: 1
- Description: Number of non-overlapping FFT frames to incoherently average (power
  averaging). Reduces noise floor variance. Total sample consumption:
  fftLength * numAveraging.

---

### window
- Type: select — 'auto' | 'rectangular' | 'hann' | 'hamming' | 'blackman' |
                 'blackmanharris' | 'flattop' | 'kaiser'
- Default: 'auto'
- Description: Time-domain window applied to each FFT frame before the transform.
  - rectangular: no windowing; use only when input is exactly coherent (integer cycles
    in frame).
  - hann, hamming, blackman, blackmanharris: good sidelobe rejection; standard for
    non-coherent sine measurements.
  - flattop: maximum amplitude accuracy, wider main lobe; preferred when exact tone
    amplitude matters over noise floor.
  - kaiser: tunable sidelobe control via kaiserBeta (beta=8 per IEEE 1241 default).
  - auto: See Auto-Window Algorithm section below.
  Windowing is skipped entirely for single_sided_power_spectrum input.

---

### kaiserBeta
- Type: numeric
- Default: 8
- Active: only when window = 'kaiser'
- Description: Kaiser window shape parameter beta. Beta=8 is the IEEE 1241 ADC
  characterization default (ENBW ~2.39 bins).

---

### winCoherentGain / winEnbw / winNHalfBins
- Type: numeric (-1 = use IEEE table default)
- Default: 1, 1, 0 (all use IEEE table defaults when set to -1 or auto)
- Description: Manual overrides for window coherent gain, ENBW, and lobe integration
  half-width. Set to -1 to use the built-in IEEE table values. Auto mode always uses
  the IEEE table values regardless of these overrides.

---

### harmonicsToConsider
- Type: numeric (integer >= 2)
- Default: 7
- Description: Number of harmonic orders (H2..Hk) to detect and subtract from the noise
  floor for THD and SFDR computation. Harmonics that alias back into the first Nyquist
  zone are correctly folded.

---

### adcNumBits
- Type: numeric
- Default: 11
- Inferred: yes — from filename: 12bit, 12b, 12bits, adc12, adc_12b
- Description: ADC resolution in bits. Used for code-to-volt conversion and for computing
  the ideal quantization noise floor.

---

### adcOffsetCode
- Type: numeric
- Default: 1023
- Description: DC offset code. Subtracted from samples before conversion:
  volt = (code - adcOffsetCode - midCode) * lsbVolt.

---

### vfsPeakToPeak
- Type: numeric, V
- Default: 2.0
- Inferred: from binary file metadata (vfsPeakToPeak field in WaveformPacket) or from
  filename (vfs2v, vpp2.0v)
- Description: Full-scale peak-to-peak voltage range. Together with adcNumBits and
  adcOffsetCode defines the complete code-to-volt mapping:
  lsbVolt = vfsPeakToPeak / 2^adcNumBits

---

### sfdrLeakageAvoidanceRadiusMhz
- Type: numeric, MHz
- Default: 0 (uses minimum 0.3% of fs automatically)
- Inferred: yes — 3 * binWidthMHz (three-bin guard band) as starting reference
- Description: Exclusion radius around the fundamental (and DC and Nyquist) when
  searching for the SFDR spur. The plugin always enforces a minimum of 0.3% of fs
  regardless. See SFDR Algorithm section.

---

### numberOfCores
- Type: numeric (integer >= 1)
- Default: 1
- Description: Number of time-interleaved ADC sub-channels. When > 1, activates
  TI-mismatch analysis. Sub-stream length per channel: fftLength / numberOfCores
  must be a power of 2.

---

### tiCorrections
- Type: string — comma-separated subset of 'O', 'G', 'P' (e.g. 'O,G,P' or 'O,G' or '')
- Default: 'none'
- Description: Selects which TI-mismatch corrections to apply. Order: offset -> gain ->
  phase (regardless of selection order).
  - O (offset): subtract per-channel mean.
  - G (gain): normalize per-channel RMS to reference.
  - P (phase): fractional-sample delay in frequency domain (Quinn-Estrade sub-bin
    estimation).
  Applied only when numberOfCores > 1.

---

### tiRefPhase
- Type: numeric
- Default: 0
- Description: Reference phase index (0-based). All other sub-channels align to this.

---

### tiOffsetQuantLsb
- Type: numeric, LSB
- Default: 0.25
- Description: Quantisation step for TI offset correction. When non-zero, the computed
  per-channel offset correction is rounded to the nearest multiple of this value before
  being applied. Useful when correction must be expressed in integer codes.

---

### spursMinThresholdEn
- Type: boolean
- Default: true
- Description: Enables minimum-power threshold for spur detection. When enabled and a
  manual spursMinDbfs override is set to non-zero, bins above the threshold are excluded
  from the noise sum (SNR calculation). Prevents harmonic energy from being counted as
  noise. Note: the auto-calculated threshold is display-only unless spursMinDbfs is
  explicitly set non-zero.

---

### spursMinCalcFactor
- Type: numeric (sigma multiplier)
- Default: 1.0
- Description: Auto-threshold calculation:
  threshold_dBFS = mean(noise_bins) + factor * std(noise_bins)
  Higher values reduce false detections. Display reference only unless spursMinDbfs
  is manually overridden.

---

### spursMinDbfs
- Type: numeric, dBFS (negative)
- Default: 0 (auto-calculated from spursMinCalcFactor for display; does NOT change SNR)
- Description: Manual override for spur minimum threshold. Non-zero value activates
  SNR filtering. Zero = display auto-calc value as reference only.

---

## Algorithm: Auto-Window Selection

The 'auto' window mode determines whether the capture is coherent (integer cycles, no
leakage) or non-coherent (fractional cycles, leakage present), and selects the optimal
window accordingly.

  Step 1: Run rectangular window -> get rectEnob (baseline)

  Step 2: For each non-rectangular candidate in order:
          [hann, hamming, blackman, blackmanharris, flattop, kaiser]:
            Run candidate -> get candidateEnob
            If candidateEnob <= rectEnob:
              allNonRectBeatRect = false
              BREAK (no need to try remaining windows)
            Else:
              Track best (highest ENOB) non-rectangular result

  Step 3: Decision:
          If allNonRectBeatRect == true:
            Use best non-rectangular window
            (reason: leakage is present, windowing improves all results -> pick best)
          Else:
            Use rectangular window
            (reason: at least one windowed result did not improve -> coherent signal,
             windowing only hurts SNR)

  Output: The chosen window name is reported in the 'window_used' output column.
          In the UI, the auto-used window is shown in teal next to the plugin name.

Why break early: If any windowed candidate fails to beat rectangular, the data is
coherent. Running the remaining candidates would be wasted computation — the decision
is already made.

Important: 'auto' mode always uses the built-in IEEE table values for coherent gain
and ENBW (winCoherentGain/winEnbw/winNHalfBins overrides are ignored). This ensures
a fair comparison across all candidate windows.

---

## Algorithm: Code-to-Volt Conversion (inputMode = 'time_domain_codes')

  midCode = 2^(adcNumBits - 1)
  lsbVolt = vfsPeakToPeak / 2^adcNumBits
  volt[i] = (code[i] - adcOffsetCode - midCode) * lsbVolt

Applied per-sample before windowing/FFT.

---

## Algorithm: Window Application & Amplitude Correction

  For each FFT frame k = 0..numAveraging-1:
    chunk    = samples[k*L .. (k+1)*L - 1]
    windowed = chunk * w                       [element-wise multiply]
    X[k]     = FFT(windowed) / L               [normalize by N]
    Ps[k]    = |X[k][0..L/2]|^2               [one-sided power]
    Ps[k][1..L/2-1] *= 2                       [fold two-sided to one-sided]

  Ps_avg = mean(Ps[k])                         [incoherent power average]

  -- Amplitude correction --
  Ps_corrected = Ps_avg / (coherentGain^2)     [undo window attenuation]

Window properties used (IEEE 1241 table):

| Window         | Coherent Gain | ENBW (bins) | nHalfBins |
|----------------|--------------|-------------|-----------|
| rectangular    | 1.0000       | 1.000       | 0         |
| hann           | 0.5000       | 1.500       | 1         |
| hamming        | 0.5400       | 1.363       | 1         |
| blackman       | 0.4200       | 1.726       | 2         |
| blackmanharris | 0.3587       | 2.004       | 3         |
| flattop        | 0.2156       | 3.770       | 4         |
| kaiser (b=8)   | 0.4020       | 2.390       | 4         |

---

## Algorithm: Fundamental & Harmonic Detection

  Find fundBin: argmax(PsDbfs[1..S1len-1])

  For windowed inputs (nHalfBins > 0):
    integrateLobePs(Ps, fundBin, nHalfBins):
      sum Ps[fundBin - nHalfBins .. fundBin + nHalfBins]
      -> returns (fundPs, refined peakBin)
    fundDbfs = 10 * log10(fundPs / PfsRef)

  For each harmonic h = 2..harmonicsToConsider:
    rawBin     = h * fundBin
    aliasedBin = fold rawBin into [1, S1len-1] (Nyquist zone aliasing)
    harmonicPs = integrateLobePs(Ps, aliasedBin, nHalfBins)

Dual-tone: finds fund2Bin as the next highest peak outside the fund lobe, then
computes all m*F1 + n*F2 intermodulation products up to order harmonicsToConsider.

---

## Algorithm: Noise Power

  totalPs   = sum(Ps[0..S1len-1])
  noisePs   = totalPs - pdcPs - fundPs - harmonicsPs - tiSpursPs
              (also subtracts fund2Ps for dual-tone)
  if noisePs < 0: noisePs = 1e-30    [floor to avoid log(negative)]

TI spur power IS subtracted from noise (same as Python reference). This ensures
SNR/ENOB do not change based on numberOfCores when no real performance change
occurred — TI spurs are signals, not noise.

Threshold filtering (spursMinDbfs override != 0 and spursMinThresholdEn = true):
  noisePsForSnr = sum(Ps[i] for i where PsDbfs[i] < spursMinDbfsOverride)

The auto-calc threshold (spursMinCalcFactor * sigma) is shown as a reference marker
but does NOT change SNR unless a manual override is explicitly set non-zero.

---

## Algorithm: SNR / SNDR / ENOB / THD

  SNR_carrier  = 10 * log10(fundPs / noisePsForSnr)            [dBc]
  SNR_fs       = 10 * log10(PfsRef / noisePsForSnr)            [dBFS]
  SNDR_carrier = 10 * log10(fundPs / (noisePs + harmonicsPs))  [dBc]
  SNDR_fs      = 10 * log10(PfsRef / (noisePs + harmonicsPs))  [dBFS]

  ENOB_SNR_c   = (SNR_carrier  - 1.76) / 6.02    [bits]
  ENOB_SNR_fs  = (SNR_fs       - 1.76) / 6.02
  ENOB_SNDR_c  = (SNDR_carrier - 1.76) / 6.02
  ENOB_SNDR_fs = (SNDR_fs      - 1.76) / 6.02

  THD_dB = 10 * log10(harmonicsPs / fundPs)        [dBc, negative = below carrier]

  Noise_rms_mV = 1000 * sqrt(noisePs)              [mV RMS]

PfsRef: Full-scale reference power. For codes/volts: (vfsPeakToPeak/2)^2 / 2.
For single_sided_power_spectrum: 1.0 linear (0 dBFS reference).

All four ENOB variants are reported in the output CSV. The carrier-referenced variants
(enob_snr_c, enob_sndr_c) reflect actual ADC distortion relative to the input tone.
The full-scale-referenced variants (enob_snr_fs, enob_sndr_fs) reflect headroom
utilization as well.

---

## Algorithm: SFDR with Avoidance Radius

SFDR is the ratio of the fundamental power to the highest spurious component, with the
fundamental excluded from the search.

  Step 1: Compute minimum blanking radius
    minRadiusMhz = 0.3% * fs_MHz
    e.g. for fs=2250 MHz -> minRadiusMhz = 6.75 MHz

  Step 2: Apply user radius (additive, not replacement)
    effectiveRadiusMhz = max(minRadiusMhz, sfdrLeakageAvoidanceRadiusMhz)

  Step 3: Convert to bins
    avoidBins = ceil(effectiveRadiusMhz * 1e6 / (fsHz / L))

  Step 4: Build blanked spectrum (copy of PsDbfs)
    Blank DC zone:       PsDbfsSfdr[0    +/- avoidBins] = -Infinity
    Blank Nyquist zone:  PsDbfsSfdr[S1len-1 +/- avoidBins] = -Infinity
    Blank fundamental:   PsDbfsSfdr[fundBin +/- avoidBins] = -Infinity
    Blank fund2:         PsDbfsSfdr[fund2Bin +/- avoidBins] = -Infinity (dual-tone)
    NOTE: harmonics are NOT blanked — they ARE valid SFDR candidates

  Step 5: Find SFDR spur
    sfdrBin   = argmax(PsDbfsSfdr[1..S1len-2])
    sfdrDbcs  = fundDbfs - PsDbfs[sfdrBin]    [dBc relative to fundamental]

  Step 6: Label the SFDR spur
    Check if sfdrBin matches any harmonic -> label as H2, H3, etc.
    Check if sfdrBin matches any TI spur  -> label as TI01, TI11, etc.
    Otherwise -> 'undesignated'

  Step 7: SFDR without TI spurs (sfdr_wo_ti_dbc)
    Start from PsDbfsSfdr (DC/Nyquist/fund already blanked)
    Additionally blank every TI spur: PsDbfsSfdr[tiSpur.bin +/- avoidBins] = -Infinity
    sfdrWoTiBin = argmax(remaining)
    sfdrWoTiDbcs = fundDbfs - PsDbfs[sfdrWoTiBin]

Why 0.3% minimum: Guarantees clearing the main-lobe leakage for all standard windows.
For fs=2250 MHz this is 6.75 MHz.

Why harmonics are not blanked: SFDR is defined as the worst spur regardless of origin.
A harmonic IS a valid SFDR candidate — it is just labeled as such. Only the fundamental,
DC, and Nyquist are excluded.

TI spurs ARE valid SFDR candidates (included in sfdr_dbc). The sfdr_wo_ti_dbc metric
removes them, giving the intrinsic SFDR of the signal chain excluding TI mismatch spurs.

---

## Algorithm: TI Mismatch Characterisation & Correction

When numberOfCores > 1:

  For each sub-channel p = 0..Np-1:
    Extract sub-stream: samples[p::Np]         [every Np-th sample]
    Sub-stream length: Lsub = L / Np           [must be power of 2]

    Offset: offsetCode[p] = midCode - mean(sub_stream)
    Gain:   gainRms[p] = std(sub_stream)
            gainNorm[p] = gainRms[p] / gainRms[refPhase]

    Phase (Quinn-Estrade sub-bin estimation):
      FFT(sub_stream, rectangular)               [MUST use rectangular here]
      Find energetic bin k_sub
      Compute epsilon (fractional bin offset) via Quinn-Estrade estimator
      Remove rectangular-window bias
      Phase angle = atan2(Im[k_sub], Re[k_sub])
      Unwrap via pi-modulus
      deltaAngle[p] = measuredAngle[p] - idealAngle[p]
      deltaAngle_ps[p] = deltaAngle_rad / (2*pi*fin) * 1e12

  Corrections (applied to time-domain codes before analysis FFT):
    Offset: codes[p::Np] -= offsetCode[p]
    Gain:   codes[p::Np] /= gainNorm[p]
    Phase:  apply fractional-sample delay in frequency domain

Sub-stream phase MUST use rectangular window: A Hann or other window biases the phase
angle at the peak bin. The Quinn-Estrade estimator assumes rectangular windowing.

TI spur positions:
  For k = 1 .. floor((numberOfCores+1)/3):
    Left spur:   k * L/numberOfCores - fundBin
    Center spur: k * L/numberOfCores
    Right spur:  k * L/numberOfCores + fundBin

---

## Output Columns (per file, in results CSV)

| Column             | Description                                         | Unit  |
|--------------------|-----------------------------------------------------|-------|
| window_used        | Window applied (especially useful for auto mode)    | --    |
| snr_c              | SNR relative to carrier                             | dBc   |
| snr_fs             | SNR relative to full scale                          | dBFS  |
| sndr_c             | SNDR relative to carrier                            | dBc   |
| sndr_fs            | SNDR relative to full scale                         | dBFS  |
| enob_snr_c         | ENOB from SNR (carrier-referenced)                  | bits  |
| enob_snr_fs        | ENOB from SNR (full-scale-referenced)               | bits  |
| enob_sndr_c        | ENOB from SNDR (carrier-referenced)                 | bits  |
| enob_sndr_fs       | ENOB from SNDR (full-scale-referenced)              | bits  |
| thd_db             | Total harmonic distortion                           | dBc   |
| sfdr_dbc           | SFDR relative to carrier                            | dBc   |
| sfdr_mhz           | SFDR spur frequency                                 | MHz   |
| sfdr_label         | SFDR spur identity (H2, TI01, undesignated)         | --    |
| sfdr_wo_ti_dbc     | SFDR excluding TI spurs                             | dBc   |
| sfdr_wo_ti_mhz     | SFDR_woTI spur frequency                            | MHz   |
| sfdr_wo_ti_label   | SFDR_woTI spur identity                             | --    |
| fund1_mhz          | Fundamental frequency                               | MHz   |
| fund1_dbfs         | Fundamental power                                   | dBFS  |
| noise_rms_mv       | RMS noise in voltage domain                         | mV    |
| fund2_mhz          | Second tone frequency (dual-tone only)              | MHz   |
| fund2_dbfs         | Second tone power (dual-tone only)                  | dBFS  |
| im3_dbc            | IM3 (dual-tone only)                                | dBc   |
| im3_mhz            | IM3 spur frequency (dual-tone only)                 | MHz   |
| vpp_volts          | Peak-to-peak voltage swing                          | V     |
| max_volts          | Maximum voltage                                     | V     |
| min_volts          | Minimum voltage                                     | V     |
| avg_volts          | Average voltage                                     | V     |
| vpp_codes          | Peak-to-peak code swing                             | codes |
| max_codes          | Maximum code                                        | codes |
| min_codes          | Minimum code                                        | codes |
| avg_codes          | Average code                                        | codes |
| fs_ghz             | Sampling frequency used                             | GHz   |
| fft_length         | Actual FFT length used                              | --    |
| sfdr_leakage_avoid_mhz | Effective SFDR avoidance radius used           | MHz   |

---

## Figures (per file, interactive)

All figures use Recharts ComposedChart with interactive tooltips.

### 1. Full Spectrum (dBFS vs MHz)

Single-sided power spectrum in dBFS. X-axis: frequency (MHz), Y-axis: power (dBFS).

Annotations:
- Red vertical marker: fundamental (F1, or F1/F2 for dual-tone)
- Orange vertical markers: harmonics H2..Hn with label and dBc values
- Purple vertical markers: TI spurs (when numberOfCores > 1)
- Green vertical marker: SFDR spur
- Amber horizontal line: spur minimum threshold (when spursMinDbfs is active)
- Gray shaded exclusion zones: sfdrLeakageAvoidanceRadiusMhz around fund

Interactive SFDR radius slider allows live re-analysis without re-running the plugin.

### 2. TI-Removed Spectrum

Same as Full Spectrum but TI spur bins set to NaN (not plotted). Useful for visually
isolating harmonic distortion from TI mismatch.

### 3. Noise-Only Spectrum

DC, fundamental, fund2, all harmonics, all TI spurs set to NaN. Shows the true noise
floor shape. Useful for identifying broadband noise and phase noise sidebands.

---

## Debug Tables

| Table ID      | Contents |
|---------------|----------|
| harmonic_table | symbol, order, bin, mhz, dbfs, dbcs for each harmonic |
| ti_spur_table  | bin, mhz, dbfs, label for each TI spur |
| spectrum_bins  | bin, mhz, dbfs for all S1len bins |

---

## Error Handling

| Condition                      | Error |
|--------------------------------|-------|
| File has fewer than 2 lines    | File has fewer than 2 lines. |
| Column not found               | Column "X" not found. Available: ... |
| No numeric samples             | No numeric samples found. |
| Window x averages > samples    | Analysis window (fftLength x averages = N) exceeds available samples (M) |
| fsGhz not available            | No sampling frequency available. Set fs in the plugin params or embed it in the file name / a CSV column. |
| TI sub-stream not power of 2   | TI cal: sub-stream length N (= fftLength/numCores) must be a power of 2. |

---

## Known Pitfalls

| Issue | Description | Fix |
|-------|-------------|-----|
| fftLength * numAveraging > N   | Exceeds available samples | Reduce fftLength or numAveraging |
| Non-power-of-2 fftLength       | Uses slow DFT (O(N^2)) | Set fftLength to power of 2; a warning is shown |
| auto-window always returns rectangular | Signal is coherent (integer cycles) | Expected behavior; use windowed mode only if testing non-coherent |
| TI correction with non-power-of-2 sub-stream | fftLength / numberOfCores not power of 2 | Set fftLength = numberOfCores * 2^k |
| SFDR missing spur near fundamental | Spur < effectiveRadius from fund | Reduce sfdrLeakageAvoidanceRadiusMhz; check harmonic table |
| spursMinDbfs auto-calc not changing SNR | Auto-calc is display-only | Set spursMinDbfs to a non-zero value explicitly |
| TI phase correction biased | Using non-rectangular window for sub-stream FFT | Plugin always uses rectangular for TI phase; do not override |

---

## Cohabitation Notes (running alongside SINL)

- targetColumn key is distinct from SINL's sampleColumn — no conflict.
- Output columns use distinct names — no overlap with SINL outputs.
- Both plugins can be active simultaneously; results are merged into one CSV row per file.

---

## Python Twin

| Field | Value |
|-------|-------|
| pythonModule   | smeas_tool |
| pythonFunction | run_smeas |

When the platform's Export as Python script feature is available, it will generate a
ready-to-run .py file using the current parameter values.