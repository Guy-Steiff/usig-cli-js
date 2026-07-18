/**
 * app/lib/ir/index.ts
 *
 * Public entry point for the IR (Intermediate Representation) module.
 *
 * Import from here, not from internal sub-modules:
 *
 *   import { IREngine, IRCache, serializeFrame, deserializeFrame } from '../lib/ir';
 *   import type { SignalFrame, IRManifestEntry, SerializedIR } from '../lib/ir';
 */

// ── Types ──────────────────────────────────────────────────────────────────
export type { SignalFrame, IRManifestEntry, SerializedIR } from './types';

// ── Cache ──────────────────────────────────────────────────────────────────
export { IRCache, IR_SCHEMA_VERSION, fileFingerprint, hintsKey } from './cache';

// ── Engine ─────────────────────────────────────────────────────────────────
export { IREngine } from './engine';
export type { IREngineStats } from './engine';

// ── Serializer ─────────────────────────────────────────────────────────────
export {
  serializeFrame,
  deserializeFrame,
  serializeFrameBundle,
  deserializeFrameBundle,
} from './serializer';

