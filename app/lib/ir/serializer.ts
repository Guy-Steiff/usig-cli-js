/**
 * app/lib/ir/serializer.ts
 * IR serialization - portable binary exchange format for SignalFrames.
 */

import type { SignalFrame, SerializedIR } from './types';
import type { WaveformMetadata } from '../ingest/types';
import { IR_SCHEMA_VERSION } from './cache';

export function serializeFrame(frame: SignalFrame): SerializedIR {
  const { packet, ...rest } = frame;
  const frameHeaders = (frame as SignalFrame & { headers?: string[] }).headers ?? [];
  const { waveform, metadata, arrays, channels } = packet;

  const normalizedWaveform =
    waveform instanceof Float32Array
      ? waveform
      : new Float32Array(waveform);

  const sourceArrays =
    arrays?.length
      ? arrays
      : channels?.length
        ? channels
        : normalizedWaveform.length > 0
          ? [{
              label: metadata.channelLabels?.[0] ?? frameHeaders[0],
              waveform: normalizedWaveform,
            }]
          : [];


  const normalizedArrays = sourceArrays.map((array) => ({
    label: array.label ?? '',
    waveform:
      array.waveform instanceof Float32Array
        ? array.waveform
        : new Float32Array(array.waveform),
  }));

  const totalElements = normalizedArrays.reduce(
    (total, array) => total + array.waveform.length,
    0,
  );

  const combinedWaveform = new Float32Array(totalElements);
  const arrayDescriptors: SerializedArrayDescriptor[] = [];

  let elementOffset = 0;

  for (const array of normalizedArrays) {
    combinedWaveform.set(array.waveform, elementOffset);

    arrayDescriptors.push({
      label: array.label,
      byteOffset: elementOffset * Float32Array.BYTES_PER_ELEMENT,
      byteLength: array.waveform.byteLength,
      length: array.waveform.length,
    });

    elementOffset += array.waveform.length;
  }

  const metaObj = {
    ...rest,
    metadata,
    waveformByteLength: normalizedWaveform.byteLength,
    waveformLength: normalizedWaveform.length,
    waveformType: 'Float32Array',
    waveformEncoding: 'Float32Array',
    waveformBytesPerElement: 4,
    payloadByteLength: combinedWaveform.byteLength,
    arrays: arrayDescriptors,
  };

  const waveformCopy = combinedWaveform.buffer.slice(
    combinedWaveform.byteOffset,
    combinedWaveform.byteOffset + combinedWaveform.byteLength,
  ) as ArrayBuffer;

  return { meta: JSON.stringify(metaObj), waveform: waveformCopy };

}

type SerializedArrayDescriptor = {
  label: string;
  byteOffset: number;
  byteLength: number;
  length: number;
};

type MetaJSON = Omit<SignalFrame, 'packet'> & {
  metadata: WaveformMetadata;
  waveformByteLength: number;
  waveformLength: number;
  waveformType: string;
  waveformBytesPerElement?: number;
  payloadByteLength?: number;
  arrays?: SerializedArrayDescriptor[];
};

export function deserializeFrame(meta: string, waveform: ArrayBuffer): SignalFrame {
  const obj = JSON.parse(meta) as MetaJSON;
  const serializedSchemaVersion = String(obj.schemaVersion);
  const currentSchemaVersion = String(IR_SCHEMA_VERSION);

  const schemaVersionCompatible =
    serializedSchemaVersion === currentSchemaVersion ||
    serializedSchemaVersion === '1';

  if (!schemaVersionCompatible) {
    throw new Error(
      `IR schema version mismatch: expected ${currentSchemaVersion}, got ${obj.schemaVersion}.`,
    );
  }

  const expectedPayloadByteLength = obj.payloadByteLength ?? obj.waveformByteLength;

  if (waveform.byteLength !== expectedPayloadByteLength) {
    throw new Error(
      `IR waveform buffer mismatch: expected ${expectedPayloadByteLength}, got ${waveform.byteLength}.`,
    );
  }

  const {
    metadata,
    waveformByteLength: _b,
    waveformLength: _l,
    payloadByteLength: _p,
    arrays: serializedArrays,
    ...rest
  } = obj;

  const payload = new Float32Array(waveform);

  if (!serializedArrays?.length) {
    return {
      ...rest,
      packet: {
        waveform: payload,
        metadata,
      },
    };
  }

  const restoredArrays = serializedArrays.map((array) => {
    const start = array.byteOffset;
    const end = start + array.byteLength;

    if (start < 0 || end > waveform.byteLength || end < start) {
      throw new Error(
        `IR array buffer mismatch for "${array.label}": offset ${start}, byteLength ${array.byteLength}, payload ${waveform.byteLength}.`,
      );
    }

    if (array.byteLength !== array.length * Float32Array.BYTES_PER_ELEMENT) {
      throw new Error(
        `IR array length mismatch for "${array.label}": expected ${array.length * Float32Array.BYTES_PER_ELEMENT} bytes, got ${array.byteLength}.`,
      );
    }

    return {
      label: array.label,
      waveform: new Float32Array(waveform.slice(start, end)),
    };
  });

  return {
    ...rest,
    packet: {
      waveform: restoredArrays[0].waveform,
      arrays: restoredArrays,
      channels: restoredArrays,
      metadata,
    },
  };

}

export function serializeFrameBundle(frames: SignalFrame[]): {
  metas: string[];
  waveforms: ArrayBuffer[];
} {
  const metas: string[] = [];
  const waveforms: ArrayBuffer[] = [];
  for (const frame of frames) {
    const { meta, waveform } = serializeFrame(frame);
    metas.push(meta);
    waveforms.push(waveform);
  }
  return { metas, waveforms };
}

export function deserializeFrameBundle(
  metas: string[],
  waveforms: ArrayBuffer[],
): SignalFrame[] {
  if (metas.length !== waveforms.length) {
    throw new Error(`IR bundle length mismatch: ${metas.length} metas vs ${waveforms.length} waveforms.`);
  }
  return metas.map((meta, i) => deserializeFrame(meta, waveforms[i]));
}

export function unpackSerializedIR(buf: Buffer) {
  const magic = Buffer.from('USIGIR1\n', 'ascii');

  if (buf.length < 12 || !buf.subarray(0, 8).equals(magic)) {
    throw new Error('Not a USIG IR binary container.');
  }

  const metaLen = buf.readUInt32LE(8);

  const metaStart = 12;
  const metaEnd = metaStart + metaLen;

  if (metaEnd > buf.length) {
    throw new Error('Corrupt USIG IR container.');
  }

  const waveformBuffer = Buffer.from(
  buf.subarray(metaEnd)
);

  return {
    meta: buf.subarray(metaStart, metaEnd).toString('utf8'),

    waveform: waveformBuffer.buffer.slice(
      waveformBuffer.byteOffset,
      waveformBuffer.byteOffset + waveformBuffer.byteLength
    ) as ArrayBuffer,
  };
}