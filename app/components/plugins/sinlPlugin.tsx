/**
 * sinlPlugin.tsx — SINL (Sine INL/DNL) Analysis Pipeline Plugin
 *
 * Complete, self-contained plugin including:
 *   1. Okawara-T sine-histogram INL/DNL algorithm
 *   2. CSV file parsing with voltage normalization
 *   3. Recharts visualization components (PDF, DNL, INL)
 *   4. Plugin manifest and parameter handling
 *
 * Algorithm Reference: Okawara's paper on ADC sine-wave testing (Equations 27-29)
 * Ported from: inl_tool.py (Python reference implementation)
 */

import { Plugin, PluginManifest, PluginFigure, PluginDebugTable } from '../../lib/pluginTypes';
import sinlDoc from './sinlPlugin.doc';
import { ingestFile } from '../../lib/ingest';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceLine, ReferenceArea, ResponsiveContainer,
} from 'recharts';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Per-code results table — equivalent to Python pd_results */
export interface InlResults {
  method: 'okawara_t';
  codes: number[];
  pdf: number[];
  cdf: number[];
  cosCdf: number[];
  dnl: number[];
  inl: number[];
  inlPolynomial: number[];
  _intMinbin: number;
  _intMaxbin: number;
  _intTruncLow: number;
  _intTruncHigh: number;
  _codeSizeOverAmp: number;
  _binsAvoidanceRadius: number;
  _avoidedBinLow: number;
  _avoidedBinHigh: number;
}

/** Scalar summary — equivalent to Python pd_singulars */
export interface InlSingulars {
  codeMin: number;
  codeMax: number;
  codeTruncLow: number;
  codeTruncHigh: number;
  lsbCodesOverCodeAmp: number;
  inlCodesP2p: number;
  inlMax: number;
  codeInlMax: number;
  inlMin: number;
  codeInlMin: number;
  missingCodesThreshold: number;
  missingCodesCount: number;
  dnlMax: number;
  codeDnlMax: number;
  dnlMin: number;
  codeDnlMin: number;
  dnlRms: number;
}

export interface InlToolOutput {
  singulars: InlSingulars;
  results: InlResults;
}

export interface SinlFigureData {
  results: InlResults;
  singulars: InlSingulars;
  fileName: string;
  adcRes: number;
  minCode: number;
  maxCode: number;
  /** Whether samples were voltages — drives axis/label display in figures. */
  inputMode: 'codes' | 'voltage';
}

export interface SinlParams {
  sampleColumn: string;
  avoidanceRadius: number;
  minSizeBin: number;
  missingThreshold: number;
  inputMode: 'codes' | 'voltage';
  minCode: number;
  maxCode: number;
}

export interface SinlInference {
  adcBits?: number;
  minCode?: number;
  maxCode?: number;
  inputMode?: 'codes' | 'voltage';

  sampleColumn?: string;

  source: {
    adcBits?: 'metadata' | 'filename' | 'default';
    minCode?: 'metadata' | 'filename' | 'default';
    maxCode?: 'metadata' | 'filename' | 'default';
    inputMode?: 'metadata' | 'filename' | 'default';
  };
}

// ─── Helpers (numpy equivalents) ──────────────────────────────────────────────

/** Build integer histogram over bins [0, 1, …, numBins-1].
 *  bins = range(0, 2^adcRes + 1) → numBins = 2^adcRes buckets */
function histogram(samples: number[], numBins: number): number[] {
  const hist = new Array<number>(numBins).fill(0);
  for (const s of samples) {
    const idx = Math.round(s);
    if (idx >= 0 && idx < numBins) hist[idx]++;
  }
  return hist;
}

/** Element-wise cumulative sum */
function cumsum(arr: number[]): number[] {
  const out = new Array<number>(arr.length);
  let acc = 0;
  for (let i = 0; i < arr.length; i++) { acc += arr[i]; out[i] = acc; }
  return out;
}

/** Element-wise diff (length n-1) */
function diff(arr: number[]): number[] {
  const out = new Array<number>(arr.length - 1);
  for (let i = 0; i < out.length; i++) out[i] = arr[i + 1] - arr[i];
  return out;
}

/** Least-squares polynomial fit, degree 3.
 *  Returns coefficients [a3, a2, a1, a0] (highest degree first, like numpy).
 *  Filters non-finite pairs before solving. */
function polyfit3(x: number[], y: number[]): [number, number, number, number] {
  const xf: number[] = [], yf: number[] = [];
  for (let i = 0; i < x.length; i++) {
    if (isFinite(x[i]) && isFinite(y[i])) { xf.push(x[i]); yf.push(y[i]); }
  }
  const n = xf.length;
  if (n < 4) return [0, 0, 0, 0];

  const deg = 3;
  const cols = deg + 1;
  const S = new Array<number>(2 * deg + 1).fill(0);
  for (const xi of xf) {
    let xpow = 1;
    for (let k = 0; k <= 2 * deg; k++) { S[k] += xpow; xpow *= xi; }
  }
  const M: number[][] = Array.from({ length: cols }, (_, i) =>
    Array.from({ length: cols }, (__, j) => S[2 * deg - i - j])
  );
  const b: number[] = Array.from({ length: cols }, (_, i) => {
    let s = 0;
    for (let k = 0; k < n; k++) {
      let xpow = 1;
      for (let p = 0; p < deg - i; p++) xpow *= xf[k];
      s += xpow * yf[k];
    }
    return s;
  });
  const aug = M.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < cols; col++) {
    let maxRow = col;
    for (let row = col + 1; row < cols; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-15) continue;
    for (let row = 0; row < cols; row++) {
      if (row === col) continue;
      const factor = aug[row][col] / pivot;
      for (let k = col; k <= cols; k++) aug[row][k] -= factor * aug[col][k];
    }
  }
  const coeff = aug.map((row, i) => row[cols] / row[i]) as [number, number, number, number];
  return coeff;
}

/** Evaluate degree-3 polynomial at each x: c[0]*x^3 + c[1]*x^2 + c[2]*x + c[3] */
function polyval3(coeff: [number, number, number, number], x: number[]): number[] {
  return x.map(xi => coeff[0] * xi ** 3 + coeff[1] * xi ** 2 + coeff[2] * xi + coeff[3]);
}

// ─── Volt-display helpers ─────────────────────────────────────────────────────

/**
 * Build a code→volt converter for voltage-mode figures.
 * When inputMode='codes', returns identity (just the code number as string).
 */
function makeCodeToVolt(
  inputMode: 'codes' | 'voltage',
  minCode: number,
  maxCode: number,
  numCodes: number,
): (code: number) => number {
  if (inputMode !== 'voltage') return (c) => c;
  return (c) => minCode + (c / (numCodes - 1)) * (maxCode - minCode);
}

/** Format a single axis / label value in the correct unit. */
function fmtX(
  inputMode: 'codes' | 'voltage',
  codeToVolt: (c: number) => number,
  code: number,
  decimals = 4,
): string {
  if (inputMode !== 'voltage') return String(Math.round(code));
  const v = codeToVolt(code);
  return `${v.toFixed(decimals)}V`;
}

// ─── Core Algorithm ────────────────────────────────────────────────────────────

/** Okawara-T: Truncated sine-histogram INL/DNL estimator */
function okawaraT(
  adcSamples: number[],
  adcRes = 11,
  binsAvoidanceRadius = 40,
  minSizeBin = 2,
): InlResults {
  const numCodes = 2 ** adcRes;

  const hist = histogram(adcSamples, numCodes);
  const totalSamples = hist.reduce((a, b) => a + b, 0);

  let intMinbin = 0;
  let avoidedBinLow = -1;
  for (let i = 0; i < hist.length; i++) {
    if (hist[i] >= minSizeBin) { intMinbin = i; break; }
    if (hist[i] > 0 && avoidedBinLow === -1) avoidedBinLow = i;
  }
  let intMaxbin = hist.length - 1;
  let avoidedBinHigh = -1;
  for (let i = hist.length - 1; i > 0; i--) {
    if (hist[i] >= minSizeBin) { intMaxbin = i; break; }
    if (hist[i] > 0 && avoidedBinHigh === -1) avoidedBinHigh = i;
  }

  let intTruncLow = intMinbin;
  {
    let maxVal = -Infinity;
    const lo = intMinbin, hi = Math.min(intMinbin + binsAvoidanceRadius, hist.length - 1);
    for (let i = lo; i <= hi; i++) {
      if (hist[i] > maxVal) { maxVal = hist[i]; intTruncLow = i; }
    }
  }
  let intTruncHigh = intMaxbin;
  {
    let maxVal = -Infinity;
    const lo = Math.max(intMaxbin - binsAvoidanceRadius, 0), hi = intMaxbin;
    for (let i = lo; i <= hi; i++) {
      if (hist[i] > maxVal) { maxVal = hist[i]; intTruncHigh = i; }
    }
  }
  const intTruncBins = intTruncHigh - intTruncLow + 1;

  const pdf = hist.map(h => h / totalSamples);
  const cdf = cumsum(pdf);
  const cosCdf = cdf.map(c => Math.cos(Math.PI * c));

  let sumLow = 0;
  for (let i = intMinbin; i <= intTruncLow; i++) sumLow += pdf[i];
  const C1 = Math.cos(Math.PI * sumLow);

  let sumHigh = 0;
  for (let i = 0; i < intTruncHigh; i++) sumHigh += pdf[i];
  const C2 = Math.cos(Math.PI * sumHigh);

  const codeSizeOverAmp = (C1 - C2) / intTruncBins;

  const dnl = new Array<number>(numCodes).fill(NaN);
  {
    const sliceCos = cosCdf.slice(intTruncLow, intTruncHigh);
    const d = diff(sliceCos);
    for (let i = 0; i < d.length; i++) {
      dnl[intTruncLow + i] = -d[i] / codeSizeOverAmp - 1;
    }
  }

  const inl = new Array<number>(numCodes).fill(NaN);
  {
    const baseSum = sumLow;
    const inner = pdf.slice(intTruncLow + 1, intTruncHigh);
    const innerCumsum = cumsum(inner);
    for (let i = 0; i < innerCumsum.length; i++) {
      const cosTerm = Math.cos(Math.PI * (baseSum + innerCumsum[i]));
      inl[intTruncLow + 1 + i] = (C1 - cosTerm) / codeSizeOverAmp - (i + 1);
    }
  }

  for (let i = 0; i < intTruncLow; i++) dnl[i] = 0;
  for (let i = intTruncHigh; i < numCodes; i++) dnl[i] = 0;
  for (let i = 0; i < intTruncLow; i++) inl[i] = 0;
  for (let i = intTruncHigh; i < numCodes; i++) inl[i] = 0;

  const codes = Array.from({ length: numCodes }, (_, i) => i);
  const polyCoeff = polyfit3(codes, inl);
  const inlPolynomial = polyval3(polyCoeff, codes);

  return {
    method: 'okawara_t',
    codes,
    pdf,
    cdf,
    cosCdf,
    dnl,
    inl,
    inlPolynomial,
    _intMinbin: intMinbin,
    _intMaxbin: intMaxbin,
    _intTruncLow: intTruncLow,
    _intTruncHigh: intTruncHigh,
    _codeSizeOverAmp: codeSizeOverAmp,
    _binsAvoidanceRadius: binsAvoidanceRadius,
    _avoidedBinLow: avoidedBinLow,
    _avoidedBinHigh: avoidedBinHigh,
  };
}

/** Analyze: Compute scalar summary metrics from okawaraT results */
function analyze(
  results: InlResults,
  missingCodeThreshold = -0.9,
): InlSingulars {
  const { codes, inl, dnl, inlPolynomial, _intTruncLow, _intTruncHigh } = results;

  let polyMax = -Infinity, polyMin = Infinity;
  for (let i = _intTruncLow; i <= _intTruncHigh; i++) {
    const v = inlPolynomial[i];
    if (isFinite(v)) {
      if (v > polyMax) polyMax = v;
      if (v < polyMin) polyMin = v;
    }
  }
  const inlP2p = polyMax - polyMin;

  let inlMax = -Infinity, inlMin = Infinity;
  let codeInlMax = 0, codeInlMin = 0;
  for (let i = 0; i < inl.length; i++) {
    if (isFinite(inl[i])) {
      if (inl[i] > inlMax) { inlMax = inl[i]; codeInlMax = codes[i]; }
      if (inl[i] < inlMin) { inlMin = inl[i]; codeInlMin = codes[i]; }
    }
  }

  let dnlMax = -Infinity, dnlMin = Infinity;
  let codeDnlMax = 0, codeDnlMin = 0;
  let missingCodesCount = 0;
  let dnlSumSq = 0, dnlCount = 0;

  for (let i = 0; i < dnl.length; i++) {
    if (isFinite(dnl[i])) {
      if (dnl[i] > dnlMax) { dnlMax = dnl[i]; codeDnlMax = codes[i]; }
      if (dnl[i] < dnlMin) { dnlMin = dnl[i]; codeDnlMin = codes[i]; }
      if (dnl[i] < missingCodeThreshold) missingCodesCount++;
      dnlSumSq += dnl[i] ** 2;
      dnlCount++;
    }
  }
  const dnlRms = dnlCount > 0 ? Math.sqrt(dnlSumSq / dnlCount) : 0;

  return {
    codeMin: results._intMinbin,
    codeMax: results._intMaxbin,
    codeTruncLow: results._intTruncLow,
    codeTruncHigh: results._intTruncHigh,
    lsbCodesOverCodeAmp: results._codeSizeOverAmp,
    inlCodesP2p: inlP2p,
    inlMax,
    codeInlMax,
    inlMin,
    codeInlMin,
    missingCodesThreshold: missingCodeThreshold,
    missingCodesCount,
    dnlMax,
    codeDnlMax,
    dnlMin,
    codeDnlMin,
    dnlRms,
  };
}

/** Run INL tool: calls okawaraT then analyze */
function runInlTool(
  adcSamples: number[],
  adcRes = 11,
  binsAvoidanceRadius = 40,
  minSizeBin = 2,
  missingCodeThreshold = -0.9,
): InlToolOutput {
  const results = okawaraT(adcSamples, adcRes, binsAvoidanceRadius, minSizeBin);
  const singulars = analyze(results, missingCodeThreshold);
  return { singulars, results };
}

// ─── Plugin Helpers ──────────────────────────────────────────────────────────

function normalizeKey(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Derive adcRes from the full-scale code range */
function deriveAdcRes(minCode: number, maxCode: number): number {
  const mn = Number(minCode) || 0;
  const mx = Number(maxCode) || 2047;
  const range = mx - mn + 1;
  return Math.max(1, Math.ceil(Math.log2(Math.max(range, 2))));
}

/** Convert raw waveform samples to integer ADC codes using inputMode/voltage normalisation. */
function samplesToCodes(
  raw: ArrayLike<number>,
  inputMode: 'codes' | 'voltage',
  minCode: number,
  maxCode: number,
  voltageAdcBits = 10,    // resolution to use when mapping voltages → codes
): number[] {
  const numCodes = inputMode === 'voltage'
    ? Math.pow(2, voltageAdcBits)
    : Math.pow(2, deriveAdcRes(Math.round(minCode), Math.round(maxCode)));
  const codes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (isNaN(v)) continue;
    codes.push(inputMode === 'voltage'
      ? Math.round((v - minCode) / (maxCode - minCode) * (numCodes - 1))
      : Math.round(v));
  }
  if (codes.length === 0) throw new Error('No numeric samples found in the specified column.');
  return codes;
}

/** Ingest a File and convert to ADC codes — replaces the old parseSamples. */
async function ingestSamples(file: File, params: SinlParams): Promise<number[]> {
  const minCode = Math.round(Number(params.minCode) ?? 0);
  const maxCode = Math.round(Number(params.maxCode) ?? 2047);
  const packet  = await ingestFile(file, { signalColumn: params.sampleColumn?.trim() || undefined });
  return samplesToCodes(packet.waveform, params.inputMode, minCode, maxCode);
}

/**
 * Auto-seed sinl params from WaveformPacket metadata.
 * If metadata.units === 'volts' and inputMode is still the default 'codes',
 * switch to 'voltage' and seed minCode/maxCode from the actual sample range.
 * The effective ADC resolution is fixed at 10-bit (1024 codes) for voltage mode
 * so the histogram has enough bins to be meaningful.
 */
function sinlAutoSeedFromPacket(
  params: SinlParams,
  packet: import('../../lib/ingest').WaveformPacket,
): SinlParams {
  if (packet.metadata.units !== 'volts') return params;
  if (params.inputMode !== 'codes') return params; // user already chose

  // Compute min/max from the actual samples
  let mn = Infinity, mx = -Infinity;
  for (const v of packet.waveform) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (!isFinite(mn) || !isFinite(mx)) return params;

  // Add a small margin so the extreme codes are not at the absolute boundary
  const margin = (mx - mn) * 0.02;
  return {
    ...params,
    inputMode: 'voltage',
    minCode:   mn - margin,
    maxCode:   mx + margin,
  };
}

const manifest: PluginManifest = {
  id: 'sinl',
  name: 'SINL — Sine INL/DNL',
  description: 'Sine-histogram INL/DNL for clipped (saturated) sine waves — not for ENOB.',
  version: '1.0.0',
  author: 'Guy Steiff',
  authorEmail: 'guy.steiff-sinlsuppport@bytz.me',
  github: '',
  linkedin: 'https://www.linkedin.com/in/guysteiff/',
  website: '',
  pythonModule: 'sinl_tool',
  pythonFunction: 'run_sinl',
  reportTitle: 'Sine INL/DNL Analysis (Okawara-T)',
  category: 'signal',
  paramSchema: [
    { key: 'sampleColumn',    label: 'Sample Column',         type: 'column-select', required: true,  description: 'CSV column containing raw ADC codes or voltages.' },
    { key: 'inputMode',       label: 'Input Mode',            type: 'text',   required: false, description: '"codes" (default) or "voltage" — if voltage, min/max code are used to normalise.' },
    { key: 'minCode',         label: 'Min code / voltage',    type: 'number', required: false, description: 'Theoretical minimum code (default 0) or minimum voltage.' },
    { key: 'maxCode',         label: 'Max code / voltage',    type: 'number', required: true,  description: 'Theoretical maximum code (e.g. 2047 for 11-bit) or maximum voltage.' },
    { key: 'avoidanceRadius', label: 'Avoidance Radius',      type: 'number', required: false, description: 'Peak search radius for truncation (default 40).' },
    { key: 'minSizeBin',      label: 'Min Bin Size',          type: 'number', required: false, description: 'Min samples for a code to count as reachable (default 2).' },
    { key: 'missingThreshold',label: 'Missing Code Threshold',type: 'number', required: false, description: 'DNL threshold below which a code is missing (default -0.9).' },
  ],
};



// ── Recharts interactive figure components ────────────────────────────────────

const CHART_COLORS = {
  line:   '#6366F1',
  poly:   '#F59E0B',
  marker: '#EF4444',
  grid:   '#1F2937',
  text:   '#9CA3AF',
  zoneLow:  'rgba(251,191,36,0.12)',
  zoneHigh: 'rgba(99,102,241,0.12)',
};

/** Custom tooltip styled for dark theme */
function DarkTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-gray-800 border border-gray-600 rounded px-3 py-2 text-xs shadow-xl">
      <p className="text-gray-400 mb-1">code: <span className="text-white font-mono">{label}</span></p>
      {payload.map((p: any) => (
        <p key={p.dataKey} style={{ color: p.color }}>
          {p.name}: <span className="font-mono">{typeof p.value === 'number' ? p.value.toFixed(5) : p.value}</span>
        </p>
      ))}
    </div>
  );
}

// ── PDF figure component ──────────────────────────────────────────────────────

// PROBLEM — magic pixel offset for rotated reference-line labels:
//   Recharts' ReferenceLine `label.offset` is always in SVG pixels relative to
//   the `position` anchor (e.g. 'insideTop' = pixels downward from the chart top
//   edge).  It has NO awareness of data coordinates — the x data value is
//   completely irrelevant to vertical label placement.
//
//   We cannot express it as "1% of the x value" because the two things live in
//   orthogonal spaces: x is a data coordinate, offset is a layout pixel.
//
// SOLUTION — tie the offset to the chart height constant instead:
//   PDF_CHART_H is the single source of truth for the chart's pixel height.
//   All label offsets are expressed as inline fractions of it:
//     * 0.07 × h ≈ 25 px  — insideTop rotated labels (down from top edge)
//     * 0.04 × h ≈ 15 px  — insideBottom / insideLeft nudge labels
//   This makes each offset self-documenting at the call site: the fraction
//   shows intent, the constant ties it to the chart size, and if PDF_CHART_H
//   ever changes every label moves proportionally.
const PDF_CHART_H = 380;

/**
 * Apply FigureViewer zoom (__xC/__yC/__zoom) to a [fullMin, fullMax] data range.
 */
function applyZoomDomain(
  fullMin: number, fullMax: number,
  controls: Record<string, any>,
  axis: 'x' | 'y',
): [number, number] {
  const zoom = axis === 'x'
    ? ((controls.__zoom  as number) ?? 1)
    : ((controls.__yZoom as number) ?? 1);
  if (zoom <= 1) return [fullMin, fullMax];
  const span = fullMax - fullMin;
  const hw   = span / (2 * zoom);
  const cFrac = axis === 'x' ? ((controls.__xC as number) ?? 0.5) : ((controls.__yC as number) ?? 0.5);
  const center = fullMin + cFrac * span;
  return [Math.max(fullMin, center - hw), Math.min(fullMax, center + hw)];
}

/** Filter sorted points array to the visible x window (with 1-point margin each side). */
function filterToWindow<T extends { code: number }>(arr: T[], xMin: number, xMax: number): T[] {
  if (arr.length === 0) return arr;
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].code < xMin) lo = mid + 1; else hi = mid; }
  const start = Math.max(0, lo - 1);
  let end = start;
  while (end < arr.length && arr[end].code <= xMax) end++;
  end = Math.min(arr.length - 1, end);
  return arr.slice(start, end + 1);
}

function PdfFigure({ data, controls }: { data: unknown; controls: Record<string, any> }) {
  const { results: r, singulars: s, adcRes, inputMode, minCode, maxCode } = data as SinlFigureData;
  const isVolt = inputMode === 'voltage';
  const avoidR = r._binsAvoidanceRadius;
  const numCodes = Math.pow(2, adcRes);
  const xMax = numCodes - 1;
  const c2v = makeCodeToVolt(inputMode, minCode, maxCode, numCodes);
  const fx = (c: number) => fmtX(inputMode, c2v, c, 3);

  const points = r.codes.map((c: number, i: number) => ({ code: c, pdf: r.pdf[i] ?? 0 }));
  const xLabel = isVolt ? 'voltage (V)' : 'code';
  const minLabel = isVolt ? c2v(s.codeMin).toFixed(3) + 'V' : String(s.codeMin);
  const maxLabel = isVolt ? c2v(s.codeMax).toFixed(3) + 'V' : String(s.codeMax);

  return (
    <div className="w-full bg-gray-900 rounded-lg p-4">
      <div className="text-sm text-gray-300 font-semibold mb-3 text-center">
        PDF vs {isVolt ? 'Voltage' : 'Codes'} <span className="text-gray-500 font-normal ml-2">min={minLabel} max={maxLabel}</span>
      </div>
      <ResponsiveContainer width="100%" height={PDF_CHART_H}>
        <LineChart data={filterToWindow(points, (applyZoomDomain(0, xMax, controls, 'x')[0]), (applyZoomDomain(0, xMax, controls, 'x')[1]))} margin={{ top: 10, right: 30, left: 10, bottom: 30 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
          <XAxis dataKey="code" stroke={CHART_COLORS.text} tick={{ fill: CHART_COLORS.text, fontSize: 11 }}
            label={{ value: xLabel, position: 'insideBottom', offset: -15, fill: CHART_COLORS.text, fontSize: 12 }}
            domain={applyZoomDomain(0, xMax, controls, 'x')} type="number"
            tickFormatter={isVolt ? (c: number) => c2v(c).toFixed(3) : undefined} />
          <YAxis stroke={CHART_COLORS.text} tick={{ fill: CHART_COLORS.text, fontSize: 11 }}
            label={{ value: 'PDF [probability]', angle: -90, position: 'insideLeft', offset: 10, fill: CHART_COLORS.text, fontSize: 12 }} />
          <Tooltip content={<DarkTooltip />} labelFormatter={isVolt ? ((c: any) => `${c2v(c).toFixed(4)}V`) as any : undefined} />
          {/* Search zone shading */}
          <ReferenceArea x1={s.codeMin} x2={s.codeMin + avoidR} fill={CHART_COLORS.zoneLow} label={{ value: 'peak search', angle: +90, fill: '#FCD34D', fontSize: 12, position: 'top', offset: -Math.round(PDF_CHART_H * 0.09) }} />
          <ReferenceArea x1={s.codeMax - avoidR} x2={s.codeMax} fill={CHART_COLORS.zoneHigh} label={{ value: 'peak search', angle: +90, fill: '#A5B4FC', fontSize: 12, position: 'top', offset: -Math.round(PDF_CHART_H * 0.09) }} />
          {/* Boundary vertical lines */}
          <ReferenceLine x={s.codeMin}      stroke="#6B7280" strokeDasharray="4 4" label={{ value: `minbin(${fx(s.codeMin)})`, angle: 0, fill: '#9CA3AF', fontSize: 12, position: 'insideBottom', offset: -Math.round(PDF_CHART_H * 0.04) }} />
          <ReferenceLine x={s.codeMin + avoidR} stroke="#6B7280" strokeDasharray="4 4" label={{ value: `+r(${avoidR})`, angle: -90, fill: '#9CA3AF', fontSize: 12, position: 'insideTop', offset: Math.round(PDF_CHART_H * 0.08) }} />
          <ReferenceLine x={s.codeMax - avoidR} stroke="#6B7280" strokeDasharray="4 4" label={{ value: `-r(${avoidR})`, angle: -90, fill: '#9CA3AF', fontSize: 12, position: 'insideTopRight', offset: Math.round(PDF_CHART_H * 0.04) }} />
          <ReferenceLine x={s.codeMax}      stroke="#6B7280" strokeDasharray="4 4" label={{ value: `maxbin(${fx(s.codeMax)})`, angle: 0, fill: '#9CA3AF', fontSize: 12, position: 'insideBottom', offset: -Math.round(PDF_CHART_H * 0.04) }} />
          {/* Truncation boundaries */}
          <ReferenceLine x={s.codeTruncLow}  stroke="#EF4444" strokeWidth={1.5} label={{ value: `trunclow(${fx(s.codeTruncLow)})`, angle: -90,  fill: '#EF4444', fontSize: 12, position: 'insideLeft', offset: -Math.round(PDF_CHART_H * 0.04) }} />
          <ReferenceLine x={s.codeTruncHigh} stroke="#EF4444" strokeWidth={1.5} label={{ value: `trunchigh(${fx(s.codeTruncHigh)})`, angle: -90, fill: '#EF4444', fontSize: 12, position: 'insideLeft',  offset: +Math.round(PDF_CHART_H * 0.04) }} />
          <Line type="monotone" dataKey="pdf" dot={false} stroke={CHART_COLORS.line} strokeWidth={1.5} name="PDF" isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── DNL figure component ──────────────────────────────────────────────────────
function DnlFigure({ data, controls }: { data: unknown; controls: Record<string, any> }) {
  const { results: r, singulars: s, adcRes, inputMode, minCode, maxCode } = data as SinlFigureData;
  const isVolt = inputMode === 'voltage';
  const numCodes = Math.pow(2, adcRes);
  const xMax = numCodes - 1;
  const c2v = makeCodeToVolt(inputMode, minCode, maxCode, numCodes);
  const fx = (c: number) => fmtX(inputMode, c2v, c, 3);

  // Compute yMin/yMax directly from the finite data — immune to stale/corrupt singulars.
  const finiteDnl = r.codes.map((_, i) => r.dnl[i]).filter(v => isFinite(v));
  const dataMin = finiteDnl.length > 0 ? Math.min(...finiteDnl) : -1;
  const dataMax = finiteDnl.length > 0 ? Math.max(...finiteDnl) : 1;
  const yPad = Math.max((dataMax - dataMin) * 0.15, 0.2);
  const yMin = dataMin - yPad;
  const yMax = dataMax + yPad;

  const points = r.codes
    .map((c: number, i: number) => {
      const v = r.dnl[i];
      return { code: c, dnl: (isFinite(v) && v >= yMin && v <= yMax) ? v : null };
    })
    .filter(p => p.dnl !== null);

  return (
    <div className="w-full bg-gray-900 rounded-lg p-4">
      <div className="text-sm text-gray-300 font-semibold mb-1 text-center">
        DNL <span className="text-green-400">+{s.dnlMax.toFixed(2)}</span> / <span className="text-red-400">{s.dnlMin.toFixed(2)}</span> LSB
        <span className="text-gray-500 font-normal ml-2">({s.missingCodesCount} missing codes)</span>
      </div>
      <ResponsiveContainer width="100%" height={380}>
        <LineChart data={filterToWindow(points, (applyZoomDomain(0, xMax, controls, 'x')[0]), (applyZoomDomain(0, xMax, controls, 'x')[1]))} margin={{ top: 10, right: 30, left: 10, bottom: 30 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
          <XAxis dataKey="code" stroke={CHART_COLORS.text} tick={{ fill: CHART_COLORS.text, fontSize: 11 }}
            label={{ value: isVolt ? 'voltage (V)' : 'code', position: 'insideBottom', offset: -15, fill: CHART_COLORS.text, fontSize: 12 }}
            domain={applyZoomDomain(0, xMax, controls, 'x')} type="number"
            tickFormatter={isVolt ? (c: number) => c2v(c).toFixed(3) : undefined} />
          <YAxis stroke={CHART_COLORS.text} tick={{ fill: CHART_COLORS.text, fontSize: 11 }}
            label={{ value: 'DNL [LSB]', angle: -90, position: 'insideLeft', offset: 10, fill: CHART_COLORS.text, fontSize: 12 }}
            domain={applyZoomDomain(yMin, yMax, controls, 'y') as [number,number]} allowDataOverflow={true}
            tickFormatter={(v: number) => v.toFixed(2)} />
          <Tooltip content={<DarkTooltip />} labelFormatter={isVolt ? ((c: any) => `${c2v(c).toFixed(4)}V`) as any : undefined} />
          <ReferenceLine y={0} stroke="#4B5563" strokeWidth={1} />
          <ReferenceLine y={s.dnlMin} stroke={CHART_COLORS.marker} strokeDasharray="4 4"
            label={{ value: `min(${fx(s.codeDnlMin)}, ${s.dnlMin.toFixed(2)})`, fill: CHART_COLORS.marker, fontSize: 9, position: 'insideBottomRight' }} />
          <ReferenceLine y={s.dnlMax} stroke="#10B981" strokeDasharray="4 4"
            label={{ value: `max(${fx(s.codeDnlMax)}, ${s.dnlMax.toFixed(2)})`, fill: '#10B981', fontSize: 9, position: 'insideTopRight' }} />
          <Line type="monotone" dataKey="dnl" dot={false} stroke={CHART_COLORS.line} strokeWidth={1.5} name="DNL" isAnimationActive={false} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── INL + polynomial figure component ────────────────────────────────────────
function InlFigure({ data, controls }: { data: unknown; controls: Record<string, any> }) {
  const { results: r, singulars: s, adcRes, inputMode, minCode, maxCode } = data as SinlFigureData;
  const isVolt = inputMode === 'voltage';
  const numCodes = Math.pow(2, adcRes);
  const xMax = numCodes - 1;
  const c2v = makeCodeToVolt(inputMode, minCode, maxCode, numCodes);
  const fx = (c: number) => fmtX(inputMode, c2v, c, 3);
  const hasPoly = r.inlPolynomial && r.inlPolynomial.length === r.codes.length;

  // Compute yMin/yMax from the finite INL values only — immune to stale singulars
  // or polynomial extrapolation blow-up at non-active codes.
  const finiteInl = r.codes.map((_: number, i: number) => r.inl[i]).filter(v => isFinite(v));
  const dataMin = finiteInl.length > 0 ? Math.min(...finiteInl) : -1;
  const dataMax = finiteInl.length > 0 ? Math.max(...finiteInl) : 1;
  const yPad = Math.max((dataMax - dataMin) * 0.15, 0.5);
  const yMin = dataMin - yPad;
  const yMax = dataMax + yPad;

  // Clamp: null out any value outside the visible domain so Recharts never expands the axis.
  // Poly is additionally restricted to codes where measured INL is active (no extrapolation blow-up).
  const points = r.codes.map((c: number, i: number) => {
    const inlV = r.inl[i];
    const inlActive = isFinite(inlV);
    const inlClamped = (inlActive && inlV >= yMin && inlV <= yMax) ? inlV : null;
    const polyV = hasPoly ? r.inlPolynomial[i] : NaN;
    const polyClamped = (inlActive && isFinite(polyV) && polyV >= yMin && polyV <= yMax) ? polyV : null;
    return { code: c, inl: inlClamped, poly: polyClamped };
  }).filter(p => p.inl !== null || p.poly !== null);

  return (
    <div className="w-full bg-gray-900 rounded-lg p-4">
      <div className="text-sm text-gray-300 font-semibold mb-1 text-center">
        INL <span className="text-green-400">+{s.inlMax.toFixed(2)}</span> / <span className="text-red-400">{s.inlMin.toFixed(2)}</span> LSB
        <span className="text-gray-500 font-normal ml-2">poly p2p: {s.inlCodesP2p.toFixed(2)}</span>
      </div>
      <ResponsiveContainer width="100%" height={380}>
        <LineChart data={filterToWindow(points, (applyZoomDomain(0, xMax, controls, 'x')[0]), (applyZoomDomain(0, xMax, controls, 'x')[1]))} margin={{ top: 10, right: 30, left: 10, bottom: 30 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
          <XAxis dataKey="code" stroke={CHART_COLORS.text} tick={{ fill: CHART_COLORS.text, fontSize: 11 }}
            label={{ value: isVolt ? 'voltage (V)' : 'code', position: 'insideBottom', offset: -15, fill: CHART_COLORS.text, fontSize: 12 }}
            domain={applyZoomDomain(0, xMax, controls, 'x')} type="number"
            tickFormatter={isVolt ? (c: number) => c2v(c).toFixed(3) : undefined} />
          <YAxis stroke={CHART_COLORS.text} tick={{ fill: CHART_COLORS.text, fontSize: 11 }}
            label={{ value: 'INL [LSB]', angle: -90, position: 'insideLeft', offset: 10, fill: CHART_COLORS.text, fontSize: 12 }}
            domain={applyZoomDomain(yMin, yMax, controls, 'y') as [number,number]} allowDataOverflow={true}
            tickFormatter={(v: number) => v.toFixed(2)} />
          <Tooltip content={<DarkTooltip />} labelFormatter={isVolt ? ((c: any) => `${c2v(c).toFixed(4)}V`) as any : undefined} />
          <Legend wrapperStyle={{ color: CHART_COLORS.text, fontSize: 11 }} verticalAlign="top" height={5} />
          <ReferenceLine y={0} stroke="#4B5563" strokeWidth={1} />
          <ReferenceLine y={s.inlMin} stroke={CHART_COLORS.marker} strokeDasharray="4 4"
            label={{ value: `min(${fx(s.codeInlMin)}, ${s.inlMin.toFixed(2)})`, fill: CHART_COLORS.marker, fontSize: 9, position: 'insideBottomRight' }} />
          <ReferenceLine y={s.inlMax} stroke="#10B981" strokeDasharray="4 4"
            label={{ value: `max(${fx(s.codeInlMax)}, ${s.inlMax.toFixed(2)})`, fill: '#10B981', fontSize: 9, position: 'insideTopRight' }} />
          <Line type="monotone" dataKey="inl" dot={false} stroke={CHART_COLORS.line} strokeWidth={1.5} name="INL measured" isAnimationActive={false} connectNulls={false} />
          {hasPoly && (
            <Line type="monotone" dataKey="poly" dot={false} stroke={CHART_COLORS.poly} strokeWidth={1.5} strokeDasharray="6 3" name="3rd-order poly" isAnimationActive={false} connectNulls={false} />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Shared figure/debug-table preparation kernel — used by prepareData and prepareDataFromWaveform. */
function _sinlPrepareCore(
  samples: number[], adcRes: number, avoidanceRadius: number,
  minSizeBin: number, missingThreshold: number,
  fileName: string, minCode: number, maxCode: number,
  inputMode: 'codes' | 'voltage' = 'codes',
): { figureData: SinlFigureData; debugTables: PluginDebugTable[] } {
  const { results, singulars } = runInlTool(samples, adcRes, avoidanceRadius, minSizeBin, missingThreshold);
  const figureData: SinlFigureData = { results, singulars, fileName, adcRes, minCode, maxCode, inputMode };
  const nanToNull = (v: number) => (isFinite(v) ? v : null);
  const debugTables: PluginDebugTable[] = [{
    id: 'inl_dnl_series',
    label: 'INL / DNL per-code series',
    columns: {
      code:           results.codes,
      pdf:            results.pdf.map(nanToNull),
      cdf:            results.cdf.map(nanToNull),
      cos_cdf:        results.cosCdf.map(nanToNull),
      dnl:            results.dnl.map(nanToNull),
      inl:            results.inl.map(nanToNull),
      inl_polynomial: results.inlPolynomial.map(nanToNull),
    },
  }];
  return { figureData, debugTables };
}

const sinlFigures: PluginFigure[] = [
  { id: 'pdf', label: 'PDF',            component: PdfFigure },
  { id: 'dnl', label: 'DNL',            component: DnlFigure },
  { id: 'inl', label: 'INL + polynomial', component: InlFigure },
];


// ── Plugin ────────────────────────────────────────────────────────────────────
export const sinlPlugin: Plugin<SinlParams> = {
  id: 'sinl',
  name: 'SINL — Sine INL/DNL',
  description: manifest.description,
  manifest,
  doc: sinlDoc,

  defaultParams: {
    sampleColumn: '',
    avoidanceRadius: 40,
    minSizeBin: 2,
    missingThreshold: -0.9,
    inputMode: 'codes',
    minCode: 0,
    maxCode: 2047,
  },

  paramFields: [
    {
      key: 'sampleColumn',
      label: 'Sample Col',
      type: 'column-select' as const,
      required: true,
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: '',
      defaultScope: 'global' as const,
      title: 'CSV column containing raw ADC codes or voltages.',
      colorClass: 'text-purple-300',
    },
    {
      key: 'inputMode',
      label: 'Input Mode',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 'codes',
      options: ['codes', 'voltage'],
      title: '"codes": integer ADC codes. "voltage": normalised via min/max range.',
    },
    {
      key: 'minCode',
      label: 'Min code',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 0,
      min: -1e9,
      step: 1,
      title: 'Theoretical minimum code (or minimum voltage). Default 0.',
    },
    {
      key: 'maxCode',
      label: 'Max code',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 2047,
      required: true,
      min: 1,
      step: 1,
      title: 'Theoretical maximum code, e.g. 2047 for 11-bit ADC. ADC resolution is derived as ⌈log₂(max−min+1)⌉.',
    },
    {
      key: 'avoidanceRadius',
      label: 'Avoid. Radius',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 40,
      min: 0,
      max: 500,
      step: 1,
      title: 'Search window (in codes) around each rail for the U-shape peak. Default 40.',
    },
    {
      key: 'minSizeBin',
      label: 'Min Bin Size',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: 2,
      min: 1,
      step: 1,
      title: 'Minimum sample count for a code to count as reached. Default 2.',
    },
    {
      key: 'missingThreshold',
      label: 'Missing Thr.',
      defaultRegex: '',
      defaultReplace: '',
      defaultValue: -0.9,
      step: 0.1,
      title: 'DNL below this value is flagged as a missing code. Default −0.9 LSB.',
    },
  ],

  outputColumns: [
    'inl_codes_p2p', 'inl_max', 'code_inl_max', 'inl_min', 'code_inl_min',
    'missing_codes_threshold', 'missing_codes_count',
    'dnl_max', 'code_dnl_max', 'dnl_min', 'code_dnl_min', 'dnl_rms',
    'code_min', 'code_max', 'code_trunclow', 'code_trunchigh',
    'lsb_codes_over_code_amp',
  ],

  getIngestHints: (params: SinlParams) => ({
    signalColumn: params.sampleColumn?.trim() || undefined,
  }),

  run: async (file: File, params: SinlParams): Promise<Record<string, string | number>> => {
    const minCode          = Math.round(Number(params.minCode)          ?? 0);
    const maxCode          = Math.round(Number(params.maxCode)          ?? 2047);
    const avoidanceRadius  = Math.max(0, Math.round(Number(params.avoidanceRadius) ?? 40));
    const minSizeBin       = Math.max(1, Math.round(Number(params.minSizeBin)      ?? 2));
    const missingThreshold = Number(params.missingThreshold) ?? -0.9;
    const adcRes           = deriveAdcRes(minCode, maxCode);
    const samples          = await ingestSamples(file, params);
    const { singulars }    = runInlTool(samples, adcRes, avoidanceRadius, minSizeBin, missingThreshold);
    return {
      filename: file.name,
      inl_codes_p2p:           +singulars.inlCodesP2p.toFixed(4),
      inl_max:                 +singulars.inlMax.toFixed(4),
      code_inl_max:            singulars.codeInlMax,
      inl_min:                 +singulars.inlMin.toFixed(4),
      code_inl_min:            singulars.codeInlMin,
      missing_codes_threshold: singulars.missingCodesThreshold,
      missing_codes_count:     singulars.missingCodesCount,
      dnl_max:                 +singulars.dnlMax.toFixed(4),
      code_dnl_max:            singulars.codeDnlMax,
      dnl_min:                 +singulars.dnlMin.toFixed(4),
      code_dnl_min:            singulars.codeDnlMin,
      dnl_rms:                 +singulars.dnlRms.toFixed(4),
      code_min:                singulars.codeMin,
      code_max:                singulars.codeMax,
      code_trunclow:           singulars.codeTruncLow,
      code_trunchigh:          singulars.codeTruncHigh,
      lsb_codes_over_code_amp: +singulars.lsbCodesOverCodeAmp.toFixed(6),
    };
  },

  runFromWaveform: async (packet, params: SinlParams) => {
    params = sinlAutoSeedFromPacket(params, packet);
    const isVolt           = params.inputMode === 'voltage';
    const minCode          = isVolt ? Number(params.minCode) : Math.round(Number(params.minCode) ?? 0);
    const maxCode          = isVolt ? Number(params.maxCode) : Math.round(Number(params.maxCode) ?? 2047);
    const adcRes           = isVolt ? 10 : deriveAdcRes(Math.round(minCode), Math.round(maxCode));
    const avoidanceRadius  = Math.max(0, Math.round(Number(params.avoidanceRadius) ?? 40));
    const minSizeBin       = Math.max(1, Math.round(Number(params.minSizeBin)      ?? 2));
    const missingThreshold = Number(params.missingThreshold) ?? -0.9;
    const samples          = samplesToCodes(packet.waveform, params.inputMode, minCode, maxCode, 10);
    const { singulars }    = runInlTool(samples, adcRes, avoidanceRadius, minSizeBin, missingThreshold);
    const fileName         = packet.metadata.sourceFile ?? 'waveform';
    return {
      filename: fileName,
      inl_codes_p2p:           +singulars.inlCodesP2p.toFixed(4),
      inl_max:                 +singulars.inlMax.toFixed(4),
      code_inl_max:            singulars.codeInlMax,
      inl_min:                 +singulars.inlMin.toFixed(4),
      code_inl_min:            singulars.codeInlMin,
      missing_codes_threshold: singulars.missingCodesThreshold,
      missing_codes_count:     singulars.missingCodesCount,
      dnl_max:                 +singulars.dnlMax.toFixed(4),
      code_dnl_max:            singulars.codeDnlMax,
      dnl_min:                 +singulars.dnlMin.toFixed(4),
      code_dnl_min:            singulars.codeDnlMin,
      dnl_rms:                 +singulars.dnlRms.toFixed(4),
      code_min:                singulars.codeMin,
      code_max:                singulars.codeMax,
      code_trunclow:           singulars.codeTruncLow,
      code_trunchigh:          singulars.codeTruncHigh,
      lsb_codes_over_code_amp: +singulars.lsbCodesOverCodeAmp.toFixed(6),
    };
  },

  prepareData: async (file: File, params: SinlParams): Promise<{ figureData: SinlFigureData; debugTables: PluginDebugTable[] }> => {
    const minCode          = Math.round(Number(params.minCode)          ?? 0);
    const maxCode          = Math.round(Number(params.maxCode)          ?? 2047);
    const avoidanceRadius  = Math.max(0, Math.round(Number(params.avoidanceRadius) ?? 40));
    const minSizeBin       = Math.max(1, Math.round(Number(params.minSizeBin)      ?? 2));
    const missingThreshold = Number(params.missingThreshold) ?? -0.9;
    const adcRes           = deriveAdcRes(minCode, maxCode);
    const samples          = await ingestSamples(file, params);
    return _sinlPrepareCore(samples, adcRes, avoidanceRadius, minSizeBin, missingThreshold, file.name, minCode, maxCode, params.inputMode);
  },

  prepareDataFromWaveform: async (packet, params: SinlParams) => {
    params = sinlAutoSeedFromPacket(params, packet);
    const isVolt           = params.inputMode === 'voltage';
    const minCode          = isVolt ? Number(params.minCode) : Math.round(Number(params.minCode) ?? 0);
    const maxCode          = isVolt ? Number(params.maxCode) : Math.round(Number(params.maxCode) ?? 2047);
    const adcRes           = isVolt ? 10 : deriveAdcRes(Math.round(minCode), Math.round(maxCode));
    const avoidanceRadius  = Math.max(0, Math.round(Number(params.avoidanceRadius) ?? 40));
    const minSizeBin       = Math.max(1, Math.round(Number(params.minSizeBin)      ?? 2));
    const missingThreshold = Number(params.missingThreshold) ?? -0.9;
    const samples          = samplesToCodes(packet.waveform, params.inputMode, minCode, maxCode, 10);
    return _sinlPrepareCore(samples, adcRes, avoidanceRadius, minSizeBin, missingThreshold,
      packet.metadata.sourceFile ?? 'waveform', minCode, maxCode, params.inputMode);
  },

  figures: sinlFigures,
};
