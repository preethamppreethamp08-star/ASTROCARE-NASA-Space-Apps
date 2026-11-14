import type { PreprocessedDataset } from './preprocessing.ts';
import type {
  AnalyzedObservation,
  BaselineComparison,
  ContaminationSensitivityPoint,
  CorrelationMatrixData,
  DomainAnalysisResult,
  FeatureContribution,
  FeatureImportanceItem,
  ModelHyperparameters,
  ScoreHistogramBin,
  ScoreSummaryStats,
  StabilityMetrics,
} from './types.ts';

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cFactor(n: number): number {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  const H = Math.log(n - 1) + 0.5772156649;
  return 2 * H - (2 * (n - 1)) / n;
}

interface ITreeNode {
  isLeaf: boolean;
  size: number;
  splitFeature?: number;
  splitValue?: number;
  left?: ITreeNode;
  right?: ITreeNode;
}

function buildITree(
  data: number[][],
  indices: number[],
  currentDepth: number,
  maxDepth: number,
  rng: () => number
): ITreeNode {
  const n = indices.length;
  if (currentDepth >= maxDepth || n <= 1) {
    return { isLeaf: true, size: n };
  }

  const numFeatures = data[0].length;
  const featureOrder = Array.from({ length: numFeatures }, (_, i) => i);
  for (let i = featureOrder.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [featureOrder[i], featureOrder[j]] = [featureOrder[j], featureOrder[i]];
  }

  for (const feat of featureOrder) {
    let minVal = Infinity;
    let maxVal = -Infinity;
    for (const idx of indices) {
      const v = data[idx][feat];
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
    if (maxVal - minVal > 1e-12) {
      const splitVal = minVal + rng() * (maxVal - minVal);
      const leftIdx: number[] = [];
      const rightIdx: number[] = [];
      for (const idx of indices) {
        if (data[idx][feat] < splitVal) leftIdx.push(idx);
        else rightIdx.push(idx);
      }
      if (leftIdx.length === 0 || rightIdx.length === 0) {
        continue;
      }
      return {
        isLeaf: false,
        size: n,
        splitFeature: feat,
        splitValue: splitVal,
        left: buildITree(data, leftIdx, currentDepth + 1, maxDepth, rng),
        right: buildITree(data, rightIdx, currentDepth + 1, maxDepth, rng),
      };
    }
  }

  return { isLeaf: true, size: n };
}

function pathLengthWithFeatureAttribution(
  point: number[],
  node: ITreeNode,
  depth: number,
  featureGain: number[]
): number {
  if (node.isLeaf || node.splitFeature === undefined || node.splitValue === undefined) {
    return depth + cFactor(node.size);
  }
  const feat = node.splitFeature;
  const goLeft = point[feat] < node.splitValue;
  const child = goLeft ? node.left! : node.right!;
  const parentExpected = cFactor(node.size);
  const childExpected = cFactor(child.size);
  const isolationGain = Math.max(0, parentExpected - childExpected);
  featureGain[feat] += isolationGain;

  return pathLengthWithFeatureAttribution(point, child, depth + 1, featureGain);
}

interface TrainedForest {
  trees: ITreeNode[];
  subSampleSize: number;
  maxDepth: number;
}

function fitIsolationForest(
  matrix: number[][],
  nEstimators = 100,
  seed = 42
): TrainedForest {
  const rng = createRng(seed);
  const n = matrix.length;
  const subSampleSize = Math.min(256, n);
  const maxDepth = Math.max(1, Math.ceil(Math.log2(subSampleSize)));
  const allIndices = Array.from({ length: n }, (_, i) => i);
  const trees: ITreeNode[] = [];

  for (let t = 0; t < nEstimators; t++) {
    const pool = [...allIndices];
    const sample: number[] = [];
    for (let k = 0; k < subSampleSize; k++) {
      const r = k + Math.floor(rng() * (n - k));
      [pool[k], pool[r]] = [pool[r], pool[k]];
      sample.push(pool[k]);
    }
    trees.push(buildITree(matrix, sample, 0, maxDepth, rng));
  }

  return { trees, subSampleSize, maxDepth };
}

function scoreWithForest(
  forest: TrainedForest,
  matrix: number[][]
): { scores: number[]; featureIsolationTotals: number[][] } {
  const cPsi = Math.max(1e-6, cFactor(forest.subSampleSize));
  const numFeatures = matrix[0].length;
  const scores: number[] = [];
  const featureIsolationTotals: number[][] = [];

  for (let i = 0; i < matrix.length; i++) {
    const point = matrix[i];
    let totalPath = 0;
    const gain = new Array<number>(numFeatures).fill(0);

    for (const tree of forest.trees) {
      totalPath += pathLengthWithFeatureAttribution(point, tree, 0, gain);
    }
    const meanPath = totalPath / forest.trees.length;
    const score = Math.pow(2, -meanPath / cPsi);
    scores.push(Number(score.toFixed(6)));
    featureIsolationTotals.push(gain.map((g) => g / forest.trees.length));
  }

  return { scores, featureIsolationTotals };
}

function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const denom = Math.sqrt(dx * dy);
  return denom > 1e-12 ? Number((num / denom).toFixed(4)) : 0;
}

function rankArray(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[indexed[k].i] = avgRank;
    i = j + 1;
  }
  return ranks;
}

function spearmanCorrelation(xs: number[], ys: number[]): number {
  return pearsonCorrelation(rankArray(xs), rankArray(ys));
}

function computeScoreSummary(scores: number[]): ScoreSummaryStats {
  const sorted = [...scores].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  return {
    min: Number(sorted[0].toFixed(4)),
    q25: Number(sorted[Math.floor(0.25 * (n - 1))].toFixed(4)),
    median: Number(sorted[Math.floor(0.5 * (n - 1))].toFixed(4)),
    mean: Number(mean.toFixed(4)),
    q75: Number(sorted[Math.floor(0.75 * (n - 1))].toFixed(4)),
    p95: Number(sorted[Math.floor(0.95 * (n - 1))].toFixed(4)),
    max: Number(sorted[n - 1].toFixed(4)),
  };
}

function buildScoreHistogram(scores: number[], isAnomalyFlags: boolean[]): ScoreHistogramBin[] {
  const minScore = Math.min(...scores, 0.25);
  const maxScore = Math.max(...scores, 0.85);
  const binCount = 12;
  const step = Math.max(0.01, (maxScore - minScore) / binCount);
  const bins: ScoreHistogramBin[] = [];

  for (let b = 0; b < binCount; b++) {
    const start = minScore + b * step;
    const end = b === binCount - 1 ? maxScore + 1e-6 : minScore + (b + 1) * step;
    let normalCount = 0;
    let anomalyCount = 0;
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] >= start && scores[i] < end) {
        if (isAnomalyFlags[i]) anomalyCount++;
        else normalCount++;
      }
    }
    bins.push({
      binLabel: `${start.toFixed(2)}`,
      binStart: Number(start.toFixed(4)),
      binEnd: Number(end.toFixed(4)),
      normalCount,
      anomalyCount,
    });
  }
  return bins;
}

export function runDomainMLAnalysis(
  dataset: PreprocessedDataset,
  contamination = 0.05
): DomainAnalysisResult {
  const clampedContamination = Math.min(0.25, Math.max(0.01, contamination));
  const n = dataset.scaledMatrix.length;
  const numFeatures = dataset.featureColumns.length;

  const primaryForest = fitIsolationForest(dataset.scaledMatrix, 100, 42);
  const { scores, featureIsolationTotals } = scoreWithForest(primaryForest, dataset.scaledMatrix);

  const sortedScoresDesc = [...scores].sort((a, b) => b - a);
  const anomalyTargetCount = Math.max(1, Math.round(n * clampedContamination));
  const thresholdScore = sortedScoresDesc[Math.min(n - 1, anomalyTargetCount - 1)];
  const isAnomalyFlags = scores.map((s) => s >= thresholdScore);

  const baselineMaxZs: number[] = [];
  const baselineFlags: boolean[] = [];
  for (let i = 0; i < n; i++) {
    let maxModZ = 0;
    for (let j = 0; j < numFeatures; j++) {
      const modZ = Math.abs(
        (0.6745 * (dataset.rawMatrix[i][j] - dataset.featureMedians[j])) / dataset.featureMads[j]
      );
      if (modZ > maxModZ) maxModZ = modZ;
    }
    baselineMaxZs.push(Number(maxModZ.toFixed(4)));
    baselineFlags.push(maxModZ > 3.5);
  }

  const globalAnomalyGain = new Array<number>(numFeatures).fill(0);
  const globalNormalGain = new Array<number>(numFeatures).fill(0);
  const globalAnomalyAbsZ = new Array<number>(numFeatures).fill(0);
  const globalNormalAbsZ = new Array<number>(numFeatures).fill(0);
  let totalAnom = 0;
  let totalNorm = 0;

  const records: AnalyzedObservation[] = [];

  for (let i = 0; i < n; i++) {
    const values: Record<string, number> = {};
    const contribs: FeatureContribution[] = [];
    const rawContribs = featureIsolationTotals[i];

    const combinedWeights = rawContribs.map((gain, j) => {
      const absZ = Math.abs(dataset.scaledMatrix[i][j]);
      return gain * (0.5 + absZ);
    });
    const weightSum = combinedWeights.reduce((a, b) => a + b, 0) || 1;

    for (let j = 0; j < numFeatures; j++) {
      const feat = dataset.featureColumns[j];
      const val = dataset.rawMatrix[i][j];
      const z = dataset.scaledMatrix[i][j];
      values[feat] = Number(val.toFixed(4));

      const pct = (combinedWeights[j] / weightSum) * 100;
      const direction: FeatureContribution['direction'] =
        z > 1.0 ? 'elevated' : z < -1.0 ? 'depressed' : 'nominal';

      contribs.push({
        feature: feat,
        value: Number(val.toFixed(4)),
        cohortMean: Number(dataset.featureMeans[j].toFixed(4)),
        cohortStd: Number(dataset.featureStds[j].toFixed(4)),
        zScore: Number(z.toFixed(3)),
        isolationContribution: Number(rawContribs[j].toFixed(4)),
        contributionPct: Number(pct.toFixed(1)),
        direction,
      });

      if (isAnomalyFlags[i]) {
        globalAnomalyGain[j] += combinedWeights[j];
        globalAnomalyAbsZ[j] += Math.abs(z);
      } else {
        globalNormalGain[j] += combinedWeights[j];
        globalNormalAbsZ[j] += Math.abs(z);
      }
    }

    if (isAnomalyFlags[i]) totalAnom++;
    else totalNorm++;

    contribs.sort((a, b) => b.contributionPct - a.contributionPct);

    const topDrivers = contribs.slice(0, 3);
    const driverText = topDrivers
      .map((d) => {
        const sign = d.zScore >= 0 ? '+' : '';
        return `${d.feature} (${sign}${d.zScore.toFixed(2)} SD, ${d.contributionPct.toFixed(1)}% attribution)`;
      })
      .join('; ');

    const explanation = isAnomalyFlags[i]
      ? `Observation #${i + 1} (${dataset.subjectIds[i]}) was flagged (score ${scores[i].toFixed(3)} >= ${thresholdScore.toFixed(3)}) because its multivariate measurements differed substantially from the learned cohort baseline. Primary drivers: ${driverText}. Note: statistical deviation only, not a medical diagnosis.`
      : `Observation #${i + 1} (${dataset.subjectIds[i]}) falls within the learned cohort baseline (score ${scores[i].toFixed(3)} < ${thresholdScore.toFixed(3)}).`;

    const contribsSlice =
      n > 3000 && !isAnomalyFlags[i] && !baselineFlags[i] ? contribs.slice(0, 6) : contribs;

    records.push({
      index: i + 1,
      subjectId: dataset.subjectIds[i],
      timestamp: dataset.timestamps[i],
      analyte: dataset.analyteLabels?.[i] ?? null,
      integrityStatus: dataset.integrityStatuses?.[i],
      values,
      anomalyScore: scores[i],
      decisionScore: Number((thresholdScore - scores[i]).toFixed(6)),
      isAnomaly: isAnomalyFlags[i],
      baselineMaxModifiedZ: baselineMaxZs[i],
      baselineFlag: baselineFlags[i],
      featureContributions: contribsSlice,
      explanation,
    });
  }

  const rawImportances = featureIsolationTotals[0].map((_, j) => {
    const anomMean = totalAnom > 0 ? globalAnomalyGain[j] / totalAnom : 0;
    const normMean = totalNorm > 0 ? globalNormalGain[j] / totalNorm : 0;
    return Math.max(0, anomMean - 0.5 * normMean) + (totalAnom > 0 ? globalAnomalyAbsZ[j] / totalAnom : 0) * 0.25;
  });
  const impSum = rawImportances.reduce((a, b) => a + b, 0) || 1;
  const featureImportance: FeatureImportanceItem[] = dataset.featureColumns
    .map((feat, j) => ({
      feature: feat,
      importance: Number((rawImportances[j] / impSum).toFixed(4)),
      meanAnomalyAbsZ: totalAnom > 0 ? Number((globalAnomalyAbsZ[j] / totalAnom).toFixed(3)) : 0,
      meanNormalAbsZ: totalNorm > 0 ? Number((globalNormalAbsZ[j] / totalNorm).toFixed(3)) : 0,
      method: 'IsolationPathAttribution' as const,
    }))
    .sort((a, b) => b.importance - a.importance);

  const testRates = [0.01, 0.03, 0.05, 0.08, 0.1, 0.15];
  const baselineFlagCount = baselineFlags.filter(Boolean).length;
  const contaminationSensitivity: ContaminationSensitivityPoint[] = testRates.map((rate) => {
    const k = Math.max(1, Math.round(n * rate));
    const thr = sortedScoresDesc[Math.min(n - 1, k - 1)];
    const flags = scores.map((s) => s >= thr);
    const flaggedCount = flags.filter(Boolean).length;
    const overlap = flags.filter((f, idx) => f && baselineFlags[idx]).length;
    const union = flags.filter((f, idx) => f || baselineFlags[idx]).length;
    return {
      contamination: rate,
      flaggedCount,
      flaggedPct: Number(((flaggedCount / n) * 100).toFixed(2)),
      thresholdScore: Number(thr.toFixed(4)),
      baselineOverlapPct: union > 0 ? Number(((overlap / union) * 100).toFixed(1)) : baselineFlagCount === 0 ? 100 : 0,
    };
  });

  const seeds = [42, 101, 202, 303, 404];
  const seedScores: number[][] = [scores];
  const seedTopSets: Set<number>[] = [
    new Set(
      scores
        .map((s, idx) => ({ s, idx }))
        .sort((a, b) => b.s - a.s)
        .slice(0, anomalyTargetCount)
        .map((x) => x.idx)
    ),
  ];

  for (let sIdx = 1; sIdx < seeds.length; sIdx++) {
    const f = fitIsolationForest(dataset.scaledMatrix, 80, seeds[sIdx]);
    const res = scoreWithForest(f, dataset.scaledMatrix);
    seedScores.push(res.scores);
    seedTopSets.push(
      new Set(
        res.scores
          .map((s, idx) => ({ s, idx }))
          .sort((a, b) => b.s - a.s)
          .slice(0, anomalyTargetCount)
          .map((x) => x.idx)
      )
    );
  }

  let jaccardSum = 0;
  let spearmanSum = 0;
  let pairCount = 0;
  for (let a = 0; a < seeds.length; a++) {
    for (let b = a + 1; b < seeds.length; b++) {
      let inter = 0;
      seedTopSets[a].forEach((idx) => {
        if (seedTopSets[b].has(idx)) inter++;
      });
      const uni = new Set([...seedTopSets[a], ...seedTopSets[b]]).size;
      jaccardSum += uni > 0 ? inter / uni : 1;
      spearmanSum += spearmanCorrelation(seedScores[a], seedScores[b]);
      pairCount++;
    }
  }

  let meanObsStd = 0;
  for (let i = 0; i < n; i++) {
    const vals = seedScores.map((arr) => arr[i]);
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    const v = vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length;
    meanObsStd += Math.sqrt(v);
  }

  const stabilityAnalysis: StabilityMetrics = {
    numSeeds: seeds.length,
    meanJaccardOverlap: Number((jaccardSum / pairCount).toFixed(4)),
    meanSpearmanRankCorr: Number((spearmanSum / pairCount).toFixed(4)),
    scoreStdAcrossSeeds: Number((meanObsStd / n).toFixed(5)),
  };

  let bothFlagged = 0;
  let onlyIsolationForest = 0;
  let onlyStatisticalBaseline = 0;
  let neitherFlagged = 0;
  for (let i = 0; i < n; i++) {
    if (isAnomalyFlags[i] && baselineFlags[i]) bothFlagged++;
    else if (isAnomalyFlags[i]) onlyIsolationForest++;
    else if (baselineFlags[i]) onlyStatisticalBaseline++;
    else neitherFlagged++;
  }
  const baselineComparison: BaselineComparison = {
    bothFlagged,
    onlyIsolationForest,
    onlyStatisticalBaseline,
    neitherFlagged,
    agreementPct: Number((((bothFlagged + neitherFlagged) / n) * 100).toFixed(2)),
    scoreCorrelation: pearsonCorrelation(scores, baselineMaxZs),
  };

  const corrFeatures = dataset.featureColumns.slice(0, 14);
  const corrMatrix: number[][] = corrFeatures.map((fA) => {
    const idxA = dataset.featureColumns.indexOf(fA);
    const colA = dataset.rawMatrix.map((r) => r[idxA]);
    return corrFeatures.map((fB) => {
      const idxB = dataset.featureColumns.indexOf(fB);
      const colB = dataset.rawMatrix.map((r) => r[idxB]);
      return pearsonCorrelation(colA, colB);
    });
  });

  const correlationMatrix: CorrelationMatrixData = {
    features: corrFeatures,
    matrix: corrMatrix,
  };

  const anomalyCount = isAnomalyFlags.filter(Boolean).length;
  const normalCount = n - anomalyCount;

  const modelParams: ModelHyperparameters = {
    algorithm: 'IsolationForest',
    nEstimators: 100,
    maxSamples: primaryForest.subSampleSize,
    maxDepth: primaryForest.maxDepth,
    contamination: clampedContamination,
    randomSeed: 42,
    scaler: 'StandardScaler (zero-mean, unit-variance)',
    imputer: 'MedianImputer',
  };

  const evaluationNotes = [
    `Trained 100-tree Isolation Forest (max_samples=${primaryForest.subSampleSize}, max_depth=${primaryForest.maxDepth}, contamination=${(clampedContamination * 100).toFixed(1)}%, seed=42) on ${n} observations across ${numFeatures} standardized features.`,
    `Compared against Modified Z-Score (MAD, |M| > 3.5) statistical baseline: ${baselineComparison.agreementPct}% observation-level agreement, score correlation r=${baselineComparison.scoreCorrelation}.`,
    `Seed stability across ${seeds.length} random initializations: mean Spearman rank correlation = ${stabilityAnalysis.meanSpearmanRankCorr}, top-k Jaccard overlap = ${stabilityAnalysis.meanJaccardOverlap}.`,
    dataset.metadata.supervisedLabelAudit.hasValidLabels
      ? `Candidate label columns detected (${dataset.metadata.supervisedLabelAudit.candidateColumns.join(', ')}), however unsupervised anomaly scoring remains primary until clinical label validity is verified.`
      : 'No ground-truth anomaly or diagnostic labels exist; classification accuracy/precision/recall/F1/ROC-AUC are intentionally omitted.',
  ];

  return {
    domain: dataset.metadata.domain,
    trained: true,
    source: 'local_ts_engine',
    modelType: 'IsolationForest (n_estimators=100)',
    baselineType: 'Modified Z-Score (MAD > 3.5)',
    modelParams,
    scoreSummary: computeScoreSummary(scores),
    trainedAt: new Date().toISOString(),
    sampleCount: n,
    featureColumns: dataset.featureColumns,
    contamination: clampedContamination,
    thresholdScore: Number(thresholdScore.toFixed(6)),
    anomalyCount,
    normalCount,
    anomalyPercentage: Number(((anomalyCount / n) * 100).toFixed(2)),
    scoreDistribution: buildScoreHistogram(scores, isAnomalyFlags),
    featureImportance,
    contaminationSensitivity,
    stabilityAnalysis,
    baselineComparison,
    correlationMatrix,
    records,
    supervisedStatus: dataset.metadata.supervisedLabelAudit,
    evaluationNotes,
  };
}
