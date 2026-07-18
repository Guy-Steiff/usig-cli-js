/**
 * resultInterpretation.ts
 *
 * Plain-English interpretation of plugin scalar results for engineers who are
 * not DSP specialists.  Returns a short one-line summary + optional detail notes.
 *
 * Supports smeas and sinl output columns.
 */

export interface InterpretedResult {
  /** One-liner, e.g. "SNR 68.3 dB — good for a 12-bit ADC" */
  headline: string;
  /** Optional extended note with context */
  note?: string;
  /** Color hint for the badge */
  level: 'good' | 'moderate' | 'warn' | 'bad' | 'info';
}

// ─── SMEAS interpretation ────────────────────────────────────────────────────

function interpretSmeas(row: Record<string, string | number>): InterpretedResult[] {
  const results: InterpretedResult[] = [];

  const snrC    = Number(row['snr_c']);
  const sndrC   = Number(row['sndr_c']);
  const thdDb   = Number(row['thd_db']);
  const sfdrDbc = Number(row['sfdr_dbc']);
  const enobSnr = Number(row['enob_sndr_fs']);     // prefer SINAD-based ENOB
  const fund1   = Number(row['fund1_mhz']);

  // SNR / ENOB
  if (!isNaN(enobSnr) && enobSnr > 0) {
    const level = enobSnr >= 9 ? 'good' : enobSnr >= 8.5 ? 'moderate' : enobSnr >= 8 ? 'warn' : 'bad';
    const adj   = enobSnr >= 9 ? 'excellent' : enobSnr >= 8.5 ? 'good' : enobSnr >= 8 ? 'moderate' : 'degraded';
    const snrStr = !isNaN(sndrC) ? ` (SINAD ${sndrC.toFixed(1)} dBFS)` : '';
    results.push({
      headline: `ENOB ${enobSnr.toFixed(2)} bits — ${adj}${snrStr}`,
      note: enobSnr < 9
        ? 'ENOB below 9 bits may indicate harmonic or wideband noise issues. Check THD and noise floor.'
        : undefined,
      level,
    });
  } else if (!isNaN(snrC) && snrC > 0) {
    const level = snrC >= 70 ? 'good' : snrC >= 60 ? 'moderate' : snrC >= 50 ? 'warn' : 'bad';
    const adj   = snrC >= 70 ? 'excellent' : snrC >= 60 ? 'good' : snrC >= 50 ? 'moderate' : 'degraded';
    results.push({ headline: `SNR ${snrC.toFixed(1)} dBFS — ${adj}`, level });
  }

  // THD
  if (!isNaN(thdDb) && thdDb < 0) {
    const level = thdDb <= -70 ? 'good' : thdDb <= -60 ? 'moderate' : thdDb <= -50 ? 'warn' : 'bad';
    const adj   = thdDb <= -70 ? 'low distortion' : thdDb <= -60 ? 'moderate distortion' : thdDb <= -50 ? 'elevated distortion' : 'high distortion';
    results.push({
      headline: `THD ${thdDb.toFixed(1)} dBc — ${adj}`,
      note: thdDb > -50 ? 'THD above −50 dBc: inspect harmonic plot for dominant spurious tones.' : undefined,
      level,
    });
  }

  // SFDR
  if (!isNaN(sfdrDbc) && sfdrDbc > 0) {
    const level = sfdrDbc >= 80 ? 'good' : sfdrDbc >= 65 ? 'moderate' : sfdrDbc >= 50 ? 'warn' : 'bad';
    const adj   = sfdrDbc >= 80 ? 'excellent spur-free range' : sfdrDbc >= 65 ? 'good' : sfdrDbc >= 50 ? 'limited' : 'poor';
    results.push({ headline: `SFDR ${sfdrDbc.toFixed(1)} dBc — ${adj}`, level });
  }

  // Fundamental frequency context
  if (!isNaN(fund1) && fund1 > 0) {
    results.push({
      headline: `Fundamental at ${fund1 >= 1000 ? (fund1 / 1000).toFixed(3) + ' GHz' : fund1.toFixed(3) + ' MHz'}`,
      level: 'info',
    });
  }

  return results;
}

// ─── SINL interpretation ─────────────────────────────────────────────────────

function interpretSinl(row: Record<string, string | number>): InterpretedResult[] {
  const results: InterpretedResult[] = [];

  const inlP2p  = Number(row['inl_codes_p2p']);
  const inlMax  = Number(row['inl_max']);
  const dnlMax  = Number(row['dnl_max']);
  const dnlMin  = Number(row['dnl_min']);
  const missing = Number(row['missing_codes_count']);

  // INL
  if (!isNaN(inlP2p) && !isNaN(inlMax)) {
    const level = inlP2p <= 1 ? 'good' : inlP2p <= 2 ? 'moderate' : inlP2p <= 4 ? 'warn' : 'bad';
    const adj   = inlP2p <= 1 ? 'excellent' : inlP2p <= 2 ? 'good' : inlP2p <= 4 ? 'moderate' : 'poor';
    results.push({
      headline: `INL P2P ${inlP2p.toFixed(2)} LSB — ${adj} linearity`,
      note: inlP2p > 2 ? `Peak INL ${inlMax.toFixed(2)} LSB. Values >1 LSB indicate non-linearity worth investigating.` : undefined,
      level,
    });
  }

  // DNL
  if (!isNaN(dnlMax) && !isNaN(dnlMin)) {
    const worseDnl = Math.max(Math.abs(dnlMax), Math.abs(dnlMin));
    const level = worseDnl <= 0.5 ? 'good' : worseDnl <= 1 ? 'moderate' : worseDnl <= 2 ? 'warn' : 'bad';
    const adj   = worseDnl <= 0.5 ? 'good' : worseDnl <= 1 ? 'acceptable' : worseDnl <= 2 ? 'elevated' : 'high';
    const note  = dnlMin <= -1 ? 'DNL ≤ −1 LSB means missing codes are present.' : undefined;
    results.push({ headline: `DNL max ${dnlMax.toFixed(2)} / min ${dnlMin.toFixed(2)} LSB — ${adj}`, note, level });
  }

  // Missing codes
  if (!isNaN(missing)) {
    const level = missing === 0 ? 'good' : missing <= 3 ? 'moderate' : 'bad';
    results.push({
      headline: missing === 0
        ? 'No missing codes detected'
        : `${missing} missing code${missing !== 1 ? 's' : ''} detected`,
      note: missing > 0 ? 'Missing codes degrade effective linearity. Check DNL minimum values.' : undefined,
      level,
    });
  }

  return results;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Given a result row from a plugin run, return plain-English interpretation
 * bullets.  Returns an empty array if no interpretable columns are found.
 */
export function interpretResult(row: Record<string, string | number>): InterpretedResult[] {
  const keys = new Set(Object.keys(row));

  // Heuristic: determine which plugin produced this row
  const isSmeas = keys.has('snr_c') || keys.has('thd_db') || keys.has('sfdr_dbc');
  const isSinl  = keys.has('inl_codes_p2p') || keys.has('dnl_max');

  const all: InterpretedResult[] = [];
  if (isSmeas) all.push(...interpretSmeas(row));
  if (isSinl)  all.push(...interpretSinl(row));
  return all;
}

/** CSS class for a given level badge */
export function levelClass(level: InterpretedResult['level']): string {
  switch (level) {
    case 'good':     return 'bg-green-500/20 text-green-300 border-green-500/30';
    case 'moderate': return 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30';
    case 'warn':     return 'bg-orange-500/20 text-orange-300 border-orange-500/30';
    case 'bad':      return 'bg-red-500/20 text-red-300 border-red-500/30';
    case 'info':     return 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30';
  }
}

