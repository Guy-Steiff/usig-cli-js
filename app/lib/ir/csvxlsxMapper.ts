#!/usr/bin/env node
/**
 * app/lib/ir/csvxlsxMapper.ts
 *
 * Tabular ingestion adapter for the USIG IR pipeline.
 *
 * Overview
 * --------
 *
 * This module is the canonical ingestion boundary for CSV and XLSX files.
 *
 * Every supported table format is normalized into the same canonical IR packet
 * used throughout the remainder of USIG.
 *
 * No plugin should need to understand CSV or spreadsheet parsing directly.
 *
 *
 * Pipeline
 * --------
 *
 *              CSV / XLSX
 *                   │
 *                   ▼
 *             parse table
 *                   │
 *                   ▼
 *        classify every column independently
 *                   │
 *      ┌────────────┴────────────┐
 *      │                         │
 *      ▼                         ▼
 * constant column          varying column
 *      │                         │
 *      ▼                         ▼
 * metadata field           waveform array
 *      │                         │
 *      └────────────┬────────────┘
 *                   ▼
 *             Canonical IR Packet
 *                   │
 *        +----------+-----------+
 *        |          |           |
 *        ▼          ▼           ▼
 *     plugins   conversion   serialization
 *
 *
 * Column Classification
 * ---------------------
 *
 * Every column is evaluated independently.
 *
 *      unique values == 1
 *              │
 *              ▼
 *        metadata field
 *
 *      unique values > 1
 *              │
 *              ▼
 *       preserved as waveform
 *
 * This intentionally avoids attempting to identify "the signal."
 *
 * Columns such as:
 *
 *   • timestamp
 *   • frequency
 *   • voltage
 *   • index
 *   • IQ components
 *   • auxiliary measurements
 *
 * are all preserved exactly as independent waveform arrays.
 *
 *
 * Multi-array Architecture
 * ------------------------
 *
 * Older ingestion logic attempted to identify a single signal column.
 *
 * That approach has been intentionally removed.
 *
 * The mapper now preserves every varying numeric column.
 *
 * packet.waveform continues to exist only as a compatibility alias pointing
 * to the first waveform so existing plugins continue functioning.
 *
 * New code should consume:
 *
 *      packet.arrays
 *
 * or
 *
 *      packet.channels
 *
 * instead.
 *
 *
 * Metadata Model
 * --------------
 *
 * Metadata is represented as values that remain constant across the entire
 * acquisition.
 *
 * Examples:
 *
 *      fs
 *      fftLength
 *      numberOfCores
 *      toneMode
 *      device
 *      acquisitionMode
 *
 * become:
 *
 *      packet.metadata
 *
 * rather than waveform arrays.
 *
 * Metadata provenance is preserved through metadataSources so later stages can
 * distinguish values originating from:
 *
 *   • CSV/XLSX ingestion
 *   • filename inference
 *   • user CLI overrides
 *   • IR processing
 *   • plugins
 *
 * The general philosophy is:
 *
 *      preserve provenance
 *      avoid destructive overwrites
 *      accumulate metadata throughout the pipeline
 *
 *
 * Responsibilities
 * ----------------
 *
 *   • parse CSV
 *   • parse XLSX
 *   • preserve every varying numeric column
 *   • identify metadata columns
 *   • normalize into canonical IR
 *   • preserve column labels
 *   • attach ingestion provenance
 *
 *
 * Not Responsible For
 * -------------------
 *
 *   • choosing which waveform is "the signal"
 *   • plugin-specific interpretation
 *   • DSP preprocessing
 *   • export formatting
 *   • filename parsing
 *   • IR serialization
 *
 *
 * Design Goals
 * ------------
 *
 * This mapper intentionally supports datasets significantly richer than a
 * traditional oscilloscope waveform.
 *
 * Examples include:
 *
 *   • synchronized multi-channel acquisition
 *   • IQ captures
 *   • frequency sweeps
 *   • timestamped measurements
 *   • arbitrary N-column numeric datasets
 *
 * without requiring architectural changes elsewhere in USIG.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ExcelJSImport from "exceljs";
import type { Row } from "exceljs";
import type { WaveformArray } from "../ingest/types";

const ExcelJS = (ExcelJSImport as any).default ?? ExcelJSImport;

interface MapperArgs {
    inputPath: string;
    filename: string;
    hints?: Record<string, unknown>;
}

interface TableData {
    headers: string[];
    rows: string[][];
}

const stripCell = (s: string) =>
    String(s).trim().replace(/^"|"$/g, "");

function parseNumeric(cell: string): number {
    const lc = cell.toLowerCase();

    if (cell.trim() === "") {
        return NaN;
    }

    if (
        lc === "inf" ||
        lc === "+inf" ||
        lc === "infinity"
    ) {
        return Infinity;
    }

    if (
        lc === "-inf" ||
        lc === "-infinity"
    ) {
        return -Infinity;
    }

    return Number(cell);
}


/* -------------------------------------------------------------------------- */
/*                              Table loading                                 */
/* -------------------------------------------------------------------------- */

async function loadCsv(file: string): Promise<TableData> {
    const text = await fs.readFile(file, "utf8");

    const lines = text
        .split(/\r?\n/)
        .filter(l => l.trim().length);

    const delimiter = lines[0].includes("\t")
        ? "\t"
        : ",";

    return {
        headers: lines[0]
            .split(delimiter)
            .map((h, i) => {
                const name = stripCell(h);
                return name || `data${i + 1}`;
            }),

        rows: lines
            .slice(1)
            .map(l => l.split(delimiter))
    };
}

async function loadXlsx(file: string): Promise<TableData> {
    const workbook = new ExcelJS.Workbook();

    await workbook.xlsx.readFile(file);

    const sheet = workbook.worksheets[0];

    if (!sheet) {
        throw new Error(
            "Workbook contains no worksheets."
        );
    }

    const rows: string[][] = [];

    sheet.eachRow(
        { includeEmpty: false },
        (row: Row) => {
            rows.push(
                (row.values as unknown[])
                    .slice(1)
                    .map(v => String(v ?? "").trim())
            );
        }
    );

    if (!rows.length) {
        throw new Error(
            "Worksheet is empty."
        );
    }

    return {
        headers: rows[0].map(
            (h, i) => h || `col_${i}`
        ),
        rows: rows.slice(1)
    };
}

async function loadTable(
    file: string
): Promise<TableData> {

    switch (path.extname(file).toLowerCase()) {

        case ".csv":
            return loadCsv(file);

        case ".xlsx":
            return loadXlsx(file);

        default:
            throw new Error(
                "Unsupported table format."
            );
    }
}

/* -------------------------------------------------------------------------- */
/*                          Column classification                             */
/* -------------------------------------------------------------------------- */

function classifyColumns(
    headers: string[],
    rows: string[][]
) {
    const arrays: WaveformArray[] = [];

    const metadata: Record<string, unknown> = {
        metadataSources: {}
    };

    for (
        let c = 0;
        c < headers.length;
        c++
    ) {
        const name = headers[c];

        const rawValues = rows.map(r =>
            stripCell(r[c] ?? "")
        );

        const nonEmpty =
            rawValues.filter(Boolean);

        if (!nonEmpty.length) {
            continue;
        }

        const unique = new Set(nonEmpty);

        if (unique.size === 1) {

            const metadataName =
                name && name.trim() !== ""
                    ? name
                    : `meta${
                        Object.keys(metadata)
                            .filter(k =>
                                k.startsWith("meta")
                            ).length
                    }`;

            metadata[metadataName] =
                nonEmpty[0];

            continue;
        }

        const numeric =
            rawValues.map(parseNumeric);

        if (
            numeric.every(
                value =>
                    Number.isFinite(value) ||
                    Number.isNaN(value)
            )
        ) {
            arrays.push({
                label:
                    name && name.trim() !== ""
                        ? name
                        : `data${arrays.length}`,

                waveform:
                    new Float32Array(numeric)
            });
        }

        /*
         * Future:
         *
         * string arrays
         * categorical arrays
         * enum arrays
         */
    }

    return {
        arrays,
        metadata
    };
}

/* -------------------------------------------------------------------------- */
/*                               Public mapper                                */
/* -------------------------------------------------------------------------- */

// Used dynamically by usig.mjs conversion pipeline.
export async function mapCsvXlsxToIRCandidate({
    inputPath,
    filename
}: MapperArgs) {

    console.log(
        "[csvxlsxMapper] mapping:",
        filename
    );

    const table =
        await loadTable(inputPath);

    const {
        arrays,
        metadata
    } = classifyColumns(
        table.headers,
        table.rows
    );

    if (!arrays.length) {
        throw new Error(
            "No varying numeric columns found."
        );
    }

    return {
        packet: {
            waveform:
                arrays[0].waveform,

            arrays,

            channels:
                arrays,

            metadata: {
                columnLabels:
                    arrays.map(a => a.label),

                ...metadata,

                metadataSources: {
                    ...(metadata.metadataSources as object),

                    csvxlsxMapper: true
                }
            }
        },

        capturedVars: {}
    };
}

export interface WaveformMetadata {
    // ── Provenance ────────────────────────────────────────────────────────────
    sourceFile?: string;
    captureTimestamp?: string;
    instrument?: string;
    processingHistory?: string[];

    // ── Binary format specifics ───────────────────────────────────────────────
    endianness?: "little" | "big";
    signed?: boolean;
    bitDepth?: number;
    storageBitDepth?: number;
    headerBytes?: number;

    // ── Multi-channel ─────────────────────────────────────────────────────────
    channels?: number;
    channelLabels?: string[];
    channelIndex?: number;

    // ── Provenance tracking ───────────────────────────────────────────────────
    metadataSources?: Record<string, unknown>;
    userOverrides?: Record<string, unknown>;
    inferredFields?: string[];
}
