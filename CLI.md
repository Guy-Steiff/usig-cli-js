# usig CLI — Headless Batch Processing Guide

`usig.mjs` is a command-line interface for running analysis plugins and conversion/probe workflows on signal capture files.

It is designed around the same IR ingestion layer used by the app pipeline:

- ingest once
- run one or more plugins
- emit report text/json/csv/yaml

---

## 1) Introduction

The CLI has three modes:

1. **Plugin analysis mode** (run `smeas`, `sinl`, `hsioalpha`, etc.)
2. **Conversion mode** (`--mux bin` / `--demux csv`)
3. **Metadata probe mode** (`--probe-metadata`)

Primary executable:

```bash
node /Users/gsm/projects/image_site/usig.mjs
```

---

## 2) Working Examples

### 2.1 Plugin Analysis (single plugin)

```bash
node /Users/gsm/projects/image_site/usig.mjs \
  -i /Users/gsm/projects/image_site/smeas_kpi_nodup.csv \
  -plugin smeas \
  -p fsGhz=2.25 \
  -p fftLength=8192 \
  -p numAveraging=4 \
  -p window=auto \
  -of json
```

### 2.2 Plugin Analysis (multi-plugin in one run)

```bash
node /Users/gsm/projects/image_site/usig.mjs \
  -i /Users/gsm/projects/image_site/smeas_kpi_nodup.csv \
  -plugin sinl,smeas \
  -of text
```

### 2.3 Conversion: CSV/TXT/BIN-ingestable input to USIG BIN

```bash
node /Users/gsm/projects/image_site/usig.mjs \
  -i /Users/gsm/projects/image_site/smeas_kpi_nodup.csv \
  --mux bin \
  --infer-meta-from-filename \
  --embed runId=demo01 \
  --name-from-metadata \
  /Users/gsm/projects/image_site/out.bin
```

### 2.4 Conversion: USIG BIN to CSV

```bash
node /Users/gsm/projects/image_site/usig.mjs \
  -i /Users/gsm/projects/unified_signal/test/samples/DSOX1102G/single.bin \
  --demux csv \
  /Users/gsm/projects/image_site/out.csv
```

### 2.5 Metadata probe (minimal read)

```bash
node /Users/gsm/projects/image_site/usig.mjs \
  -i /Users/gsm/projects/unified_signal/test/samples/DSOX1102G/single.bin \
  --probe-metadata \
  -of json
```

### 2.6 Verbose run with positional output

```bash
node /Users/gsm/projects/image_site/usig.mjs \
  -i /Users/gsm/projects/image_site/smeas_kpi_nodup.csv \
  -plugin smeas \
  -v \
  /Users/gsm/projects/image_site/report.txt
```

### 2.7 Sample slicing (ffmpeg-style indices)

```bash
node /Users/gsm/projects/image_site/usig.mjs \
  -i /Users/gsm/projects/image_site/smeas_kpi_nodup.csv \
  -plugin smeas \
  --start-sample 1024 \
  --end-sample 12287 \
  -p fsGhz=2.25 \
  -of json
```

---

## 3) Arguments and Flags

### 3.1 Input and plugin selection

- `-i <path>` input path (CLI consumes one resolved path string)
- `-plugin <id[,id2]>` plugin ids
  - supports comma-separated ids
  - supports repeated `-plugin`
  - supports space-separated ids after `-plugin`

Example forms:

```bash
node usig.mjs -i data.csv -plugin smeas
node usig.mjs -i data.csv -plugin sinl,smeas
node usig.mjs -i data.csv -plugin sinl -plugin smeas
```

### 3.2 Parameter overrides

- `-p key=value` repeatable
- Values are auto-coerced:
  - `true` / `false` -> boolean
  - numeric strings -> number
  - otherwise -> string

### 3.3 Output formatting

- `-of <fmt>`
- `--format <fmt>` (alias)
- `-print_format <fmt>` (alias)

Supported formats:

- `text` (default)
- `json`
- `csv`
- `yaml`

### 3.4 Verbosity and help

- `-v` or `--verbose` or bare `verbose`
- `-h` or `--help`

### 3.5 Conversion flags

- `--mux bin`
- `--demux csv`
- `--infer-meta-from-filename`
- `--embed key=value` (repeatable)
- `--name-from-metadata`
- `--meta-to-filename`

### 3.6 Probe and channel flags

- `--probe-metadata`
- `--channel-index <n>` (alias: `--channel <n>`) is parsed
- `--start-sample <n>` 0-based first sample index (inclusive)
- `--end-sample <n>` 0-based last sample index (inclusive)

---

## 4) Mode Semantics

### 4.1 Plugin analysis mode

Entry condition: `-i` + at least one `-plugin`.

Flow:

1. Parse args.
2. Resolve plugin aliases (`hsio` -> `hsioalpha`).
3. Validate plugin files exist.
4. Ingest once via IR (`IREngine.getOrIngest`).
5. Run each plugin on the shared frame (`runFromWaveform` when available).
6. Emit combined output.

### 4.2 Conversion mode

Entry condition: `--mux` or `--demux`.

Rules:

- `--mux` and `--demux` are mutually exclusive.
- Supported today:
  - mux target: `bin`
  - demux target: `csv`
- `--demux xlsx` is rejected in this path.

### 4.3 Probe mode

Entry condition: `--probe-metadata`.

Minimal-read behavior:

- `.csv` / `.txt`: streamed line scan for headers + uniqueness counts
- `.xlsx`: streamed worksheet reader
- `.bin`: USIG header check first, then external BIN header parse (full-read fallback only if parse error)

Probe output can include:

- `probe.fileType`
- `probe.availableColumns`
- `probe.columnCount`
- `probe.uniqueValueCountByColumn`
- BIN-derived fields such as `sampleRateHz`, `numSamples`, `numWaveforms`, `channelIndices`
- `singleValueColumns`
- `ingestError`

---

## 5) Architecture

`usig.mjs` is an IR-centric CLI.

Core idea:

- raw file -> ingest layer -> canonical `SignalFrame` / waveform packet
- plugins consume waveform packet, not raw CSV text parsing in plugin code

Relevant components:

- `app/lib/ir/index.ts` for IR engine and serialization helpers
- `app/lib/ingest/ingest.ts` for format-specific ingestion
- `app/components/plugins/*Plugin.tsx` for analyzers

Runtime pattern in plugin mode:

- one ingest
- many plugin runs
- one merged report

This keeps behavior consistent across plugin combinations and avoids repeated parsing work.

---

## 6) Current Limitations (as of current usig.mjs)

- No `--dry-run` flag.
- No `-loglevel` flag.
- No `-o` flag (output is positional).
- Report output format does not include `xlsx`.
- Shell glob expansion is shell-dependent; CLI does not implement its own glob walker.
- `--channel-index` / `--channel` is parsed and probe logic can show channel metadata; verify end-to-end channel selection in your specific plugin/conversion path if that behavior is critical.

---

## 7) Quick Troubleshooting

### Plugin not found

Check expected plugin file path exists:

```bash
ls /Users/gsm/projects/image_site/app/components/plugins/smeasPlugin.tsx
```

### Unsupported format

Use one of:

- `text`
- `json`
- `csv`
- `yaml`

### Sanity check CLI health

```bash
cd /Users/gsm/projects/image_site
node --check usig.mjs
```
