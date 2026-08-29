import subprocess
import shutil
from pathlib import Path
import os
import time



# =============================================================================
# Configuration
# =============================================================================

# Controls printing of subprocess stdout/stderr.
# Keep False for normal regression runs.
# Set True when debugging CLI behavior.
b_verbose = True


# =============================================================================
# Helpers
# =============================================================================

def run_usig(command, b_verbose=False):
    """
    Execute a USIG CLI command.

    Returns
    -------
    subprocess.CompletedProcess
    """

    result = subprocess.run(
        command,
        capture_output=True,
        text=True
    )

    if b_verbose:
        print("\nCOMMAND:")
        print(" ".join(command))

        print("\nSTDOUT:")
        print(result.stdout)

        print("\nSTDERR:")
        print(result.stderr)

    if result.returncode != 0:
        raise RuntimeError(
            f"USIG command failed:\n"
            f"{' '.join(command)}\n\n"
            f"{result.stderr}"
        )

    return result


def add_check(report, name, condition):
    """
    Add a validation result.
    """

    report.append(
        {
            "check": name,
            "passed": bool(condition)
        }
    )


def validate_numeric(
        report,
        name,
        actual,
        expected,
        tolerance_percent
):
    """
    Validate numeric result with percentage tolerance.
    """

    if actual is None:
        add_check(
            report,
            name,
            False
        )
        return

    tolerance = abs(expected) * tolerance_percent / 100.0

    add_check(
        report,
        name,
        abs(actual - expected) <= tolerance
    )


def generate_report_text(report):

    lines = []

    lines.append("=" * 80)
    lines.append("USIG SMEAS VALIDATION REPORT")
    lines.append(
        f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}"
    )
    lines.append("=" * 80)

    failed = 0

    for item in report:

        status = "PASS" if item["passed"] else "FAIL"

        if not item["passed"]:
            failed += 1

        lines.append(
            f"{status:<6} : {item['check']}"
        )

    lines.append("-" * 80)

    lines.append(
        f"TOTAL: {len(report)} checks, "
        f"{failed} failures"
    )

    lines.append("=" * 80)

    return "\n".join(lines)


def save_report(report, output_folder):

    report_path = (
        output_folder /
        "smeas_validation_report.txt"
    )

    text = generate_report_text(report)

    with open(
        report_path,
        "w",
        encoding="utf-8"
    ) as f:
        f.write(text)

    return report_path


def parse_smeas_output(stdout):
    """
    Parse the Outputs section from verbose smeas output.

    Example:

    Outputs:
      snr_c: 40.16
      enob_sndr_fs: 8.449

    Returns
    -------
    dict
    """

    outputs = {}

    in_outputs = False

    for line in stdout.splitlines():

        line = line.strip()

        if line == "Outputs:":
            in_outputs = True
            continue

        if not in_outputs:
            continue

        if not line:
            continue

        if ":" not in line:
            continue

        key, value = line.split(":", 1)

        key = key.strip()
        value = value.strip()

        try:
            outputs[key] = float(value)

        except ValueError:
            outputs[key] = value

    return outputs


def find_node():

    # Normal case:
    # node is already available in PATH
    node = shutil.which("node")

    if node:
        return node

    # Common Windows locations
    windows_candidates = [
        Path(os.environ.get("ProgramFiles", "")) / "nodejs" / "node.exe",
        Path(os.environ.get("ProgramFiles(x86)", "")) / "nodejs" / "node.exe",
    ]

    # Common Unix locations
    unix_candidates = [
        Path("/usr/bin/node"),
        Path("/usr/local/bin/node"),
    ]

    candidates = (
        windows_candidates +
        unix_candidates
    )

    for candidate in candidates:

        if candidate.exists():
            return str(candidate)

        # nvm fallback (Linux/macOS)
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


# =============================================================================
# Main SMEAS regression test
# =============================================================================

def main():

    # -------------------------------------------------------------------------
    # Environment setup
    # -------------------------------------------------------------------------
    # -------------------------------------------------------------------------
    # Environment setup
    # -------------------------------------------------------------------------

    PROJECT_ROOT = Path(__file__).resolve().parents[2]
    node_executable = find_node()

    USIG_CLI = PROJECT_ROOT / "usig.mjs"

    if not USIG_CLI.exists():
        raise FileNotFoundError(
            f"Missing USIG CLI entry point: {USIG_CLI}"
        )

    subprocess.run(
        [node_executable, "--version"],
        check=True,
        capture_output=True
    )

    # -------------------------------------------------------------------------
    # Test folders
    # -------------------------------------------------------------------------

    RESULTS_ROOT = (
            PROJECT_ROOT /
            "test" /
            "results" /
            "smeas_scalar_kpi_test"
    )

    timestamp = time.strftime(
        "%Y_%m_%d_%H_%M_%S"
    )

    output_folder = (
            RESULTS_ROOT /
            timestamp
    )

    output_folder.mkdir(
        parents=True,
        exist_ok=True
    )

    # -------------------------------------------------------------------------
    # Golden dataset
    # -------------------------------------------------------------------------

    golden_csv = (
        PROJECT_ROOT
        /
        "test"
        /
        "golden_raw_data"
        /
        "sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv"
    )


    if not golden_csv.exists():

        raise FileNotFoundError(
            f"Missing golden dataset: {golden_csv}"
        )


    report = []


    # =========================================================================
    # Configuration 1
    #
    # tiCorrections=none
    #
    # Expected:
    #
    # fund1_mhz       118.6523 +/- 1%
    # enob_sndr_fs    8.449   +/- 1%
    # sfdr_wo_ti_dbc  57.6    +/- 1%
    #
    # =========================================================================

    config1_output = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            "-plugin",
            "smeas",
            "-p",
            "fsGhz=2.25",
            "-p",
            "fftLength=8192",
            "-p",
            "numAveraging=4",
            "-p",
            "numberOfCores=8",
            "-p",
            "tiCorrections=none",
            "-p",
            "window=auto",
            "-v",
            "verbose"
        ],
        b_verbose
    )


    smeas1 = parse_smeas_output(
        config1_output.stdout
    )


    add_check(
        report,
        "Configuration 1: smeas execution completed",
        len(smeas1) > 0
    )


    validate_numeric(
        report,
        "Configuration 1: fund1_mhz within tolerance",
        smeas1.get("fund1_mhz"),
        118.6523,
        1
    )


    validate_numeric(
        report,
        "Configuration 1: enob_sndr_fs within tolerance",
        smeas1.get("enob_sndr_fs"),
        8.449,
        1
    )


    validate_numeric(
        report,
        "Configuration 1: sfdr_wo_ti_dbc within tolerance",
        smeas1.get("sfdr_wo_ti_dbc"),
        57.6,
        1
    )


    # =========================================================================
    # Configuration 2
    #
    # tiCorrections=ogp
    #
    # Expected:
    #
    # fund1_mhz       118.6523 +/- 1%
    # enob_sndr_fs    8.455   +/- 1%
    #
    # =========================================================================

    config2_output = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            "-plugin",
            "smeas",
            "-p",
            "fsGhz=2.25",
            "-p",
            "fftLength=8192",
            "-p",
            "numAveraging=4",
            "-p",
            "numberOfCores=8",
            "-p",
            "tiCorrections=ogp",
            "-p",
            "window=auto",
            "-v",
            "verbose"
        ],
        b_verbose
    )


    smeas2 = parse_smeas_output(
        config2_output.stdout
    )


    add_check(
        report,
        "Configuration 2: smeas execution completed",
        len(smeas2) > 0
    )


    validate_numeric(
        report,
        "Configuration 2: fund1_mhz within tolerance",
        smeas2.get("fund1_mhz"),
        118.6523,
        1
    )


    validate_numeric(
        report,
        "Configuration 2: enob_sndr_fs within tolerance",
        smeas2.get("enob_sndr_fs"),
        8.455,
        1
    )

    # -------------------------------------------------------------------------
    # Save raw outputs for debugging
    # -------------------------------------------------------------------------

    with open(
            output_folder / "config1_verbose_output.txt",
            "w",
            encoding="utf-8"
    ) as f:
        f.write(config1_output.stdout)

    with open(
            output_folder / "config1_stderr.txt",
            "w",
            encoding="utf-8"
    ) as f:
        f.write(config1_output.stderr)

    with open(
            output_folder / "config2_verbose_output.txt",
            "w",
            encoding="utf-8"
    ) as f:
        f.write(config2_output.stdout)

    with open(
            output_folder / "config2_stderr.txt",
            "w",
            encoding="utf-8"
    ) as f:
        f.write(config2_output.stderr)

    # -------------------------------------------------------------------------
    # Final report
    # -------------------------------------------------------------------------

    report_text = generate_report_text(report)

    print(report_text)

    save_report(
        report,
        output_folder
    )


if __name__ == "__main__":
    main()
