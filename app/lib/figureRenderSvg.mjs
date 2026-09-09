/**
 * Plain-ESM, DOM-free SVG renderer for PortableFigureDescription objects
 * (see app/lib/pluginTypes.ts for the type). No React, no Recharts, no
 * browser APIs — safe to run directly under Node for the CLI.
 *
 * This is intentionally a small, hand-rolled scientific-plot renderer, not
 * a general-purpose charting library. It aims for semantic fidelity with
 * the current Recharts-based figures (title/axes/series/legend/reference
 * lines/reference areas), not pixel-perfect parity.
 *
 * Ticks: when the description does not provide explicit tick values, this
 * renderer derives its own "nice" ticks from the data domain.
 */

const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 560;

const COLORS = {
  bg: '#111827',
  grid: '#1F2937',
  axis: '#6B7280',
  text: '#D1D5DB',
  title: '#E5E7EB',
  series: ['#6366F1', '#F59E0B', '#10B981', '#EC4899', '#3B82F6'],
  referenceLine: '#EF4444',
  referenceArea: 'rgba(251,191,36,0.14)',
};

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Simple "nice" tick generator — not exact d3-scale, but produces evenly
 * spaced, readable tick values covering [min, max]. */
function niceTicks(min, max, count = 6) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return [min ?? 0, max ?? 0];
  }
  const span = max - min;
  const rawStep = span / Math.max(count - 1, 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(rawStep))));
  const residual = rawStep / magnitude;
  let niceResidual;
  if (residual >= 5) niceResidual = 10;
  else if (residual >= 2) niceResidual = 5;
  else if (residual >= 1) niceResidual = 2;
  else niceResidual = 1;
  const step = niceResidual * magnitude;
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.5; v += step) {
    ticks.push(Math.round(v / step) * step);
  }
  return ticks.filter((v) => v >= min - step * 0.001 && v <= max + step * 0.001);
}

function formatTick(v) {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function finiteValues(arr) {
  return arr.filter((v) => typeof v === 'number' && Number.isFinite(v));
}

/**
 * Render a PortableFigureDescription (see pluginTypes.ts) to an SVG string.
 * @param {import('./pluginTypes').PortableFigureDescription} desc
 * @param {{width?: number, height?: number}} [opts]
 * @returns {string} SVG markup
 */
export function renderFigureToSvg(desc, opts = {}) {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;

  const marginLeft = 70;
  const marginRight = 24;
  const marginTop = desc.legend?.enabled ? 56 : 40;
  const marginBottom = 56;

  const plotW = width - marginLeft - marginRight;
  const plotH = height - marginTop - marginBottom;

  const xData = desc.x?.data ?? [];
  const xFinite = finiteValues(xData);
  const xMin = xFinite.length ? Math.min(...xFinite) : 0;
  const xMax = xFinite.length ? Math.max(...xFinite) : 1;

  const allY = [];
  for (const s of desc.series ?? []) {
    for (const v of s.y) if (typeof v === 'number' && Number.isFinite(v)) allY.push(v);
  }
  for (const rl of desc.referenceLines ?? []) {
    if (rl.axis === 'y' && Number.isFinite(rl.value)) allY.push(rl.value);
  }
  let yMin = allY.length ? Math.min(...allY) : -1;
  let yMax = allY.length ? Math.max(...allY) : 1;
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  } else {
    const pad = (yMax - yMin) * 0.1;
    yMin -= pad;
    yMax += pad;
  }

  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  const toPx = (xv) => marginLeft + ((xv - xMin) / xSpan) * plotW;
  const toPy = (yv) => marginTop + plotH - ((yv - yMin) / ySpan) * plotH;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  );
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${COLORS.bg}"/>`);

  // Title
  if (desc.title) {
    parts.push(
      `<text x="${width / 2}" y="24" text-anchor="middle" font-size="16" font-family="sans-serif" fill="${COLORS.title}" font-weight="600">${escapeXml(
        desc.title
      )}</text>`
    );
  }

  // Reference areas (drawn before grid/series so lines remain visible on top)
  for (const area of desc.referenceAreas ?? []) {
    const x1 = toPx(area.x1);
    const x2 = toPx(area.x2);
    const left = Math.min(x1, x2);
    const w = Math.abs(x2 - x1);
    parts.push(
      `<rect x="${left.toFixed(2)}" y="${marginTop}" width="${w.toFixed(2)}" height="${plotH}" fill="${COLORS.referenceArea}"/>`
    );
    if (area.label) {
      parts.push(
        `<text x="${(left + w / 2).toFixed(2)}" y="${marginTop + 14}" text-anchor="middle" font-size="10" font-family="sans-serif" fill="#FCD34D">${escapeXml(
          area.label
        )}</text>`
      );
    }
  }

  // Grid + ticks
  const xTicks = niceTicks(xMin, xMax, 6);
  const yTicks = niceTicks(yMin, yMax, 6);

  if (desc.grid?.x) {
    for (const t of xTicks) {
      const px = toPx(t);
      parts.push(
        `<line x1="${px.toFixed(2)}" y1="${marginTop}" x2="${px.toFixed(2)}" y2="${marginTop + plotH}" stroke="${COLORS.grid}" stroke-dasharray="3 3"/>`
      );
    }
  }
  if (desc.grid?.y) {
    for (const t of yTicks) {
      const py = toPy(t);
      parts.push(
        `<line x1="${marginLeft}" y1="${py.toFixed(2)}" x2="${marginLeft + plotW}" y2="${py.toFixed(2)}" stroke="${COLORS.grid}" stroke-dasharray="3 3"/>`
      );
    }
  }

  // Axes
  parts.push(
    `<line x1="${marginLeft}" y1="${marginTop + plotH}" x2="${marginLeft + plotW}" y2="${marginTop + plotH}" stroke="${COLORS.axis}"/>`
  );
  parts.push(`<line x1="${marginLeft}" y1="${marginTop}" x2="${marginLeft}" y2="${marginTop + plotH}" stroke="${COLORS.axis}"/>`);

  for (const t of xTicks) {
    const px = toPx(t);
    parts.push(
      `<text x="${px.toFixed(2)}" y="${marginTop + plotH + 16}" text-anchor="middle" font-size="10" font-family="sans-serif" fill="${COLORS.text}">${formatTick(t)}</text>`
    );
  }
  for (const t of yTicks) {
    const py = toPy(t);
    parts.push(
      `<text x="${marginLeft - 8}" y="${(py + 3).toFixed(2)}" text-anchor="end" font-size="10" font-family="sans-serif" fill="${COLORS.text}">${formatTick(t)}</text>`
    );
  }

  // Axis labels
  if (desc.x?.label) {
    parts.push(
      `<text x="${marginLeft + plotW / 2}" y="${height - 12}" text-anchor="middle" font-size="12" font-family="sans-serif" fill="${COLORS.text}">${escapeXml(
        desc.x.label
      )}</text>`
    );
  }
  if (desc.y?.label) {
    parts.push(
      `<text x="16" y="${marginTop + plotH / 2}" text-anchor="middle" font-size="12" font-family="sans-serif" fill="${COLORS.text}" transform="rotate(-90 16 ${marginTop + plotH / 2})">${escapeXml(
        desc.y.label
      )}</text>`
    );
  }

  // Reference lines
  for (const rl of desc.referenceLines ?? []) {
    if (rl.axis === 'y') {
      const py = toPy(rl.value);
      parts.push(
        `<line x1="${marginLeft}" y1="${py.toFixed(2)}" x2="${marginLeft + plotW}" y2="${py.toFixed(2)}" stroke="${COLORS.referenceLine}" stroke-dasharray="4 4"/>`
      );
      if (rl.label) {
        parts.push(
          `<text x="${marginLeft + plotW - 4}" y="${(py - 4).toFixed(2)}" text-anchor="end" font-size="10" font-family="sans-serif" fill="${COLORS.referenceLine}">${escapeXml(
            rl.label
          )}</text>`
        );
      }
    } else {
      const px = toPx(rl.value);
      parts.push(
        `<line x1="${px.toFixed(2)}" y1="${marginTop}" x2="${px.toFixed(2)}" y2="${marginTop + plotH}" stroke="${COLORS.referenceLine}" stroke-dasharray="4 4"/>`
      );
      if (rl.label) {
        parts.push(
          `<text x="${(px + 4).toFixed(2)}" y="${marginTop + 12}" font-size="10" font-family="sans-serif" fill="${COLORS.referenceLine}">${escapeXml(
            rl.label
          )}</text>`
        );
      }
    }
  }

  // Data series (as polylines, breaking on null/NaN gaps)
  desc.series?.forEach((series, idx) => {
    const color = COLORS.series[idx % COLORS.series.length];
    const dash = series.style === 'dashed' ? ' stroke-dasharray="6 3"' : '';
    let segment = [];
    const segments = [];
    for (let i = 0; i < xData.length; i++) {
      const yv = series.y[i];
      if (typeof yv === 'number' && Number.isFinite(yv) && Number.isFinite(xData[i])) {
        segment.push(`${toPx(xData[i]).toFixed(2)},${toPy(yv).toFixed(2)}`);
      } else if (segment.length > 0) {
        segments.push(segment);
        segment = [];
      }
    }
    if (segment.length > 0) segments.push(segment);
    for (const seg of segments) {
      if (seg.length < 2) continue;
      parts.push(`<polyline points="${seg.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5"${dash}/>`);
    }
  });

  // Legend
  if (desc.legend?.enabled && desc.series?.length) {
    const legendY = marginTop - 24;
    let legendX = marginLeft;
    desc.series.forEach((series, idx) => {
      const color = COLORS.series[idx % COLORS.series.length];
      parts.push(`<line x1="${legendX}" y1="${legendY}" x2="${legendX + 16}" y2="${legendY}" stroke="${color}" stroke-width="2"${series.style === 'dashed' ? ' stroke-dasharray="6 3"' : ''}/>`);
      parts.push(
        `<text x="${legendX + 20}" y="${legendY + 4}" font-size="11" font-family="sans-serif" fill="${COLORS.text}">${escapeXml(series.name)}</text>`
      );
      legendX += 22 + series.name.length * 6.5 + 16;
    });
  }

  parts.push('</svg>');
  return parts.join('\n');
}

export default { renderFigureToSvg };
