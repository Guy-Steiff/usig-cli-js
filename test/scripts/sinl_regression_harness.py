import os
import shutil
import subprocess
import time
from pathlib import Path
# =============================================================================
# Configuration
# =============================================================================

# Controls printing of subprocess command/stdout/stderr.
#
# False:
#     Normal regression operation.
#
# True:
#     Print every command, return code, stdout and stderr immediately.
b_verbose = False

# Percentage tolerance for numeric regression comparisons.
KPI_TOLERANCE_PERCENT = 1.0
# =============================================================================
# Helpers
# =============================================================================

def add_check(report, name, condition, reason=None):
    """
    Add a validation result to the regression report.
    """

    item = {
        "check": name,
        "passed": bool(condition),
    }

    if reason:
        item["reason"] = reason

    report.append(item)
def add_skip(report, name, reason):
    """
    Add a skipped validation.
    Skips are intentionally not counted as failures.
    """

    report.append(
        {
            "check": name,
            "passed": True,
            "skipped": True,
            "reason": reason,
        }
    )
def command_succeeded(result):
    """
    Return True when a subprocess completed successfully.
    """

    return (
        result is not None
        and result.returncode == 0
    )
def check_command(report, name, result):
    """
    Record whether a command completed successfully.
    """

    if result is None:
        add_check(
            report,
            name,
            False,
            "command could not be started"
        )

        return

    if result.returncode != 0:
        add_check(
            report,
            name,
            False,
            f"command returned exit code {result.returncode}"
        )

        return

    add_check(
        report,
        name,
        True
    )
def get_stdout(result):
    """
    Safely return stdout from a subprocess result.
    """

    if result is None:
        return ""

    return result.stdout or ""
def get_stderr(result):
    """
    Safely return stderr from a subprocess result.
    """

    if result is None:
        return ""

    return result.stderr or ""
def run_usig(command, b_verbose=False):
    """
    Execute a USIG CLI command.
    Important:
        A USIG non-zero exit code does not raise an exception.
    The regression harness records the failure and continues so that all
    independent tests can execute.
    Returns
    -------
    subprocess.CompletedProcess | None
        CompletedProcess when the process started successfully.
        None only when subprocess execution itself could not be started.
    """

    command = [str(arg) for arg in command]

    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True
        )

    except Exception as exc:
        print(
            "\nFAILED TO START USIG COMMAND:\n"
            f"{' '.join(command)}\n\n"
            f"{type(exc).__name__}: {exc}"
        )

        return None

    if b_verbose:
        print("\n" + "=" * 80)
        print("COMMAND")
        print("=" * 80)
        print(" ".join(command))

        print("\nRETURN CODE:")
        print(result.returncode)

        print("\nSTDOUT:")
        print(result.stdout)

        print("\nSTDERR:")
        print(result.stderr)

    elif result.returncode != 0:
        print(
            f"\nUSIG command failed "
            f"(return code {result.returncode}):\n"
            f"{' '.join(command)}\n"
            f"\nSTDOUT:\n{result.stdout}"
            f"\nSTDERR:\n{result.stderr}"
        )

    return result
def save_text(path, text):
    """
    Save text using UTF-8.
    """

    path = Path(path)

    with open(
        path,
        "w",
        encoding="utf-8"
    ) as f:
        f.write(
            text or ""
        )
def save_command_output(
        output_folder,
        prefix,
        result
):
    """
    Save stdout and stderr for a command.
    Safe when the command failed or could not be started.
    """

    stdout_path = (
        output_folder /
        f"{prefix}_stdout.txt"
    )

    stderr_path = (
        output_folder /
        f"{prefix}_stderr.txt"
    )

    save_text(
        stdout_path,
        get_stdout(result)
    )

    save_text(
        stderr_path,
        get_stderr(result)
    )

    return stdout_path, stderr_path
def assert_file_exists(report, name, path):
    """
    Check that a file exists and is a regular file.
    """

    path = Path(path)

    add_check(
        report,
        name,
        path.exists() and path.is_file(),
        None
        if path.exists() and path.is_file()
        else f"file not found: {path}"
    )
def validate_numeric(
        report,
        name,
        actual,
        expected,
        tolerance_percent=KPI_TOLERANCE_PERCENT
):
    """
    Validate a numeric value against an expected value.
    Uses percentage tolerance.
    Zero is handled explicitly because percentage tolerance around zero
    is otherwise meaningless.
    """

    if actual is None:
        add_check(
            report,
            name,
            False,
            "actual value was not available"
        )

        return

    try:
        actual = float(actual)
        expected = float(expected)

    except (
        TypeError,
        ValueError
    ):
        add_check(
            report,
            name,
            False,
            f"non-numeric value: actual={actual!r}"
        )

        return

    if expected == 0:
        passed = (
            actual == 0
        )

        reason = (
            None
            if passed
            else f"expected 0, actual {actual}"
        )

    else:
        tolerance = (
            abs(expected)
            * tolerance_percent
            / 100.0
        )

        difference = abs(
            actual - expected
        )

        passed = (
            difference <= tolerance
        )

        reason = (
            None
            if passed
            else (
                f"expected {expected}, "
                f"actual {actual}, "
                f"allowed ±{tolerance}"
            )
        )

    add_check(
        report,
        name,
        passed,
        reason
    )
def parse_scalar_outputs(stdout):
    """
    Parse the normal USIG text output.
    Expected structure:
        Outputs:
          inl_codes_p2p: 0.1843
          inl_max: 3.307
          code_inl_max: 1171
          ...
    Returns
    -------
    dict
        Mapping of output name to float/string.
    """

    outputs = {}

    if not stdout:
        return outputs

    in_outputs = False

    for raw_line in stdout.splitlines():
        line = raw_line.strip()

        if line == "Outputs:":
            in_outputs = True
            continue

        if not in_outputs:
            continue

        if not line:
            continue

        if ":" not in line:
            continue

        key, value = line.split(
            ":",
            1
        )

        key = key.strip()
        value = value.strip()

        if not key:
            continue

        try:
            outputs[key] = float(value)

        except ValueError:
            outputs[key] = value

    return outputs
def find_node():
    """
    Locate Node.js in an OS-agnostic manner.
    Search order:
      1. PATH
      2. Common Windows installations
      3. Common Unix installations
      4. nvm installations

    Returns
    -------
    str
        Node executable path.
    """

    node = shutil.which("node")

    if node:
        return node

    windows_candidates = [

        Path(
            os.environ.get(
                "ProgramFiles",
                ""
            )
        )
        / "nodejs"
        / "node.exe",
        Path(
            os.environ.get(
                "ProgramFiles(x86)",
                ""
            )
        )
        / "nodejs"
        / "node.exe",
    ]

    unix_candidates = [

        Path("/usr/bin/node"),
        Path("/usr/local/bin/node"),
    ]

    candidates = (
        windows_candidates
        + unix_candidates
    )

    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return str(candidate)

    # -------------------------------------------------------------------------
    # nvm fallback
    # -------------------------------------------------------------------------

    nvm_root = (
        Path.home()
        / ".nvm"
        / "versions"
        / "node"
    )

    if nvm_root.exists():
        versions = list(
            nvm_root.glob(
                "*/bin/node"
            )
        )

        if versions:
            # Prefer the highest semantic-looking version directory.
            # Sorting by the complete path is adequate for the common
            # v20.x/v22.x/v24.x nvm layout.
            versions.sort(
                key=lambda p: str(p),
                reverse=True
            )

            return str(
                versions[0]
            )

    raise RuntimeError(
        "Node.js was not found. "
        "Please install Node.js before running USIG."
    )
def generate_report_text(report):
    """
    Generate the human-readable regression report.
    """

    lines = []

    lines.append(
        "=" * 80
    )

    lines.append(
        "USIG SINL REGRESSION VALIDATION REPORT"
    )

    lines.append(
        f"Timestamp: "
        f"{time.strftime('%Y-%m-%d %H:%M:%S')}"
    )

    lines.append(
        "=" * 80
    )

    failed = 0
    passed = 0
    skipped = 0

    for item in report:
        if item.get(
            "skipped",
            False
        ):
            status = "SKIP"

            skipped += 1

        else:
            if item.get(
                "passed",
                False
            ):
                status = "PASS"
                passed += 1

            else:
                status = "FAIL"
                failed += 1

        line = (
            f"{status:<6} : "
            f"{item['check']}"
        )

        reason = item.get(
            "reason"
        )

        if reason:
            line += (
                f" ({reason})"
            )

        lines.append(
            line
        )

    lines.append(
        "-" * 80
    )

    lines.append(
        f"TOTAL: {len(report)} checks, "
        f"{passed} passed, "
        f"{failed} failures, "
        f"{skipped} skipped"
    )

    lines.append(
        "=" * 80
    )

    return "\n".join(
        lines
    )
def save_report(report, output_folder):
    """
    Save the human-readable regression report.
    """

    report_path = (
        output_folder
        / "sinl_regression_report.txt"
    )

    save_text(
        report_path,
        generate_report_text(report)
    )

    return report_path
def validate_kpis(
        report,
        prefix,
        outputs,
        expected_kpis,
        tolerance_percent=KPI_TOLERANCE_PERCENT
):
    """
    Validate selected KPI values.
    If the output dictionary is empty, individual KPI checks are recorded
    as skipped rather than creating a misleading cascade of failures.
    """

    if not outputs:
        for key in expected_kpis:
            add_skip(
                report,
                f"{prefix}: {key} within "
                f"{tolerance_percent:g}% of golden",
                "no scalar outputs were produced"
            )

        return

    for key, expected in expected_kpis.items():
        if key not in outputs:
            add_check(
                report,
                f"{prefix}: KPI output exists: {key}",
                False,
                "KPI was not present in USIG Outputs section"
            )

            continue

        validate_numeric(
            report,
            f"{prefix}: {key} within "
            f"{tolerance_percent:g}% of golden",
            outputs.get(key),
            expected,
            tolerance_percent
        )
def validate_output_columns(
        report,
        dataframe,
        expected_kpis,
        prefix
):
    """
    Validate that expected KPI columns are present in a pandas DataFrame.
    This function is retained for actual CSV KPI files.
    It is NOT used to interpret ordinary USIG stdout, because the normal
    textual USIG output is not necessarily a KPI CSV table.
    """

    if dataframe is None:
        for key in expected_kpis:
            add_check(
                report,
                f"{prefix}: KPI column exists: {key}",
                False,
                "CSV could not be loaded"
            )

        return

    if dataframe.empty:
        for key in expected_kpis:
            add_check(
                report,
                f"{prefix}: KPI column exists: {key}",
                False,
                "CSV contains no rows"
            )

        return

    row = dataframe.iloc[0]

    for key, expected in expected_kpis.items():
        if key not in dataframe.columns:
            add_check(
                report,
                f"{prefix}: KPI column exists: {key}",
                False,
                "column not found in CSV"
            )

            continue

        actual = row[key]

        validate_numeric(
            report,
            f"{prefix}: {key} within "
            f"{KPI_TOLERANCE_PERCENT:g}% of golden",
            actual,
            expected,
            KPI_TOLERANCE_PERCENT
        )

def pd2table(document, pd_data, f_font_size=9.5): #, str_units = 'volts'):
    table1 = document.add_table(rows=pd_data.shape[0] + 1, cols=pd_data.shape[1])

    # add the header rows.
    for jj in range(pd_data.shape[-1]):
        table1.cell(0, jj).text = pd_data.columns[jj]

    # add the rest of the data frame
    for ii in range(pd_data.shape[0]):
        for jj in range(pd_data.shape[-1]):
            item = pd_data.values[ii, jj]
            if item == float('inf'):
                item_to_write = 'inf'
            elif item == float('-inf'):
                item_to_write = '-inf'
            else:
                if isinstance(item, float) and not (np.isnan(item)):
                    if int(item) == float(item):
                        item_to_write = f'{int(item):>,}'
                    elif int(item) != float(item):
                        item_to_write = f'{item:>,.2f}'
                    else:
                        item_to_write = item
                else:
                    item_to_write = item
            # item_to_write = item
            table1.cell(ii + 1, jj).text = str(item_to_write)
    for row in table1.rows:
        for cell in row.cells:
            paragraphs = cell.paragraphs
            paragraph = paragraphs[0]
            run_obj = paragraph.runs
            run = run_obj[0]
            font = run.font
            font.size = Pt(f_font_size)
    table1.style = 'Table Grid'
    # document.add_paragraph(f'(units are {str_units})', style='Normal')

def main():
    # =========================================================================
    # Environment setup
    # =========================================================================

    PROJECT_ROOT = (
        Path(__file__)
        .resolve()
        .parents[2]
    )

    node_executable = find_node()

    USIG_CLI = (
        PROJECT_ROOT
        / "usig.mjs"
    )

    if not USIG_CLI.exists():
        raise FileNotFoundError(
            f"Missing USIG CLI entry point: "
            f"{USIG_CLI}"
        )

    # -------------------------------------------------------------------------
    # Verify Node runtime
    # -------------------------------------------------------------------------

    node_version_result = subprocess.run(
        [
            node_executable,
            "--version"
        ],
        check=True,
        capture_output=True,
        text=True
    )

    node_version = (
        node_version_result.stdout.strip()
    )

    print(
        f"Node.js: {node_version}"
    )

    print(
        f"USIG CLI: {USIG_CLI}"
    )

    # =========================================================================
    # Test folders
    # =========================================================================

    RESULTS_ROOT = (
        PROJECT_ROOT
        / "test"
        / "results"
        / "sinl_tests"
    )

    timestamp = time.strftime(
        "%Y_%m_%d_%H_%M_%S"
    )

    output_folder = (
        RESULTS_ROOT
        / timestamp
    )

    output_folder.mkdir(
        parents=True,
        exist_ok=True
    )

    # =========================================================================
    # Golden dataset
    # =========================================================================

    golden_csv = (
        PROJECT_ROOT
        / "test"
        / "golden_raw_data"
        / "sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv"
    )

    if not golden_csv.exists():
        raise FileNotFoundError(
            f"Missing golden dataset: "
            f"{golden_csv}"
        )

    # =========================================================================
    # pandas
    # =========================================================================

    try:
        import pandas as pd

    except ImportError as exc:
        raise RuntimeError(
            "pandas is required to run the "
            "SINL regression harness."
        ) from exc

    report = []

    # =========================================================================
    # Expected golden KPI values
    # =========================================================================

    expected_kpis = {

        "inl_codes_p2p": 0.1843,
        "inl_max": 3.307,
        "code_inl_max": 1171,
        "inl_min": -2.4758,
        "code_inl_min": 874,
        "missing_codes_threshold": -0.9,
        "missing_codes_count": 0,
        "dnl_max": 1.0015,
        "code_dnl_max": 957,
        "dnl_min": -0.8174,
        "code_dnl_min": 982,
        "dnl_rms": 0.1614,
        "code_min": 779,
        "code_max": 1273,
        "code_trunclow": 787,
        "code_trunchigh": 1264,
        "lsb_codes_over_code_amp": 0.004137,
    }

    # =========================================================================
    # 1) Scalar KPI stability
    #
    # IMPORTANT:
    #
    # Do NOT assume that:
    #
    #     USIG -of csv
    #
    # produces a CSV representation of the textual "Outputs:" section.
    #
    # The previous harness mixed two different output contracts:
    #
    #   - normal CLI stdout
    #   - file/output-format CSV
    #
    # It then overwrote the generated CSV with stdout and attempted to load
    # that file with pandas.
    #
    # That is why the previous run reported:
    #
    #   PASS scalar KPI CSV loaded by pandas
    #
    # followed by:
    #
    #   KPI column not found in CSV
    #
    # For KPI regression we use the stable textual Outputs section directly.
    # The raw stdout is saved separately.
    # =========================================================================

    scalar_output = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            "-plugin",
            "sinl",
        ],
        b_verbose
    )

    check_command(
        report,
        "1: scalar KPI SINL execution completed",
        scalar_output
    )

    save_command_output(
        output_folder,
        "01_scalar",
        scalar_output
    )

    scalar_outputs = parse_scalar_outputs(
        get_stdout(scalar_output)
    )

    add_check(
        report,
        "1: scalar KPI Outputs section produced",
        len(scalar_outputs) > 0,
        (
            None
            if scalar_outputs
            else "SINL Outputs section was not found"
        )
    )

    validate_kpis(
        report,
        "1",
        scalar_outputs,
        expected_kpis
    )

    # =========================================================================
    # 1b) Optional CSV output-format smoke test
    #
    # This tests the CLI's actual CSV output contract without pretending that
    # stdout is that CSV.
    #
    # The exact CLI-generated file is preserved untouched.
    # =========================================================================

    scalar_csv_output = (
        output_folder
        / "sinl_scalar_output.csv"
    )

    scalar_csv_command = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            "-plugin",
            "sinl",
            "-of",
            "csv",
            str(scalar_csv_output),
        ],
        b_verbose
    )

    check_command(
        report,
        "1b: SINL CSV output-format execution completed",
        scalar_csv_command
    )

    assert_file_exists(
        report,
        "1b: SINL CSV output file was created",
        scalar_csv_output
    )

    save_command_output(
        output_folder,
        "01b_scalar_csv",
        scalar_csv_command
    )

    if scalar_csv_output.exists():
        try:
            csv_df = pd.read_csv(
                scalar_csv_output
            )

            # Basic load check
            csv_loaded = not csv_df.empty
            add_check(
                report,
                "1b: generated CSV can be loaded by pandas",
                csv_loaded,
                (
                    None
                    if csv_loaded
                    else "generated CSV contains no rows"
                )
            )

            if csv_loaded:
                # Exact-row check: should contain exactly one data row for scalar KPI output
                one_row = csv_df.shape[0] == 1
                add_check(
                    report,
                    "1b: generated CSV contains exactly one data row",
                    one_row,
                    None if one_row else f"CSV contains {csv_df.shape[0]} rows"
                )

                # Columns presence: all expected KPI keys must be present
                missing = [k for k in expected_kpis.keys() if k not in csv_df.columns]
                add_check(
                    report,
                    "1b: generated CSV contains expected KPI columns",
                    len(missing) == 0,
                    None if len(missing) == 0 else f"missing columns: {missing}"
                )

                # Ensure human-readable labels are not present as columns
                hr_present = any(c in csv_df.columns for c in ['Inputs', 'Outputs'])
                add_check(
                    report,
                    "1b: CSV does not contain human-readable report sections",
                    not hr_present,
                    None if not hr_present else "CSV contains human-readable section headers"
                )

                # If columns are present, validate numeric KPI values against golden
                if len(missing) == 0:
                    validate_output_columns(
                        report,
                        csv_df,
                        expected_kpis,
                        "1b"
                    )

        except Exception as exc:
            add_check(
                report,
                "1b: generated CSV can be loaded by pandas",
                False,
                f"{type(exc).__name__}: {exc}"
            )

    else:
        add_skip(
            report,
            "1b: generated CSV can be loaded by pandas",
            "CSV output file was not created"
        )

    # =========================================================================
    # 1c) XLSX output-format smoke test
    # =========================================================================
    scalar_xlsx_output = (
        output_folder
        / "sinl_scalar_output.xlsx"
    )

    scalar_xlsx_command = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            "-plugin",
            "sinl",
            str(scalar_xlsx_output),
        ],
        b_verbose
    )

    check_command(
        report,
        "1c: SINL XLSX output-format execution completed",
        scalar_xlsx_command
    )

    assert_file_exists(
        report,
        "1c: SINL XLSX output file was created",
        scalar_xlsx_output
    )

    # Quick binary check: XLSX is a ZIP archive (PK)
    try:
        with open(scalar_xlsx_output, 'rb') as f:
            sig = f.read(2)
        is_zip = sig == b'PK'
        add_check(
            report,
            "1c: generated XLSX looks like a ZIP archive",
            is_zip,
            None if is_zip else "XLSX file missing PK signature"
        )
    except Exception as exc:
        add_check(
            report,
            "1c: generated XLSX looks like a ZIP archive",
            False,
            f"{type(exc).__name__}: {exc}"
        )

    # =========================================================================
    # 1d) BIN output-format smoke test
    # =========================================================================
    scalar_bin_output = (
        output_folder
        / "sinl_scalar_output.bin"
    )

    scalar_bin_command = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            "-plugin",
            "sinl",
            str(scalar_bin_output),
        ],
        b_verbose
    )

    check_command(
        report,
        "1d: SINL BIN output-format execution completed",
        scalar_bin_command
    )

    assert_file_exists(
        report,
        "1d: SINL BIN output file was created",
        scalar_bin_output
    )

    # Check magic bytes for USIG IR container
    try:
        with open(scalar_bin_output, 'rb') as f:
            magic = f.read(8)
        is_usigir = magic == b'USIGIR1\n'
        add_check(
            report,
            "1d: generated BIN starts with USIGIR1 magic",
            is_usigir,
            None if is_usigir else "BIN file does not start with USIGIR1 magic"
        )
    except Exception as exc:
        add_check(
            report,
            "1d: generated BIN starts with USIGIR1 magic",
            False,
            f"{type(exc).__name__}: {exc}"
        )

    # =========================================================================
    # 1e) Unsupported extension rejection test
    # =========================================================================
    scalar_unsupported_output = (
        output_folder
        / "sinl_scalar_output.unsup"
    )

    scalar_unsupported_command = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            "-plugin",
            "sinl",
            str(scalar_unsupported_output),
        ],
        b_verbose
    )

    add_check(
        report,
        "1e: unsupported extension is rejected (non-zero exit)",
        scalar_unsupported_command is not None and scalar_unsupported_command.returncode != 0,
        None if (scalar_unsupported_command is not None and scalar_unsupported_command.returncode != 0) else "CLI accepted unsupported extension"
    )

    # =========================================================================
    # 2) Filename inference
    # =========================================================================

    filename_inference = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            "-plugin",
            "sinl",
        ],
        b_verbose
    )

    check_command(
        report,
        "2: filename inference SINL execution completed",
        filename_inference
    )

    save_command_output(
        output_folder,
        "02_filename_inference",
        filename_inference
    )

    filename_outputs = parse_scalar_outputs(
        get_stdout(filename_inference)
    )

    add_check(
        report,
        "2: filename inference produced scalar outputs",
        len(filename_outputs) > 0,
        (
            None
            if filename_outputs
            else "SINL Outputs section was not found"
        )
    )

    validate_numeric(
        report,
        "2: inl_codes_p2p within 1% of golden",
        filename_outputs.get(
            "inl_codes_p2p"
        ),
        0.1843,
        KPI_TOLERANCE_PERCENT
    )

    validate_numeric(
        report,
        "2: dnl_rms within 1% of golden",
        filename_outputs.get(
            "dnl_rms"
        ),
        0.1614,
        KPI_TOLERANCE_PERCENT
    )

    # =========================================================================
    # 3) Explicit -p overrides filename inference
    # =========================================================================

    override_output = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            "-plugin",
            "sinl",
            "-p",
            "maxCode=4095",
        ],
        b_verbose
    )

    check_command(
        report,
        "3: explicit -p override SINL execution completed",
        override_output
    )

    save_command_output(
        output_folder,
        "03_override",
        override_output
    )

    override_outputs = parse_scalar_outputs(
        get_stdout(override_output)
    )

    add_check(
        report,
        "3: explicit -p override produced scalar outputs",
        len(override_outputs) > 0,
        (
            None
            if override_outputs
            else "SINL Outputs section was not found"
        )
    )

    if override_output is not None:
        override_text = get_stdout(
            override_output
        )

        add_check(
            report,
            "3: maxCode override is shown in normal output",
            (
                "maxCode = 4095 << overridden from user input"
                in override_text
            ),
            (
                None
                if (
                    "maxCode = 4095 << overridden from user input"
                    in override_text
                )
                else "expected override marker was not found"
            )
        )

    else:
        add_check(
            report,
            "3: maxCode override is shown in normal output",
            False,
            "override command could not be started"
        )

    # =========================================================================
    # 4) CSV -> BIN -> SINL analysis
    # =========================================================================

    golden_bin = (
        output_folder
        / "golden_from_csv.bin"
    )

    bin_conversion = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            str(golden_bin),
        ],
        b_verbose
    )

    check_command(
        report,
        "4: CSV to BIN conversion completed",
        bin_conversion
    )

    assert_file_exists(
        report,
        "4: CSV to BIN conversion produced output",
        golden_bin
    )

    save_command_output(
        output_folder,
        "04_bin_conversion",
        bin_conversion
    )

    bin_analysis = None

    if golden_bin.exists():
        bin_analysis = run_usig(
            [
                node_executable,
                str(USIG_CLI),
                "-i",
                str(golden_bin),
                "-plugin",
                "sinl",
            ],
            b_verbose
        )

    else:
        add_skip(
            report,
            "4: SINL analysis of converted BIN completed",
            "BIN file was not created"
        )

    check_command(
        report,
        "4: SINL analysis of converted BIN completed",
        bin_analysis
    )

    save_command_output(
        output_folder,
        "04_bin_analysis",
        bin_analysis
    )

    bin_outputs = parse_scalar_outputs(
        get_stdout(bin_analysis)
    )

    add_check(
        report,
        "4: BIN analysis produced scalar outputs",
        len(bin_outputs) > 0,
        (
            None
            if bin_outputs
            else "SINL Outputs section was not found"
        )
    )

    validate_numeric(
        report,
        "4: BIN inl_codes_p2p within 1% of golden",
        bin_outputs.get(
            "inl_codes_p2p"
        ),
        0.1843,
        KPI_TOLERANCE_PERCENT
    )

    validate_numeric(
        report,
        "4: BIN dnl_rms within 1% of golden",
        bin_outputs.get(
            "dnl_rms"
        ),
        0.1614,
        KPI_TOLERANCE_PERCENT
    )

    # =========================================================================
    # 5) CSV -> XLSX -> SINL analysis
    #
    # The current failure is NOT a Python harness failure.
    #
    # The USIG bundled runtime itself reports:
    #
    #     Dynamic require of "crypto" is not supported
    #
    # through ExcelJS.
    #
    # Therefore this harness:
    #
    #   1. records the XLSX conversion result
    #   2. verifies the XLSX file exists
    #   3. attempts XLSX analysis
    #   4. records the actual CLI failure
    #   5. does not fabricate KPI failures when no SINL output exists
    #
    # The XLSX analysis command remains a real regression failure because
    # XLSX input is currently expected to work.
    # =========================================================================

    golden_xlsx = (
        output_folder
        / "golden_from_csv.xlsx"
    )

    xlsx_conversion = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            str(golden_xlsx),
        ],
        b_verbose
    )

    check_command(
        report,
        "5: CSV to XLSX conversion completed",
        xlsx_conversion
    )

    assert_file_exists(
        report,
        "5: CSV to XLSX conversion produced output",
        golden_xlsx
    )

    save_command_output(
        output_folder,
        "05_xlsx_conversion",
        xlsx_conversion
    )

    xlsx_analysis = None

    if golden_xlsx.exists():
        xlsx_analysis = run_usig(
            [
                node_executable,
                str(USIG_CLI),
                "-i",
                str(golden_xlsx),
                "-plugin",
                "sinl",
            ],
            b_verbose
        )

    else:
        add_skip(
            report,
            "5: SINL analysis of converted XLSX completed",
            "XLSX file was not created"
        )

    if golden_xlsx.exists():
        check_command(
            report,
            "5: SINL analysis of converted XLSX completed",
            xlsx_analysis
        )

    save_command_output(
        output_folder,
        "05_xlsx_analysis",
        xlsx_analysis
    )

    xlsx_outputs = parse_scalar_outputs(
        get_stdout(xlsx_analysis)
    )

    if xlsx_analysis is not None and command_succeeded(
        xlsx_analysis
    ):
        add_check(
            report,
            "5: XLSX analysis produced scalar outputs",
            len(xlsx_outputs) > 0,
            (
                None
                if xlsx_outputs
                else "SINL produced no scalar output"
            )
        )

        if xlsx_outputs:
            validate_numeric(
                report,
                "5: XLSX inl_codes_p2p within 1% of golden",
                xlsx_outputs.get(
                    "inl_codes_p2p"
                ),
                0.1843,
                KPI_TOLERANCE_PERCENT
            )

            validate_numeric(
                report,
                "5: XLSX dnl_rms within 1% of golden",
                xlsx_outputs.get(
                    "dnl_rms"
                ),
                0.1614,
                KPI_TOLERANCE_PERCENT
            )

        else:
            add_skip(
                report,
                "5: XLSX inl_codes_p2p within 1% of golden",
                "SINL XLSX analysis produced no scalar outputs"
            )

            add_skip(
                report,
                "5: XLSX dnl_rms within 1% of golden",
                "SINL XLSX analysis produced no scalar outputs"
            )

    else:
        add_skip(
            report,
            "5: XLSX analysis produced scalar outputs",
            "SINL XLSX analysis failed before producing outputs; see "
            "05_xlsx_analysis_stderr.txt"
        )

        add_skip(
            report,
            "5: XLSX inl_codes_p2p within 1% of golden",
            "SINL XLSX analysis failed before producing outputs"
        )

        add_skip(
            report,
            "5: XLSX dnl_rms within 1% of golden",
            "SINL XLSX analysis failed before producing outputs"
        )

    # =========================================================================
    # 6) Debug table runtime exports (CSV, XLSX, BIN)
    # =========================================================================

    debug_csv_output = (
        output_folder
        / "inl_dnl_series_debug.csv"
    )

    debug_csv_command = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            "-plugin",
            "sinl",
            "-debug",
            "inl_dnl_series=" + str(debug_csv_output),
        ],
        b_verbose
    )

    check_command(
        report,
        "6a: debug CSV export completed",
        debug_csv_command
    )

    assert_file_exists(
        report,
        "6a: debug CSV file created",
        debug_csv_output
    )

    if debug_csv_output.exists():
        try:
            import pandas as pd
        except Exception:
            add_check(
                report,
                "6a: debug CSV can be loaded by pandas",
                False,
                "pandas is required to run this check"
            )
        else:
            try:
                df = pd.read_csv(debug_csv_output)
                expected_cols = ['code','pdf','cdf','cos_cdf','dnl','inl','inl_polynomial']
                missing = [c for c in expected_cols if c not in df.columns]
                add_check(
                    report,
                    "6a: debug CSV contains expected columns",
                    len(missing) == 0,
                    None if len(missing) == 0 else f"missing columns: {missing}"
                )
            except Exception as exc:
                add_check(
                    report,
                    "6a: debug CSV can be loaded by pandas",
                    False,
                    f"{type(exc).__name__}: {exc}"
                )

    # XLSX
    debug_xlsx_output = (
        output_folder
        / "inl_dnl_series_debug.xlsx"
    )

    debug_xlsx_command = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            "-plugin",
            "sinl",
            "-debug",
            "inl_dnl_series=" + str(debug_xlsx_output),
        ],
        b_verbose
    )

    check_command(
        report,
        "6b: debug XLSX export completed",
        debug_xlsx_command
    )

    assert_file_exists(
        report,
        "6b: debug XLSX file created",
        debug_xlsx_output
    )

    # Quick check: XLSX is a ZIP
    try:
        with open(debug_xlsx_output, 'rb') as f:
            sig = f.read(2)
        add_check(
            report,
            "6b: debug XLSX looks like ZIP",
            sig == b'PK',
            None if sig == b'PK' else "missing PK signature"
        )
    except Exception as exc:
        add_check(
            report,
            "6b: debug XLSX looks like ZIP",
            False,
            f"{type(exc).__name__}: {exc}"
        )

    # BIN
    debug_bin_output = (
        output_folder
        / "inl_dnl_series_debug.bin"
    )

    debug_bin_command = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            "-plugin",
            "sinl",
            "-debug",
            "inl_dnl_series=" + str(debug_bin_output),
        ],
        b_verbose
    )

    check_command(
        report,
        "6c: debug BIN export completed",
        debug_bin_command
    )

    assert_file_exists(
        report,
        "6c: debug BIN file created",
        debug_bin_output
    )

    try:
        with open(debug_bin_output, 'rb') as f:
            magic = f.read(8)
        add_check(
            report,
            "6c: debug BIN starts with USIGIR1 magic",
            magic == b'USIGIR1\n',
            None if magic == b'USIGIR1\n' else "BIN does not start with USIGIR1"
        )
    except Exception as exc:
        add_check(
            report,
            "6c: debug BIN starts with USIGIR1 magic",
            False,
            f"{type(exc).__name__}: {exc}"
        )

    # Unsupported extension rejection for debug
    debug_unsupported_output = (
        output_folder
        / "inl_dnl_series_debug.unsup"
    )

    debug_unsupported_command = run_usig(
        [
            node_executable,
            str(USIG_CLI),
            "-i",
            str(golden_csv),
            "-plugin",
            "sinl",
            "-debug",
            "inl_dnl_series=" + str(debug_unsupported_output),
        ],
        b_verbose
    )

    add_check(
        report,
        "6d: debug unsupported extension is rejected (non-zero exit)",
        debug_unsupported_command is not None and debug_unsupported_command.returncode != 0,
        None if (debug_unsupported_command is not None and debug_unsupported_command.returncode != 0) else "CLI accepted unsupported debug extension"
    )

    # =========================================================================
    # 7) Figure export
    # =========================================================================

    add_skip(
        report,
        "7: SINL PDF/DNL/INL figure export",
        "CLI figure export not implemented yet"
    )

    # =========================================================================
    # 7) Figure export
    # =========================================================================

    add_skip(
        report,
        "7: SINL PDF/DNL/INL figure export",
        "CLI figure export not implemented yet"
    )

    # =========================================================================
    # 8) Figure information / plotting hooks
    # =========================================================================

    add_skip(
        report,
        "8: SINL figure information / plotting hooks",
        "figure information API not implemented yet"
    )

    # =========================================================================
    # Save a complete command summary
    # =========================================================================

    environment_text = (
        "USIG SINL REGRESSION ENVIRONMENT\n"
        "================================\n"
        f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
        f"Node.js: {node_version}\n"
        f"Node executable: {node_executable}\n"
        f"USIG CLI: {USIG_CLI}\n"
        f"Project root: {PROJECT_ROOT}\n"
        f"Golden CSV: {golden_csv}\n"
        f"Output folder: {output_folder}\n"
    )

    save_text(
        output_folder / "environment.txt",
        environment_text
    )

    # =========================================================================
    # Final report
    # =========================================================================

    report_text = generate_report_text(
        report
    )

    print()
    print(report_text)

    report_path = save_report(
        report,
        output_folder
    )

    print()
    print(f"Results: {output_folder}")
    print(f"Report:  {report_path}")

    # =========================================================================
    # Final process status
    #
    # IMPORTANT:
    #
    # All tests have now executed.
    #
    # Only non-skipped failed checks cause process failure.
    # =========================================================================

    failures = [item for item in report if not item.get("skipped", False) and not item.get("passed", False)]

    if failures:
        print(
            f"\nRegression failed: "
            f"{len(failures)} check(s) failed."
        )

        raise SystemExit(1)

    print("\nRegression completed successfully.")


if __name__ == "__main__":
    main()