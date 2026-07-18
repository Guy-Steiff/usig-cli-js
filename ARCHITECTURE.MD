# Software Architecture Reference

Platform: Guy Steiff ADC & HSIO Validation Platform
Runtime:  Browser (Next.js/React) + CLI (Node.js ESM)
Date:     2026-06-29

---

## Overview

The platform is built on three concentric layers, each with a single responsibility:

  Layer 1 — Ingestion     app/lib/ingest/
    Raw File bytes -> WaveformPacket

  Layer 2 — IR Cache      app/lib/ir/
    WaveformPacket + columnar metadata -> SignalFrame (cached)

  Layer 3 — Plugin Analysis   app/components/plugins/
    SignalFrame -> scalar KPIs + figures + debug tables

All three layers share the same TypeScript types and run identically in the browser
and in the usig CLI. No layer reaches down past its boundary: plugins never read files,
ingestion never runs analysis, the IR cache never modifies data.

---

## Layer 1: Ingestion

### Rule

app/lib/ingest/ingest.ts is THE ONLY file in the JS codebase that reads raw File bytes
for signal data. No plugin, no component, no test may call the File API directly.

### Entry Points

  ingestFile(file: File, hints?: IngestHints): Promise<WaveformPacket>

    THE primary entry point. Reads the file, detects format, parses samples, returns
    a normalized WaveformPacket containing a Float32Array and WaveformMetadata.
    Plugins must not call this directly — use IREngine instead.

  ingestAllColumns(file: File): Promise<IngestColumnsResult>

    Parses all columns from a file without selecting a single signal column.
    Used by the UI at file-add time for header population, column-select heuristic,
    single-value column detection, and capturedVars extraction.

### Format Detection (detectFormat)

  magic bytes 'AG' or 'RG'             -> 'bin'  (Keysight / Rigol oscilloscope)
  extension '.bin' or '.raw'           -> 'bin'
  extension '.csv'                     -> 'csv'
  extension '.txt' / '.dat' / '.tsv' / '.asc' -> 'txt'
  everything else                      -> 'txt' (fallback)

### Format Parsers

Binary (ingestBin):
  - Reads Keysight/Agilent (AG magic) and Rigol (RG magic) binary waveform formats.
  - Extracts sampleRateHz, yUnits, bitsPerPoint from file header via parseBinMetadata()
    (implemented in app/lib/binReader.ts).
  - Heuristic for float32 oscilloscope captures: if bitsPerPoint=4 and sample range is
    within +-1000V, sets units='volts'.
  - Computes vfsPeakToPeak from actual sample range (for smeas auto-seeding).

CSV (ingestCsv):
  - Auto-detects delimiter: tab preferred over comma.
  - Column selection: hints.signalColumn exact match, else most-unique-values heuristic.
  - Optional fsGhzColumnRegex: extracts sample rate from a constant-valued column.
  - preserveBinIndex mode: keeps row order, substitutes -Infinity for non-numeric cells
    (used for single_sided_power_spectrum input mode in SMEAS).

TXT (ingestTxt):
  - Handles flat (one value per line) and columnar (multiple values per line).
  - Strips comment lines starting with '#' (Python/numpy convention).
  - Auto-detects delimiter: tab > multi-space > comma > semicolon.
  - Header detection: first line with any non-numeric token is treated as header.
  - Column selection: by header name, by 0-based numeric index string, or by heuristic.

### WaveformPacket

The output of every ingest call. The canonical unit of signal data.

  interface WaveformPacket {
    waveform: Float32Array;      // normalized sample array
    metadata: WaveformMetadata;
  }

  interface WaveformMetadata {
    sampleRateHz: number;        // Hz (0 = unknown)
    dtype: string;               // 'int8' | 'int16' | ... | 'float64'
    numSamples: number;
    sourceFormat: string;        // 'csv' | 'txt' | 'bin' | ...
    units?: string;              // 'volts' | 'adc_codes' | ...
    vfsPeakToPeak?: number;      // full-scale range (volts), if known
    bitDepth?: number;
    inferredFields?: string[];   // which fields were inferred
    ...                          // see app/lib/ingest/types.ts for full list
  }

### IngestHints

User/pipeline overrides. Passed through from plugin.getIngestHints() via IREngine.

  interface IngestHints {
    sampleRateHz?: number;        // override sample rate
    signalColumn?: string;        // exact column name or 0-based index (TXT)
    fsGhzColumnRegex?: string;    // regex to find fs column in CSV
    preserveBinIndex?: boolean;   // for single_sided_power_spectrum mode
    dtype?: string;               // for generic binary
    endianness?: 'little' | 'big';
    headerBytes?: number;         // bytes to skip for generic binary
    units?: string;               // physical units of the signal
    maxSamples?: number;          // cap ingestion for thumbnails/previews
  }

### Metadata Precedence

  1. hints (user/pipeline overrides)     highest priority
  2. Embedded file metadata              binary headers, CSV column names
  3. Inferred                            marked in inferredFields[]

---

## Layer 2: IR Cache

### Files

  app/lib/ir/
    types.ts      SignalFrame, IRManifestEntry, SerializedIR
    cache.ts      IRCache class + fileFingerprint() + hintsKey()
    engine.ts     IREngine orchestrator
    serializer.ts serializeFrame(), deserializeFrame()
    index.ts      public re-exports

### SignalFrame

The canonical IR unit. Each (file x hints) combination has exactly one SignalFrame.

  interface SignalFrame {
    packet: WaveformPacket;                     // primary signal data
    headers: string[];                          // all column names
    singleValueColumns: Record<string,string>;  // constant-value columns -> value
    capturedVars: Record<string,number>;        // filename-extracted SI values
    cacheKey: string;                           // "name:size:lastModified"
    hintsKey: string;                           // '' | JSON of active IngestHints
    ingestedAt: number;                         // unix ms
    schemaVersion: string;                      // '1.0.0'
  }

  capturedVars keys: 'fs_hz', 'fin_hz', 'adc_bits', 'vfs_pp'
  (SI base units: Hz, Hz, bits, V)

### Cache Key Design

  fileFingerprint(file: File): string
    -> "name:size:lastModified"
    Identifies the source file without hashing its content. Sufficient to detect
    re-drops of a modified file (lastModified changes when the file is re-saved).

  hintsKey(hints?: IngestHints): string
    -> '' for the base frame (no hints, heuristic column selection)
    -> stable JSON of active hint fields with sorted keys for any other frame
    Fields considered: sampleRateHz, signalColumn, fsGhzColumnRegex,
                       preserveBinIndex, dtype, endianness, headerBytes, units, maxSamples

  storeKey = fileFingerprint + '::' + hintsKey

A single file can have multiple cached SignalFrames:
  - one base frame (empty hints, heuristic column)
  - one per unique IngestHints set requested by plugins

### IREngine API

  class IREngine {

    // Combined file-add: get columns AND pre-warm base frame (2 reads max)
    async getOrIngestWithColumns(file: File): Promise<IngestColumnsResult>

    // Get SignalFrame — 0 reads on cache hit, 1 read on miss
    async getOrIngest(file: File, hints?: IngestHints): Promise<SignalFrame>

    // Get columnar data only (no waveform cache)
    async getColumnarData(file: File): Promise<IngestColumnsResult>

    // Invalidate all frames for a file (called on file removal)
    invalidate(file: File): void

    // Clear entire cache (called on pipeline reset)
    clear(): void

    // Hit/miss statistics + current cache size
    getStats(): IREngineStats     // { hits: number, misses: number, size: number }

    // JSON-safe manifest of all cached frames (debug / export)
    getManifest(): IRManifestEntry[]
  }

### Data Flow in PipelineBlock (app/components/PipelineBlock.tsx)

  addFiles(files):
    for each file:
      colsResult = await irEngineRef.current.getOrIngestWithColumns(file)
      // 2 reads: ingestAllColumns() + ingestFile() for base frame
      // subsequent calls are cache hits (0 reads)

  runPipeline():
    for each file:
      baseFrame = await irEngineRef.current.getOrIngest(entry.file)
      // cache HIT (0 reads) — base frame pre-warmed at file-add time
      basePacket = baseFrame.packet

      for each plugin:
        hints = plugin.getIngestHints(params)
        waveformPacket = hints
          ? (await irEngineRef.current.getOrIngest(entry.file, hints)).packet
          // cache HIT if same column as previous run; MISS (1 read) on first use
          : basePacket
        result = await plugin.runFromWaveform(waveformPacket, params)

  removeFile(name):
    irEngineRef.current.invalidate(file)   // frees all frames for this file

  clearAllFiles():
    irEngineRef.current.clear()            // frees entire cache

### Read Count Summary

  Phase                       Old flow        IR flow (steady state)
  File add                    1 read          2 reads (cols + base), then 0
  Run — base frame            1 read          0 reads
  Run — per-plugin hints      1 read/plugin   0 reads (cache hit)
  Re-run same params          1 + N reads     0 reads
  Re-run new hints            1 + N reads     1 read per new hintsKey

### Serialization (portable binary exchange)

  // app/lib/ir/serializer.ts

  const { meta, waveform } = serializeFrame(frame)
  // meta:     JSON string (all fields except waveform Float32Array)
  // waveform: raw ArrayBuffer (Float32 bytes, compatible with numpy.frombuffer)

  const frame2 = deserializeFrame(meta, waveform)
  // throws if schemaVersion mismatch or byte length mismatch

  // Multi-frame bundles (IR export files / IndexedDB blobs)
  const { metas, waveforms } = serializeFrameBundle(frames)
  const frames2 = deserializeFrameBundle(metas, waveforms)

---

## Layer 3: Plugin System

### Plugin Interface (app/lib/pluginTypes.ts)

  interface Plugin<P = Record<string, string>> {
    id:           string;
    name:         string;
    manifest:     PluginManifest;        // JSON-safe metadata
    defaultParams: P;
    paramFields?: InferredParamField[];  // runtime UI + regex inference declarations

    // Standard scalar output (required)
    run(file: File, params: P): Promise<Record<string, string | number>>

    // Preferred path for new plugins (receives WaveformPacket, not File)
    runFromWaveform?(packet: WaveformPacket, params: P): Promise<Record<string, string | number>>
    prepareDataFromWaveform?(packet: WaveformPacket, params: P): Promise<{ figureData?, debugTables? }>

    // Optional rich output via File (legacy path)
    prepareData?(file: File, params: P): Promise<{ figureData?, debugTables? }>
    figures?: PluginFigure[]

    // Tells the IR engine which column / hints to use
    getIngestHints?(params: P): IngestHints

    // Called when any param changes (for linked/derived fields)
    onParamChange?(changedKey: string, params: P): Partial<P> | null

    // Pipeline-level captured vars this plugin wants auto-populated from filename
    capturedVarsRequests?: Array<{ capturedKey: string; paramKey: string }>

    outputColumns?: string[]    // declared output column names
  }

### Plugin Registry

  app/components/plugins/pluginRegistry.ts
  PLUGINS: Plugin[] = [sinlPlugin, smeasPlugin, hsioPlugin, minimalPlugin, minimalPlotPlugin]

### Parameter Scoping

Each InferredParamField carries defaultScope: 'global' | 'per-file':

  global:   one value shared across all files. Rendered in the plugin card.
  per-file: one value per file. Rendered as a column in the file table.
            Auto-seeded from filename regex.

The user can flip any field between scopes at runtime via the scope toggle button.
paramScopeOverrides in localStorage persists these overrides across sessions.

---

## Filename Parameter Inference — Two-Level System

### Level 1: Pipeline Captured Vars (domain-agnostic, ingest.ts)

  extractCapturedVarsFromFilename(filename) -> { fs_hz, fin_hz, adc_bits, vfs_pp }

Runs on every file at add-time. Results stored in IngestColumnsResult.capturedVars and
in each SignalFrame.capturedVars.

  Key       Matches                         Example                    Value (SI)
  --------- ------------------------------- -------------------------- ----------
  fs_hz     fs{N}p{M}ghz, fs{N}mhz,        fs2p25ghz                  2.25e9 Hz
            sample_rate_1e9, FS_2250MHz     sample_rate_1e9            1.0e9 Hz
  fin_hz    fin{N}mhz, f_in_{N}MHz,        fin100mhz                  1e8 Hz
            finused{N}p{M}mhz              finused599p93mhz           5.9993e8 Hz
  adc_bits  {N}bit, {N}b, adc{N}           12bit, adc16               12
  vfs_pp    vfs{N}p{M}v, vpp{N}v           vfs2p0v, vpp1p8v           2.0 V

Plugins consume these via capturedVarsRequests:

  capturedVarsRequests: [
    { capturedKey: 'fs_hz',    paramKey: 'fsGhz' },
    { capturedKey: 'adc_bits', paramKey: 'adcNumBits' },
    { capturedKey: 'vfs_pp',   paramKey: 'vfsPeakToPeak' },
  ]

The pipeline in PipelineBlock.tsx applies capturedVarsRequests first (step 1), then
plugin-specific regex (step 2) which can override.

### Level 2: Plugin-Specific Regex (per InferredParamField.defaultRegex)

Each plugin declares field-level regex patterns for finer-grained extraction. Example
from smeasPlugin:

  {
    key:          'fsGhz',
    defaultRegex: 'fs(\\d+(?:p\\d+)?(?:mhz|ghz)?)',
    defaultReplace: '',
    transform: (raw) => { /* parse MHz/GHz token to float GHz */ }
  }

applyRegexToFilename(filename, regex, replace) extracts the first capture group,
applies replacement pairs, and passes the result through transform().

Two-capture-group convention: if the regex has two capture groups, they are joined
with '.' to handle p-encoded decimals:

  regex:    'fs(\\d+)p(\\d+)ghz'
  filename: 'fs2p25ghz_data.csv'
  result:   '2.25'   (groups '2' and '25' joined with '.')

### Plugin Hook: getIngestHints(params)

Every plugin that uses a column-select parameter MUST implement getIngestHints so the
IR engine knows which column to extract as the signal waveform:

  getIngestHints: (params: SmeasParams): IngestHints => ({
    signalColumn:     String(params.targetColumn || ''),
    fsGhzColumnRegex: String(params.fsGhzColumnRegex || ''),
    preserveBinIndex: params.inputMode === 'single_sided_power_spectrum',
    sampleRateHz:     Number(params.fsGhz) * 1e9 || 0,
  })

The IR engine calls getIngestHints(params) at run time to compute the hintsKey for
cache lookup. If the same plugin has been run before with the same params, the frame
is a cache hit. If params changed (e.g. user selected a different column), hintsKey
differs and a new ingest is triggered.

### Filename Recommendations for Best Auto-Inference

Use the pattern:  _{word}{integer}p{decimals}{units}_

Example full filename:
  TT_chipA_fs2p25ghz_fin100mhz_12bit_vfs2v_m30c_4core_prbs31_run001.csv

Token guide:

  Token            Pattern              Example           Inferred param
  ---------------- -------------------- ----------------- ----------------
  Sample rate      fs{N}p{M}ghz         fs2p25ghz         fsGhz = 2.25
                   fs{N}ghz             fs100ghz          fsGhz = 100.0
                   fs{N}mhz             fs2250mhz         fsGhz = 2.25
  Input frequency  fin{N}mhz            fin100mhz         fin_hz = 1e8
                   finused{N}p{M}mhz    finused599p93mhz  fin_hz = 5.9993e8
  ADC bits         {N}bit               12bit             adcNumBits = 12
                   adc{N}               adc16             adcNumBits = 16
  Full-scale       vfs{N}p{M}v          vfs2p0v           vfsPeakToPeak = 2.0
                   vpp{N}v              vpp1p8v           vfsPeakToPeak = 1.8
  Temperature      m{N}  (replace m=-)  m30               temp = -30
                   p{N}  (replace p=+)  p85               temp = 85
  TI cores         {N}core / {N}ch      4core             numberOfCores = 4
  Signal type      prbs31 / clock       prbs31            signalType = prbs31
  Process corner   TT_ / SS_ / FF_      TT_               skew = TT

The p-encoding (2p25 instead of 2.25) avoids filesystem issues with decimal points.
Units suffixes (ghz, mhz, khz, hz, v, bit, b) are case-insensitive.

---

## Component Map

  Component           File                                    Role
  ------------------- --------------------------------------- ---------------------------
  PipelineBlock       app/components/PipelineBlock.tsx        Batch processing, IR lifecycle
  FigureViewer        app/components/FigureViewer.tsx         Canvas/Recharts renderer with controls
  WaveformThumbnail   app/components/WaveformThumbnail.tsx    Hover waveform preview
  IREngine            app/lib/ir/engine.ts                    Cache orchestrator
  IRCache             app/lib/ir/cache.ts                     In-memory Map store
  ingestFile          app/lib/ingest/ingest.ts                THE ONLY raw file reader
  pluginTypes         app/lib/pluginTypes.ts                  Plugin interface definitions
  pipelineStorage     app/lib/pipelineStorage.ts              localStorage persistence
  resultInterpretation app/lib/resultInterpretation.ts        Plain-English result badges
  pluginRegistry      app/components/plugins/pluginRegistry.ts PLUGINS array

---

## PipelineBlock Lifecycle (React)

  Mount
    irEngineRef = useRef(new IREngine())   // one engine per session

  addFiles(files)
    for each file f:
      colsResult = await irEngineRef.current.getOrIngestWithColumns(f)
      // Populates headers, singleValueColumns, capturedVars in UI state
      // Caches base SignalFrame for f

  runPipeline()
    setRunning(true)
    for each fileEntry:
      baseFrame = await irEngineRef.current.getOrIngest(fileEntry.file)
      for each activePlugin:
        hints = plugin.getIngestHints(params)
        frame = hints
          ? await irEngineRef.current.getOrIngest(fileEntry.file, hints)
          : baseFrame
        row = await plugin.runFromWaveform(frame.packet, params)
        accumulate row into resultsCSV
    setRunning(false)
    setIrStats(irEngineRef.current.getStats())

  removeFile(name)
    irEngineRef.current.invalidate(file)

  clearAllFiles()
    irEngineRef.current.clear()
    setIrStats(null)

  Unmount / session end
    IREngine garbage-collected (all SignalFrames freed)

---

## CLI Architecture (usig.mjs — planned)

  usig.mjs (Node.js ESM)
    |
    +--> parseArgs()           reads process.argv
    +--> resolveFiles()        expands glob patterns
    +--> loadPluginForCli()    imports plugin by ID from pluginRegistry
    +--> IREngine (singleton)  same cache.ts / engine.ts as browser
    |
    for each file:
      +-- IREngine.getOrIngestWithColumns(file)
      +-- IREngine.getOrIngest(file, hints) -> SignalFrame
      +-- plugin.runFromWaveform(packet, params)
      +-- collect result row
    |
    +--> formatOutput()        csv / json / xlsx
    +--> writeOutput()         stdout or -o file
    +--> [--ir-manifest]       print IREngine.getManifest() to stderr

The CLI uses the same IREngine, ingestFile, and plugin runFromWaveform functions as the
browser. The only browser-specific dependency stubbed in CLI mode is File (replaced with
a Node.js Blob-compatible wrapper using fs.readFile + a synthetic File-like object).

---

## Data Flow Diagram (full system)

  User drops files
       |
       v
  PipelineBlock.addFiles()
       |
       v
  IREngine.getOrIngestWithColumns(file)
       |--- ingestAllColumns(file)  [1 read]   -> headers, singleValueColumns, capturedVars
       |--- ingestFile(file)        [1 read]   -> WaveformPacket (base frame)
       |--- cache.set(fingerprint::, frame)
       v
  UI state updated: headers, column-select, param auto-seed from capturedVars

  User presses Run
       |
       v
  PipelineBlock.runPipeline()
       |
       for each file x plugin:
         |
         v
         IREngine.getOrIngest(file, hints)
               |--- cache.has(fingerprint::hintsKey)?  YES -> return frame [0 reads]
               |                                        NO  -> ingestFile(file, hints) [1 read]
               |                                              -> cache.set(fingerprint::hintsKey, frame)
               v
         frame.packet -> plugin.runFromWaveform(packet, params)
               |
               v
         { snr_c, enob_sndr_fs, eye_height_mv, ... }   [scalar row]
         { figureData, debugTables }                    [per-file rich output]
       |
       v
  Results CSV assembled, figures rendered, debug tables available for download
       |
       v
  [Export CSV/XLSX/JSON] or [Send to PVCJS]