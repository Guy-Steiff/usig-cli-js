import os
import time
import subprocess
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

    os.environ["PATH"] += ':/home/gnew/.nvm/versions/node/v24.11.1/bin'

    PROJECT_ROOT = Path(__file__).resolve().parents[2]

    # Verify Node runtime is available because USIG CLI is Node-based.
    subprocess.run(
        ["node", "--version"],
        check=True
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
            "usig",
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

    run_usig(
        [
            "usig",
            "-i",
            str(csv_to_bin),
            str(bin_to_csv)
        ],
        b_verbose
    )

    add_check(
        report,
        "Step 1: BIN -> CSV file created",
        bin_to_csv.exists()
    )

    pd_roundtrip = pd.read_csv(bin_to_csv)

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
        (pd_roundtrip["data"] == pd_orig["data"]).all()
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
    #
    # Metadata is not validated here because it is stored inside the BIN.
    # Validation happens after STEP 3 when the BIN is exported again.
    # =========================================================================

    run_usig(
        [
            "usig",
            "-i",
            str(golden_csv),
            "--infer-meta-from-filename",
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
            "usig",
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

    pd_metadata_roundtrip = pd.read_csv(metadata_bin_to_csv)

    # -------------------------------------------------------------------------
    # Waveform validation
    # -------------------------------------------------------------------------

    add_check(
        report,
        "Step 3: waveform preserved after metadata BIN roundtrip",
        (pd_metadata_roundtrip["data"] == pd_orig["data"]).all()
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
            "usig",
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
            "usig",
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

    pd_override = pd.read_csv(override_csv)

    add_check(
        report,
        "Step 5: waveform preserved after override",
        (pd_override["data"] == pd_orig["data"]).all()
    )

    add_check(
        report,
        "Step 5: row count preserved after override",
        len(pd_override) == len(pd_orig)
    )

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
            "usig",
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
            "usig",
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

    pd_xlsx = pd.read_csv(xlsx_roundtrip_csv)

    add_check(
        report,
        "Step 7: waveform preserved after XLSX roundtrip",
        (pd_xlsx["data"] == pd_override["data"]).all()
    )

    add_check(
        report,
        "Step 7: row count preserved after XLSX roundtrip",
        len(pd_xlsx) == len(pd_override)
    )

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