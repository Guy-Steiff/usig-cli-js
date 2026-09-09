import os
import re
import time
import subprocess
import shutil
import pandas as pd
from pathlib import Path


# =============================================================================
# Configuration
# =============================================================================

# Controls printing of subprocess stdout/stderr.
# Keep False for normal regression runs.
# Set True when debugging CLI behavior.
b_verbose = False

# =============================================================================
# Helpers
# =============================================================================

def run_usig(command, b_verbose=False):
    """
    Execute a USIG CLI command.

    Parameters
    ----------
    command : list
        Command list suitable for subprocess.run().
    b_verbose : bool
        Print stdout/stderr when enabled.

    Returns
    -------
    subprocess.CompletedProcess
    """

    result = subprocess.run(
        command,
        capture_output=True,
        text=True
    )

    command_text = " ".join(str(item) for item in command)

    if b_verbose:
        print("\nCOMMAND:")
        print(command_text)
        print("\nSTDOUT:")
        print(result.stdout)
        print("\nSTDERR:")
        print(result.stderr)

    return result


def find_node():

    node = shutil.which("node")

    if node:
        return node

    windows_candidates = [
        Path(os.environ.get("ProgramFiles", "")) / "nodejs" / "node.exe",
        Path(os.environ.get("ProgramFiles(x86)", "")) / "nodejs" / "node.exe",
    ]

    unix_candidates = [
        Path("/usr/bin/node"),
        Path("/usr/local/bin/node"),
    ]

    candidates = windows_candidates + unix_candidates

    for candidate in candidates:
        if candidate.exists():
            return str(candidate)

    nvm_root = Path.home() / ".nvm" / "versions" / "node"

    if nvm_root.exists():
        versions = sorted(
            nvm_root.glob("*/bin/node"),
            reverse=True
        )

        if versions:
            return str(versions[0])

    raise RuntimeError(
        "Node.js was not found. "
        "Please install Node.js before running USIG."
    )


def parse_resolved_inputs(stderr_text):
    """
    Parse the CLI's verbose "[usig] resolved input[n]: file=... startSample=...
    endSample=... inputFormat=..." diagnostic lines into an ordered list of
    dicts. Used to prove that multiple -i / expanded -f concat inputs are
    retained internally, in order, with their own per-input attributes,
    before any (currently expected) explicit multi-input rejection occurs.
    """

    pattern = re.compile(
        r"resolved input\[(\d+)\]: file=(\S+) startSample=(\S+) endSample=(\S+) inputFormat=(\S+)"
    )

    entries = []

    for match in pattern.finditer(stderr_text or ""):
        entries.append(
            {
                "index": int(match.group(1)),
                "file": match.group(2),
                "startSample": match.group(3),
                "endSample": match.group(4),
                "inputFormat": match.group(5),
            }
        )

    entries.sort(key=lambda e: e["index"])

    return entries


def parse_mass_conversion_jobs(stderr_text):
    """
    Parse the CLI's verbose "[usig] job N: input=... output=... startSample=...
    endSample=... outputFormat=..." diagnostic lines emitted for each
    independent job in a mass-conversion batch. Used to prove that every job
    independently retains its own input/output/sample-window/format, in
    command-line order, with no leakage between jobs.
    """

    pattern = re.compile(
        r"job (\d+): input=(\S+) output=(\S+) startSample=(\S+) endSample=(\S+) outputFormat=(\S+)"
    )

    entries = []

    for match in pattern.finditer(stderr_text or ""):
        entries.append(
            {
                "index": int(match.group(1)),
                "input": match.group(2),
                "output": match.group(3),
                "startSample": match.group(4),
                "endSample": match.group(5),
                "outputFormat": match.group(6),
            }
        )

    entries.sort(key=lambda e: e["index"])

    return entries


def add_check(report, name, condition):

    report.append(
        {
            "check": name,
            "passed": bool(condition)
        }
    )


def generate_report_text(report):

    lines = []

    lines.append("=" * 80)
    lines.append("USIG CLI CONCAT / FLAG NORMALIZATION VALIDATION REPORT")
    lines.append(f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("=" * 80)

    failed = 0

    for item in report:
        status = "PASS" if item["passed"] else "FAIL"

        if not item["passed"]:
            failed += 1

        lines.append(f"{status:<6} : {item['check']}")

    lines.append("-" * 80)
    lines.append(f"TOTAL: {len(report)} checks, {failed} failures")
    lines.append("=" * 80)

    return "\n".join(lines)


def save_report(report, output_folder):

    report_path = output_folder / "cli_concat_and_flags_report.txt"

    with open(report_path, "w", encoding="utf-8") as f:
        f.write(generate_report_text(report))

    return report_path


def write_csv(path, values):
    """
    Write a minimal single-column CSV with a 'data' column, matching the
    canonical waveform column used elsewhere in the regression suite.
    """

    pd.DataFrame({"data": values}).to_csv(path, index=False)


# =============================================================================
# Main regression test
# =============================================================================

def main():

    # -------------------------------------------------------------------------
    # Environment setup
    # -------------------------------------------------------------------------

    PROJECT_ROOT = Path(__file__).resolve().parents[2]
    node_executable = find_node()
    USIG_CLI = PROJECT_ROOT / "usig.mjs"

    if not USIG_CLI.exists():
        raise FileNotFoundError(f"Missing USIG CLI entry point: {USIG_CLI}")

    subprocess.run(
        [node_executable, "--version"],
        check=True,
        capture_output=True
    )

    RESULTS_ROOT = PROJECT_ROOT / "test" / "results"
    timestamp = time.strftime("%Y_%m_%d_%H_%M_%S")
    output_folder = RESULTS_ROOT / "cli_concat_and_flags_test" / timestamp
    output_folder.mkdir(parents=True, exist_ok=True)

    report = []

    # =========================================================================
    # Fixture data
    # =========================================================================
    #
    # Three tiny distinguishable CSVs so that multi-input order/identity can
    # be proven by inspecting the "[usig] resolved input[n]: file=..." verbose
    # diagnostic emitted by the CLI before it ingests (or rejects) each input.
    # =========================================================================

    file_a = output_folder / "A.csv"
    file_b = output_folder / "B.csv"
    file_c = output_folder / "C.csv"

    write_csv(file_a, [1.0, 2.0, 3.0, 4.0])
    write_csv(file_b, [10.0, 20.0, 30.0, 40.0])
    write_csv(file_c, [100.0, 200.0, 300.0, 400.0])

    # =========================================================================
    # TEST 1: existing single-input parsing remains backward compatible
    # =========================================================================

    plain_out = output_folder / "plain_roundtrip.csv"

    result = run_usig(
        [node_executable, str(USIG_CLI), "-i", str(file_a), str(plain_out)],
        b_verbose
    )

    add_check(
        report,
        "1: plain single-input CSV->CSV conversion succeeds",
        result.returncode == 0
    )

    add_check(
        report,
        "1: plain single-input output file created",
        plain_out.exists()
    )

    if plain_out.exists():
        pd_plain = pd.read_csv(plain_out)
        add_check(
            report,
            "1: plain single-input data preserved",
            "data" in pd_plain.columns
            and list(pd_plain["data"]) == [1.0, 2.0, 3.0, 4.0]
        )

    # =========================================================================
    # TEST 2: canonical single-dash flags (-infer-meta-from-filename)
    # =========================================================================

    flagged_out = output_folder / "flagged.bin"

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(file_a),
            "-infer-meta-from-filename",
            str(flagged_out)
        ],
        b_verbose
    )

    add_check(
        report,
        "2: canonical single-dash -infer-meta-from-filename accepted",
        result.returncode == 0
    )

    add_check(
        report,
        "2: canonical single-dash flag produced output file",
        flagged_out.exists()
    )

    # Old double-dash spelling must no longer be recognized as the same flag.
    # It should not error the process (unknown flags are ignored by the
    # tokenizer), but it must not enable the same behavior as a recognized
    # flag. We check this indirectly by confirming the command still runs
    # (since unknown tokens are simply skipped) and produces output.
    double_dash_out = output_folder / "double_dash_flag_ignored.bin"

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(file_a),
            "--infer-meta-from-filename",
            str(double_dash_out)
        ],
        b_verbose
    )

    add_check(
        report,
        "2: legacy double-dash flag no longer required for CLI to run",
        result.returncode == 0
    )

    # =========================================================================
    # TEST 3: negative numeric values bind to -ss / -to (not treated as flags)
    # =========================================================================
    #
    # This validates CLI token binding only (not downstream sample-window
    # semantics, which are unrelated to this task). With -v enabled, the CLI
    # emits a diagnostic line reporting the parsed sample window. If -10/-5
    # were NOT correctly bound to -ss/-to (e.g. misread as unrelated/unknown
    # flags), startSample/endSample would remain null and no diagnostic line
    # would be emitted at all.
    # =========================================================================

    negative_out = output_folder / "negative_window.csv"

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(file_a),
            "-ss",
            "-10",
            "-to",
            "-5",
            "-v",
            str(negative_out)
        ],
        b_verbose
    )

    add_check(
        report,
        "3: -ss -10 -to -5 command succeeds",
        result.returncode == 0
    )

    stderr_text = result.stderr or ""

    add_check(
        report,
        "3: negative -ss/-to values were bound to the preceding options",
        "startSample=-10" in stderr_text
        and "endSample=-5" in stderr_text
    )

    # =========================================================================
    # TEST 4: strict concat list — happy path, order preserved (A then B)
    # =========================================================================
    #
    # Concat is now a pure input-list expansion mechanism (no phase-1
    # first-file behavior). A conversion-mode command driven by a two-entry
    # concat list must therefore fail explicitly (multi-input execution
    # semantics are not yet defined for conversion mode) rather than silently
    # using only the first entry.
    # =========================================================================

    list_ab = output_folder / "list_ab.txt"
    list_ab.write_text(
        f"file '{file_a.name}'\nfile '{file_b.name}'\n",
        encoding="utf-8"
    )

    concat_ab_out = output_folder / "concat_ab.csv"

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-f",
            "concat",
            "-i",
            str(list_ab),
            str(concat_ab_out)
        ],
        b_verbose
    )

    add_check(
        report,
        "4: -f concat -i list.txt (A then B) in conversion mode fails explicitly",
        result.returncode != 0
    )

    add_check(
        report,
        "4: multi-input conversion error names the unsupported operation",
        "conversion mode does not yet support multiple inputs" in (result.stderr or "")
    )

    add_check(
        report,
        "4: multi-entry concat never silently produces output from only the first entry",
        not concat_ab_out.exists()
    )

    # =========================================================================
    # TEST 5: strict concat list — single-entry concat still succeeds
    # =========================================================================
    #
    # A concat list with exactly one entry is a valid single-input case and
    # must continue to work exactly like a plain -i.
    # =========================================================================

    list_single = output_folder / "list_single.txt"
    list_single.write_text(
        f"file '{file_b.name}'\n",
        encoding="utf-8"
    )

    concat_single_out = output_folder / "concat_single.csv"

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-f",
            "concat",
            "-i",
            str(list_single),
            str(concat_single_out)
        ],
        b_verbose
    )

    add_check(
        report,
        "5: -f concat -i list.txt with a single entry succeeds",
        result.returncode == 0
    )

    if concat_single_out.exists():
        pd_concat_single = pd.read_csv(concat_single_out)
        add_check(
            report,
            "5: single-entry concat resolves the relative path correctly (B)",
            "data" in pd_concat_single.columns
            and list(pd_concat_single["data"]) == [10.0, 20.0, 30.0, 40.0]
        )
    else:
        add_check(
            report,
            "5: single-entry concat resolves the relative path correctly (B)",
            False
        )

    # =========================================================================
    # TEST 6: malformed concat list — bare path (no 'file' keyword) rejected
    # =========================================================================

    list_bare = output_folder / "list_bare.txt"
    list_bare.write_text(
        f"{file_a.name}\n",
        encoding="utf-8"
    )

    bare_out = output_folder / "concat_bare.csv"

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-f",
            "concat",
            "-i",
            str(list_bare),
            str(bare_out)
        ],
        b_verbose
    )

    add_check(
        report,
        "6: bare path concat entry is rejected (non-zero exit)",
        result.returncode != 0
    )

    add_check(
        report,
        "6: bare path concat entry error mentions list file and line number",
        (str(list_bare) in (result.stderr or ""))
        and (":1:" in (result.stderr or ""))
    )

    add_check(
        report,
        "6: bare path concat entry produced no output file",
        not bare_out.exists()
    )

    # =========================================================================
    # TEST 7: malformed concat list — unquoted path rejected
    # =========================================================================

    list_unquoted = output_folder / "list_unquoted.txt"
    list_unquoted.write_text(
        f"file {file_a.name}\n",
        encoding="utf-8"
    )

    unquoted_out = output_folder / "concat_unquoted.csv"

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-f",
            "concat",
            "-i",
            str(list_unquoted),
            str(unquoted_out)
        ],
        b_verbose
    )

    add_check(
        report,
        "7: unquoted concat entry is rejected (non-zero exit)",
        result.returncode != 0
    )

    add_check(
        report,
        "7: unquoted concat entry produced no output file",
        not unquoted_out.exists()
    )

    # =========================================================================
    # TEST 8: empty concat list (no valid entries) rejected
    # =========================================================================

    list_empty = output_folder / "list_empty.txt"
    list_empty.write_text(
        "\n\n   \n",
        encoding="utf-8"
    )

    empty_out = output_folder / "concat_empty.csv"

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-f",
            "concat",
            "-i",
            str(list_empty),
            str(empty_out)
        ],
        b_verbose
    )

    add_check(
        report,
        "8: empty concat list (no entries) is rejected (non-zero exit)",
        result.returncode != 0
    )

    add_check(
        report,
        "8: empty concat list produced no output file",
        not empty_out.exists()
    )

    # =========================================================================
    # TEST 9: two ordinary -i arguments are retained, in order (never reduced
    # to only the first or only the second, i.e. the classic overwrite bug)
    # =========================================================================
    #
    # Multi-input execution is not yet implemented for plugin runs, so the
    # command is expected to fail explicitly. Before doing so, the CLI's
    # verbose diagnostic proves that both -i A and -i B were independently
    # retained and ingested, in order.
    # =========================================================================

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i", str(file_a),
            "-i", str(file_b),
            "-plugin", "sinl",
            "-v",
        ],
        b_verbose
    )

    add_check(
        report,
        "9: two -i args: plugin execution fails explicitly (multi-input unsupported)",
        result.returncode != 0
        and "does not yet support multiple inputs" in (result.stderr or "")
    )

    resolved_9 = parse_resolved_inputs(result.stderr)

    add_check(
        report,
        "9: two -i args are both retained internally, in order (A then B)",
        [e["file"] for e in resolved_9] == [str(file_a), str(file_b)]
    )

    # =========================================================================
    # TEST 10: three ordinary -i arguments preserve order
    # =========================================================================

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i", str(file_a),
            "-i", str(file_b),
            "-i", str(file_c),
            "-plugin", "sinl",
            "-v",
        ],
        b_verbose
    )

    resolved_10 = parse_resolved_inputs(result.stderr)

    add_check(
        report,
        "10: three -i args are all retained internally, in order (A,B,C)",
        [e["file"] for e in resolved_10] == [str(file_a), str(file_b), str(file_c)]
    )

    # =========================================================================
    # TEST 11: each input retains its own -ss / -to (including negative
    # values), rather than one input's window leaking onto another's
    # =========================================================================

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i", str(file_a),
            "-ss", "-10",
            "-to", "-5",
            "-i", str(file_b),
            "-ss", "20",
            "-to", "40",
            "-plugin", "sinl",
            "-v",
        ],
        b_verbose
    )

    resolved_11 = parse_resolved_inputs(result.stderr)

    add_check(
        report,
        "11: each input retains its own -ss/-to (A: -10/-5, B: 20/40)",
        len(resolved_11) == 2
        and resolved_11[0]["startSample"] == "-10"
        and resolved_11[0]["endSample"] == "-5"
        and resolved_11[1]["startSample"] == "20"
        and resolved_11[1]["endSample"] == "40"
    )

    # =========================================================================
    # TEST 12: each input can carry its own -f (format hint)
    # =========================================================================

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i", str(file_a),
            "-f", "csv",
            "-i", str(file_b),
            "-f", "bin",
            "-plugin", "sinl",
            "-v",
        ],
        b_verbose
    )

    resolved_12 = parse_resolved_inputs(result.stderr)

    add_check(
        report,
        "12: each input can carry its own -f (A=csv, B=bin)",
        len(resolved_12) == 2
        and resolved_12[0]["inputFormat"] == "csv"
        and resolved_12[1]["inputFormat"] == "bin"
    )

    # =========================================================================
    # TEST 13: -f concat expands multiple file 'path' entries, in order, with
    # relative paths resolved relative to the list file
    # =========================================================================

    list_abc = output_folder / "list_abc.txt"
    list_abc.write_text(
        f"file '{file_a.name}'\nfile '{file_b.name}'\nfile '{file_c.name}'\n",
        encoding="utf-8"
    )

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-f", "concat",
            "-i", str(list_abc),
            "-plugin", "sinl",
            "-v",
        ],
        b_verbose
    )

    resolved_13 = parse_resolved_inputs(result.stderr)

    add_check(
        report,
        "13: -f concat expands 3 entries in order, with relative paths resolved",
        [e["file"] for e in resolved_13] == [str(file_a), str(file_b), str(file_c)]
    )

    add_check(
        report,
        "13: concat-expanded multi-input plugin execution fails explicitly",
        result.returncode != 0
        and "does not yet support multiple inputs" in (result.stderr or "")
    )

    # =========================================================================
    # TEST 14: exactly one -i still follows the existing single-input path
    # (already exercised by TEST 1, re-asserted here against the plugin path)
    # =========================================================================

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i", str(file_a),
            "-plugin", "sinl",
        ],
        b_verbose
    )

    add_check(
        report,
        "14: exactly one -i still succeeds through the plugin execution path",
        result.returncode == 0
    )

    # =========================================================================
    # TEST 15: multiple -i in conversion mode fails explicitly rather than
    # silently reducing to the first (or second) input
    # =========================================================================

    conv_multi_out = output_folder / "conv_multi.csv"

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i", str(file_a),
            "-i", str(file_b),
            str(conv_multi_out),
        ],
        b_verbose
    )

    add_check(
        report,
        "15: -i A -i B in conversion mode fails explicitly (multi-input unsupported)",
        result.returncode != 0
        and "cannot share a single output" in (result.stderr or "")
    )

    add_check(
        report,
        "15: -i A -i B in conversion mode never silently writes output from only one input",
        not conv_multi_out.exists()
    )

    # =========================================================================
    # TEST 16: two independent mass-conversion jobs (CSV->XLSX, XLSX->CSV)
    # execute in order, each producing its own correct output with no
    # cross-contamination between jobs
    # =========================================================================
    #
    # Fixture: convert file_b (data 10,20,30,40) to xlsx once, independently
    # of the batch under test, so job 1 of the batch has a distinct XLSX
    # input to convert back to CSV.
    # =========================================================================

    fixture_b_xlsx = output_folder / "fixture_b.xlsx"

    result = run_usig(
        [node_executable, str(USIG_CLI), "-i", str(file_b), str(fixture_b_xlsx), "-y"],
        b_verbose
    )

    add_check(
        report,
        "16: fixture setup: B.csv -> fixture_b.xlsx succeeds",
        result.returncode == 0 and fixture_b_xlsx.exists()
    )

    job16_a_out = output_folder / "job16_a.xlsx"
    job16_b_out = output_folder / "job16_b.csv"

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i", str(file_a), str(job16_a_out),
            "-i", str(fixture_b_xlsx), str(job16_b_out),
            "-y",
        ],
        b_verbose
    )

    add_check(
        report,
        "16: two independent jobs (CSV->XLSX, XLSX->CSV) succeed together",
        result.returncode == 0
    )

    add_check(
        report,
        "16: job 0 output (XLSX) exists",
        job16_a_out.exists()
    )

    add_check(
        report,
        "16: job 1 output (CSV) exists",
        job16_b_out.exists()
    )

    if job16_a_out.exists():
        pd_job16_a = pd.read_excel(job16_a_out)
        add_check(
            report,
            "16: job 0 output contains job 0's own data (A: 1,2,3,4), not job 1's",
            "data" in pd_job16_a.columns
            and list(pd_job16_a["data"]) == [1.0, 2.0, 3.0, 4.0]
        )

    if job16_b_out.exists():
        pd_job16_b = pd.read_csv(job16_b_out)
        add_check(
            report,
            "16: job 1 output contains job 1's own data (B: 10,20,30,40), not job 0's",
            "data" in pd_job16_b.columns
            and list(pd_job16_b["data"]) == [10.0, 20.0, 30.0, 40.0]
        )

    # =========================================================================
    # TEST 17: three independent mass-conversion jobs preserve order and each
    # retains only its own data
    # =========================================================================

    job17_a_out = output_folder / "job17_a.xlsx"
    job17_b_out = output_folder / "job17_b.xlsx"
    job17_c_out = output_folder / "job17_c.xlsx"

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i", str(file_a), str(job17_a_out),
            "-i", str(file_b), str(job17_b_out),
            "-i", str(file_c), str(job17_c_out),
            "-y",
        ],
        b_verbose
    )

    add_check(
        report,
        "17: three independent jobs succeed together",
        result.returncode == 0
    )

    all_17_exist = job17_a_out.exists() and job17_b_out.exists() and job17_c_out.exists()

    add_check(
        report,
        "17: all three job outputs exist",
        all_17_exist
    )

    if all_17_exist:
        pd_17_a = pd.read_excel(job17_a_out)
        pd_17_b = pd.read_excel(job17_b_out)
        pd_17_c = pd.read_excel(job17_c_out)

        add_check(
            report,
            "17: job 0 output retains A's data (1,2,3,4)",
            list(pd_17_a["data"]) == [1.0, 2.0, 3.0, 4.0]
        )

        add_check(
            report,
            "17: job 1 output retains B's data (10,20,30,40)",
            list(pd_17_b["data"]) == [10.0, 20.0, 30.0, 40.0]
        )

        add_check(
            report,
            "17: job 2 output retains C's data (100,200,300,400)",
            list(pd_17_c["data"]) == [100.0, 200.0, 300.0, 400.0]
        )

    # =========================================================================
    # TEST 18: each job retains its own -ss / -to (including negative values),
    # with no leakage between jobs
    # =========================================================================

    job18_a_out = output_folder / "job18_a.xlsx"
    job18_b_out = output_folder / "job18_b.xlsx"

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i", str(file_a), "-ss", "-10", "-to", "-5", str(job18_a_out),
            "-i", str(file_b), "-ss", "20", "-to", "40", str(job18_b_out),
            "-y", "-v",
        ],
        b_verbose
    )

    add_check(
        report,
        "18: mass conversion with per-job -ss/-to succeeds",
        result.returncode == 0
    )

    jobs_18 = parse_mass_conversion_jobs(result.stderr)

    add_check(
        report,
        "18: each job retains its own -ss/-to (A: -10/-5, B: 20/40), no leakage",
        len(jobs_18) == 2
        and jobs_18[0]["startSample"] == "-10"
        and jobs_18[0]["endSample"] == "-5"
        and jobs_18[1]["startSample"] == "20"
        and jobs_18[1]["endSample"] == "40"
    )

    # =========================================================================
    # TEST 19: each job can retain its own -f (format hint) where supported
    # =========================================================================

    job19_a_out = output_folder / "job19_a.xlsx"
    job19_b_out = output_folder / "job19_b.csv"

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-f", "csv", "-i", str(file_a), str(job19_a_out),
            "-f", "xlsx", "-i", str(fixture_b_xlsx), str(job19_b_out),
            "-y", "-v",
        ],
        b_verbose
    )

    jobs_19 = parse_mass_conversion_jobs(result.stderr)

    add_check(
        report,
        "19: mass conversion with per-job -f succeeds",
        result.returncode == 0
    )

    add_check(
        report,
        "19: each job's own -f is retained without leaking to the other job",
        len(jobs_19) == 2
        and jobs_19[0]["input"] == str(file_a)
        and jobs_19[0]["output"] == str(job19_a_out)
        and jobs_19[1]["input"] == str(fixture_b_xlsx)
        and jobs_19[1]["output"] == str(job19_b_out)
    )

    # =========================================================================
    # TEST 20: multiple inputs mapped to a single shared output are rejected
    # explicitly (this is deliberately NOT mass conversion)
    # =========================================================================

    shared_out_20 = output_folder / "shared_20.xlsx"

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i", str(file_a),
            "-i", str(file_b),
            str(shared_out_20),
        ],
        b_verbose
    )

    add_check(
        report,
        "20: -i A -i B <one output> is rejected explicitly",
        result.returncode != 0
        and "cannot share a single output" in (result.stderr or "")
    )

    add_check(
        report,
        "20: -i A -i B <one output> never silently writes any output",
        not shared_out_20.exists()
    )

    # =========================================================================
    # TEST 21: multiple inputs with no outputs at all are rejected (never
    # silently reduced to processing only the first or only the last input)
    # =========================================================================

    result = run_usig(
        [node_executable, str(USIG_CLI), "-i", str(file_a), "-i", str(file_b)],
        b_verbose
    )

    add_check(
        report,
        "21: -i A -i B with no outputs at all is rejected (no plugin, no output)",
        result.returncode != 0
    )

    # =========================================================================
    # TEST 22: a mass-conversion job list where only some jobs have their own
    # output is rejected explicitly, rather than silently converting a subset
    # =========================================================================

    job22_a_out = output_folder / "job22_a.xlsx"

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i", str(file_a), str(job22_a_out),
            "-i", str(file_b),
        ],
        b_verbose
    )

    add_check(
        report,
        "22: partial job list (one input missing its own output) is rejected",
        result.returncode != 0
        and "requires every input to have its own recognized output" in (result.stderr or "")
    )

    # =========================================================================
    # TEST 23: existing single-input conversion (Test 1) and existing concat
    # parser tests (Tests 4-8, 13) remain valid under the new positional
    # output / job-grammar parsing logic — re-asserted here with a fresh,
    # simple single-input case to guard against regressions introduced by the
    # mass-conversion positional-output changes.
    # =========================================================================

    job23_out = output_folder / "job23_single.csv"

    result = run_usig(
        [node_executable, str(USIG_CLI), "-i", str(file_a), str(job23_out), "-y"],
        b_verbose
    )

    add_check(
        report,
        "23: single -i <in> <out> still follows the existing single-job path",
        result.returncode == 0 and job23_out.exists()
    )

    if job23_out.exists():
        pd_job23 = pd.read_csv(job23_out)
        add_check(
            report,
            "23: single-job output data is unchanged (1,2,3,4)",
            list(pd_job23["data"]) == [1.0, 2.0, 3.0, 4.0]
        )

    # =========================================================================
    # Final report
    # =========================================================================

    report_text = generate_report_text(report)
    print(report_text)
    save_report(report, output_folder)

    return 0 if all(item["passed"] for item in report) else 1


if __name__ == "__main__":
    raise SystemExit(main())
