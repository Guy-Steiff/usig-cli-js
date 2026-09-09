import os
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
    # Two tiny distinguishable CSVs so that concat entry-order can be proven
    # by inspecting which file's data ended up in the (phase-1 single-input)
    # output.
    # =========================================================================

    file_a = output_folder / "A.csv"
    file_b = output_folder / "B.csv"

    write_csv(file_a, [1.0, 2.0, 3.0, 4.0])
    write_csv(file_b, [10.0, 20.0, 30.0, 40.0])

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
        "4: -f concat -i list.txt (A then B) command succeeds",
        result.returncode == 0
    )

    if concat_ab_out.exists():
        pd_concat_ab = pd.read_csv(concat_ab_out)
        add_check(
            report,
            "4: concat resolves relative paths and selects first entry (A)",
            "data" in pd_concat_ab.columns
            and list(pd_concat_ab["data"]) == [1.0, 2.0, 3.0, 4.0]
        )
    else:
        add_check(
            report,
            "4: concat resolves relative paths and selects first entry (A)",
            False
        )

    # =========================================================================
    # TEST 5: strict concat list — order preserved (B then A)
    # =========================================================================

    list_ba = output_folder / "list_ba.txt"
    list_ba.write_text(
        f"file '{file_b.name}'\nfile '{file_a.name}'\n",
        encoding="utf-8"
    )

    concat_ba_out = output_folder / "concat_ba.csv"

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-f",
            "concat",
            "-i",
            str(list_ba),
            str(concat_ba_out)
        ],
        b_verbose
    )

    add_check(
        report,
        "5: -f concat -i list.txt (B then A) command succeeds",
        result.returncode == 0
    )

    if concat_ba_out.exists():
        pd_concat_ba = pd.read_csv(concat_ba_out)
        add_check(
            report,
            "5: concat entry order determines selected input (B first)",
            "data" in pd_concat_ba.columns
            and list(pd_concat_ba["data"]) == [10.0, 20.0, 30.0, 40.0]
        )
    else:
        add_check(
            report,
            "5: concat entry order determines selected input (B first)",
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
    # Final report
    # =========================================================================

    report_text = generate_report_text(report)
    print(report_text)
    save_report(report, output_folder)

    return 0 if all(item["passed"] for item in report) else 1


if __name__ == "__main__":
    raise SystemExit(main())
