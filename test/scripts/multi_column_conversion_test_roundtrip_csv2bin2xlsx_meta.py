import os
import time
import subprocess
import pandas as pd
import numpy as np
import shutil
from pathlib import Path


# =============================================================================
# Configuration
# =============================================================================

b_verbose = False

NUMERIC_ATOL = 2e-7
NUMERIC_RTOL = 0.0

# =============================================================================
# Helpers
# =============================================================================

def run_usig(command, b_verbose=False, log_file=None):

    result = subprocess.run(
        command,
        capture_output=True,
        text=True
    )

    command_text = " ".join(str(item) for item in command)

    if log_file is not None:
        with open(log_file, "a", encoding="utf-8") as f:
            f.write("\n")
            f.write("=" * 80 + "\n")
            f.write("COMMAND\n")
            f.write("=" * 80 + "\n")
            f.write(command_text + "\n")

            f.write("\n")
            f.write("=" * 80 + "\n")
            f.write("STDOUT\n")
            f.write("=" * 80 + "\n")
            f.write(result.stdout)

            f.write("\n")
            f.write("=" * 80 + "\n")
            f.write("STDERR\n")
            f.write("=" * 80 + "\n")
            f.write(result.stderr)

            f.write("\n")

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
    lines.append("USIG MULTI-COLUMN CONVERSION VALIDATION REPORT")
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
        "conversion_report.txt"
    )

    with open(report_path, "w", encoding="utf-8") as f:
        f.write(generate_report_text(report))

    return report_path


def varying_numeric_columns(dataframe):
    """
    Return columns which:

      1. contain numeric data
      2. actually vary among their non-NaN values

    NaN values are allowed.
    """

    columns = []

    for column in dataframe.columns:

        series = pd.to_numeric(
            dataframe[column],
            errors="coerce"
        )

        non_null = series.dropna()

        if (
            len(non_null) > 1
            and non_null.nunique(dropna=True) > 1
        ):
            columns.append(column)

    return columns


def validate_varying_columns(
    report,
    original,
    roundtrip,
    prefix
):

    original_varying = varying_numeric_columns(original)

    for column in original_varying:

        if column not in roundtrip.columns:
            add_check(
                report,
                f"{prefix}: varying column '{column}' exists",
                False
            )
            continue

        try:
            original_values = pd.to_numeric(
                original[column],
                errors="coerce"
            )

            roundtrip_values = pd.to_numeric(
                roundtrip[column],
                errors="coerce"
            )

            same_values = (
                len(original_values) == len(roundtrip_values)
                and np.allclose(
                original_values.to_numpy(dtype=float),
                roundtrip_values.to_numpy(dtype=float),
                rtol=NUMERIC_RTOL,
                atol=NUMERIC_ATOL,
                equal_nan=True
            )
            )

        except Exception:
            same_values = False

        add_check(
            report,
            f"{prefix}: varying column '{column}' values preserved",
            same_values
        )

def validate_dataframe(
    report,
    original,
    roundtrip,
    prefix,
    expected_extra_columns=None
):
    expected_extra_columns = expected_extra_columns or []

    expected_columns = (
        list(original.columns) +
        expected_extra_columns
    )

    add_check(
        report,
        f"{prefix}: column names preserved",
        list(roundtrip.columns) == expected_columns
    )

    add_check(
        report,
        f"{prefix}: row count preserved",
        len(original) == len(roundtrip)
    )

    validate_varying_columns(
        report,
        original,
        roundtrip,
        prefix
    )



# =============================================================================
# Main regression test
# =============================================================================

# def main():
if __name__ == '__main__':

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
    # Test data
    # -------------------------------------------------------------------------

    RESULTS_ROOT = (
        PROJECT_ROOT /
        "test" /
        "results"
    )

    timestamp = time.strftime(
        "%Y_%m_%d_%H_%M_%S"
    )

    output_folder = (
        RESULTS_ROOT /
        "multi_column_conversion_test" /
        timestamp
    )

    output_folder.mkdir(
        parents=True,
        exist_ok=True
    )

    conversion_log = Path(output_folder) / "usig_conversion.log"

    golden_csv = (
        PROJECT_ROOT /
        "test" /
        "golden_raw_data" /
        "inl_dnl_series.csv"
    )

    if not golden_csv.exists():
        raise FileNotFoundError(
            f"Missing golden dataset: {golden_csv}"
        )


    # -------------------------------------------------------------------------
    # Generated files
    # -------------------------------------------------------------------------

    csv_to_bin = (
        output_folder /
        "inl_dnl_series.bin"
    )

    bin_to_csv = (
        output_folder /
        "inl_dnl_series_bin2csv.csv"
    )

    override_bin = (
        output_folder /
        "inl_dnl_series_override.bin"
    )

    override_csv = (
        output_folder /
        "inl_dnl_series_override_bin2csv.csv"
    )

    xlsx_output = (
        output_folder /
        "inl_dnl_series.xlsx"
    )

    xlsx_roundtrip_csv = (
        output_folder /
        "inl_dnl_series_xlsx2csv.csv"
    )


    # -------------------------------------------------------------------------
    # Load original golden dataframe
    # -------------------------------------------------------------------------

    pd_orig = pd.read_csv(golden_csv)
    with open(conversion_log, "a", encoding="utf-8") as f:
        f.write(f"Columns: {list(pd_orig.columns)!r}\n")
        f.write(f"Shape: {pd_orig.shape!r}\n")

        for column in pd_orig.columns:
            series = pd.to_numeric(
                pd_orig[column],
                errors="coerce"
            )

            f.write(
                f"  {column}: "
                f"dtype={pd_orig[column].dtype!r}, "
                f"numeric={series.notna().all()!r}, "
                f"nunique={series.nunique(dropna=False)!r}, "
                f"min={series.min()!r}, "
                f"max={series.max()!r}\n"
            )

    # for column in pd_orig.columns:
    #     series = pd.to_numeric(
    #         pd_orig[column],
    #         errors="coerce"
    #     )
    #     if series.isna().any():
    #         bad_indices = series[series.isna()].index.tolist()
    #
    #         print(
    #             f"\nNON-NUMERIC VALUES DETECTED IN '{column}':"
    #         )
    #         print(
    #             f"  Count: {len(bad_indices)}"
    #         )
    #         print(
    #             f"  Indices: {bad_indices[:20]}"
    #         )
    #         print(
    #             f"  Raw values: "
    #             f"{pd_orig.loc[bad_indices[:20], column].tolist()}"
    #         )

        print(
            f"  {column}: "
            f"dtype={pd_orig[column].dtype}, "
            f"numeric={series.notna().all()}, "
            f"nunique={series.nunique(dropna=False)}, "
            f"min={series.min()}, "
            f"max={series.max()}"
        )

    report = []

    original_varying = varying_numeric_columns(pd_orig)

    print(
        f"Detected varying numeric columns: "
        f"{original_varying}"
    )


    # =========================================================================
    # DATASET SANITY CHECKS
    # =========================================================================

    add_check(
        report,
        "Dataset: at least one varying numeric column exists",
        len(original_varying) > 0
    )

    add_check(
        report,
        "Dataset: multiple varying numeric columns exist",
        len(original_varying) > 1
    )


    # =========================================================================
    # STEP 0
    #
    # CSV -> BIN
    # =========================================================================

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            str(csv_to_bin)
        ],
        b_verbose,
        conversion_log
    )

    add_check(
        report,
        "Step 0: CSV -> BIN command succeeded",
        result is not None
    )

    add_check(
        report,
        "Step 0: BIN file created",
        csv_to_bin.exists()
    )

    add_check(
        report,
        "Step 0: BIN file is non-empty",
        csv_to_bin.exists()
        and csv_to_bin.stat().st_size > 0
    )


    # =========================================================================
    # STEP 1
    #
    # BIN -> CSV
    #
    # This is the primary regression test:
    #
    # every varying numeric column from the original CSV must survive.
    # =========================================================================

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(csv_to_bin),
            str(bin_to_csv)
        ],
        b_verbose,
        conversion_log
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
        validate_dataframe(
            report,
            pd_orig,
            pd_roundtrip,
            "Step 1"
        )

    # =========================================================================
    # STEP 2
    #
    # CSV -> BIN with CLI override
    #
    # This deliberately does NOT test filename metadata inference.
    # It tests that a metadata/parameter override does not destroy the
    # multi-column waveform representation.
    # =========================================================================

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            "-p",
            "numaveraging=5",
            str(override_bin)
        ],
        b_verbose,
        conversion_log
    )

    add_check(
        report,
        "Step 2: override BIN command succeeded",
        result is not None
    )

    add_check(
        report,
        "Step 2: override BIN created",
        override_bin.exists()
    )

    add_check(
        report,
        "Step 2: override BIN non-empty",
        override_bin.exists()
        and override_bin.stat().st_size > 0
    )


    # =========================================================================
    # STEP 3
    #
    # BIN -> CSV after override
    # =========================================================================

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(override_bin),
            str(override_csv)
        ],
        b_verbose,
        conversion_log
    )

    add_check(
        report,
        "Step 3: override BIN -> CSV command succeeded",
        result is not None
    )

    add_check(
        report,
        "Step 3: override BIN -> CSV created",
        override_csv.exists()
    )

    pd_override = None

    if override_csv.exists():
        try:
            pd_override = pd.read_csv(override_csv)
        except Exception as e:
            print(f"Step 3: failed to read CSV: {e}")

    add_check(
        report,
        "Step 3: CSV readable",
        pd_override is not None
    )

    if pd_override is not None:
        with open(conversion_log, "a", encoding="utf-8") as f:
            f.write("\n")
            f.write("=" * 80 + "\n")
            f.write("STEP 3 DATAFRAME DIAGNOSTICS\n")
            f.write("=" * 80 + "\n")

        validate_dataframe(
            report,
            pd_orig,
            pd_override,
            "Step 3",
            expected_extra_columns=["numaveraging"]
        )

        add_check(
            report,
            "Step 3: numaveraging preserved",
            (
                "numaveraging" in pd_override.columns
                and pd_override["numaveraging"].eq(5).all()
            )
        )


    # =========================================================================
    # STEP 4
    #
    # CSV -> XLSX
    #
    # The XLSX path must preserve the same multi-column representation.
    # =========================================================================

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(override_csv),
            str(xlsx_output)
        ],
        b_verbose,
        conversion_log
    )

    add_check(
        report,
        "Step 4: CSV -> XLSX command succeeded",
        result is not None
    )

    add_check(
        report,
        "Step 4: XLSX file created",
        xlsx_output.exists()
    )

    add_check(
        report,
        "Step 4: XLSX file is non-empty",
        xlsx_output.exists()
        and xlsx_output.stat().st_size > 0
    )


    # =========================================================================
    # STEP 5
    #
    # XLSX -> CSV
    #
    # Validate complete multi-column preservation.
    # =========================================================================

    result = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(xlsx_output),
            str(xlsx_roundtrip_csv)
        ],
        b_verbose,
        conversion_log
    )

    add_check(
        report,
        "Step 5: XLSX -> CSV command succeeded",
        result is not None
    )

    add_check(
        report,
        "Step 5: XLSX -> CSV created",
        xlsx_roundtrip_csv.exists()
    )

    pd_xlsx = None

    if xlsx_roundtrip_csv.exists():

        try:
            pd_xlsx = pd.read_csv(
                xlsx_roundtrip_csv
            )

        except Exception as e:
            print(
                f"Step 5: failed to read CSV: {e}"
            )

    add_check(
        report,
        "Step 5: CSV readable",
        pd_xlsx is not None
    )

    if pd_xlsx is not None:
        with open(conversion_log, "a", encoding="utf-8") as f:
            f.write("\n")
            f.write("=" * 80 + "\n")
            f.write("STEP 5 DATAFRAME DIAGNOSTICS\n")
            f.write("=" * 80 + "\n")
            f.write(
                f"Original columns: {list(pd_orig.columns)!r}\n"
            )
            f.write(
                f"XLSX columns: {list(pd_xlsx.columns)!r}\n"
            )
            f.write(
                f"Original shape: {pd_orig.shape!r}\n"
            )
            f.write(
                f"XLSX shape: {pd_xlsx.shape!r}\n"
            )
            f.write(
                f"Original dtypes:\n{pd_orig.dtypes!r}\n"
            )
            f.write(
                f"XLSX dtypes:\n{pd_xlsx.dtypes!r}\n"
            )

        validate_dataframe(
            report,
            pd_orig,
            pd_xlsx,
            "Step 5",
            expected_extra_columns=["numaveraging"]
        )

        add_check(
            report,
            "Step 5: numaveraging preserved",
            (
                    "numaveraging" in pd_xlsx.columns
                    and pd_xlsx["numaveraging"].eq(5).all()
            )
        )

    # =========================================================================
    # FINAL REPORT
    # =========================================================================

    report_text = generate_report_text(report)

    print(report_text)

    save_report(
        report,
        output_folder
    )


# if __name__ == "__main__":
#     main()
