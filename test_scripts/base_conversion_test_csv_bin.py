import time
import os
import pandas as pd
import tqdm
import subprocess
os.environ["PATH"] += ':/home/gnew/.nvm/versions/node/v24.11.1/bin'

if __name__ == '__main__':
    print(os.system("node --version"))
    str_root_results_folder = r"/media/gnew/Mech/results/usig_unitesting/results"
    str_base_name = "base_conversion_test_csv_bin"
    str_timestamps = str(time.strftime("%Y_%m_%d_%H_%M_%S", time.localtime()))
    str_full_results_folder = os.path.join(str_root_results_folder, str_base_name, str_timestamps)
    os.makedirs(str_full_results_folder, exist_ok=True)

    str_input_path = r'/media/gnew/Mech/results/usig_unitesting/sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp_metafromfile.bin'
    str_output_path = os.path.join(str_full_results_folder, 'sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp_metafromfile_binrecon.csv')

    command = [
        'usig',
        '-i', str_input_path,
        str_output_path
    ]

    result = subprocess.run(
        command,
        capture_output=True,
        text=True
    )

    stdout = result.stdout
    stderr = result.stderr

    # Save logs
    with open(os.path.join(str_full_results_folder, "usig_stdout.txt"), "w") as f:
        f.write(stdout)

    with open(os.path.join(str_full_results_folder, "usig_stderr.txt"), "w") as f:
        f.write(stderr)

    return_code = result.returncode

    print(stdout)
    print(stderr)

