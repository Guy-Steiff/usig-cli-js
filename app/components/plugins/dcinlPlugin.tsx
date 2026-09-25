import {
    type Plugin, PluginManifest,
    type WaveformPacket,
} from '../../lib/pluginTypes';

interface DcinlParams {
  outputCode?: string;
  inputVoltage?: string;
}

const manifest: PluginManifest = {
  id: 'dcinl',
  name: 'DCINL — DC INL/DNL',
  description: 'DC (ramp) INL/DNL from paired ADC output codes and input voltage samples.',
  version: '0.1.0',
  author: 'Guy Steiff',
  github: '',
  linkedin: 'https://www.linkedin.com/in/guysteiff/',
  authorEmail: 'a@a.com',
  website: '',
  pythonModule: '',
  pythonFunction: '',
  reportTitle: 'DC INL/DNL Analysis',
  category: 'signal',
  paramSchema: [
    {
      key: 'outputCode',
      label: 'Output Code Column',
      type: 'column-select',
      description: 'CSV column containing the ADC output codes under test.',
      default: '',
      aliases: ['codes', 'adcCode', 'adcCodes', 'outputCodes'],
    },
    {
      key: 'inputVoltage',
      label: 'Input Voltage Column',
      type: 'column-select',
      description: 'CSV column containing the corresponding analog input voltage samples.',
      default: '',
      aliases: ['volts', 'voltage', 'inputVolts'],
    },
  ],

  // Declarative debug table capabilities. These are lightweight metadata only
  // and do not contain table data. prepareData() still generates the actual
  // PluginDebugTable objects at runtime.
  debugTables: [],

  // Declarative figure capabilities. Safe to enumerate via `-figure list`
  // without ingesting an input or loading the React figure components.
  figures: [],
};

export const dcinlPlugin: Plugin<DcinlParams> = {
  id: 'dcinl',
  name: 'dcinl — DC INL/DNL (placeholder)',
  description: 'Multi-column ingestion placeholder: verifies codes + volts columns reach the plugin.',

  outputColumns: ['status', 'n_samples', 'codes_label', 'volts_label', 'codes_first', 'volts_first'],

  getIngestHints: (params: DcinlParams) => ({
    // The codes column is the primary waveform for this plugin.
    targetColumn: params.outputCode?.trim() || undefined,
  }),


  run: async (packet: WaveformPacket, params: DcinlParams) => {
    const codes = packet.arrays?.find(a => a.label === params.outputCode);
    const volts = packet.arrays?.find(a => a.label === params.inputVoltage);

    if (!codes || !volts) {
      return {
        status: `missing column: codes=${params.outputCode} found=${!!codes}, volts=${params.inputVoltage} found=${!!volts}`,
        n_samples: 0,
        codes_label: '',
        volts_label: '',
        codes_first: NaN,
        volts_first: NaN,
      };
    }

    return {
      status: 'ok',
      n_samples: codes.waveform.length,
      codes_label: codes.label,
      volts_label: volts.label,
      codes_first: codes.waveform[0],
      volts_first: volts.waveform[0],
    };
  },
};