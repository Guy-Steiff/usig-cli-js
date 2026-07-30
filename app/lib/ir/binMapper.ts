#!/usr/bin/env node
/**
 * app/lib/ir/binMapper.ts
 *
 * Binary ingestion adapter for the USIG IR pipeline.
 *
 * Overview
 * --------
 *
 * This module is the canonical binary ingestion boundary for USIG.
 *
 * Its responsibility is intentionally narrow:
 *
 *     binary file
 *          │
 *          ▼
 *   binary hypothesis mapper
 *          │
 *          ▼
 *      canonical IR packet
 *          │
 *          ▼
 *   plugins / exporters / serializer
 *
 * The remainder of the application never needs to understand binary layouts.
 * Everything downstream operates exclusively on the canonical IR representation.
 *
 * Architecture
 * ------------
 *
 *                    +----------------------+
 *                    |   input .bin file    |
 *                    +----------+-----------+
 *                               |
 *                               v
 *                 hypothesis_gen_for_ir_from_bin.js
 *                               |
 *                     generateHypothesis()
 *                               |
 *                               v
 *                    Canonical IR Candidate
 *                               |
 *                               v
 *                    SignalFrame / IR Packet
 *                               |
 *             +-----------------+-----------------+
 *             |                 |                 |
 *             v                 v                 v
 *         plugins          conversion       serialization
 *
 *
 * Design Philosophy
 * -----------------
 *
 * Historically USIG contained two independent binary ingestion paths:
 *
 *   1. Instrument-generated binary files
 *
 *   2. USIG-generated binary files
 *
 * Each path contained special-case logic and assumptions about the origin
 * of the binary.
 *
 * During the IR refactor this architecture was intentionally removed.
 *
 * Instead, every binary file now passes through the same hypothesis-based
 * mapper regardless of where the file originated.
 *
 * The binary mapper proved sufficiently robust across both instrument output
 * and USIG-generated output and therefore became the single supported
 * ingestion implementation.
 *
 * As a consequence:
 *
 *      Instrument BIN
 *              │
 *              │
 *      USIG BIN
 *              │
 *              ▼
 *      Binary Hypothesis Mapper
 *              │
 *              ▼
 *         Canonical IR
 *
 * There is no longer a distinction between "instrument mode" and
 * "USIG mode" during ingestion.
 *
 *
 * Failure Philosophy
 * ------------------
 *
 * If this mapper cannot successfully interpret a binary file, the binary is
 * considered outside the scope of the USIG interchange format.
 *
 * This is an acceptable outcome.
 *
 * The objective of USIG is not to decode every arbitrary proprietary binary
 * layout, but rather to support:
 *
 *   • instrument-aligned waveform binaries
 *   • intentionally simple binary waveform dumps
 *   • USIG-generated binary containers
 *
 * If none of the binary hypotheses match, the binary should simply be treated
 * as unsupported instead of introducing additional special-case parsers.
 *
 *
 * Responsibilities
 * ----------------
 *
 *   • invoke the binary hypothesis engine
 *   • normalize mapper output into the canonical IR packet
 *   • preserve waveform fidelity
 *   • preserve discovered metadata
 *   • expose captured variables for future diagnostics
 *   • isolate binary interpretation from the remainder of the pipeline
 *
 *
 * Not Responsible For
 * -------------------
 *
 *   • binary format reverse engineering
 *   • waveform decoding algorithms
 *   • plugin-specific preprocessing
 *   • metadata inference from filenames
 *   • CSV/XLSX conversion
 *   • IR serialization
 *   • export formatting
 *
 *
 * Metadata
 * --------
 *
 * The mapper preserves metadata discovered during binary analysis.
 *
 * Later pipeline stages may augment metadata from additional sources:
 *
 *   • filename inference
 *   • user CLI overrides
 *   • plugin-generated metadata
 *   • IR processing history
 *
 * Metadata sources are intentionally accumulated rather than overwritten,
 * allowing downstream tooling to distinguish where each value originated.
 *
 *
 * Future
 * ------
 *
 * The mapper intentionally exposes a canonical IR packet rather than a
 * plugin-specific structure.
 *
 * This allows future binary formats to be supported by extending the
 * hypothesis engine without requiring changes to:
 *
 *   • plugins
 *   • exporters
 *   • serializers
 *   • conversion pipeline
 */

import * as fs from 'node:fs/promises';
import {
  deserializeFrame,
  unpackSerializedIR,
} from './serializer';

import { generateHypothesis } from './hypothesis_gen_for_ir_from_bin.js';


function materializeMetadataFields(fields = []) {
  const metadata = {
    metadataSources: {},
  };

  for (const field of fields) {
    if (!field.path.startsWith('metadata.')) {
      continue;
    }

    const path = field.path
      .replace(/^metadata\./, '')
      .split('.');

    let target = metadata;

    while (path.length > 1) {
      const key = path.shift();

      if (!target[key]) {
        target[key] = /^\d+$/.test(path[0]) ? [] : {};
      }

      target = target[key];
    }

    const finalKey = path[0];

    if (Array.isArray(target)) {
      target[Number(finalKey)] = field.value;
    } else {
      target[finalKey] = field.value;
    }
  }

  return metadata;
}

function normalizeChannels(mapped: any, raw: Buffer) {
  const channelDefinitions = mapped.channels;

  if (!Array.isArray(channelDefinitions) || channelDefinitions.length === 0) {
    const instructions = mapped.reconstruction_instructions;

    const waveformOffset =
      raw.length -
      (instructions.samples * instructions.bytes_per_sample);

    return [
      {
        label: 'data',
        waveform: reconstructWaveform(raw, {
          ...instructions,
          offset: waveformOffset,
        }),
      },
    ];
  }

  return channelDefinitions.map((channel, index) => {
    const waveform = reconstructWaveform(
      raw,
      channel.reconstruction
    );

    return {
      label: channel.label ?? `channel_${index}`,
      waveform,
    };
  });
}

function reconstructWaveform(
      buffer: Buffer,
      instructions: any
    ) {
  const {
    encoding,
    samples,
    offset = 0,
    scale = 1,
    offset_value = 0,
  } = instructions;

  const payload = buffer.subarray(offset);
    if (payload.byteOffset % 4 !== 0 && encoding === 'float32') {
      const aligned = Buffer.from(payload);
      return reconstructWaveform(aligned, {
        ...instructions,
        offset: 0,
      });
    }

  switch (encoding) {
    case 'float32': {
      const raw = new Float32Array(
          payload.buffer.slice(
              payload.byteOffset,
              payload.byteOffset + samples * 4
          )
      );

      return Float32Array.from(
        raw,
        v => (v + offset_value) * scale
      );
    }

    case 'int16': {
      const raw = new Int16Array(
          payload.buffer.slice(
            payload.byteOffset,
            payload.byteOffset + samples * 2
          )
        );

      return Float32Array.from(
        raw,
        v => (v + offset_value) * scale
      );
    }

    default:
      throw new Error(
        `Unsupported waveform encoding: ${encoding}`
      );
  }
}

export async function mapBinaryToIRCandidate({
  inputPath,
  filename,
  hints: _hints = {},
}) {
  console.log('[binMapper] mapping:', filename);

  const raw = await fs.readFile(inputPath);


  // --------------------------------------------------
  // First: try native USIG IR container
  // --------------------------------------------------

  try {
    const {
      meta,
      waveform,
    } = unpackSerializedIR(raw);

    const frame =
      deserializeFrame(
        meta,
        waveform
      );

    return {
      packet: frame.packet,
      capturedVars: frame.capturedVars ?? {},
    };

  } catch {
    // Not a USIG container.
    // Continue with generic binary hypothesis mapping.
  }


  // --------------------------------------------------
  // Second: arbitrary binary mapping
  // --------------------------------------------------

  const mapped: any =
    generateHypothesis(inputPath);


  if (!mapped?.decision?.can_create_ir) {
    throw new Error(
      `Binary mapper failed for ${filename}`
    );
  }


  const metadata =
    materializeMetadataFields(
      mapped.metadata_fields
    );


  const channels =
    normalizeChannels(
      mapped,
      raw
    );


  const waveform =
    channels[0].waveform;


  return {
    packet: {
      waveform,
      channels,
      metadata: {
        ...metadata,
      },
    },

    capturedVars:
      mapped.capturedVars ?? {},
  };
}