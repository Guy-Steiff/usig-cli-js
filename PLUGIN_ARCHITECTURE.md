# Plugin Architecture: IR Layer & Multi-Plugin Cohabitation

## TL;DR

✅ **YES** — We ARE using an IR (Intermediate Representation) layer!  
✅ **YES** — Both SMEAS and SINL can already run on the same file in one go!

## The IR Layer (WaveformPacket)

### What It Is

The **WaveformPacket** is a canonical data model that represents ingested signal data:

```typescript
// From app/lib/ingest.ts
export interface WaveformPacket {
  waveform: Float32Array;              // The actual signal samples
  metadata: WaveformMetadata;          // File info, sampling rate, units, etc.
}

export interface WaveformMetadata {
  sourceFile?: string;
  sampleRateHz?: number;
  numSamples: number;
  units?: 'codes' | 'volts';          // Auto-detected
  vfsPeakToPeak?: number;              // Auto-measured
  // ... other metadata
}
```

### How It Works

1. **IR Engine** (`app/lib/ir.ts`):
   - Ingests files (CSV, binary, etc.) via the ingestion layer
   - Returns cached `WaveformPacket` for subsequent access
   - Supports per-plugin custom ingestion hints

2. **Plugin Integration** (`app/lib/pluginTypes.ts`):
   - Plugins declare `getIngestHints()` to specify which column/parameters to use
   - Plugins implement `runFromWaveform()` and `prepareDataFromWaveform()` to process the packet
   - Fallback to `run()` and `prepareData()` for legacy plugins that only accept File

## Multi-Plugin Cohabitation

The pipeline **already supports running multiple plugins on the same file**.

### Evidence from PipelineBlock.tsx

**File:** `/Users/gsm/projects/image_site/app/components/PipelineBlock.tsx`

#### Step 1: Single Ingestion (lines 1480-1491)

```typescript
// Ingest file ONCE via IR engine
const baseFrame = await irEngineRef.current.getOrIngest(entry.file);
let basePacket = baseFrame.packet;
```

#### Step 2: Loop Over Selected Plugins (lines 1496)

```typescript
for (const plugin of selectedPlugins) {
  // Each plugin gets its own hints-specific packet (if needed)
  const pluginHints = plugin.getIngestHints 
    ? plugin.getIngestHints(params) 
    : undefined;
  const waveformPacket = pluginHints
    ? (await irEngineRef.current.getOrIngest(entry.file, pluginHints)).packet
    : basePacket;
```

#### Step 3: Run Each Plugin (lines 1561-1563)

```typescript
const pluginResult = plugin.runFromWaveform
  ? await plugin.runFromWaveform(waveformPacket, params)
  : await plugin.run(entry.file, params);  // fallback
```

#### Step 4: Collect Data Per Plugin (lines 1581-1598)

```typescript
// Each plugin's figure data is keyed by pluginId
const prevFigureData = updatedEntries[i].figureDataByPlugin ?? {};
updatedEntries[i] = {
  ...updatedEntries[i],
  figureDataByPlugin: {
    ...prevFigureData,
    [plugin.id]: prepResult.figureData  // No overwrites!
  },
  debugTables: [...prevDebugTables, ...newDebugTables],
};
```

#### Step 5: Conflict Resolution (lines 1644-1654)

```typescript
// Detect columns that appear in multiple plugins
const columnToPlugins: Record<string, string[]> = {};
for (const { pluginId, result } of pluginResults) {
  for (const colName of Object.keys(result)) {
    if (!columnToPlugins[colName]) columnToPlugins[colName] = [];
    columnToPlugins[colName].push(pluginId);
  }
}
// User is prompted to resolve conflicts via renaming
```

## Plugin Implementation Status

| Plugin | `runFromWaveform()` | `prepareDataFromWaveform()` | `getIngestHints()` | Status |
|--------|-------------------|---------------------------|------------------|--------|
| SMEAS | ✅ Line 3022 | ✅ Line 3034 | ✅ Line 2991 | Full IR support |
| SINL | ✅ Line 895 | ✅ Line 940 | ✅ Line 860 | Full IR support |
| HSIO | ? (needs check) | ? (needs check) | ? (needs check) | TBD |
| SHIO | ? (needs check) | ? (needs check) | ? (needs check) | TBD |

## How to Use: Run SMEAS + SINL on Same File

### Via Web UI

1. Upload a file to PipelineBlock
2. In the plugin selector, choose **both** "SMEAS" and "SINL"
3. Configure parameters for each plugin separately
4. Click "Run"
5. Both plugins process the ingested file
6. Output CSV contains columns from both plugins
7. Figure data is shown per plugin in separate tabs

### Via CLI (usig.mjs) — Not Yet Supported

Currently `usig.mjs` runs a **single** plugin. To add multi-plugin support:

```bash
# Current (single plugin):
node usig.mjs -i data.csv -plugin smeas -p fsGhz=2.25 output.csv

# Proposed (multi-plugin):
# node usig.mjs -i data.csv -plugin smeas,sinl -p smeas.fsGhz=2.25 -p sinl.sampleColumn=codes output.csv
```

This would require updating usig.mjs to:
- Accept multiple plugins
- Orchestrate the IR engine
- Merge outputs with conflict resolution

## Architecture Benefits

🎯 **Efficiency** — Single ingestion, multiple analyses (no re-parsing)  
🎯 **Consistency** — All plugins work on the same numerical foundation  
🎯 **Extensibility** — New plugins automatically integrate without changes  
🎯 **Safety** — Per-plugin figure data/debug tables never collide  
🎯 **Flexibility** — Users choose which plugins to run; pipeline handles orchestration

## Next Steps for Full Cohabitation

If you want to extend this further:

1. **CLI multi-plugin support** — Update usig.mjs to accept multiple plugins
2. **Batch mode** — Run same set of plugins across multiple files
3. **Plugin ordering** — Allow plugins to declare dependencies/ordering
4. **Cross-plugin data sharing** — Let one plugin consume another's output

All infrastructure is already in place — it's just not exposed at the CLI level yet!

