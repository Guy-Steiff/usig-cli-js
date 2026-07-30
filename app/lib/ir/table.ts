/**
 * app/lib/ir/table.ts
 *
 * Converts IR into a generic table.
 *
 * Export priority:
 *
 * 1. sourceTable
 *    Exact original input columns.
 *
 * 2. waveform fallback
 *    Only for binary/synthetic inputs without a table.
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
  // preserve original input table
  // ─────────────────────────────────────────────

  if (frame.sourceTable) {

    const headers =
      frame.sourceTable.headers;


    const length =
      Math.max(
        ...headers.map(
          h =>
            frame.sourceTable!.columns[h]?.length ?? 0
        )
      );


    const rows: unknown[][] = [];


    for (let i = 0; i < length; i++) {

      rows.push(
        headers.map(
          h =>
            frame.sourceTable!.columns[h]?.[i] ?? ''
        )
      );

    }


    return {
      headers,
      rows,
    };
  }



  // ─────────────────────────────────────────────
  // Binary fallback
  // ─────────────────────────────────────────────

  return {

    headers: [
      frame.waveformColumn,
    ],

    rows:
      Array.from(
        frame.packet.waveform,
        v => [v]
      ),
  };
}