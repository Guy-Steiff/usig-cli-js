# USIG CLI

USIG is a command-line interface for ingesting waveform data into the USIG
canonical intermediate representation (IR), converting between supported file
formats, embedding measurement metadata, and executing waveform-analysis
plugins.

This document describes the user-facing CLI behavior, command syntax, input
and output semantics, metadata inference, plugin execution, conversion, debug
output, and currently known or intended behavior.

The CLI is invoked through Node.js:

```text
node usig.mjs <arguments>
```

If `usig` has been installed as a command, the equivalent form is:

```text
usig <arguments>
```

---

## 1. Command Modes

USIG has two principal operating modes:

1. Conversion mode
2. Plugin analysis mode

There is also a metadata inspection operation and a plugin/debug operation.

The presence or absence of `-plugin` is significant.

### Conversion mode

A conversion is requested by providing an input file and an output file:

```text
node usig.mjs -i <input-file> <output-file> [options]
```

For example:

```text
node usig.mjs -i input.csv output.bin
```

```text
node usig.mjs -i input.bin output.csv
```

```text
node usig.mjs -i input.bin output.xlsx
```

Conversion does not require a plugin.

Conversion uses the same canonical IR representation used by analysis.

### Plugin analysis mode

A plugin invocation is requested by placing `-plugin <plugin-id>` after an
input:

```text
node usig.mjs -i <input-file> -plugin <plugin-id> [options]
```

For example:

```text
node usig.mjs -i waveform.csv -plugin smeas
```

A plugin invocation normally produces its analysis result on the terminal.

There is no requirement for a plugin invocation to have an output file.

### Multiple plugins

Multiple plugin invocations are written as separate `-plugin` options.

They are NOT specified as a comma-separated plugin list.

Correct:

```text
node usig.mjs -i waveform.csv -plugin smeas -plugin sinl
```

Incorrect:

```text
node usig.mjs -i waveform.csv -plugin smeas,sinl
```

Each plugin invocation establishes an action and can have plugin-specific
parameters associated with it.

For example:

```text
node usig.mjs -i waveform.csv \
  -plugin smeas -p foo=1 \
  -plugin sinl -p bar=2
```

means:

```text
smeas receives foo=1
sinl receives bar=2
```

A `-p` following a plugin is therefore associated with that plugin invocation.

---

# 2. Complete CLI Flag Reference

The current CLI help is conceptually organized as follows.

## Core input and execution flags

| Flag | Argument | Purpose |
|---|---|---|
| `-i` | `<file>` | Specify an input waveform file |
| `-plugin` | `<plugin-id>` | Execute a plugin against the preceding/current input |
| `-p` | `<key=value>` | Supply or override a parameter |
| `-of` | `<format>` | Request an analysis-output format |
| `-v` | none | Show additional diagnostic/debug information |
| `-y` | none | Overwrite an existing output file |
| `-h` | none | Show help |
| `-help` | none | Show help |

## Sample-range flags

| Flag | Argument | Purpose |
|---|---|---|
| `-start-sample` | `<n>` | Start processing at sample index `n` |
| `-end-sample` | `<n>` | End processing at sample index `n` |

## Metadata flags

| Flag | Argument | Purpose |
|---|---|---|
| `-probe-metadata` | none | Inspect metadata associated with the input |
| `-infer-meta-from-filename` | none | During conversion, infer metadata from the input filename and embed it in the output |
| `-meta-to-filename` | none | Include metadata in the output filename |

## Debug flags

| Flag | Argument | Purpose |
|---|---|---|
| `-debug` | `<spec>` | Request plugin debug output |

The complete debug specification is described later in this document.

---

# 3. Basic Usage

## Show CLI help

```text
usig -h
```

or:

```text
usig -help
```

The same help may be obtained using:

```text
node usig.mjs -h
```

## Convert a file

```text
usig -i input.csv output.bin
```

## Analyze a file

```text
usig -i waveform.csv -plugin smeas
```

## Analyze with a parameter override

```text
usig -i waveform.csv -plugin smeas -p fsGhz=2.25
```

## Run multiple plugins

```text
usig -i waveform.csv -plugin smeas -plugin sinl
```

## Show diagnostic information

```text
usig -i waveform.csv -plugin smeas -v
```

## Inspect metadata

```text
usig -i waveform.csv -probe-metadata
```

---

# 4. Inputs

## 4.1 `-i`

The `-i` flag specifies an input file:

```text
-i <input-file>
```

Example:

```text
usig -i waveform.csv -plugin smeas
```

The input is ingested into the canonical USIG representation before being
consumed by analysis plugins or conversion.

The canonical representation allows USIG to operate on waveform data without
requiring plugins to understand every physical input file representation.

---

# 5. Conversion Mode

## 5.1 Basic conversion syntax

The basic conversion syntax is:

```text
node usig.mjs -i <input-file> <output-file> [options]
```

Examples:

```text
node usig.mjs -i input.csv output.bin
```

```text
node usig.mjs -i input.bin output.csv
```

```text
node usig.mjs -i input.bin output.xlsx
```

The output filename determines the conversion format.

Currently documented conversion output formats are:

| Extension | Output |
|---|---|
| `.bin` | USIG binary representation |
| `.csv` | CSV representation |
| `.xlsx` | Excel workbook |

JSON output is planned but should not currently be treated as a fully
supported conversion format.

Some JSON compatibility exists in the implementation, but it is not yet
considered sufficiently robust or fully featured to document as a supported
conversion path.

---

# 6. Conversion Is an IR Round Trip

Conversion is not intended to be a collection of unrelated file-to-file
transforms.

Conceptually, conversion follows:

```text
input file
    |
    v
ingestion
    |
    v
canonical USIG IR
    |
    v
output serialization
```

For example:

```text
CSV
 |
 v
USIG IR
 |
 v
BIN
```

and:

```text
BIN
 |
 v
USIG IR
 |
 v
CSV
```

and:

```text
CSV
 |
 v
USIG IR
 |
 v
XLSX
```

This is important because metadata and waveform structure can survive a
conversion even when the physical representation changes.

The regression tests specifically validate this round-trip behavior.

For example, a CSV waveform converted to BIN and then back to CSV is expected
to preserve:

- waveform values
- row count
- column count
- column names
- relevant metadata

---

# 7. Supported BIN Concept

The USIG `.bin` format is intended for serialized waveform/measurement data
that USIG can map cleanly into its canonical representation.

The BIN representation is not intended to accept arbitrary binary files.

A supported binary file should have a straightforward serialized structure
that USIG can interpret.

The serialized representation may contain:

- one signal
- multiple signals
- vectors
- multiple vectors
- metadata
- combinations of waveform/vector data and metadata

For example, a measurement-instrument-style serialized structure can be
represented if the ordering and structure are sufficiently well defined for
USIG to map it.

An unusual or unknown binary ordering may fail ingestion.

This is intentional: if USIG cannot reliably determine how the serialized
binary data maps into the canonical IR, it should return an error rather than
silently inventing a mapping.

There are currently no general "legacy binary formats" that should be
described as automatically supported merely because they are binary.

Other input formats may be added in the future.

---

# 8. BIN Serialization

The BIN serialization is intended to provide a compact representation of
the canonical measurement structure.

At a conceptual level, the BIN contains a serialized representation of the
canonical IR rather than simply being a dump of one CSV column.

A BIN may therefore represent:

```text
metadata
signals
vectors
multiple signals/vectors
```

The exact serialization structure is an implementation/architecture concern
and is intentionally kept separate from the user-facing CLI description.

The CLI-level contract is:

```text
supported serialized BIN
        |
        v
USIG ingestion
        |
        v
canonical IR
```

If a binary file contains data in an ordering or structure that cannot be
reliably mapped to the IR, ingestion should fail with an error.

A more detailed BIN serialization specification belongs in `architecture.md`
and may be expanded as the serialization implementation is documented.

---

# 9. Metadata

Metadata and plugin inputs are related but distinct concepts.

## Metadata

Metadata describes the measurement, source, or file.

Examples include:

```text
fs
tonemode
fftlength
numaveraging
numberofcores
ticorrections
```

## Plugin inputs

Plugin inputs control how a plugin executes.

For example, the `smeas` plugin may have inputs such as:

```text
fsGhz
toneMode
fftLength
numAveraging
numberOfCores
tiCorrections
```

A metadata value may be useful to a plugin when the plugin has an associated
input/hook that consumes that value.

The intended architecture is that metadata can automatically supply plugin
inputs when the appropriate plugin input exists.

---

# 10. Filename Metadata Inference

USIG supports a filename convention for encoding metadata.

For example:

```text
sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv
```

The filename contains a series of metadata parameters separated primarily by
underscores.

The general grammar is:

```text
<key><numeric-value><unit>
```

For example:

```text
fs2p25ghz
```

can be interpreted as:

```text
key   = fs
value = 2.25
unit  = ghz
```

A numeric value may also have no unit:

```text
fftlength8192
```

A string value is represented using `~`:

```text
tonemode~single
```

or:

```text
ticorrections~ogp
```

The general forms are therefore:

```text
<key><numeric-value><unit>
```

```text
<key><numeric-value>
```

```text
<key>~<string-value>
```

---

# 11. Filename Metadata Example

Consider:

```text
sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv
```

The intended metadata interpretation is:

| Filename parameter | Key | Value | Units |
|---|---|---:|---|
| `fs2p25ghz` | `fs` | `2.25` | `ghz` |
| `tonemode~single` | `tonemode` | `single` | `NaN` |
| `fftlength8192` | `fftlength` | `8192` | `NaN` |
| `numaveraging4` | `numaveraging` | `4` | `NaN` |
| `numberofcores8` | `numberofcores` | `8` | `NaN` |
| `ticorrections~ogp` | `ticorrections` | `ogp` | `NaN` |

The leading portion:

```text
sine
```

is not itself a metadata parameter under this convention.

The extension:

```text
.csv
```

is also not part of the final metadata value.

---

# 12. Filename Separators

The underscore is the primary parameter separator.

For example:

```text
fs2p25ghz_tonemode~single_fftlength8192
```

contains three metadata expressions:

```text
fs2p25ghz
tonemode~single
fftlength8192
```

The filename parser must also account for the filename extension at the end.

For example:

```text
ticorrections~ogp.csv
```

must result in:

```text
ticorrections = ogp
```

rather than:

```text
ticorrections = ogp.csv
```

Thus the conceptual parsing rule is:

```text
filename
    |
    +-- extension handling
    |
    +-- underscore-separated components
    |
    +-- metadata expression parsing
```

---

# 13. Units in Filename Metadata

Units can be recognized as part of the filename metadata expression.

For example:

```text
fs2p25ghz
```

contains:

```text
fs
2.25
ghz
```

The `ghz` unit is recognized by the metadata layer.

It is not currently safe to assume that every unit has a direct functional
effect inside every plugin.

For example, `fs2p25ghz` may ultimately provide an IR metadata value whose
unit information is meaningful at the IR layer, while a particular plugin may
consume a corresponding value such as `fsGhz`.

The relationship between filename metadata units and individual plugin input
representations should therefore not be assumed beyond the documented
plugin hooks.

---

# 14. `-infer-meta-from-filename`

The flag:

```text
-infer-meta-from-filename
```

is primarily a conversion/metadata-embedding control.

It is not a switch that a plugin normally needs in order to use filename
derived values during plugin analysis.

Its important conversion behavior is:

```text
input filename
    |
    v
filename metadata inference
    |
    v
metadata
    |
    v
output file
```

For example:

```text
node usig.mjs \
  -i sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv \
  -infer-meta-from-filename \
  output.bin
```

causes metadata captured from the input filename to be embedded into
`output.bin`.

The metadata is embedded internally in the output file.

It does not depend on the output filename retaining the metadata text.

---

# 15. Filename Inference During Plugin Analysis

Plugins can automatically receive values inferred from the input filename.

For example:

```text
usig \
  -i sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv \
  -plugin smeas
```

can result in plugin inputs such as:

```text
toneMode = "single"
fftLength = 8192
numAveraging = 4
numberOfCores = 8
tiCorrections = "O,G,P"
```

being resolved from filename information when those values correspond to
plugin inputs/hooks.

This is separate from `-infer-meta-from-filename`.

`-infer-meta-from-filename` controls metadata embedding during conversion.

Plugin input resolution can use filename inference automatically.

---

# 16. Plugin Parameter Resolution Hierarchy

The intended parameter resolution hierarchy for plugin execution is:

```text
plugin default
    <
filename inference
    <
metadata already present in input
    <
explicit -p
```

In other words, when all applicable sources exist, the intended priority is:

1. Plugin default
2. Filename-derived value
3. Metadata already contained in the input
4. Explicit user override using `-p`

The explicit `-p` value therefore has the highest priority.

This hierarchy is intended behavior and should be treated as the target
behavior even where implementation coverage or regression testing is not yet
complete.

---

# 17. Plugin Input Resolution Example

Suppose a plugin declares:

```text
fftLength
```

and has a default:

```text
fftLength = 4096
```

If the filename contains:

```text
fftlength8192
```

then the filename can provide:

```text
fftLength = 8192
```

If the input file already contains metadata specifying:

```text
fftLength = 16384
```

then the intended hierarchy gives the existing input metadata priority over
the filename inference:

```text
plugin default      = 4096
filename inference  = 8192
input metadata      = 16384
```

Therefore:

```text
fftLength = 16384
```

If the user explicitly supplies:

```text
-p fftLength=2048
```

then:

```text
fftLength = 2048
```

because explicit user input has the highest priority.

---

# 18. Plugin Input Resolution Display

USIG reports resolved plugin inputs.

For example:

```text
Inputs:
  targetColumn = "data" << inferred from source column
  fsGhz = 2.25 << overridden from user input
  toneMode = "single" << inferred from file name
  inputMode = "time_domain_codes" << default applied
  fftLength = 8192 << inferred from file name
  numAveraging = 4 << inferred from file name
```

The source annotation is part of the normal analysis output.

`-v` does not control whether the resolved `Inputs` section is displayed.

The `-v` flag adds additional diagnostic information.

---

# 19. Plugin Hooks and Metadata

Filename metadata is intended to be useful because metadata keys can correspond
to plugin inputs.

For example, the filename:

```text
sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv
```

contains:

```text
fs
tonemode
fftlength
numaveraging
numberofcores
ticorrections
```

The `smeas` plugin has corresponding inputs/hooks represented by names such
as:

```text
fsGhz
toneMode
fftLength
numAveraging
numberOfCores
tiCorrections
```

Where the metadata-to-plugin mapping exists, the inferred metadata can
automatically populate the plugin input.

This is one of the principal reasons for maintaining a consistent filename
metadata convention.

---

# 20. Example `smeas` Resolution

Given:

```text
sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv
```

and:

```text
usig -i sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv \
  -plugin smeas \
  -p fsGhz=2.25
```

the resolved inputs can include:

```text
fsGhz = 2.25 << overridden from user input
toneMode = "single" << inferred from file name
inputMode = "time_domain_codes" << default applied
fftLength = 8192 << inferred from file name
numAveraging = 4 << inferred from file name
harmonicsToConsider = 7 << default applied
adcNumBits = 11 << default applied
adcOffsetCode = 1023 << default applied
vfsPeakToPeak = 2 << default applied
numberOfCores = 8 << inferred from file name
tiCorrections = "O,G,P" << inferred from file name
```

The exact set of displayed plugin inputs depends on the plugin.

---

# 21. `-p`

The `-p` flag supplies a parameter:

```text
-p <key=value>
```

Example:

```text
usig -i waveform.csv -plugin smeas -p fsGhz=2.25
```

Multiple parameters can be provided:

```text
usig -i waveform.csv \
  -plugin smeas \
  -p fsGhz=2.25 \
  -p fftLength=8192 \
  -p numAveraging=4
```

In plugin mode, `-p` is used to explicitly provide or override plugin inputs.

In conversion mode, `-p` has a different purpose.

---

# 22. `-p` in Conversion Mode

When no plugin action is being performed, `-p` can be used to embed metadata
into the conversion output.

For example:

```text
node usig.mjs \
  -i A.csv A_mod.csv \
  -p key1=value1 \
  -p keyN=valueN
```

The parameters are embedded into the resulting output file.

This is different from plugin parameter resolution.

Conceptually:

```text
CSV
 |
 v
IR
 |
 +-- parameter metadata from -p
 |
 v
A_mod.csv
```

The resulting file permanently contains the metadata according to the
serialization rules of the output format.

---

# 23. Metadata Embedding in BIN

For BIN output, metadata is serialized internally with the binary
representation.

Conceptually:

```text
waveform/vector data
+
metadata
+
other canonical IR information
        |
        v
serialized BIN
```

Metadata therefore survives a BIN round trip.

For example:

```text
input.csv
   |
   | -p numaveraging=5
   v
output.bin
   |
   v
output.csv
```

can recover:

```text
numaveraging = 5
```

from the BIN.

The metadata is stored in a dedicated serialized representation rather than
being repeated once for every waveform sample.

---

# 24. Metadata Embedding in CSV and XLSX

For CSV and XLSX output, metadata is embedded using columns.

A metadata value is represented by a column containing a single unique value
across the relevant data rows.

For example:

```text
data,fs,tonemode,fftlength
1.2,2.25,single,8192
1.3,2.25,single,8192
1.4,2.25,single,8192
```

Here:

```text
fs        = 2.25
tonemode  = single
fftlength = 8192
```

are metadata represented as columns.

The values are repeated across the full column.

This approach is intentionally straightforward and keeps metadata visible and
portable when the file is opened using ordinary CSV or spreadsheet tools.

---

# 25. Cost of CSV/XLSX Metadata Embedding

The CSV/XLSX metadata representation is comparatively expensive because a
metadata value is represented across a full column.

For example:

```text
data,fs,tonemode
1.2,2.25,single
1.3,2.25,single
1.4,2.25,single
...
```

The same metadata value is therefore physically repeated for many rows.

This is a tradeoff.

Advantages include:

- metadata is visible in ordinary data tools
- metadata survives ordinary CSV/XLSX handling
- metadata can be reconstructed by ingestion
- the representation does not require a special metadata sidecar

The cost is increased file size and repeated values.

Users who do not want metadata physically embedded in every CSV/XLSX row can
instead use the filename metadata convention when appropriate.

---

# 26. Metadata Round Trip

The intended metadata round trip is:

```text
filename metadata
       |
       v
metadata inference
       |
       v
canonical IR
       |
       v
output serialization
       |
       v
metadata embedded in output
```

For BIN:

```text
filename
   |
   v
metadata
   |
   v
BIN serialization
```

For CSV/XLSX:

```text
filename
   |
   v
metadata
   |
   v
metadata columns
```

On a subsequent ingestion, the metadata can be reconstructed into the
canonical IR.

---

# 27. `-meta-to-filename`

The flag:

```text
-meta-to-filename
```

requests that metadata be represented in the output filename.

This is distinct from embedding metadata inside the output file.

The two concepts are:

```text
metadata-to-file
```

and:

```text
metadata-to-filename
```

A file can use the filename convention for human-readable metadata while the
serialized representation can also carry metadata internally.

---

# 28. `-probe-metadata`

The flag:

```text
-probe-metadata
```

requests inspection of input metadata.

Example:

```text
usig -i waveform.bin -probe-metadata
```

This operation is useful for examining metadata without necessarily executing
an analysis plugin.

It is especially useful when determining whether metadata survived a
conversion.

---

# 29. Multiple Inputs

The `-i` flag can occur more than once.

For example:

```text
node usig.mjs \
  -i A.csv A.xlsx \
  -i B.csv B.xlsx \
  -plugin smeas
```

This syntax is currently ambiguous and should not be treated as a well-defined
multi-input plugin workflow.

The important distinction is that an input/output pair can constitute a
conversion action, while a plugin invocation constitutes an analysis action.

For example:

```text
-i A.csv A.xlsx
```

describes:

```text
A.csv -> A.xlsx
```

while:

```text
-i B.csv -plugin smeas
```

describes:

```text
B.csv -> smeas analysis
```

The current parser behavior observed in testing is that an input/action
without a corresponding action does not necessarily result in an independent
operation.

---

# 30. Observed Multiple-Input Behavior

The following command was tested:

```text
usig \
  -i A.csv \
  -i A.csv \
  -plugin smeas \
  -p fsGhz=2.25
```

The observed behavior was that only the input associated with the plugin
action was actually analyzed.

The first input did not independently produce an operation.

This demonstrates that repeated `-i` options should not currently be assumed
to establish an independent queue of operations.

---

# 31. Multiple Inputs Mixed With Conversion and Plugins

A particularly important case is:

```text
node usig.mjs \
  -i A.csv A.xlsx \
  -i B.csv B.xlsx \
  -plugin smeas
```

The observed/current interpretation is effectively:

```text
A.csv -> A.xlsx
```

and:

```text
B.csv -> smeas
```

The `B.xlsx` path is problematic.

The command syntactically places an output path after `B.csv` before the plugin,
but there is no explicit plugin output-file syntax that establishes what
`B.xlsx` should mean for `smeas`.

In observed behavior, `smeas` can produce its analysis output and the scalar
result can subsequently be written to `B.xlsx`.

This is an undesirable and currently undefined-looking behavior.

The intended behavior for a future/cleaner command model is that a plugin
without an explicitly associated output action should simply emit its analysis
result according to normal plugin output behavior.

In particular, the desired interpretation of:

```text
-i B.csv -plugin smeas
```

is:

```text
B.csv
  |
  v
smeas
  |
  v
analysis result printed to screen
```

not:

```text
B.csv
  |
  v
smeas
  |
  v
some implicitly selected B.xlsx output
```

Therefore:

```text
node usig.mjs \
  -i A.csv A.xlsx \
  -i B.csv B.xlsx \
  -plugin smeas
```

should be regarded as an ambiguous/bug-prone command rather than a recommended
way of combining conversion and analysis.

---

# 32. Recommended Separation of Operations

For clarity, conversion and plugin analysis should currently be written as
separate commands.

Instead of relying on:

```text
node usig.mjs \
  -i A.csv A.xlsx \
  -i B.csv B.xlsx \
  -plugin smeas
```

use:

```text
node usig.mjs -i A.csv A.xlsx
```

and:

```text
node usig.mjs -i B.csv -plugin smeas
```

This makes the intended action of every input unambiguous.

---

# 33. Multiple Plugins and Parameter Scope

Multiple plugins are expressed through repeated `-plugin` options.

Example:

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas \
  -p foo=1 \
  -plugin sinl \
  -p bar=2
```

The intended interpretation is:

```text
smeas:
    foo=1

sinl:
    bar=2
```

The plugins operate against the same ingested waveform.

This is different from supplying multiple inputs to one plugin.

---

# 34. Plugin Inputs Are Not Conversion Outputs

A plugin invocation represents an analysis action.

For example:

```text
node usig.mjs -i waveform.csv -plugin smeas
```

means:

```text
ingest waveform
    |
    v
run smeas
    |
    v
produce analysis result
```

It does not inherently mean:

```text
ingest waveform
    |
    v
convert waveform to a file
```

An output file appearing in a command containing both conversion syntax and
plugin syntax can therefore create ambiguity.

---

# 35. `-of`

The `-of` flag specifies an analysis-output format:

```text
-of <format>
```

The currently documented formats are:

```text
text
json
csv
yaml
```

For example:

```text
node usig.mjs -i waveform.csv -plugin smeas -of json
```

The existence of an output format does not imply that the result is written
to a file.

The output destination and output serialization format are separate concepts.

JSON output support exists in the analysis/output layer, but JSON should not
be confused with the currently documented conversion formats.

JSON conversion is planned and should be treated as future functionality
rather than a fully supported conversion feature.

---

# 36. `-v`

The `-v` flag enables additional diagnostic/debug information:

```text
-v
```

Example:

```text
node usig.mjs -i waveform.csv -plugin smeas -v
```

Additional information can include:

- ingestion details
- inference details
- parameter resolution details
- frame information
- other diagnostic information

The normal resolved `Inputs` section does not depend on `-v`.

---

# 37. `-y`

The `-y` flag allows an existing output file to be overwritten:

```text
-y
```

Example:

```text
node usig.mjs -i input.csv output.bin -y
```

Without `-y`, an existing output should not be silently overwritten.

---

# 38. Sample Range

USIG supports selecting a sample range.

## `-start-sample`

```text
-start-sample <n>
```

Specifies the starting sample index.

Example:

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas \
  -start-sample 1000
```

## `-end-sample`

```text
-end-sample <n>
```

Specifies the ending sample index.

Example:

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas \
  -end-sample 9000
```

Both can be supplied:

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas \
  -start-sample 1000 \
  -end-sample 9000
```

---

# 39. Plugin Help

Plugin-specific help can be requested using:

```text
usig -h -plugin smeas
```

or:

```text
node usig.mjs -h -plugin smeas
```

Plugin help is intended to expose information such as:

- configurable inputs
- parameter types
- descriptions
- required/optional status
- possible values
- aliases
- defaults where available

Example:

```text
usig -h -plugin sinl
```

---

# 40. General Help Versus Plugin Help

General help:

```text
usig -h
```

describes the CLI.

Plugin help:

```text
usig -h -plugin smeas
```

describes the selected plugin.

This distinction allows the CLI to remain generic while plugins document
their own inputs.

---

# 41. `-debug`

The `-debug` option requests plugin debug output.

The general syntax is:

```text
-debug <spec>
```

The supported specification forms are:

```text
-debug list
```

```text
-debug all
```

```text
-debug <tableId>
```

```text
-debug <tableId>=<file|dir>
```

---

# 42. Debug `list`

Use:

```text
-debug list
```

to discover plugin-declared debug tables without requiring an input file.

Conceptually:

```text
plugin
  |
  v
declared debug tables
```

Example:

```text
node usig.mjs -plugin smeas -debug list
```

This operation is useful when discovering which debug tables a plugin exposes.

---

# 43. Debug `all`

Use:

```text
-debug all
```

to request all available debug tables.

An input is required.

An optional output directory can be supplied.

Example:

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas \
  -debug all
```

A directory can be explicitly supplied:

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas \
  -debug all=/tmp/debug/
```

The path must be a directory path and should have a trailing `/`.

Therefore:

```text
-debug all=/tmp/debug/
```

is the intended form.

---

# 44. Debug Specific Table

A particular debug table can be requested:

```text
-debug <tableId>
```

Example:

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas \
  -debug spectrum
```

The exact table identifier is plugin-specific.

---

# 45. Debug Output Destination

A specific debug table can be assigned an explicit filename or directory:

```text
-debug <tableId>=<file|dir>
```

For example:

```text
-debug spectrum=/tmp/spectrum.csv
```

or, where supported:

```text
-debug spectrum=/tmp/debug/
```

The distinction between a file and directory is determined by the debug
output handling.

---

# 46. BIN Debug Output

A plugin debug table can also use BIN output.

BIN is therefore not exclusively a conversion output format.

A debug table may be serialized as BIN when the debug-table implementation
supports that representation.

Conceptually:

```text
plugin
  |
  v
debug table
  |
  v
BIN serialization
```

This is useful when a debug table is naturally represented as structured
vectors/signals rather than as plain text.

---

# 47. Analysis Output

A plugin normally produces an analysis result.

For example:

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas
```

may display:

```text
Inputs:
  ...

Outputs:
  filename: ...
  window_used: rectangular
  snr_c: 40.22
  snr_fs: 52.78
  sndr_c: 40.1
  sndr_fs: 52.66
  ...
```

The result is associated with the plugin that produced it.

When multiple plugins are run, the results are identified separately.

Example:

```text
Outputs:
  [smeas]
    ...
  [sinl]
    ...
```

---

# 48. Plugin Output Versus Conversion Output

These are separate concepts.

A plugin output is an analysis result.

A conversion output is a serialized representation of the canonical IR.

For example:

```text
usig -i waveform.csv -plugin smeas
```

produces analysis output.

Whereas:

```text
usig -i waveform.csv waveform.bin
```

produces a converted data file.

The plugin result is not the same object as the original waveform representation.

---

# 49. CSV/XLSX Conversion Example

Suppose the input is:

```text
waveform.csv
```

and the desired output is:

```text
waveform.xlsx
```

The command is:

```text
node usig.mjs -i waveform.csv waveform.xlsx
```

USIG conceptually performs:

```text
waveform.csv
     |
     v
ingestion
     |
     v
canonical IR
     |
     v
XLSX serialization
     |
     v
waveform.xlsx
```

If metadata is supplied using `-p`, that metadata is embedded into the output.

Example:

```text
node usig.mjs \
  -i waveform.csv \
  waveform.xlsx \
  -p gg=1
```

The resulting XLSX can contain a `gg` metadata column.

---

# 50. CSV to BIN With Metadata From Filename

Given:

```text
sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv
```

the following command enables filename metadata embedding:

```text
node usig.mjs \
  -i sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv \
  -infer-meta-from-filename \
  output.bin
```

The filename is parsed.

The resulting metadata is placed into the canonical representation.

The canonical representation is serialized into:

```text
output.bin
```

The metadata is therefore stored inside the BIN.

---

# 51. BIN to CSV Metadata Recovery

A BIN containing metadata can be converted back to CSV:

```text
node usig.mjs -i output.bin output.csv
```

The CSV representation can contain metadata columns.

For example:

```text
data,fs,tonemode,fftlength,numaveraging,numberofcores,ticorrections
1.2,2.25,single,8192,4,8,ogp
1.3,2.25,single,8192,4,8,ogp
1.4,2.25,single,8192,4,8,ogp
```

The waveform and metadata can therefore survive:

```text
CSV
 |
 v
BIN
 |
 v
CSV
```

---

# 52. Conversion Regression Behavior

The existing regression tests establish several important conversion
principles.

## CSV -> BIN

The conversion must:

- succeed
- create the BIN
- create a non-empty BIN

## BIN -> CSV

The resulting CSV must preserve:

- column count
- column names
- waveform data
- row count

## Filename metadata -> BIN -> CSV

The metadata inferred from the filename must survive the round trip.

The regression dataset expects:

```text
fs = 2.25
tonemode = single
fftlength = 8192
numaveraging = 4
numberofcores = 8
ticorrections = ogp
```

## Explicit metadata override

A conversion such as:

```text
node usig.mjs \
  -i metadata.csv \
  -p numaveraging=5 \
  output.bin
```

must embed:

```text
numaveraging = 5
```

into the output.

After converting the BIN back to CSV, the regression test expects the
overridden value to remain:

```text
numaveraging = 5
```

while the other metadata values remain unchanged.

---

# 53. XLSX Metadata Round Trip

The regression tests also validate:

```text
CSV
 |
 v
XLSX
 |
 v
CSV
```

The waveform must remain unchanged.

The row count must remain unchanged.

Metadata must survive.

For example, after a conversion with:

```text
-p gg=1
```

the XLSX-to-CSV round trip is expected to contain:

```text
gg = 1
```

along with the previously existing metadata.

---

# 54. Complete Metadata Example

Consider the input:

```text
sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv
```

Its intended filename metadata is:

| Parameter | Key | Value | Unit |
|---|---|---:|---|
| `fs2p25ghz` | `fs` | `2.25` | `ghz` |
| `tonemode~single` | `tonemode` | `single` | `NaN` |
| `fftlength8192` | `fftlength` | `8192` | `NaN` |
| `numaveraging4` | `numaveraging` | `4` | `NaN` |
| `numberofcores8` | `numberofcores` | `8` | `NaN` |
| `ticorrections~ogp` | `ticorrections` | `ogp` | `NaN` |

The metadata can then be mapped to plugin inputs where hooks exist.

For `smeas`, the corresponding plugin values can include:

| Metadata | Plugin input |
|---|---|
| `fs` | `fsGhz` |
| `tonemode` | `toneMode` |
| `fftlength` | `fftLength` |
| `numaveraging` | `numAveraging` |
| `numberofcores` | `numberOfCores` |
| `ticorrections` | `tiCorrections` |

The exact mapping is plugin-specific.

---

# 55. String Values and `~`

The tilde is significant when the metadata value is a string.

For example:

```text
tonemode~single
```

means:

```text
key   = tonemode
value = single
```

Likewise:

```text
ticorrections~ogp
```

means:

```text
key   = ticorrections
value = ogp
```

The tilde distinguishes a string-value expression from the numeric-value
forms.

Therefore:

```text
tonemode~single
```

should not be rewritten as:

```text
tonemodesingle
```

when using this metadata convention.

---

# 56. Numeric Values Without Units

A numeric parameter does not require a unit.

For example:

```text
fftlength8192
```

is valid.

It means:

```text
key   = fftlength
value = 8192
unit  = absent
```

Likewise:

```text
numaveraging4
```

means:

```text
key   = numaveraging
value = 4
unit  = absent
```

---

# 57. Numeric Values With Units

A numeric value can include a recognized unit.

For example:

```text
fs2p25ghz
```

represents:

```text
key   = fs
value = 2.25
unit  = ghz
```

The `p` is used to represent the decimal point within the filename-safe
numeric expression.

Thus:

```text
2.25
```

is encoded as:

```text
2p25
```

inside:

```text
fs2p25ghz
```

---

# 58. Filename Naming Convention

A metadata-bearing filename can therefore be thought of as:

```text
<description>_<parameter>_<parameter>_<parameter>.<extension>
```

where each parameter can take one of the forms:

```text
<key><numeric-value><unit>
```

or:

```text
<key><numeric-value>
```

or:

```text
<key>~<string-value>
```

Example:

```text
sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv
```

---

# 59. Metadata Is Not the Same as the Filename

A filename is one possible source of metadata.

Once metadata has been embedded into a BIN, the BIN has its own internal
metadata representation.

Similarly, CSV/XLSX output can carry metadata as columns.

Therefore:

```text
filename metadata
```

and:

```text
embedded metadata
```

are related but distinct representations.

A subsequent conversion can use embedded metadata even if the output filename
no longer contains the original metadata convention.

---

# 60. Metadata Source Priority

For plugin execution, the intended priority is:

```text
1. plugin default
2. filename inference
3. metadata already in input
4. explicit -p
```

Expressed as a chain:

```text
plugin default
    <
filename inference
    <
input metadata
    <
explicit -p
```

This ordering is intended to make explicit user parameters authoritative
while allowing useful metadata to flow automatically through conversions.

---

# 61. Conversion Metadata Sources

Conversion has a different concern.

When converting a file, metadata can be supplied through explicit parameters:

```text
-p key=value
```

and, when requested, inferred from the input filename:

```text
-infer-meta-from-filename
```

For example:

```text
node usig.mjs \
  -i input.csv \
  -infer-meta-from-filename \
  output.bin
```

captures filename metadata and embeds it in the output.

Explicit conversion parameters can be used to add or override metadata.

---

# 62. Conversion Does Not Require `-plugin`

This is a fundamental distinction.

Correct:

```text
node usig.mjs -i input.csv output.bin
```

No plugin is required.

Correct:

```text
node usig.mjs -i input.csv output.xlsx -p gg=1
```

No plugin is required.

The `-p` in this context embeds metadata rather than configuring a plugin.

---

# 63. Plugin Mode Does Not Require an Output File

Correct:

```text
node usig.mjs -i waveform.csv -plugin smeas
```

The analysis result can be displayed on screen.

There does not need to be an output path following the plugin.

This distinction is important when parsing commands containing multiple `-i`
and `-plugin` operations.

---

# 64. Parameter Placement

For plugin execution, a parameter can occur after the plugin invocation:

```text
-plugin smeas -p foo=1
```

With multiple plugins:

```text
-plugin smeas -p foo=1 -plugin sinl -p bar=2
```

the intended association is:

```text
smeas -> foo=1
sinl  -> bar=2
```

A `-p` can also occur after the final plugin invocation.

For example:

```text
-plugin smeas -p foo=1
```

is valid.

The behavior of placing a `-p` after a conversion output path has not been
fully tested and should not be relied upon without confirming the parser
behavior.

---

# 65. Important Distinction: Plugin `-p` Versus Conversion `-p`

The same flag has two operational meanings depending on the command context.

## Plugin mode

```text
-plugin smeas -p fsGhz=2.25
```

means:

```text
provide/override the smeas input fsGhz
```

## Conversion mode

```text
-i input.csv output.bin -p fsGhz=2.25
```

means:

```text
embed metadata fsGhz=2.25 into the conversion output
```

The parameter is therefore not universally "a plugin argument."

Its meaning depends on the active operation.

---

# 66. Input Column Inference

For CSV/XLSX inputs, USIG can infer a sample column from the available input
columns when the plugin requires one.

For example:

```text
targetColumn = "data" << inferred from source column
```

This allows a plugin to operate without requiring the user to explicitly
specify the waveform column when the source structure makes the correct
column sufficiently clear.

A user can explicitly override this with:

```text
-p sampleColumn=data
```

or the plugin's corresponding input name.

The exact parameter name is plugin-specific.

---

# 67. Example Plugin Resolution

A plugin execution may therefore combine several sources:

```text
Input file:
    waveform.csv

Source columns:
    data

Filename:
    sine_fs2p25ghz_tonemode~single_fftlength8192.csv

Plugin defaults:
    inputMode = time_domain_codes
    harmonicsToConsider = 7

Filename inference:
    toneMode = single
    fftLength = 8192

User:
    fsGhz = 2.25
```

The resolved input set can then contain:

```text
targetColumn = "data" << inferred from source column
fsGhz = 2.25 << overridden from user input
toneMode = "single" << inferred from file name
inputMode = "time_domain_codes" << default applied
fftLength = 8192 << inferred from file name
harmonicsToConsider = 7 << default applied
```

---

# 68. Input Resolution Is Visible

USIG reports not only the resolved value but also the source.

For example:

```text
fsGhz = 2.25 << overridden from user input
```

means the user supplied the value explicitly.

Similarly:

```text
fftLength = 8192 << inferred from file name
```

means the filename provided it.

And:

```text
inputMode = "time_domain_codes" << default applied
```

means the plugin default was used.

This makes the parameter resolution process inspectable.

---

# 69. Conversion and Analysis Are Both Built on IR

Both operations share ingestion:

```text
input file
    |
    v
USIG ingestion
    |
    v
canonical IR
```

From there the operation diverges.

Conversion:

```text
canonical IR
    |
    v
output serialization
```

Analysis:

```text
canonical IR
    |
    v
plugin
    |
    v
analysis result
```

This is the central operational model of the CLI.

---

# 70. Example: Conversion With Explicit Metadata

Command:

```text
node usig.mjs \
  -i A.csv A_mod.csv \
  -p key1=value1 \
  -p keyN=valueN
```

Conceptually:

```text
A.csv
 |
 v
ingest
 |
 v
canonical IR
 |
 +-- key1=value1
 |
 +-- keyN=valueN
 |
 v
A_mod.csv
```

The metadata is permanently represented in the conversion output according
to the output format.

---

# 71. Example: Filename Metadata to BIN

Command:

```text
node usig.mjs \
  -i sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv \
  -infer-meta-from-filename \
  measurement.bin
```

Conceptually:

```text
filename
    |
    v
metadata inference
    |
    +-- fs = 2.25 ghz
    +-- tonemode = single
    +-- fftlength = 8192
    +-- numaveraging = 4
    +-- numberofcores = 8
    +-- ticorrections = ogp
    |
    v
canonical IR
    |
    v
measurement.bin
```

---

# 72. Example: Metadata Override During Conversion

Suppose:

```text
input.csv
```

already contains:

```text
numaveraging = 4
```

The user performs:

```text
node usig.mjs \
  -i input.csv \
  -p numaveraging=5 \
  output.bin
```

The intended conversion result contains:

```text
numaveraging = 5
```

The regression test explicitly exercises this pattern.

After:

```text
output.bin -> output.csv
```

the recovered metadata is expected to contain:

```text
numaveraging = 5
```

---

# 73. Example: CSV/XLSX Metadata Embedding

Command:

```text
node usig.mjs \
  -i input.csv \
  -p gg=1 \
  output.xlsx
```

The XLSX output can represent the metadata as a column:

```text
data,gg
1.2,1
1.3,1
1.4,1
```

On conversion back:

```text
node usig.mjs -i output.xlsx output.csv
```

the metadata can be recovered as:

```text
gg = 1
```

---

# 74. Example: BIN Metadata Embedding

Command:

```text
node usig.mjs \
  -i input.csv \
  -p numaveraging=5 \
  output.bin
```

The BIN does not need to repeat:

```text
numaveraging=5
```

for every waveform sample.

Instead, metadata is stored in the serialized metadata representation.

Conceptually:

```text
BIN
+--------------------------------+
| canonical waveform/vector data |
|                                |
| metadata                       |
|   numaveraging = 5             |
|   ...                          |
+--------------------------------+
```

---

# 75. Filename Metadata Versus Embedded Metadata

These mechanisms solve different problems.

Filename metadata:

```text
human-readable
portable in filenames
useful for automatic inference
```

Embedded metadata:

```text
travels with the data
survives filename changes
can be recovered after conversion
```

CSV/XLSX embedding:

```text
visible in ordinary data/spreadsheet tools
but physically repeated across columns
```

BIN embedding:

```text
serialized efficiently in one metadata representation
```

---

# 76. Legacy Formats

USIG should not currently be documented as having a generic collection of
legacy formats accepted through a legacy `IREngine.getOrIngest()` pathway.

JSON is planned alongside additional future formats.

At present, the supported file types should be understood in terms of what
the current ingestion and serialization implementation actually supports.

Future formats may be added without changing the canonical IR model.

---

# 77. JSON

JSON support exists in limited compatibility areas, but it is not yet
considered robustly tested and fully featured.

JSON should therefore be treated as planned/future functionality for the
purposes of the user-facing conversion documentation.

In particular, do not assume that:

```text
node usig.mjs -i input.json output.csv
```

is a fully supported general-purpose conversion path.

The intended direction is for JSON support to be expanded alongside other
future formats.

---

# 78. Output Format Summary

Current conversion output:

| Format | Extension | Status |
|---|---|---|
| USIG BIN | `.bin` | Supported |
| CSV | `.csv` | Supported |
| Excel | `.xlsx` | Supported |
| JSON | `.json` | Planned / not yet robustly featured |

Analysis output formats:

| Format | `-of` value | Purpose |
|---|---|---|
| Text | `text` | Human-readable analysis output |
| JSON | `json` | Machine-readable analysis output |
| CSV | `csv` | Tabular analysis output |
| YAML | `yaml` | Structured textual analysis output |

Analysis-output support and conversion-format support are separate concepts.

---

# 79. Complete Basic Command Examples

## Convert CSV to BIN

```text
node usig.mjs -i waveform.csv waveform.bin
```

## Convert BIN to CSV

```text
node usig.mjs -i waveform.bin waveform.csv
```

## Convert BIN to XLSX

```text
node usig.mjs -i waveform.bin waveform.xlsx
```

## Convert CSV to XLSX

```text
node usig.mjs -i waveform.csv waveform.xlsx
```

## Analyze with `smeas`

```text
node usig.mjs -i waveform.csv -plugin smeas
```

## Analyze with an explicit parameter

```text
node usig.mjs -i waveform.csv -plugin smeas -p fsGhz=2.25
```

## Analyze with two parameters

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas \
  -p fsGhz=2.25 \
  -p fftLength=8192
```

## Analyze with two plugins

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas \
  -plugin sinl
```

## Analyze with separate plugin parameters

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas \
  -p foo=1 \
  -plugin sinl \
  -p bar=2
```

## Analyze a sample range

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas \
  -start-sample 1000 \
  -end-sample 9000
```

## Show diagnostics

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas \
  -v
```

## Inspect metadata

```text
node usig.mjs \
  -i waveform.csv \
  -probe-metadata
```

---

# 80. Complete Metadata Conversion Examples

## Embed explicit metadata

```text
node usig.mjs \
  -i A.csv \
  A_mod.csv \
  -p key1=value1 \
  -p keyN=valueN
```

## Infer metadata from filename during conversion

```text
node usig.mjs \
  -i sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv \
  -infer-meta-from-filename \
  output.bin
```

## Embed an explicit override

```text
node usig.mjs \
  -i input.csv \
  -p numaveraging=5 \
  output.bin
```

## Convert embedded metadata to CSV

```text
node usig.mjs \
  -i output.bin \
  output.csv
```

---

# 81. Complete Plugin Examples

## `smeas`

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas
```

## `smeas` with sampling frequency

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas \
  -p fsGhz=2.25
```

## `smeas` with multiple parameters

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas \
  -p fsGhz=2.25 \
  -p fftLength=8192 \
  -p numAveraging=4
```

## Multiple plugins

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas \
  -plugin sinl
```

## Multiple plugins with independent parameters

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas \
  -p fsGhz=2.25 \
  -plugin sinl \
  -p bar=2
```

---

# 82. Example Filename-to-Plugin Flow

Input:

```text
sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv
```

Command:

```text
node usig.mjs \
  -i sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv \
  -plugin smeas
```

Filename parsing produces approximately:

```text
fs = 2.25
tonemode = single
fftlength = 8192
numaveraging = 4
numberofcores = 8
ticorrections = ogp
```

Plugin mapping can then provide corresponding `smeas` inputs where hooks exist.

The plugin may additionally use defaults for inputs not supplied by metadata.

---

# 83. Example Override Flow

Input filename:

```text
sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv
```

Command:

```text
node usig.mjs \
  -i sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv \
  -plugin smeas \
  -p numAveraging=5
```

Filename inference provides:

```text
numAveraging = 4
```

but explicit `-p` provides:

```text
numAveraging = 5
```

The intended final value is:

```text
numAveraging = 5
```

because:

```text
explicit -p
```

has higher priority than:

```text
filename inference
```

---

# 84. Conversion and Plugin Operations Should Be Read Left-to-Right

The CLI is easiest to reason about by identifying actions.

For example:

```text
-i A.csv A.xlsx
```

is a conversion action:

```text
A.csv -> A.xlsx
```

while:

```text
-i B.csv -plugin smeas
```

is an analysis action:

```text
B.csv -> smeas
```

Multiple plugins extend the analysis action:

```text
-i B.csv -plugin smeas -plugin sinl
```

meaning:

```text
B.csv
 |
 +--> smeas
 |
 +--> sinl
```

Both plugins use the same ingested waveform.

---

# 85. Same Input, Multiple Plugins

When multiple plugins are invoked for the same input:

```text
node usig.mjs \
  -i waveform.csv \
  -plugin smeas \
  -plugin sinl
```

the intended conceptual flow is:

```text
waveform.csv
     |
     v
ingestion
     |
     v
canonical IR
     |
     +---------> smeas
     |
     +---------> sinl
```

The plugins do not represent two separate file conversions.

They are separate analyses of the same ingested waveform.

---

# 86. Multiple Inputs Are Not Multi-Signal Plugin Inputs

Multiple `-i` options should not currently be interpreted as a way to provide
multiple waveform signals to a plugin.

The current plugin model is intended to use a single input waveform per
plugin execution.

Future developments may introduce plugins that intentionally consume multiple
inputs.

Until then, a command such as:

```text
-i A.csv -i B.csv -plugin smeas
```

should not be documented as a supported way of giving `smeas` two signals.

---

# 87. Multiple Signals Inside BIN

This restriction should not be confused with the capabilities of the BIN
representation.

A BIN can represent multiple signals/vectors if they are serialized in a
structure that USIG can map correctly.

The distinction is:

```text
BIN representation:
    can contain multiple signals/vectors

current plugin invocation:
    generally consumes one ingested input
```

A future multi-input plugin architecture may use the richer IR capability.

---

# 88. Conversion Bug / Ambiguity

A currently observed command pattern is:

```text
node usig.mjs \
  -i A.csv A.xlsx \
  -i B.csv B.xlsx \
  -plugin smeas
```

The first pair is clearly a conversion:

```text
A.csv -> A.xlsx
```

The second input is then associated with the plugin.

The presence of:

```text
B.xlsx
```

creates an ambiguous condition because the plugin invocation does not
explicitly establish that `B.xlsx` is a plugin output destination.

Observed behavior can result in the `smeas` scalar/vector result being written
to `B.xlsx`.

This is considered an undesirable/undefined action.

The intended semantic model should instead distinguish:

```text
conversion output
```

from:

```text
plugin result
```

explicitly.

---

# 89. Recommended Interpretation of the Ambiguous Case

Until the CLI parser is tightened, do not rely on:

```text
-i A.csv A.xlsx -i B.csv B.xlsx -plugin smeas
```

as a supported compound workflow.

Use separate commands:

```text
node usig.mjs -i A.csv A.xlsx
```

and:

```text
node usig.mjs -i B.csv -plugin smeas
```

If plugin output needs to be saved, use the plugin's supported output/debug
mechanism rather than relying on an adjacent conversion output path whose
association is ambiguous.

---

# 90. Error Handling for Unsupported BIN Mapping

A BIN file should not be accepted merely because it has a `.bin` extension.

The ingestion layer must be able to map its serialized contents into the
canonical IR.

If the binary ordering is unknown or cannot be mapped reliably, the correct
behavior is an ingestion error.

For example:

```text
unknown binary ordering
        |
        v
cannot establish IR mapping
        |
        v
error
```

rather than:

```text
unknown binary ordering
        |
        v
guess
        |
        v
possibly corrupt waveform
```

---

# 91. Why the Canonical IR Matters

The canonical IR provides a common representation between ingestion,
conversion, metadata handling, and plugins.

Without it, every plugin would need to understand every input format.

With it:

```text
CSV ----\
XLSX ----\
BIN ------> canonical IR ----> plugin
future ---/        |
                   |
                   +---------> CSV
                   |
                   +---------> XLSX
                   |
                   +---------> BIN
```

This is the fundamental reason conversion and analysis share the same
ingestion path.

---

# 92. User-Facing Mental Model

A useful way to think about USIG is:

```text
FILES
  |
  v
INGESTION
  |
  v
CANONICAL IR
  |
  +----------------------+
  |                      |
  v                      v
CONVERSION             PLUGINS
  |                      |
  v                      v
FILES                  RESULTS
```

Metadata can enter at the ingestion/conversion boundary or be supplied
explicitly.

For plugins, parameter resolution then follows:

```text
plugin default
      <
filename inference
      <
input metadata
      <
explicit -p
```

---

# 93. CLI Help Reference

The following is the current high-level help structure:

```text
USIG — waveform analysis CLI

USAGE

  usig -i <input-file> -plugin <id> [options]
  usig -i <input-file> <output-file> [options]

ANALYSIS

  -i <file>                 Input waveform file
  -plugin <id>              Plugin to run
  -p <key=value>            Override an input parameter
  -of <format>              Output format: text | json | csv | yaml

CONVERSION

  Conversion mode is selected from the output filename extension.

  Supported output formats:

    .bin
    .csv
    .xlsx

OPTIONS

  -v                        Show additional diagnostic/debug output
  -y                        Overwrite an existing output file
  -h, -help                 Show this help
  -start-sample <n>         Start at sample index <n>
  -end-sample <n>           End at sample index <n>
  -probe-metadata           Inspect input metadata
  -debug <spec>             Request plugin debug output

METADATA

  -infer-meta-from-filename
                            Infer metadata from the input filename

  -meta-to-filename         Include metadata in the output filename
```

The exact installed CLI help may contain additional wording or plugin-specific
information.

---

# 94. Quick Reference

## Conversion

```text
usig -i <input> <output>
```

## Conversion with metadata

```text
usig -i <input> <output> -p key=value
```

## Conversion with filename metadata embedding

```text
usig -i <input> -infer-meta-from-filename <output>
```

## Plugin

```text
usig -i <input> -plugin <plugin-id>
```

## Plugin override

```text
usig -i <input> -plugin <plugin-id> -p key=value
```

## Multiple plugins

```text
usig -i <input> -plugin <plugin-id> -plugin <plugin-id2>
```

## Different parameters for different plugins

```text
usig -i <input> \
  -plugin <plugin-id> -p key1=value1 \
  -plugin <plugin-id2> -p key2=value2
```

## Analysis output format

```text
usig -i <input> -plugin <plugin-id> -of json
```

## Diagnostics

```text
usig -i <input> -plugin <plugin-id> -v
```

## Metadata inspection

```text
usig -i <input> -probe-metadata
```

## Plugin debug table discovery

```text
usig -plugin <plugin-id> -debug list
```

## All plugin debug tables

```text
usig -i <input> -plugin <plugin-id> -debug all
```

## Specific debug table

```text
usig -i <input> -plugin <plugin-id> -debug <tableId>
```

---

# 95. Operational Summary

USIG supports three important classes of operation:

```text
1. Conversion
2. Plugin analysis
3. Metadata/debug inspection
```

Conversion:

```text
-i input output
```

Plugin analysis:

```text
-i input -plugin plugin
```

Multiple plugins:

```text
-i input -plugin plugin1 -plugin plugin2
```

Conversion metadata:

```text
-i input output -p key=value
```

Filename metadata embedding during conversion:

```text
-i input -infer-meta-from-filename output
```

Plugin parameter resolution:

```text
plugin default
    <
filename inference
    <
metadata already in input
    <
explicit -p
```

Metadata filename grammar:

```text
<key><numeric-value><unit>
```

or:

```text
<key><numeric-value>
```

or:

```text
<key>~<string-value>
```

Primary filename separator:

```text
_
```

with the filename extension handled separately.

---

# 96. Current and Intended Behavior

The following distinctions are important when implementing or extending the
CLI.

## Established conversion behavior

The regression tests demonstrate:

- CSV can be converted to BIN.
- BIN can be converted to CSV.
- BIN round trips preserve waveform data.
- CSV structure is preserved across the BIN round trip.
- filename metadata can be embedded into BIN when
  `-infer-meta-from-filename` is supplied.
- embedded metadata can be recovered from BIN.
- conversion `-p` values can be embedded as metadata.
- metadata overrides survive BIN round trips.
- CSV can be converted to XLSX.
- XLSX can be converted back to CSV.
- waveform data survives the XLSX round trip.
- metadata survives the XLSX round trip.

## Intended plugin behavior

The intended parameter priority is:

```text
plugin default
    <
filename inference
    <
metadata already in input
    <
explicit -p
```

Plugin filename inference is not dependent on the conversion-only
`-infer-meta-from-filename` flag.

## Current/known ambiguous behavior

Multiple `-i` operations combined with conversion output paths and plugin
actions can result in ambiguous association between an output path and a
plugin.

For example:

```text
-i A.csv A.xlsx -i B.csv B.xlsx -plugin smeas
```

can cause `B.xlsx` to receive the plugin result even though this is not a
clearly defined plugin-output syntax.

This should not be relied upon.

## Intended future direction

The CLI should make conversion actions and plugin actions unambiguous,
especially when multiple inputs are present.

Future multi-input plugins may intentionally consume multiple signals, but
the current plugin model should not be assumed to provide that capability.

---

# 97. Design Principle

The central design principle of the CLI is that USIG should make the
relationship between waveform data, metadata, conversion, and analysis
explicit:

```text
SOURCE FILE
    |
    v
INGEST
    |
    v
CANONICAL IR
    |
    +----------------------+
    |                      |
    v                      v
CONVERSION             PLUGIN ANALYSIS
    |                      |
    v                      v
OUTPUT FILE             RESULT
```

Metadata can be carried through this system:

```text
filename metadata
       |
       v
metadata representation
       |
       v
canonical IR
       |
       +--------------------+
       |                    |
       v                    v
BIN metadata          CSV/XLSX metadata
```

Plugin parameters can then be resolved from:

```text
plugin defaults
       |
       v
filename inference
       |
       v
input metadata
       |
       v
explicit -p
```

This allows waveform data and the contextual information required to interpret
that waveform to travel together through the USIG conversion and analysis
pipeline.
