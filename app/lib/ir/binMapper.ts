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
import type { WaveformPacket } from '../ingest/types';
import {
  deserializeFrame,
  unpackSerializedIR,
} from './serializer';

import { generateHypothesis } from './hypothesis_gen_for_ir_from_bin.js';


function materializeMetadataFields(
  fields: Array<{
    path: string;
    value: unknown;
  }> = []
): Record<string, any> {
  const metadata: Record<string, any> = {
    metadataSources: {},
  };

  for (const field of fields) {
    if (!field.path.startsWith('metadata.')) {
      continue;
    }

    const path = field.path
      .replace(/^metadata\./, '')
      .split('.');

    let target: any = metadata;

    while (path.length > 1) {
      const key = path.shift()!;

      if (!target[key]) {
        target[key] =
          /^\d+$/.test(path[0])
            ? []
            : {};
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

  if (
    !Array.isArray(channelDefinitions) ||
    channelDefinitions.length === 0
  ) {
    const instructions = mapped.reconstruction_instructions;

    if (
      !instructions ||
      !Number.isInteger(instructions.samples) ||
      !Number.isInteger(instructions.bytes_per_sample)
    ) {
      throw new Error(
        'Binary mapper produced no channel definitions and incomplete waveform reconstruction instructions.'
      );
    }

    // Determine offset to use. If an explicit offset was provided in the
    // reconstruction instructions (e.g. embedded metadata), honor it exactly.
    // Only fall back to end-of-file placement when no explicit offset exists.
    let waveformOffset: number;
    if (Object.prototype.hasOwnProperty.call(instructions, 'offset') && Number.isInteger(instructions.offset)) {
      waveformOffset = instructions.offset as number;
    } else {
      waveformOffset = raw.length - (instructions.samples * instructions.bytes_per_sample);
    }

    const metadata =
      materializeMetadataFields(
        mapped.metadata_fields
      );

    const channelLabels =
      Array.isArray(metadata.channelLabels)
        ? metadata.channelLabels
        : [];

    const label = channelLabels[0];


    const waveform = reconstructWaveform(raw, {
      ...instructions,
      offset: waveformOffset,
    });

    const reconUsed = {
      encoding: instructions.encoding ?? 'float32',
      endianness: instructions.endianness ?? 'little',
      bytes_per_sample: instructions.bytes_per_sample,
      samples: instructions.samples,
      offset: waveformOffset,
      scale: instructions.scale ?? 1.0,
      offset_value: instructions.offset_value ?? 0.0,
      channelIndex: 0,
    };

    return [
      {
        label,
        waveform,
        reconstructionUsed: reconUsed,
      },
    ];

    }

    return channelDefinitions.map((channel, index) => {
      const waveform = reconstructWaveform(
        raw,
        channel.reconstruction
      );

      const reconUsed = {
        encoding: channel.reconstruction?.encoding ?? 'float32',
        endianness: channel.reconstruction?.endianness ?? 'little',
        bytes_per_sample: channel.reconstruction?.bytes_per_sample,
        samples: channel.reconstruction?.samples,
        offset: channel.reconstruction?.offset ?? 0,
        scale: channel.reconstruction?.scale ?? 1.0,
        offset_value: channel.reconstruction?.offset_value ?? 0.0,
        channelIndex: index,
      };

      return {
        label: channel.label ?? `channel_${index}`,
        waveform,
        reconstructionUsed: reconUsed,
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
    endianness = 'little',
    bytes_per_sample,
  } = instructions;

  const littleEndian = endianness === 'little';

  // Validate available bytes explicitly. Choose to throw on insufficient
  // data rather than silently truncate — makes behavior explicit and testable.
  const needed = samples * bytes_per_sample;
  const available = buffer.length - offset;
  if (available < needed) {
    throw new Error(
      `Insufficient data for waveform reconstruction: need ${needed} bytes starting at offset ${offset}, only ${available} available.`
    );
  }

  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset + offset,
    needed
  );

  switch (encoding) {
    case 'float32': {
      const out = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        const v = view.getFloat32(i * 4, littleEndian);
        out[i] = (v + offset_value) * scale;
      }
      return out;
    }

    case 'int16': {
      const out = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        const v = view.getInt16(i * 2, littleEndian);
        out[i] = (v + offset_value) * scale;
      }
      return out;
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
  data,
  hints: _hints = {},
}: {
  inputPath?: string;
  filename: string;
  data?: Buffer;
  hints?: Record<string, unknown>;
}): Promise<{
  packet: WaveformPacket;
  capturedVars: Record<string, unknown>;
}> {


  console.log('[binMapper] mapping:', filename);

  const raw =
    data ??
    (inputPath
      ? await fs.readFile(inputPath)
      : null);

  if (!raw) {
    throw new Error(
      `Binary mapper requires either inputPath or data for "${filename}".`
    );
  }



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

    console.error('[DEBUG binMapper native IR]', {
      frameKeys: Object.keys(frame ?? {}),
      packetKeys: Object.keys(frame?.packet ?? {}),
      packetMetadata: frame?.packet?.metadata,
      waveformLength: frame?.packet?.waveform?.length,
    });

    return {
      packet: frame.packet,
      capturedVars: frame.capturedVars ?? {},
    };

  } catch (error) {
    console.error('[DEBUG binMapper native IR failed]', error);

    // Not a USIG container.
    // Continue with generic binary hypothesis mapping.
  }




  // --------------------------------------------------
  // Second: arbitrary binary mapping
  // --------------------------------------------------

  const mapped: any =
      generateHypothesis(raw);

  if (!mapped?.decision?.can_create_ir) {
    throw new Error(
      `Binary mapper failed for ${filename}`
    );
  }

  const metadata = {
    ...materializeMetadataFields(
      mapped.metadata_fields
    ),
    channelLabels: Array.isArray(mapped.channel_labels)
      ? mapped.channel_labels
      : undefined,
  } as WaveformPacket['metadata'];


  const mappedWithMetadata = {
    ...mapped,
    metadata,
  };

  const channels =
    normalizeChannels(
      mappedWithMetadata,
      raw
    );


  const waveform =
    channels[0].waveform;

  // Persist effective reconstruction instructions used for the primary channel
  // so downstream consumers can audit and reproduce the decoding.
  const primaryRecon: any = (() => {
    // If normalizeChannels recorded the actual reconstructionUsed for the channel, prefer it.
    const ch = channels[0];
    if (ch && ch.reconstructionUsed) {
      return ch.reconstructionUsed;
    }

    // If mapped provided a top-level reconstruction_instructions, use that as base.
    const top = mapped.reconstruction_instructions ?? {};
    // If channels provided per-channel reconstruction, prefer that.
    const chRecon = mapped.channels && Array.isArray(mapped.channels) && mapped.channels[0]?.reconstruction
      ? mapped.channels[0].reconstruction
      : undefined;
    const used = {
      encoding: chRecon?.encoding ?? top.encoding ?? 'float32',
      endianness: chRecon?.endianness ?? top.endianness ?? 'little',
      bytes_per_sample: chRecon?.bytes_per_sample ?? top.bytes_per_sample ?? (top.encoding === 'int16' ? 2 : 4),
      samples: chRecon?.samples ?? top.samples ?? waveform.length,
      offset: chRecon?.offset ?? top.offset ?? 0,
      scale: chRecon?.scale ?? top.scale ?? 1.0,
      offset_value: chRecon?.offset_value ?? top.offset_value ?? 0.0,
      channelIndex: 0,
    };
    return used;
  })();

  console.error('[DEBUG binMapper canonical output]', {
    metadata,
    channelLabels: metadata.channelLabels,
    signalColumn: metadata.signalColumn,
    channels: channels.map(channel => ({
      label: channel.label,
      waveformLength: channel.waveform?.length,
    })),
    primaryReconstruction: primaryRecon,
  });


  return {
    packet: {
      waveform,
      arrays: channels.map(c => ({ label: c.label, waveform: c.waveform })),
      channels: channels.map(c => ({ label: c.label, waveform: c.waveform })),
      metadata: {
        ...metadata,
        reconstruction: primaryRecon,
        channelLabels:
          metadata.channelLabels ??
          channels.map(channel => channel.label),
      },
    },

    capturedVars:
      mapped.capturedVars ?? {},
  };

}