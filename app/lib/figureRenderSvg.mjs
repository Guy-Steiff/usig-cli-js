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
 *
 * Heatmap support: `desc.heatmap` (a generic 2D grid, see pluginTypes.ts)
 * is rasterized to a PNG (via `sharp`) and embedded as a base64 data-URI
 * `<image>` element. This is why renderFigureToSvg() is async — its one
 * call site (usig.mjs) awaits it.
 */

import sharp from 'sharp';

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
  // Semantic 'warning' style — analytical warning/constraint regions
  // (e.g. SFDR avoidance zones), rendered more prominently than the
  // default reference area.
  referenceAreaWarning: 'rgba(251,191,36,0.35)',
};

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Rough monospace text-width estimate in px for a given font size — used
 * only for sizing the results-panel box so label/value text fits inside it.
 * Purely typographic (no domain knowledge of what the text means). */
function estimateTextWidth(s, fontSize) {
  return String(s).length * fontSize * 0.62;
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
 * Generic min→max normalized colormap for a single grid cell value.
 * 'heat' (default): a common red→yellow→white ramp, not domain-specific.
 * 'grayscale': plain intensity ramp.
 * Returns [r, g, b] each 0-255.
 */
function colormapValue(t, colorScale) {
  const c = Math.max(0, Math.min(1, t));
  if (colorScale === 'grayscale') {
    const v = Math.round(c * 255);
    return [v, v, v];
  }
  // 'heat': ramps red -> yellow -> white across three equal thirds.
  const r = Math.min(255, Math.floor(255 * (c * 3)));
  const g = Math.min(255, Math.floor(255 * Math.max(0, c * 3 - 1)));
  const b = Math.min(255, Math.floor(255 * Math.max(0, c * 3 - 2)));
  return [r, g, b];
}

/**
 * Rasterize a generic PortableFigureDescription heatmap grid into a PNG,
 * returned as a base64 data URI ready for an SVG <image> element. Purely
 * mechanical (normalize + colorize); has no knowledge of what the grid
 * values represent. See pluginTypes.ts for the row-major/orientation
 * convention (grid row 0 == extent[2]/yMin; last row == extent[3]/yMax).
 */
async function rasterizeHeatmapToDataUri(heatmap) {
  const { grid, width: gw, height: gh, colorScale } = heatmap;
  const finite = finiteValues(grid);
  // Manual min/max loop instead of Math.min(...)/Math.max(...): spreading
  // large grids (e.g. 500x1000 = 500,000 values) into Math.min/max
  // overflows the JS call stack (V8 argument limit).
  let maxVal = 0;
  let minVal = 0;
  if (finite.length) {
    maxVal = finite[0];
    minVal = finite[0];
    for (const v of finite) {
      if (v > maxVal) maxVal = v;
      if (v < minVal) minVal = v;
    }
  }
  // Small floor above the minimum so sparse single-count noise pixels
  // don't visually dominate/obscure the plot's actual structure — a
  // generic default, not tuned to any specific plugin's data.
  const floor = minVal + (maxVal - minVal) * 0.05;
  const span = Math.max(maxVal - floor, 1e-12);

  const buf = Buffer.alloc(gw * gh * 4);
  for (let row = 0; row < gh; row++) {
    // Flip vertically: grid row 0 = yMin (bottom) but PNG row 0 = image top.
    const srcRow = gh - 1 - row;
    for (let col = 0; col < gw; col++) {
      const val = grid[srcRow * gw + col];
      const idx = (row * gw + col) * 4;
      if (!Number.isFinite(val) || val <= floor) {
        buf[idx + 3] = 0; // transparent
        continue;
      }
      const t = (val - floor) / span;
      const [r, g, b] = colormapValue(t, colorScale);
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = 220;
    }
  }

  const png = await sharp(buf, { raw: { width: gw, height: gh, channels: 4 } }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

/**
 * Render a PortableFigureDescription (see pluginTypes.ts) to an SVG string.
 * @param {import('./pluginTypes').PortableFigureDescription} desc
 * @param {{width?: number, height?: number}} [opts]
 * @returns {string} SVG markup
 */
export async function renderFigureToSvg(desc, opts = {}) {
  const baseWidth = opts.width ?? DEFAULT_WIDTH;
  const baseHeight = opts.height ?? DEFAULT_HEIGHT;

  // Additive sections — only reserved when the description actually uses
  // these optional fields, so figures that don't set them (e.g. SINL)
  // render at exactly baseWidth x baseHeight, unchanged from before these
  // fields existed.
  const legendItems = desc.legend?.items ?? [];
  const resultsPanel = desc.resultsPanel ?? [];
  const legendCols = 4;
  const legendRows = legendItems.length ? Math.ceil(legendItems.length / legendCols) : 0;
  const legendSectionH = legendRows ? legendRows * 22 + 12 : 0;
  // Results panel: a sidebar to the right of the plot (mirrors the legacy
  // amber ResultsPanel), not a section stacked below the graph. Width is
  // sized from the actual label/value text so nothing overflows the box.
  const resultsRowFontSize = 9;
  const resultsPanelInnerW = resultsPanel.length
    ? Math.max(
        estimateTextWidth('CARRIER / FS', resultsRowFontSize + 1),
        ...resultsPanel.map(
          (row) =>
            estimateTextWidth(row.label, resultsRowFontSize) +
            16 +
            estimateTextWidth(row.value, resultsRowFontSize)
        )
      )
    : 0;
  const panelWidth = resultsPanel.length ? Math.min(360, Math.max(150, resultsPanelInnerW + 34)) : 0;

  const width = baseWidth + panelWidth;
  const height = baseHeight + legendSectionH;

  const marginLeft = 70;
  const marginRight = 24 + panelWidth;
  const marginTop = desc.legend?.enabled ? 56 : 40;
  const marginBottom = 56;

  const plotW = width - marginLeft - marginRight;
  const plotH = baseHeight - marginTop - marginBottom;

  const xData = desc.x?.data ?? [];
  const xFinite = finiteValues(xData);
  let xMin = xFinite.length ? Math.min(...xFinite) : 0;
  let xMax = xFinite.length ? Math.max(...xFinite) : 1;
  const allY = [];
  for (const s of desc.series ?? []) {
    for (const v of s.y) if (typeof v === 'number' && Number.isFinite(v)) allY.push(v);
  }
  for (const rl of desc.referenceLines ?? []) {
    if (rl.axis === 'y' && Number.isFinite(rl.value)) allY.push(rl.value);
  }
  for (const mk of desc.markers ?? []) {
    if (Number.isFinite(mk.y)) allY.push(mk.y);
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
  // Extra headroom above the highest marker so its label (drawn just above
  // the point) doesn't get clipped by the plot's top edge.
  if ((desc.markers ?? []).length) {
    yMax += (yMax - yMin) * 0.08;
  }
  // A heatmap's extent is the authoritative domain (an exact data-space
  // rectangle, e.g. an eye diagram's fixed voltage rails) — use it as-is,
  // without the padding/headroom applied above for line-series domains.
  if (desc.heatmap && Array.isArray(desc.heatmap.extent) && desc.heatmap.extent.length === 4) {
    const [hx1, hx2, hy1, hy2] = desc.heatmap.extent;
    xMin = hx1; xMax = hx2; yMin = hy1; yMax = hy2;
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

  // Heatmap — a generic rasterized 2D grid (see pluginTypes.ts), drawn as
  // the plot's background so series/markers/reference lines/areas layer
  // on top of it, exactly like a plotted series would.
  if (desc.heatmap && Array.isArray(desc.heatmap.grid) && desc.heatmap.grid.length > 0) {
    const dataUri = await rasterizeHeatmapToDataUri(desc.heatmap);
    const [hx1, hx2, hy1, hy2] = desc.heatmap.extent;
    const imgX = toPx(hx1);
    const imgYTop = toPy(hy2); // extent[3] (yMax) maps to the top of the image
    const imgW = toPx(hx2) - toPx(hx1);
    const imgH = toPy(hy1) - toPy(hy2); // extent[2] (yMin) maps to the bottom
    parts.push(
      `<image x="${imgX.toFixed(2)}" y="${imgYTop.toFixed(2)}" width="${imgW.toFixed(2)}" height="${imgH.toFixed(2)}" href="${dataUri}" preserveAspectRatio="none"/>`
    );
  }

  // Reference areas (drawn before grid/series so lines remain visible on
  // top). These are plain translucent regions; their semantic meaning (e.g.
  // "SFDR avoidance") is conveyed only via legend.items, never painted
  // directly on the plot.
  for (const area of desc.referenceAreas ?? []) {
    const x1 = toPx(area.x1);
    const x2 = toPx(area.x2);
    const left = Math.min(x1, x2);
    const w = Math.abs(x2 - x1);
    const areaFill = area.style === 'warning' ? COLORS.referenceAreaWarning : COLORS.referenceArea;
    parts.push(
      `<rect x="${left.toFixed(2)}" y="${marginTop}" width="${w.toFixed(2)}" height="${plotH}" fill="${areaFill}"/>`
    );
  }

  // Grid + ticks — honor explicit ticks when the plugin provides them;
  // otherwise fall back to auto-derived "nice" ticks.
  const xTicks = desc.x?.ticks?.length ? desc.x.ticks : niceTicks(xMin, xMax, 6);
  const yTicks = desc.y?.ticks?.length ? desc.y.ticks : niceTicks(yMin, yMax, 6);

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

  // Axis labels. x-label is placed directly below the plot's tick text
  // (inside the base canvas region), independent of the legend strip that
  // follows — layout order: plot -> x-label -> legend -> (results panel
  // as an independent right-side column).
  if (desc.x?.label) {
    parts.push(
      `<text x="${marginLeft + plotW / 2}" y="${marginTop + plotH + 34}" text-anchor="middle" font-size="12" font-family="sans-serif" fill="${COLORS.text}">${escapeXml(
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

  // Markers — discrete labeled points (e.g. spectral spurs). Drawn as a
  // colored point exactly at (x, y) with its label immediately above; no
  // connecting line to the axis (distinct from referenceLines).
  for (const mk of desc.markers ?? []) {
    if (!Number.isFinite(mk.x) || !Number.isFinite(mk.y)) continue;
    const px = toPx(mk.x);
    const py = toPy(mk.y);
    const color = mk.color || COLORS.title;
    if (mk.shape === 'triangle') {
      const r = 5;
      const p1 = `${px.toFixed(2)},${(py - r).toFixed(2)}`;
      const p2 = `${(px - r).toFixed(2)},${(py + r).toFixed(2)}`;
      const p3 = `${(px + r).toFixed(2)},${(py + r).toFixed(2)}`;
      parts.push(`<polygon points="${p1} ${p2} ${p3}" fill="${color}"/>`);
    } else {
      parts.push(`<circle cx="${px.toFixed(2)}" cy="${py.toFixed(2)}" r="3.5" fill="${color}"/>`);
    }
    if (mk.label) {
      const labelY = (py - 8).toFixed(2);
      if (mk.textRotation) {
        parts.push(
          `<text x="${px.toFixed(2)}" y="${labelY}" text-anchor="start" font-size="9" font-family="monospace" fill="${color}" transform="rotate(${mk.textRotation} ${px.toFixed(2)} ${labelY})">${escapeXml(
            mk.label
          )}</text>`
        );
      } else {
        parts.push(
          `<text x="${px.toFixed(2)}" y="${labelY}" text-anchor="middle" font-size="10" font-family="sans-serif" fill="${color}">${escapeXml(
            mk.label
          )}</text>`
        );
      }
    }
  }

  // Reference lines — drawn last (on top of series/markers) so a reference
  // level (e.g. a spur minimum threshold) remains visible above the plotted
  // trace, matching its role as a reference overlay rather than plotted data.
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

  // Legend-items strip — explicit legend entries (e.g. marker categories),
  // drawn below the base canvas (after the plot + x-axis label). Additive:
  // only rendered when the description provides legend.items.
  if (legendItems.length) {
    const stripTop = baseHeight + 6;
    const colW = plotW / legendCols;
    legendItems.forEach((item, idx) => {
      const col = idx % legendCols;
      const row = Math.floor(idx / legendCols);
      const ix = marginLeft + col * colW;
      const iy = stripTop + row * 22;
      const color = item.color || COLORS.text;
      if (item.shape === 'area') {
        parts.push(`<rect x="${ix}" y="${iy - 9}" width="16" height="10" fill="${color}"/>`);
      } else if (item.shape === 'triangle') {
        parts.push(`<polygon points="${ix + 8},${iy - 9} ${ix},${iy + 1} ${ix + 16},${iy + 1}" fill="${color}"/>`);
      } else if (item.shape === 'circle') {
        parts.push(`<circle cx="${ix + 8}" cy="${iy - 4}" r="4" fill="${color}"/>`);
      } else {
        parts.push(`<line x1="${ix}" y1="${iy - 4}" x2="${ix + 16}" y2="${iy - 4}" stroke="${color}" stroke-width="2"/>`);
      }
      parts.push(
        `<text x="${ix + 20}" y="${iy}" font-size="11" font-family="sans-serif" fill="${COLORS.text}">${escapeXml(item.label)}</text>`
      );
    });
  }

  // Results panel — amber sidebar to the right of the plot (mirrors the
  // legacy ResultsPanel component). Additive: only rendered when provided.
  if (resultsPanel.length) {
    const panelX = marginLeft + plotW + 14;
    const panelY = marginTop;
    const panelW = panelWidth - 24;
    const panelH = plotH;
    const rowH = 13;
    const headerH = 22;

    parts.push(
      `<rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="6" fill="rgba(120,53,15,0.2)" stroke="rgba(180,83,9,0.4)"/>`
    );
    parts.push(
      `<text x="${panelX + 10}" y="${panelY + 16}" font-size="9" font-family="sans-serif" letter-spacing="0.05em" fill="#FCD34D" font-weight="600">CARRIER / FS</text>`
    );
    parts.push(
      `<line x1="${panelX + 8}" y1="${panelY + headerH}" x2="${panelX + panelW - 8}" y2="${panelY + headerH}" stroke="rgba(180,83,9,0.4)"/>`
    );
    const maxRows = Math.max(0, Math.floor((panelH - headerH - 6) / rowH));
    resultsPanel.slice(0, maxRows).forEach((row, idx) => {
      const ry = panelY + headerH + 12 + idx * rowH;
      parts.push(
        `<text x="${panelX + 10}" y="${ry}" font-size="9" font-family="monospace" fill="rgba(252,211,77,0.7)">${escapeXml(row.label)}</text>`
      );
      parts.push(
        `<text x="${panelX + panelW - 10}" y="${ry}" text-anchor="end" font-size="9" font-family="monospace" fill="#FEF3C7">${escapeXml(row.value)}</text>`
      );
    });
  }

  parts.push('</svg>');
  return parts.join('\n');
}

export default { renderFigureToSvg };
