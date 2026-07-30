#!/usr/bin/env node


const path = require("path");


const {
    generateHypothesis
}
=
require("./hypothesis_gen_for_ir_from_bin");



const TEST_FILES = [

    {
        name:
            "instrument binary",

        file:
            "/media/gnew/Mech/results/usig_unitesting/wavebin_examples/single.bin",

        expectedMode:
            "heuristic_reconstruction_instructions"
    },


    {
        name:
            "embedded metadata binary",

        file:
            "/media/gnew/Mech/results/usig_unitesting/cannon_conversion_files/sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp_woverrides.bin",

        expectedMode:
             "embedded_reconstruction_instructions"
    }

];



let failures = 0;



for (const test of TEST_FILES) {


    console.log("");
    console.log(
        "TEST:",
        test.name
    );


    const result =
        generateHypothesis(
            test.file
        );


    console.log(
        "mode:",
        result.decision.mode
    );


    console.log(
        "confidence:",
        result.decision.confidence
    );


    if (
        !result.decision.can_create_ir
    ) {

        console.error(
            "FAIL: cannot create IR"
        );

        failures++;
        continue;

    }


    if (
        result.decision.mode !==
        test.expectedMode
    ) {

        console.error(
            "FAIL: unexpected mode"
        );

        failures++;

    }


    const ri =
        result.reconstruction_instructions;


    if (!ri) {

        console.error(
            "FAIL: missing reconstruction instructions"
        );

        failures++;
        continue;

    }


    const required = [

        "encoding",
        "endianness",
        "bytes_per_sample",
        "samples",
        "offset",
        "scale",
        "offset_value"

    ];


    for (const field of required) {

        if (
            ri[field] === undefined ||
            ri[field] === null
        ) {

            console.error(
                "FAIL: missing field:",
                field
            );

            failures++;

        }

    }


    console.log(
        "PASS"
    );

}



console.log("");

if (
    failures > 0
) {

    console.error(
        "FAILED:",
        failures,
        "checks"
    );

    process.exit(1);

}
else {

    console.log(
        "ALL TESTS PASSED"
    );

}