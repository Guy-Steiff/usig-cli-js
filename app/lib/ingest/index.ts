/**
 * app/lib/ingest/index.ts
 * Public re-export barrel for the ingestion layer.
 */
export { ingestFile, ingestAllColumns, extractCapturedVarsFromFilename } from './ingest';
export type { IngestHints, IngestColumnsResult } from './ingest';
export type { WaveformPacket, WaveformMetadata, WaveformMetadataRequired, WaveformMetadataOptional, SourceFormat, SignalUnits } from './types';

