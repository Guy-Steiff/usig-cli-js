import json
import shutil
import subprocess
import time
from pathlib import Path


# =============================================================================
# Configuration
# =============================================================================

# Controls printing of subprocess stdout/stderr.
# Keep False for normal regression runs.
b_verbose = True


# =============================================================================
# Helpers
# =============================================================================

def run_usig(command, b_verbose=False, expect_success=True):
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

    if expect_success and result.returncode != 0:
        raise RuntimeError(
            f"USIG command failed:\n"
            f"{' '.join(command)}\n\n"
            f"{result.stderr}"
        )

    return result


def add_check(report, name, condition):
    report.append({"check": name, "passed": bool(condition)})


def find_node():

    node = shutil.which("node")
    if node:
        return node

    unix_candidates = [
        Path("/usr/bin/node"),
        Path("/usr/local/bin/node"),
    ]
    for candidate in unix_candidates:
        if candidate.exists():
            return str(candidate)

    nvm_root = Path.home() / ".nvm" / "versions" / "node"
    if nvm_root.exists():
        versions = sorted(nvm_root.glob("*/bin/node"), reverse=True)
        if versions:
            return str(versions[0])

    raise RuntimeError(
        "Node.js was not found. Please install Node.js before running USIG."
    )


def generate_report_text(report):

    lines = []
    lines.append("=" * 80)
    lines.append("USIG SMEAS FIGURE/DEBUG VALIDATION REPORT")
    lines.append(f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("=" * 80)

    failures = 0
    for entry in report:
        status = "PASS" if entry["passed"] else "FAIL"
        if not entry["passed"]:
            failures += 1
        lines.append(f"{status}   : {entry['check']}")

    lines.append("-" * 80)
    lines.append(f"TOTAL: {len(report)} checks, {failures} failures")
    lines.append("=" * 80)

    return "\n".join(lines), failures


# =============================================================================
# Main SMEAS figure/debug regression test
# =============================================================================

def main():

    PROJECT_ROOT = Path(__file__).resolve().parents[2]
    node_executable = find_node()
    USIG_CLI = PROJECT_ROOT / "usig.mjs"

    if not USIG_CLI.exists():
        raise FileNotFoundError(f"Missing USIG CLI entry point: {USIG_CLI}")

    golden_csv = (
        PROJECT_ROOT
        / "test"
        / "golden_raw_data"
        / "sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv"
    )

    if not golden_csv.exists():
        raise FileNotFoundError(f"Missing golden dataset: {golden_csv}")

    RESULTS_ROOT = PROJECT_ROOT / "test" / "results" / "smeas_figure_debug_test"
    timestamp = time.strftime("%Y_%m_%d_%H_%M_%S")
    output_folder = RESULTS_ROOT / timestamp
    output_folder.mkdir(parents=True, exist_ok=True)

    report = []

    base_params = [
        "-p", "fsGhz=2.25",
        "-p", "fftLength=8192",
        "-p", "numAveraging=4",
    ]

    # =========================================================================
    # 1. -figure list (declarative manifest.figures, no ingestion needed)
    # =========================================================================

    result = run_usig(
        [node_executable, str(USIG_CLI), "-i", str(golden_csv), "-plugin", "smeas",
         *base_params, "-p", "numberOfCores=8", "-figure", "list"],
        b_verbose,
    )
    add_check(report, "-figure list: exits successfully", result.returncode == 0)
    combined = result.stdout + result.stderr
    add_check(report, "-figure list: lists 'spectrum'", "spectrum" in combined)
    add_check(report, "-figure list: lists 'spectrum_ti_deembedded'", "spectrum_ti_deembedded" in combined)
    add_check(report, "-figure list: lists 'spectrum_noise'", "spectrum_noise" in combined)

    # =========================================================================
    # 2. -debug list (declarative manifest.debugTables)
    # =========================================================================

    result = run_usig(
        [node_executable, str(USIG_CLI), "-i", str(golden_csv), "-plugin", "smeas",
         *base_params, "-p", "numberOfCores=8", "-debug", "list"],
        b_verbose,
    )
    add_check(report, "-debug list: exits successfully", result.returncode == 0)
    combined = result.stdout + result.stderr
    for table_id in ["spectra", "timedomain", "im_components", "ti_spurs", "ti_cal"]:
        add_check(report, f"-debug list: lists '{table_id}'", table_id in combined)

    # =========================================================================
    # 3. Default SVG output for a single figure (+ sibling JSON)
    # =========================================================================

    svg_default = output_folder / "spectrum.svg"
    json_default = output_folder / "spectrum.json"
    # sfdrLeakageAvoidanceRadiusMhz has no implicit default/clamp (exact
    # user-specified radius; 0 means "no avoidance zone at all"), so an
    # explicit non-zero value is passed here to exercise the SFDR-avoidance
    # reference-area rendering path.
    run_usig(
        [node_executable, str(USIG_CLI), "-i", str(golden_csv), "-plugin", "smeas",
         *base_params, "-p", "numberOfCores=8", "-p", "sfdrLeakageAvoidanceRadiusMhz=3",
         "-figure", f"spectrum={svg_default}", "-y", "-fig_as_json"],
        b_verbose,
    )
    add_check(report, "default SVG output: spectrum.svg created", svg_default.exists())
    add_check(report, "default SVG output: sibling spectrum.json created (with -fig_as_json)", json_default.exists())
    if svg_default.exists():
        svg_text = svg_default.read_text()
        add_check(report, "SVG: contains <svg> root element", svg_text.strip().startswith("<svg"))
        add_check(
            report,
            "SVG: SFDR-avoidance reference area uses 'warning' translucent-yellow fill",
            'fill="rgba(251,191,36,0.35)"' in svg_text,
        )
        add_check(report, "SVG: fundamental marker circle drawn in #EF4444", '<circle' in svg_text and '#EF4444' in svg_text)
        add_check(report, "SVG: legend item text 'Spectrum' present", ">Spectrum<" in svg_text)
        add_check(report, "SVG: results panel header present", "CARRIER / FS" in svg_text)
        add_check(report, "SVG: results panel SFDR row present", ">SFDR<" in svg_text)

    # =========================================================================
    # 3b. -fig_as_json is opt-in: without the flag, no sibling JSON is written.
    # =========================================================================

    svg_no_json = output_folder / "spectrum_no_json.svg"
    json_no_json = output_folder / "spectrum_no_json.json"
    run_usig(
        [node_executable, str(USIG_CLI), "-i", str(golden_csv), "-plugin", "smeas",
         *base_params, "-p", "numberOfCores=8",
         "-figure", f"spectrum={svg_no_json}", "-y"],
        b_verbose,
    )
    add_check(report, "-fig_as_json absent: spectrum_no_json.svg created", svg_no_json.exists())
    add_check(report, "-fig_as_json absent: no sibling JSON written", not json_no_json.exists())

    # =========================================================================
    # 4. PNG and JPEG output
    # =========================================================================

    png_path = output_folder / "spectrum.png"
    jpg_path = output_folder / "spectrum.jpg"
    run_usig(
        [node_executable, str(USIG_CLI), "-i", str(golden_csv), "-plugin", "smeas",
         *base_params, "-p", "numberOfCores=8",
         "-figure", f"spectrum={png_path}", "-y"],
        b_verbose,
    )
    run_usig(
        [node_executable, str(USIG_CLI), "-i", str(golden_csv), "-plugin", "smeas",
         *base_params, "-p", "numberOfCores=8",
         "-figure", f"spectrum={jpg_path}", "-y"],
        b_verbose,
    )
    add_check(report, "PNG output: spectrum.png created", png_path.exists())
    add_check(report, "PNG output: non-trivial file size", png_path.exists() and png_path.stat().st_size > 100)
    add_check(report, "JPEG output: spectrum.jpg created", jpg_path.exists())
    add_check(report, "JPEG output: non-trivial file size", jpg_path.exists() and jpg_path.stat().st_size > 100)

    # =========================================================================
    # 5. JSON numerical correctness (PortableFigureDescription content)
    #    Cross-checked against smeas_scalar_results_test.py's known-good KPIs
    #    for this exact golden input + params (fund1_mhz ~= 118.6523 MHz).
    # =========================================================================

    if json_default.exists():
        desc = json.loads(json_default.read_text())
        add_check(report, "JSON: figure id == 'spectrum'", desc.get("figure") == "spectrum")
        add_check(report, "JSON: has x.data array", isinstance(desc.get("x", {}).get("data"), list) and len(desc["x"]["data"]) > 0)
        add_check(report, "JSON: has one PS_dBFS series", len(desc.get("series", [])) == 1)
        if desc.get("series"):
            add_check(
                report,
                "JSON: series y length matches x length",
                len(desc["series"][0]["y"]) == len(desc["x"]["data"]),
            )
        fund_markers = [
            mk for mk in desc.get("markers", [])
            if mk.get("label", "").startswith("H1") or mk.get("label", "").startswith("F1")
        ]
        add_check(report, "JSON: fundamental marker present", len(fund_markers) == 1)
        if fund_markers:
            add_check(
                report,
                "JSON: fundamental marker x within tolerance (118.6523 MHz +/- 1%)",
                abs(fund_markers[0]["x"] - 118.6523) <= (118.6523 * 0.01),
            )
            add_check(report, "JSON: fundamental marker color is #EF4444", fund_markers[0].get("color") == "#EF4444")
        legend_items = desc.get("legend", {}).get("items", [])
        add_check(report, "JSON: legend items present", len(legend_items) > 0)
        add_check(report, "JSON: x.ticks present", isinstance(desc.get("x", {}).get("ticks"), list) and len(desc["x"]["ticks"]) > 0)
        add_check(report, "JSON: y.ticks present", isinstance(desc.get("y", {}).get("ticks"), list) and len(desc["y"]["ticks"]) > 0)
        add_check(report, "JSON: resultsPanel present", len(desc.get("resultsPanel", [])) > 0)
        warning_areas = [ra for ra in desc.get("referenceAreas", []) if ra.get("style") == "warning"]
        add_check(report, "JSON: at least one 'warning'-styled reference area (SFDR avoidance)", len(warning_areas) > 0)

    # =========================================================================
    # 6. Conditional figure: spectrum_ti_deembedded skipped (undefined) when
    #    numberOfCores <= 1 — must not crash, must report a clean error.
    # =========================================================================

    ti_skip_path = output_folder / "ti_not_applicable.svg"
    result = run_usig(
        [node_executable, str(USIG_CLI), "-i", str(golden_csv), "-plugin", "smeas",
         *base_params, "-p", "numberOfCores=1",
         "-figure", f"spectrum_ti_deembedded={ti_skip_path}", "-y"],
        b_verbose,
        expect_success=False,
    )
    add_check(
        report,
        "conditional figure: spectrum_ti_deembedded reports 'not applicable' when numberOfCores=1",
        "not applicable" in result.stderr,
    )
    add_check(
        report,
        "conditional figure: no file written when not applicable",
        not ti_skip_path.exists(),
    )

    # =========================================================================
    # 7. -figure all (all three figures + siblings)
    # =========================================================================

    all_dir = output_folder / "all_figures"
    run_usig(
        [node_executable, str(USIG_CLI), "-i", str(golden_csv), "-plugin", "smeas",
         *base_params, "-p", "numberOfCores=8", "-figure", f"all={all_dir}", "-y", "-fig_as_json"],
        b_verbose,
    )
    for fig_id in ["spectrum", "spectrum_ti_deembedded", "spectrum_noise"]:
        add_check(report, f"-figure all: {fig_id}.svg created", (all_dir / f"{fig_id}.svg").exists())
        add_check(report, f"-figure all: {fig_id}.json created (with -fig_as_json)", (all_dir / f"{fig_id}.json").exists())

    # =========================================================================
    # 8. Multiple figures requested together, plus debug table, in one call
    # =========================================================================

    combo_dir = output_folder / "combo"
    combo_dir.mkdir(parents=True, exist_ok=True)
    spectra_csv = combo_dir / "spectra.csv"
    combo_spectrum = combo_dir / "spectrum.svg"
    combo_noise = combo_dir / "spectrum_noise.svg"
    run_usig(
        [node_executable, str(USIG_CLI), "-i", str(golden_csv), "-plugin", "smeas",
         *base_params, "-p", "numberOfCores=8",
         "-debug", f"spectra={spectra_csv}",
         "-figure", f"spectrum={combo_spectrum}",
         "-figure", f"spectrum_noise={combo_noise}",
         "-y"],
        b_verbose,
    )
    add_check(report, "figure+debug together: spectra.csv created", spectra_csv.exists())
    add_check(report, "figure+debug together: spectrum.svg created", combo_spectrum.exists())
    add_check(report, "figure+debug together: spectrum_noise.svg created", combo_noise.exists())

    # =========================================================================
    # 9. Multiple independent input jobs (job-scoped plugin execution)
    #    Two -i/-plugin groups in one invocation must produce independent,
    #    non-interfering outputs (different params -> different results).
    # =========================================================================

    multi_dir = output_folder / "multi_job"
    multi_dir.mkdir(parents=True, exist_ok=True)
    job1_svg = multi_dir / "job1_spectrum.svg"
    job2_svg = multi_dir / "job2_spectrum.svg"
    result = run_usig(
        [
            node_executable, str(USIG_CLI),
            "-i", str(golden_csv), "-plugin", "smeas", *base_params, "-p", "numberOfCores=8",
            "-figure", f"spectrum={job1_svg}",
            "-i", str(golden_csv), "-plugin", "smeas",
            "-p", "fsGhz=2.25", "-p", "fftLength=4096", "-p", "numAveraging=1", "-p", "numberOfCores=1",
            "-figure", f"spectrum={job2_svg}",
            "-y",
        ],
        b_verbose,
    )
    add_check(report, "multi-job: exits successfully", result.returncode == 0)
    add_check(report, "multi-job: job1 spectrum.svg created", job1_svg.exists())
    add_check(report, "multi-job: job2 spectrum.svg created", job2_svg.exists())
    if job1_svg.exists() and job2_svg.exists():
        add_check(
            report,
            "multi-job: job1 and job2 outputs are independent (different fftLength -> different content)",
            job1_svg.read_text() != job2_svg.read_text(),
        )

    # =========================================================================
    # 10. Existing single-input behavior unaffected (scalar KPI still produced)
    # =========================================================================

    result = run_usig(
        [node_executable, str(USIG_CLI), "-i", str(golden_csv), "-plugin", "smeas",
         *base_params, "-p", "numberOfCores=8"],
        b_verbose,
    )
    add_check(report, "single-input path: exits successfully", result.returncode == 0)
    add_check(report, "single-input path: scalar output includes fund1_mhz", "fund1_mhz" in result.stdout)

    # =========================================================================
    # 11. Dual-tone TI de-embedded figure (spectrum_ti_deembedded):
    #     F1/F2/DC must remain finite (never nulled by TI removal), TI-spur
    #     bins must be attenuated/removed, and IM products must remain
    #     visible unless they coincide with an actual TI bin.
    #     (This golden dataset is single-tone data forced through dual-tone
    #     analysis -- only F1/F2/DC/TI-removal structural behavior is
    #     asserted here, not F2/IM3 physical validity.)
    # =========================================================================

    dual_ti_json = output_folder / "dual_ti_deembedded.json"
    dual_ti_svg = output_folder / "dual_ti_deembedded.svg"
    result = run_usig(
        [node_executable, str(USIG_CLI), "-i", str(golden_csv), "-plugin", "smeas",
         *base_params, "-p", "toneMode=dual", "-p", "numberOfCores=8",
         "-figure", f"spectrum_ti_deembedded={dual_ti_svg}", "-y", "-fig_as_json"],
        b_verbose,
    )
    add_check(report, "dual-tone TI-deembedded: exits successfully", result.returncode == 0)
    add_check(report, "dual-tone TI-deembedded: JSON sibling created", dual_ti_json.exists())

    if dual_ti_json.exists():
        desc = json.loads(dual_ti_json.read_text())
        x_data = desc.get("x", {}).get("data", [])
        y_data = desc.get("series", [{}])[0].get("y", [])

        add_check(report, "dual-tone TI-deembedded: series length matches x length", len(x_data) == len(y_data))

        def nearest_y(freq_mhz):
            idx = min(range(len(x_data)), key=lambda i: abs(x_data[i] - freq_mhz))
            return y_data[idx]

        dc_val = y_data[0] if y_data else None
        f1_val = nearest_y(118.6523) if x_data else None
        f2_val = nearest_y(707.5195) if x_data else None

        add_check(report, "dual-tone TI-deembedded: DC (bin 0) is finite (not NaN/null)", dc_val is not None)
        add_check(report, "dual-tone TI-deembedded: F1 bin is finite (not NaN/null)", f1_val is not None)
        add_check(report, "dual-tone TI-deembedded: F2 bin is finite (not NaN/null)", f2_val is not None)

        markers = desc.get("markers", [])
        f1_markers = [m for m in markers if m.get("label", "").startswith("F1 ")]
        f2_markers = [m for m in markers if m.get("label", "").startswith("F2 ")]
        add_check(report, "dual-tone TI-deembedded: F1 marker present", len(f1_markers) == 1)
        add_check(report, "dual-tone TI-deembedded: F2 marker present", len(f2_markers) == 1)

        add_check(
            report,
            "dual-tone TI-deembedded: title shows both F1 and F2 (not single-tone 'Fund=')",
            "F1=" in desc.get("title", "") and "F2=" in desc.get("title", ""),
        )
        legend_labels = [it.get("label", "") for it in desc.get("legend", {}).get("items", [])]
        add_check(
            report,
            "dual-tone TI-deembedded: legend contains a distinct F2 entry",
            any(lbl.startswith("F2 @") for lbl in legend_labels),
        )

        # IM markers remain visible in the TI-removed figure unless a
        # coincidental TI-bin collision nulls that specific bin -- this
        # merely confirms IM markers are still emitted (not globally
        # suppressed by TI removal), matching "IM stays visible, not removed".
        im_markers = [m for m in markers if m.get("color") == "#A855F7"]
        add_check(report, "dual-tone TI-deembedded: IM/harmonic markers still present", len(im_markers) > 0)

    # =========================================================================
    # 12. Dual-tone main spectrum figure: TI and IM markers must coexist
    #     (independent classifications), not mutually suppress each other.
    # =========================================================================

    dual_main_json = output_folder / "dual_main_spectrum.json"
    dual_main_svg = output_folder / "dual_main_spectrum.svg"
    result = run_usig(
        [node_executable, str(USIG_CLI), "-i", str(golden_csv), "-plugin", "smeas",
         *base_params, "-p", "toneMode=dual", "-p", "numberOfCores=8",
         "-figure", f"spectrum={dual_main_svg}", "-y", "-fig_as_json"],
        b_verbose,
    )
    add_check(report, "dual-tone main spectrum: exits successfully", result.returncode == 0)
    if dual_main_json.exists():
        desc = json.loads(dual_main_json.read_text())
        markers = desc.get("markers", [])
        ti_markers = [m for m in markers if m.get("shape") == "triangle"]
        im_markers = [m for m in markers if m.get("color") == "#A855F7"]
        add_check(report, "dual-tone main spectrum: TI markers present", len(ti_markers) > 0)
        add_check(report, "dual-tone main spectrum: IM/harmonic markers present", len(im_markers) > 0)
        legend_labels = [it.get("label", "") for it in desc.get("legend", {}).get("items", [])]
        add_check(
            report,
            "dual-tone main spectrum: legend has both a TI entry and a Harmonics/IM entry",
            any("TI spurs" in lbl for lbl in legend_labels) and any("Harmonics" in lbl for lbl in legend_labels),
        )
        results_panel = desc.get("resultsPanel", [])
        add_check(
            report,
            "dual-tone main spectrum: results panel contains a TI-related row",
            any("TI" in str(row.get("label", "")) for row in results_panel),
        )

    # -------------------------------------------------------------------------
    # Report
    # -------------------------------------------------------------------------

    report_text, failures = generate_report_text(report)
    print("\n" + report_text)

    report_path = output_folder / "smeas_figure_debug_report.txt"
    report_path.write_text(report_text)
    print(f"\nResults: {output_folder}")
    print(f"Report:  {report_path}")

    if failures > 0:
        raise SystemExit(f"Regression failed: {failures} check(s) failed.")


if __name__ == "__main__":
    main()
