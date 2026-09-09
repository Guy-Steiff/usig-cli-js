import os
import time
import subprocess
import pandas as pd
import shutil
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
def validate_metadata(report, dataframe, expected_metadata, prefix):

    for key, expected_value in expected_metadata.items():

        if key not in dataframe.columns:
            add_check(
                report,
                f"{prefix}: {key} metadata column exists",
                False
            )
            continue

        add_check(
            report,
            f"{prefix}: {key} metadata recovered",
            (dataframe[key] == expected_value).all()
        )

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

    if result.returncode != 0:
        print(
            f"\nUSIG command failed:\n"
            f"{command_text}\n\n"
            f"{result.stderr}"
        )
        return None

    return result

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


def add_check(report, name, condition):
    """
    Add a validation result to the report.

    We intentionally do not assert immediately.
    The goal is to execute the entire conversion flow and
    provide a complete pass/fail summary at the end.
    """

    report.append(
        {
            "check": name,
            "passed": bool(condition)
        }
    )


def generate_report_text(report):

    lines = []

    lines.append("=" * 80)
    lines.append("USIG CONVERSION VALIDATION REPORT")
    lines.append(f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}")
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
        "conversion_report.txt"
    )

    text = generate_report_text(report)

    with open(report_path, "w", encoding="utf-8") as f:
        f.write(text)

    return report_path

# =============================================================================
# Main conversion regression test
# =============================================================================

def main():

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

    # Verify Node runtime is available because USIG CLI is Node-based.
    subprocess.run(
        [node_executable, "--version"],
        check=True,
        capture_output=True
    )

    # -------------------------------------------------------------------------
    # Test data and result folders
    # -------------------------------------------------------------------------

    RESULTS_ROOT = os.path.join(PROJECT_ROOT, "test", "results")
    timestamp = time.strftime("%Y_%m_%d_%H_%M_%S")
    output_folder = os.path.join(RESULTS_ROOT, "conversion_dataframe_test", timestamp)

    os.makedirs(output_folder, exist_ok=True)

    golden_csv = (
        PROJECT_ROOT
        / "test"
        / "golden_raw_data"
        / "sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv"
    )

    if not golden_csv.exists():
        raise FileNotFoundError(
            f"Missing golden dataset: {golden_csv}"
        )


    # -------------------------------------------------------------------------
    # Define generated files
    # -------------------------------------------------------------------------

    csv_to_bin = Path(
        os.path.join(output_folder,
                     (
                         "sine_fs2p25ghz_tonemode~single_fftlength8192_"
                         "numaveraging4_numberofcores8_ticorrections~ogp.bin"
                     )
                     )
    )

    bin_to_csv = Path(
        os.path.join(output_folder,
                     (
                         "sine_fs2p25ghz_tonemode~single_fftlength8192_"
                         "numaveraging4_numberofcores8_ticorrections~ogp.csv"
                     )
                     )
    )

    metadata_bin = Path(
        os.path.join(output_folder,
                     (
                         "sine_fs2p25ghz_tonemode~single_fftlength8192_"
                         "numaveraging4_numberofcores8_ticorrections~ogp_metafromfile.bin"
                     )
                     )
    )

    metadata_bin_to_csv = Path(
        os.path.join(output_folder,
                     (
                         "sine_fs2p25ghz_tonemode~single_fftlength8192_"
                         "numaveraging4_numberofcores8_ticorrections~ogp_metafromfile_bin2csv.csv"
                     )
                     )
    )



    # -------------------------------------------------------------------------
    # Load original golden dataframe once.
    #
    # This dataframe represents the expected source data.
    # All roundtrip comparisons are performed against this.
    # -------------------------------------------------------------------------

    pd_orig = pd.read_csv(golden_csv)

    report = []

    # =========================================================================
    # STEP 0
    #
    # CSV -> BIN
    #
    # Verify:
    #   - CLI succeeds
    #   - BIN file is created
    #   - BIN file is non-empty
    # =========================================================================

    run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            str(csv_to_bin)
        ],
        b_verbose
    )

    add_check(
        report,
        "Step 0: CSV -> BIN file created",
        Path(csv_to_bin).exists()
    )

    add_check(
        report,
        "Step 0: BIN file is non-empty",
        Path(csv_to_bin).exists() and Path(csv_to_bin).stat().st_size > 0
    )

    # =========================================================================
    # STEP 1
    #
    # BIN -> CSV
    #
    # Verify:
    #   - waveform survives the roundtrip
    #   - exported dataframe structure is preserved
    # =========================================================================

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(csv_to_bin),
            str(bin_to_csv)
        ],
        b_verbose
    )

    add_check(
        report,
        "Step 1: BIN -> CSV command succeeded",
        result is not None
    )

    add_check(
        report,
        "Step 1: BIN -> CSV file created",
        bin_to_csv.exists()
    )

    pd_roundtrip = None

    if bin_to_csv.exists():
        try:
            pd_roundtrip = pd.read_csv(bin_to_csv)
        except Exception as e:
            print(f"Step 1: failed to read CSV: {e}")

    add_check(
        report,
        "Step 1: CSV readable",
        pd_roundtrip is not None
    )

    if pd_roundtrip is not None:
        add_check(
            report,
            "Step 1: CSV column count preserved",
            len(pd_orig.columns) == len(pd_roundtrip.columns)
        )

        add_check(
            report,
            "Step 1: CSV column names preserved",
            list(pd_orig.columns) == list(pd_roundtrip.columns)
        )

        add_check(
            report,
            "Step 1: waveform data preserved",
            "data" in pd_roundtrip.columns
            and "data" in pd_orig.columns
            and (pd_roundtrip["data"] == pd_orig["data"]).all()
        )

        add_check(
            report,
            "Step 1: row count preserved",
            len(pd_orig) == len(pd_roundtrip)
        )

    # =========================================================================
    # STEP 2
    #
    # CSV -> BIN using metadata inferred from filename
    # (CSV -> BIN with --infer-meta-from-filename)
    #
    # Metadata is not validated here because it is stored inside the BIN.
    # Validation happens after STEP 3 when the BIN is exported again.
    # =========================================================================

    run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            "-infer-meta-from-filename",
            str(metadata_bin)
        ],
        b_verbose
    )

    add_check(
        report,
        "Step 2: metadata-inferred BIN created",
        metadata_bin.exists()
    )

    add_check(
        report,
        "Step 2: metadata-inferred BIN non-empty",
        metadata_bin.exists() and metadata_bin.stat().st_size > 0
    )

    # =========================================================================
    # STEP 3
    #
    # BIN -> CSV
    #
    # Validate:
    #
    #   1. Waveform survived
    #   2. Metadata inferred from filename was embedded correctly
    #      and reconstructed correctly
    #
    # =========================================================================

    run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(metadata_bin),
            str(metadata_bin_to_csv)
        ],
        b_verbose
    )

    add_check(
        report,
        "Step 3: metadata BIN -> CSV created",
        metadata_bin_to_csv.exists()
    )

    pd_metadata_roundtrip = None

    if metadata_bin_to_csv.exists():
        try:
            pd_metadata_roundtrip = pd.read_csv(metadata_bin_to_csv)
        except Exception as e:
            print(f"Step 3: failed to read CSV: {e}")

    add_check(
        report,
        "Step 3: CSV readable",
        pd_metadata_roundtrip is not None
    )

    # -------------------------------------------------------------------------
    # Waveform validation
    # -------------------------------------------------------------------------

    add_check(
        report,
        "Step 3: waveform preserved after metadata BIN roundtrip",
        pd_metadata_roundtrip is not None
        and "data" in pd_metadata_roundtrip.columns
        and (pd_metadata_roundtrip["data"] == pd_orig["data"]).all()
    )

    # -------------------------------------------------------------------------
    # Metadata validation
    #
    # These values originate from filename parsing:
    #
    # sine_fs2p25ghz_tonemode~single_fftlength8192_
    # numaveraging4_numberofcores8_ticorrections~ogp.csv
    #
    # The fact these survive:
    #
    # filename
    #    |
    #    v
    # metadata inference
    #    |
    #    v
    # binary container
    #    |
    #    v
    # CSV export
    #
    # proves the metadata pipeline.
    # -------------------------------------------------------------------------

    if pd_metadata_roundtrip is not None:
        validate_metadata(
            report,
            pd_metadata_roundtrip,
            {
                "fs": 2.25,
                "tonemode": "single",
                "fftlength": 8192,
                "numaveraging": 4,
                "numberofcores": 8,
                "ticorrections": "ogp"
            },
            "Step 3"
        )


    # =========================================================================
    # STEP 4
    #
    # CSV -> BIN
    #
    # Override:
    #     numaveraging=5
    #
    # This tests that CLI parameter overrides are embedded into the container.
    #
    # Validation happens after STEP 5 when the BIN is exported again.
    # =========================================================================

    run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            metadata_bin_to_csv,
            "-p",
            "numaveraging=5",
            os.path.join(output_folder, "sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp_woverrides.bin")
        ],
        b_verbose
    )

    override_bin = Path(
        os.path.join(
            output_folder,
            "sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_"
            "numberofcores8_ticorrections~ogp_woverrides.bin")
    )

    add_check(
        report,
        "Step 4: override BIN created",
        override_bin.exists()
    )

    # =========================================================================
    # STEP 5
    #
    # BIN -> CSV
    #
    # Validate:
    #   - waveform preserved
    #   - override metadata applied
    # =========================================================================

    override_csv = Path(
        os.path.join(output_folder,
                     "sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_"
                     "numberofcores8_ticorrections~ogp_woverrides_bin2csv.csv"
                     )
    )

    run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(override_bin),
            str(override_csv)
        ],
        b_verbose
    )

    add_check(
        report,
        "Step 5: override BIN exported to CSV",
        override_csv.exists()
    )

    pd_override = None

    if override_csv.exists():
        try:
            pd_override = pd.read_csv(override_csv)
        except Exception as e:
            print(f"Step 5: failed to read CSV: {e}")

    add_check(
        report,
        "Step 5: CSV readable",
        pd_override is not None
    )

    add_check(
        report,
        "Step 5: waveform preserved after override",
        pd_override is not None
        and "data" in pd_override.columns
        and (pd_override["data"] == pd_orig["data"]).all()

    )

    add_check(
        report,
        "Step 5: row count preserved after override",
        pd_override is not None
        and len(pd_override) == len(pd_orig)

    )
    if pd_override is not None:
        validate_metadata(
            report,
            pd_override,
            {
                "fs": 2.25,
                "tonemode": "single",
                "fftlength": 8192,
                "numaveraging": 5,
                "numberofcores": 8,
                "ticorrections": "ogp"
            },
            "Step 5"
        )

    # =========================================================================
    # STEP 6
    #
    # CSV -> XLSX
    #
    # Override:
    #     gg=1
    #
    # Validation happens after STEP 7.
    # =========================================================================

    xlsx_output = Path(
        os.path.join(
            output_folder,
            "sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_"
            "numberofcores8_ticorrections~ogp_woverrides_bin2csv.xlsx")
    )

    run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(override_csv),
            "-p",
            "gg=1",
            str(xlsx_output)
        ],
        b_verbose
    )

    add_check(
        report,
        "Step 6: XLSX export created",
        xlsx_output.exists()
    )

    add_check(
        report,
        "Step 6: XLSX file is non-empty",
        xlsx_output.exists() and xlsx_output.stat().st_size > 0
    )

    # =========================================================================
    # STEP 7
    #
    # XLSX -> CSV
    #
    # Validate:
    #   - XLSX ingestion works
    #   - waveform preserved
    #   - metadata survives
    # =========================================================================

    xlsx_roundtrip_csv = Path(
        os.path.join(output_folder,
                     "sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_"
                     "numberofcores8_ticorrections~ogp_woverrides_xlsx2csv.csv"
                     )
    )

    run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(xlsx_output),
            str(xlsx_roundtrip_csv)
        ],
        b_verbose
    )

    add_check(
        report,
        "Step 7: XLSX imported and exported to CSV",
        xlsx_roundtrip_csv.exists()
    )

    pd_xlsx = None

    if xlsx_roundtrip_csv.exists():
        try:
            pd_xlsx = pd.read_csv(xlsx_roundtrip_csv)
        except Exception as e:
            print(f"Step 7: failed to read CSV: {e}")

    add_check(
        report,
        "Step 7: CSV readable",
        pd_xlsx is not None
    )

    add_check(
        report,
        "Step 7: waveform preserved after XLSX roundtrip",
        pd_xlsx is not None
        and pd_override is not None
        and "data" in pd_xlsx.columns
        and "data" in pd_override.columns
        and (pd_xlsx["data"] == pd_override["data"]).all()

    )

    add_check(
        report,
        "Step 7: row count preserved after XLSX roundtrip",
        pd_xlsx is not None
        and pd_override is not None
        and len(pd_xlsx) == len(pd_override)
    )
    if pd_xlsx is not None:
        validate_metadata(
            report,
            pd_xlsx,
            {
                "fs": 2.25,
                "tonemode": "single",
                "fftlength": 8192,
                "numaveraging": 5,
                "numberofcores": 8,
                "ticorrections": "ogp",
                "gg": 1
            },
            "Step 7"
        )

    # -------------------------------------------------------------------------
    # Final report
    # -------------------------------------------------------------------------

    report_text = generate_report_text(report)
    print(report_text)
    save_report(
        report,
        Path(output_folder)
    )

if __name__ == "__main__":
    main()