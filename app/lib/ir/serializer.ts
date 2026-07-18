/**
 * app/lib/ir/serializer.ts
 * IR serialization - portable binary exchange format for SignalFrames.
 */

import type { SignalFrame, SerializedIR } from './types';
import type { WaveformMetadata } from '../ingest/types';
import { IR_SCHEMA_VERSION } from './cache';

export function serializeFrame(frame: SignalFrame): SerializedIR {
  const { packet, ...rest } = frame;
  const { waveform, metadata } = packet;
   const normalizedWaveform =
    waveform instanceof Float32Array
      ? waveform
      : new Float32Array(waveform);

  const metaObj = {
    ...rest,
    metadata,
    waveformByteLength: normalizedWaveform.byteLength,
    waveformLength: normalizedWaveform.length,
    waveformType: 'Float32Array',
    waveformEncoding: 'Float32Array',
    waveformBytesPerElement: 4,
  };
  const waveformCopy = normalizedWaveform.buffer.slice(
    normalizedWaveform.byteOffset,
    normalizedWaveform.byteOffset + normalizedWaveform.byteLength,
  ) as ArrayBuffer;
  return { meta: JSON.stringify(metaObj), waveform: waveformCopy };
}

type MetaJSON = Omit<SignalFrame, 'packet'> & {
  metadata: WaveformMetadata;
  waveformByteLength: number;
  waveformLength: number;
  waveformType: string;
  waveformBytesPerElement?: number;
};

export function deserializeFrame(meta: string, waveform: ArrayBuffer): SignalFrame {
  const obj = JSON.parse(meta) as MetaJSON;
  if (obj.schemaVersion !== IR_SCHEMA_VERSION) {
    throw new Error(
      `IR schema version mismatch: expected ${IR_SCHEMA_VERSION}, got ${obj.schemaVersion}.`,
    );
  }
  if (waveform.byteLength !== obj.waveformByteLength) {
    throw new Error(
      `IR waveform buffer mismatch: expected ${obj.waveformByteLength}, got ${waveform.byteLength}.`,
    );
  }
  const { metadata, waveformByteLength: _b, waveformLength: _l, ...rest } = obj;
  const restoredWaveform = new Float32Array(waveform);

  return {
    ...rest,
    packet: {
      waveform: restoredWaveform,
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
