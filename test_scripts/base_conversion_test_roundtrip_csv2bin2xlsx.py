import os
import time
import subprocess
import pandas as pd


if __name__ == "__main__":

    os.environ["PATH"] += ':/home/gnew/.nvm/versions/node/v24.11.1/bin'

    print(os.system("node --version"))


    output_folder = os.path.join("/media/gnew/Mech/results/usig_unitesting/results",
                                 "conversion_dataframe_test",
                                 time.strftime("%Y_%m_%d_%H_%M_%S")
                                 )
    str_input_csv_path = r'/media/gnew/Mech/results/usig_unitesting/cannon_conversion_files/sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv'
    str_1_csv2bin_out_path = os.path.join(output_folder, 'sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.bin')
    str_2_csv2bin2csv_out_path = os.path.join(output_folder, 'sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp.csv')

    os.makedirs(output_folder, exist_ok=True)

    pd_data = pd.DataFrame(columns=['usig_command_lst'], index=range(8))
    pd_data.loc[0, 'usig_command_lst'] = ['usig', '-i', str_input_csv_path, str_1_csv2bin_out_path]
    pd_data.loc[1, 'usig_command_lst'] = ['usig', '-i', str_1_csv2bin_out_path, str_2_csv2bin2csv_out_path]
    pd_data.loc[2, 'usig_command_lst'] = ['usig',
                                          '-i',
                                          str_input_csv_path,
                                          '--infer-meta-from-filename',
                                          os.path.join(output_folder, 'sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp_metafromfile.bin')]
    pd_data.loc[3, 'usig_command_lst'] = ['usig',
                                          '-i',
                                          os.path.join(output_folder, 'sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp_metafromfile.bin'),
                                          os.path.join(output_folder, 'sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp_metafromfile_bin2csv.csv')]
    pd_data.loc[4, 'usig_command_lst'] = ['usig',
                                          '-i',
                                          os.path.join(output_folder, 'sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp_metafromfile_bin2csv.csv'),
                                          '-p',
                                          'numaveraging=5',
                                          os.path.join(output_folder, 'sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp_woverrides.bin')]
    pd_data.loc[5, 'usig_command_lst'] = ['usig',
                                          '-i',
                                          os.path.join(output_folder, 'sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp_woverrides.bin'),
                                          os.path.join(output_folder, 'sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp_woverrides_bin2csv.csv')]
    pd_data.loc[6, 'usig_command_lst'] = ['usig',
                                          '-i',
                                          os.path.join(output_folder, 'sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp_woverrides_bin2csv.csv'),
                                          '-p',
                                          'gg=1',
                                          os.path.join(output_folder, 'sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp_woverrides_bin2csv.xlsx')]
    pd_data.loc[7, 'usig_command_lst'] = ['usig',
                                          '-i',
                                          os.path.join(output_folder, 'sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp_woverrides_bin2csv.xlsx'),
                                          os.path.join(output_folder, 'sine_fs2p25ghz_tonemode~single_fftlength8192_numaveraging4_numberofcores8_ticorrections~ogp_woverrides_xlsx2csv.csv')]

    for index, row in pd_data.iterrows():
        result = subprocess.run(row['usig_command_lst'], capture_output=True, text=True)
        stdout = result.stdout
        stderr = result.stderr
        print(stdout)
        print(stderr)


