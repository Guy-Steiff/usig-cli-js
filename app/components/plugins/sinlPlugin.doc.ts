// Auto-generated from sinlPlugin.md — do not edit directly, edit the .md file then re-run: node scripts/md-to-ts.js
const doc = `# sinlPlugin.tsx — SINL: Sine INL/DNL Analysis

**Plugin ID**: \`sinl\`  
**Category**: Signal / ADC Characterisation  
**Author**: Guy Steiff  
**Version**: 1.0.0

---

## What It Does

Measures **Integral Nonlinearity (INL)** and **Differential Nonlinearity (DNL)** from ADC captures driven by a **clipped (saturated) sine wave** — the classic Okawara-T method. Designed for ADCs where the input signal clips at the rails, making standard histogram methods invalid.

> **Not for ENOB.** Use SMEAS for spectral metrics (SNR/SNDR/ENOB/THD/SFDR).  
> Use SINL for static linearity: INL/DNL, missing codes, truncation zone.

---

## Algorithm: Okawara-T (Truncated Sine Histogram)

Port of \`inl_tool.py\`. The algorithm:

1. **Histogram** raw ADC samples into \`2^adcRes\` bins
2. **Find \`intMinbin\` / \`intMaxbin\`**: first/last bin with ≥ \`minSizeBin\` samples — defines the reachable code range
3. **Truncation search**: within ±\`avoidanceRadius\` codes of each rail, find the peak of the U-shaped PDF — this is the truncation boundary (\`intTruncLow\` / \`intTruncHigh\`). The saturation peak inflates those bins; truncating there avoids bias
4. **PDF / CDF / cos(CDF)**: normalize histogram → cumulative → apply \`cos(π·CDF)\` to linearize the sine-wave distribution
5. **DNL**: \`−d(cosCdf)/codeSizeOverAmp − 1\` over the active zone; zero-padded outside
6. **INL**: cumulative sum of the linearized CDF, referenced to the truncation boundary; zero-padded outside
7. **3rd-order polynomial fit** to INL for smooth trend extraction and p2p metric

**Key insight**: the cos(CDF) transform converts the sine-wave PDF into a locally-linear function; its derivative directly gives the code-width deviation (DNL), and its integral gives the accumulated offset (INL).

---

## Inputs

| Parameter | Key | Type | Default | Description |
|---|---|---|---|---|
| Sample Column | \`sampleColumn\` | column-select | *(auto)* | CSV column with raw ADC codes or voltages |
| Input Mode | \`inputMode\` | options | \`codes\` | \`codes\` = integer codes; \`voltage\` = normalise via min/max range |
| Min Code | \`minCode\` | number | \`0\` | Theoretical minimum code (or minimum voltage in \`voltage\` mode) |
| Max Code | \`maxCode\` | number | \`2047\` | Theoretical maximum code — ADC resolution derived as \`⌈log₂(max−min+1)⌉\` |
| Avoidance Radius | \`avoidanceRadius\` | number | \`40\` | Search window (codes) around each rail for the U-shape saturation peak |
| Min Bin Size | \`minSizeBin\` | number | \`2\` | Minimum sample count for a code to count as reachable |
| Missing Threshold | \`missingThreshold\` | number | \`-0.9\` | DNL below this value is flagged as a missing code |

**Scope**: all parameters are global (shared across all files in a batch). \`sampleColumn\` is a \`column-select\` with \`defaultScope: 'global'\` — auto-seeded to the column with the most unique values when files are loaded.

---

## Outputs (CSV row per file)

| Column | Description |
|---|---|
| \`filename\` | Source file name |
| \`inl_codes_p2p\` | INL peak-to-peak from 3rd-order polynomial fit (LSB) |
| \`inl_max\` | Maximum INL (LSB) |
| \`code_inl_max\` | ADC code at maximum INL |
| \`inl_min\` | Minimum INL (LSB) |
| \`code_inl_min\` | ADC code at minimum INL |
| \`missing_codes_threshold\` | Threshold used for missing code detection |
| \`missing_codes_count\` | Number of codes where DNL < threshold |
| \`dnl_max\` | Maximum DNL (LSB) |
| \`code_dnl_max\` | ADC code at maximum DNL |
| \`dnl_min\` | Minimum DNL (LSB) |
| \`code_dnl_min\` | ADC code at minimum DNL |
| \`dnl_rms\` | RMS DNL across active code range (LSB) |
| \`code_min\` | First reachable code (intMinbin) |
| \`code_max\` | Last reachable code (intMaxbin) |
| \`code_trunclow\` | Truncation boundary — low end |
| \`code_trunchigh\` | Truncation boundary — high end |
| \`lsb_codes_over_code_amp\` | Internal scale factor (codeSizeOverAmp) — diagnostic |

---

## Figures (per file, interactive)

All figures are **Recharts** React components. Opened via the **Plot** button in the file table.

### 1. PDF — Probability Density Function

Shows the sine-wave U-shaped PDF histogram across all codes.

**Annotations**:
- 🟡 Shaded zone: peak-search window around \`codeMin\` (low rail)
- 🟣 Shaded zone: peak-search window around \`codeMax\` (high rail)
- Gray dashed: \`minbin\` and \`maxbin\` boundary lines
- Gray dashed: \`+r\` / \`−r\` radius markers (edge of avoidance window)
- Red solid: \`trunclow\` and \`trunchigh\` — final truncation boundaries

**Layout note**: all label offsets use \`PDF_CHART_H * fraction\` expressions (not magic px numbers) so label placement scales proportionally if the chart height changes.

### 2. DNL — Differential Nonlinearity per code

Line plot of DNL [LSB] vs code index over the active range (outside truncation zone shown as null, not plotted).

**Annotations**:
- \`y=0\` reference line
- Red dashed: minimum DNL with code label
- Green dashed: maximum DNL with code label

Y-axis domain computed from finite data (immune to stale singulars).

### 3. INL + 3rd-order polynomial

Line plot of measured INL [LSB] vs code index, with the 3rd-order polynomial fit overlay.

**Annotations**:
- \`y=0\` reference line
- Red dashed: minimum INL
- Green dashed: maximum INL
- Amber dashed: polynomial overlay (legend: "3rd-order poly")

Polynomial is **restricted to the active code range** — no extrapolation blowup outside the truncation zone.

---

## Debug Tables (downloadable)

| Table | Contents |
|---|---|
| \`inl_dnl_series\` | Per-code series: \`code\`, \`pdf\`, \`cdf\`, \`cos_cdf\`, \`dnl\`, \`inl\`, \`inl_polynomial\` |

Download via the **Debug** button in the file table → CSV or JSON.

---

## Error Handling

| Condition | Error thrown |
|---|---|
| File has fewer than 2 lines | \`File has fewer than 2 lines.\` |
| Column not found | \`Column "X" not found. Available: ...\` |
| No numeric samples | \`No numeric samples found in the specified column.\` |

Errors surface per-file in the pipeline status column — other files in the batch continue processing.

---

## Cohabitation Notes (running alongside SMEAS)

- \`sampleColumn\` uses key \`sampleColumn\` — distinct from SMEAS's \`targetColumn\`. No conflict.
- Output keys (\`inl_max\`, \`dnl_max\`, etc.) are all SINL-specific — no overlap with SMEAS outputs.
- Both plugins can be active simultaneously; results are merged into one CSV row per file.

---

## Python Twin

| Field | Value |
|---|---|
| \`pythonModule\` | \`sinl_tool\` |
| \`pythonFunction\` | \`run_sinl\` |

When the platform's "Export as Python script" feature is available, it will generate:

\`\`\`python
# Auto-generated by image_site
from sinl_tool import run_sinl
import pandas as pd, glob

params = dict(
    sample_column='ADC sample [LSB]',
    input_mode='codes',
    min_code=0,
    max_code=2047,
    avoidance_radius=40,
    min_size_bin=2,
    missing_threshold=-0.9,
)

rows = [run_sinl(pd.read_csv(f), **params) for f in glob.glob('data/*.csv')]
pd.DataFrame(rows).to_csv('results.csv', index=False)
\`\`\`

---

## File

\`app/components/plugins/sinlPlugin.tsx\` — fully self-contained (~800 lines):  
Algorithm + CSV parsing + Recharts figures + manifest + plugin export. No external dependencies beyond \`recharts\`.

`;
export default doc;
