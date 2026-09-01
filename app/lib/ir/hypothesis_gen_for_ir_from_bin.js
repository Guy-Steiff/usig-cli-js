#!/usr/bin/env node

// hypothesis_gen_for_ir_from_bin.js
//
// USIG IR Binary Hypothesis Generator
//
// Purpose:
// Analyze arbitrary binary payloads and generate
// reconstruction instructions suitable for ingestion
// into USIG IR.
//
// Detection paths:
//
// 1. Embedded metadata reconstruction
// 2. Heuristic waveform reconstruction
// 3. Reject unknown layouts
//
// This module intentionally does not assume
// a binary file format.
import path from "node:path";

// ------------------------------------------------------------
// Constants
// ------------------------------------------------------------

const METADATA_HINTS = [
    '"waveformLength"',
    '"waveformEncoding"',
    '"schemaVersion"',
    '"waveformBytesPerElement"',
    '"metadata"'
];

const JSON_START_TOKENS = [
    '{'
];

// ------------------------------------------------------------
// IO
// ------------------------------------------------------------

function safeDecodeUtf8(buffer) {
    return buffer.toString("utf8");
}

// ------------------------------------------------------------
// Metadata detection
// ------------------------------------------------------------

function detectEmbeddedMetadata(data) {
    const text =
        safeDecodeUtf8(
            data.subarray(
                0,
                Math.min(
                    data.length,
                    4096
                )
            )
        );

    let hits = 0;

    for (const hint of METADATA_HINTS) {
        if (text.includes(hint)) {
            hits++;
        }
    }

    return {
        detected:
            text.includes('"waveformLength"') &&
            text.includes('"waveformBytesPerElement"'),
        confidence:
            hits >= 2
                ? 1.0
                : 0
    };
}

// ------------------------------------------------------------
// JSON extraction from binary payload
// ------------------------------------------------------------

function extractJsonRegion(data) {

    const text =
        data.toString(
            "utf8",
            0,
            Math.min(data.length, 65536)
        );

    const starts = [];

    for (const token of JSON_START_TOKENS) {
        const index =
            text.indexOf(token);
        if (index >= 0) {
            starts.push(index);
        }
    }

    for (
        const start of starts.sort(
            (a,b)=>a-b
        )
    ) {
        let depth = 0;
        let inString = false;
        let escape = false;

        for (
            let i=start;
            i<text.length;
            i++
        ) {

            const c = text[i];

            if (inString) {
                if (escape) {
                    escape = false;
                }
                else if (c === "\\") {
                    escape = true;
                }
                else if (c === '"') {
                    inString = false;
                }
            }
            else {
                if (c === '"') {
                    inString = true;
                }
                else if (c === "{") {
                    depth++;
                }
                else if (c === "}") {
                    depth--;

                    if (depth === 0) {

                        const candidate =
                            text.substring(
                                start,
                                i + 1
                            );

                        try {

                            return JSON.parse(
                                candidate
                            );

                        }

                        catch(e) {

                            break;

                        }

                    }

                }

            }

        }

    }

    return null;

}

// ------------------------------------------------------------
// Flatten metadata
// ------------------------------------------------------------

function flattenJson(
    obj,
    prefix=""
) {

    const output = [];

    if (
        obj &&
        typeof obj === "object"
    ) {

        for (
            const [key,value]
            of Object.entries(obj)
        ) {

            const current =
                prefix
                    ? `${prefix}.${key}`
                    : key;

            if (
                value &&
                typeof value === "object"
            ) {

                output.push(
                    ...flattenJson(
                        value,
                        current
                    )
                );

            }

            else {

                output.push({

                    path:
                        current,
                    value,
                    source:
                        "embedded_metadata"

                });

            }

        }

    }

    return output;

}
// ------------------------------------------------------------
// Encoding normalization
// ------------------------------------------------------------

function normalizeEncoding(value) {

    if (!value) {

        return null;

    }

    const v =
        String(value)
            .toLowerCase();

    if (
        v.includes("float32")
    ) {

        return "float32";

    }

    if (
        v.includes("int16")
    ) {

        return "int16";

    }

    if (
        v.includes("float64")
    ) {

        return "float64";

    }

    return v;

}

// ------------------------------------------------------------
// Reconstruction instruction builder
// ------------------------------------------------------------

function buildReconstructionInstructions(
    metadataFields,
    inferredCandidate = null
) {

    const lookup = {};

    for (const field of metadataFields) {

        lookup[
            field.path.toLowerCase()
        ] =
            field.value;

    }
    function find(names) {

        for (
            const key of Object.keys(lookup)
        ) {

            for (
                const name of names
            ) {

                if (
                    key.endsWith(
                        name.toLowerCase()
                    )
                ) {

                    return lookup[key];

                }

            }

        }

        return null;

    }
    const instructions = {

        encoding:
            normalizeEncoding(
                find([
                    "waveformencoding",
                    "waveformtype",
                    "encoding"
                ])
            ),
        endianness:
            find([
                "endianness"
            ]),
        bytes_per_sample:
            find([
                "waveformbytesperelement",
                "bytespersample"
            ]),
        samples:
            find([
                "waveformlength",
                "samples"
            ]),
        offset:
            inferredCandidate?.offset ?? 0,
        scale:
            find([
                "scale"
            ]),
        offset_value:
            find([
                "offset_value",
                "offsetvalue"
            ])

    };
    if (inferredCandidate) {

        if (!instructions.encoding) {

            instructions.encoding =
                inferredCandidate.encoding;

        }
        if (!instructions.endianness) {

            instructions.endianness =
                inferredCandidate.endianness;

        }
        if (!instructions.samples) {

            instructions.samples =
                inferredCandidate.length;

        }
        instructions.offset =
            inferredCandidate.offset ?? 0;

    }
    if (!instructions.encoding) {

        instructions.encoding =
            "float32";

    }
    if (!instructions.endianness) {

        instructions.endianness =
            "little";

    }
    if (!instructions.bytes_per_sample) {

        if (
            instructions.encoding === "float32"
        ) {

            instructions.bytes_per_sample = 4;

        }

        else if (
            instructions.encoding === "float64"
        ) {

            instructions.bytes_per_sample = 8;

        }

        else if (
            instructions.encoding === "int16"
        ) {

            instructions.bytes_per_sample = 2;

        }

    }
    if (
        instructions.scale === null ||
        instructions.scale === undefined
    ) {

        instructions.scale = 1.0;

    }
    if (
        instructions.offset_value === null ||
        instructions.offset_value === undefined
    ) {

        instructions.offset_value = 0.0;

    }
    return instructions;

}
// ------------------------------------------------------------
// Parse embedded metadata
// ------------------------------------------------------------

function parseEmbeddedMetadata(data) {

    const metadata =
        extractJsonRegion(data);

    const jsonText =
    JSON.stringify(metadata);

    const jsonOffset =
        data.indexOf(
            Buffer.from(jsonText)
        );
    const result = {
        metadata_fields: [],
        channel_labels: [],
        reconstruction_instructions_source: null
    };

    if (!metadata) {

        return result;

    }
    const fields =
        flattenJson(
            metadata
        );
    result.metadata_fields =
        fields;
    const channelLabels = [];

    for (const field of fields) {
        if (
            field.path === "metadata.channelLabels.0" ||
            field.path.startsWith("metadata.channelLabels.")
        ) {
            const match =
                field.path.match(/^metadata\.channelLabels\.(\d+)$/);

            if (
                match &&
                typeof field.value === "string" &&
                field.value.trim()
            ) {
                channelLabels[Number(match[1])] =
                    field.value.trim();
            }
        }
    }

    result.channel_labels = channelLabels.filter(
        label => typeof label === "string" && label.length > 0
    );

    let waveformLength = null;

    let waveformByteLength = null;

    let waveformEncoding = null;
    for (const field of fields) {

        if (
            field.path.endsWith(
                "waveformLength"
            )
        ) {

            waveformLength =
                field.value;

        }
        if (
            field.path.endsWith(
                "waveformByteLength"
            )
        ) {

            waveformByteLength =
                field.value;

        }
        if (
            field.path.endsWith(
                "waveformEncoding"
            )
        ) {

            waveformEncoding =
                field.value;

        }

    }
    if (
        waveformLength &&
        waveformByteLength
    ) {
        result.reconstruction_instructions_source =
        {
            samples:
                waveformLength,
            byte_length:
                waveformByteLength,
            encoding:
                waveformEncoding ||
                "Float32Array",
            offset:
                jsonOffset + jsonText.length,
        };
    }

    return result;
}
// ------------------------------------------------------------
// Float32 statistics
// ------------------------------------------------------------

function floatStats(
    data,
    offset
) {

    const values = [];

    const count =
        Math.floor(
            (data.length - offset) / 4
        );
    if (count < 64) {

        return null;

    }
    for (
        let i = 0;
        i < count;
        i++
    ) {

        let value;

        try {

            value =
                data.readFloatLE(
                    offset + i * 4
                );

        }

        catch(e) {

            break;

        }
        if (
            Number.isFinite(value)
        ) {

            values.push(value);

        }

    }
    if (
        values.length < 64
    ) {

        return null;

    }
    let min =
        values[0];

    let max =
        values[0];

    let sum = 0;
    for (const value of values) {

        if (value < min) {

            min = value;

        }
        if (value > max) {

            max = value;

        }
        sum += value;

    }
    return {

        count:
            values.length,
        min,
        max,
        mean:
            sum / values.length

    };

}

// ------------------------------------------------------------
// Binary waveform hypothesis mapper
// ------------------------------------------------------------

function findWaveformCandidate(data) {

    let best = null;
    for (
        let offset = 0;
        offset < Math.min(
            data.length,
            8192
        );
        offset += 4
    ) {

        const stats =
            floatStats(
                data,
                offset
            );
        if (!stats) {

            continue;

        }
        let confidence =
            0.5;
        if (
            stats.min > -10 &&
            stats.max < 10
        ) {

            confidence += 0.4;

        }
        if (
            Math.abs(stats.mean) < 1
        ) {

            confidence += 0.099;

        }
        const candidate =
        {

            type:
                "waveform_candidate",
            offset,
            encoding:
                "float32",
            endianness:
                "little",
            length:
                stats.count,
            statistics:
                stats,
            confidence:
                Math.min(
                    confidence,
                    0.999
                )

        };
        if (
            !best ||
            candidate.confidence >
            best.confidence
        ) {

            best = candidate;

        }

    }
    return best;

}
// ------------------------------------------------------------
// Generate IR ingestion hypothesis
// ------------------------------------------------------------

function generateHypothesis(data, filename = "binary") {

    const result =
    {

        file:
            path.basename(
                filename
            ),
        size_bytes:
            data.length,
        metadata_fields:
            [],
        arrays:
            [],
        reconstruction_instructions:
            null,
        decision:
            {}

    };
    const metadataDetection =
        detectEmbeddedMetadata(
            data
        );
    // --------------------------------------------------------
    // Path 1:
    // Embedded metadata reconstruction
    // --------------------------------------------------------

    if (
        metadataDetection.detected
    ) {

        const parsed =
            parseEmbeddedMetadata(data);
        result.metadata_fields =
            parsed.metadata_fields;
        result.channel_labels =
            parsed.channel_labels;
        result.reconstruction_instructions =
            buildReconstructionInstructions(
                result.metadata_fields,
                parsed.reconstruction_instructions_source
            );
        if (
            !result.reconstruction_instructions.samples ||
            !result.reconstruction_instructions.bytes_per_sample ||
            !result.reconstruction_instructions.encoding
        ) {
            result.decision = {
                can_create_ir: false,
                confidence: 0,
                mode: "incomplete_reconstruction_instructions",
                error: "Embedded metadata found but waveform reconstruction information is incomplete"
            };

            return result;
        }

result.decision =
{
    can_create_ir: true,
            confidence:
                1.0,
            mode:
                "embedded_reconstruction_instructions"

        };
        return result;

    }

    // --------------------------------------------------------
    // Path 2:
    // Heuristic waveform discovery
    // --------------------------------------------------------

    const candidate =
        findWaveformCandidate(
            data
        );
    if (candidate) {

        result.arrays =
        [

            candidate

        ];
        result.reconstruction_instructions =
            buildReconstructionInstructions(
                [],
                candidate
            );
        result.decision =
        {

            can_create_ir:
                true,
            confidence:
                candidate.confidence,
            mode:
                "heuristic_reconstruction_instructions"

        };
        return result;

    }

    // --------------------------------------------------------
    // Path 3:
    // Unknown binary
    // --------------------------------------------------------

    result.decision =
    {
        can_create_ir:
            false,
        confidence:
            0,
        mode:
            "unknown_binary_layout",
        error:
            "Unable to determine waveform reconstruction instructions"

    };
    return result;
}
// ------------------------------------------------------------
// Export
// ------------------------------------------------------------

module.exports = {
    generateHypothesis
};