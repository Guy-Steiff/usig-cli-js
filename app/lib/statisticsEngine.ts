/**
 * Statistics Engine
 *
 * Correlation computation, R² analysis, and interpretive summary generation
 * for validation data analysis.
 */

export interface CorrelationResult {
  variable: string;
  correlation: number;
  strength: 'High' | 'Medium' | 'Low';
}

/**
 * Compute Pearson correlation coefficient between two arrays
 */
export const computeCorrelation = (x: number[], y: number[]): number => {
  const n = x.length;
  if (n === 0) return 0;

  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
  const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  if (denominator === 0) return 0;
  return numerator / denominator;
};

/**
 * Compute R² (coefficient of determination) from Pearson r
 */
export const computeR2 = (x: number[], y: number[]): number => {
  const pearsonR = computeCorrelation(x, y);
  return pearsonR * pearsonR;
};

/**
 * Compute correlation results for multiple X variables against Y variable
 */
export const computeCorrelations = (
  data: Record<string, any>[],
  yVariable: string,
  xVariables: string[]
): CorrelationResult[] => {
  return xVariables.map(xVar => {
    const yValues = data.map(d => typeof d[yVariable] === 'number' ? d[yVariable] as number : 0);
    const xValues = data.map(d => typeof d[xVar] === 'number' ? d[xVar] as number : 0);

    const r2 = computeR2(xValues, yValues);

    return {
      variable: xVar,
      correlation: r2,
      strength: (r2 > 0.5 ? 'High' : r2 > 0.25 ? 'Medium' : 'Low') as 'High' | 'Medium' | 'Low'
    };
  }).sort((a, b) => b.correlation - a.correlation);
};

/**
 * Generate human-readable interpretation of correlation results
 */
export const generateInterpretation = (
  correlations: CorrelationResult[],
  yVariable: string
): string => {
  const highFactors = correlations.filter(c => c.strength === 'High');
  const mediumFactors = correlations.filter(c => c.strength === 'Medium');

  if (highFactors.length === 0 && mediumFactors.length === 0) {
    return `Weak relationships detected. Consider alternative factors or data quality.`;
  }

  if (highFactors.length === 1 && mediumFactors.length === 0) {
    return `Primary variance driver: ${highFactors[0].variable} (${(highFactors[0].correlation * 100).toFixed(0)}%)`;
  }

  if (highFactors.length === 2) {
    return `Primary variance drivers: ${highFactors[0].variable} (${(highFactors[0].correlation * 100).toFixed(0)}%), ${highFactors[1].variable} (${(highFactors[1].correlation * 100).toFixed(0)}%)`;
  }

  if (highFactors.length === 1 && mediumFactors.length > 0) {
    return `Primary variance driver: ${highFactors[0].variable} (${(highFactors[0].correlation * 100).toFixed(0)}%), with moderate ${mediumFactors[0].variable} interaction (${(mediumFactors[0].correlation * 100).toFixed(0)}%)`;
  }

  if (highFactors.length > 2) {
    return `Multiple strong drivers: ${highFactors.slice(0, 3).map(f => f.variable).join(', ')} all explain significant variance`;
  }

  return `Primary variance drivers: ${highFactors.concat(mediumFactors).slice(0, 2).map(f => `${f.variable} (${(f.correlation * 100).toFixed(0)}%)`).join(', ')}`;
};

