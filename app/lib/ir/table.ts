/**
 * app/lib/ir/table.ts
 *
 * Converts a SignalFrame into a generic table.
 *
 * For tabular ingestion, every preserved varying waveform array becomes
 * an output column.
 *
 * The first waveform remains the compatibility fallback for legacy packets
 * which do not expose packet.arrays.
 */

import type { SignalFrame } from './types';

export interface IRTable {
  headers: string[];
  rows: unknown[][];
}

export function frameToTable(
  frame: SignalFrame
): IRTable {

  // ─────────────────────────────────────────────
  // Preferred path:
  // preserve all independently ingested arrays
  // ─────────────────────────────────────────────

  const arrays = frame.packet.arrays;

  if (arrays && arrays.length > 0) {

    const headers = arrays.map(
      array => array.label
    );

    const length = Math.max(
      ...arrays.map(
        array => array.waveform.length
      )
    );

    const rows: unknown[][] = [];

    for (let i = 0; i < length; i++) {

      rows.push(
        arrays.map(
          array => array.waveform[i] ?? ''
        )
      );
    }

    return {
      headers,
      rows,
    };
  }

  // ─────────────────────────────────────────────
  // Legacy / binary fallback
  // ─────────────────────────────────────────────

  const header =
    frame.packet.metadata.channelLabels?.[0]
    ?? frame.headers[0]
    ?? 'samples';

  return {
    headers: [
      header,
    ],

    rows: Array.from(
      frame.packet.waveform,
      value => [value]
    ),
  };
}
