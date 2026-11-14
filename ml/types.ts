export type DatasetDomain = 'physiological' | 'cbc' | 'immune';

export type MmashWindowMode = 'window_60s' | 'epoch_20';
export type ImmuneProcessingMode = 'per_analyte' | 'wide_pivot' | 'pooled';

export interface PipelineConfig {
  mmashWindowMode: MmashWindowMode;
  mmashWindowSeconds: number;
  immuneProcessingMode: ImmuneProcessingMode;
  cbcExcludeSuspectRows: boolean;
}

export type ColumnRole =
  | 'subject_id'
  | 'timestamp'
  | 'feature'
  | 'categorical'
  | 'label_candidate'
  | 'ignored';

export interface ColumnProfile {
  name: string;
  inferredType: 'numeric' | 'datetime' | 'categorical' | 'text';
  role: ColumnRole;
  unit: string | null;
  nonNullCount: number;
  missingCount: number;
  missingPct: number;
  uniqueCount: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  std: number | null;
  q25: number | null;
  q75: number | null;
  iqrOutlierCount: number;
  excludedReason?: string | null;
}

export interface ZipEntryInfo {
  path: string;
  sizeBytes: number;
  rowCount: number;
  columns: string[];
  inferredSubjectId: string | null;
}

export interface SupervisedLabelAudit {
  hasValidLabels: boolean;
  candidateColumns: string[];
  reason: string;
}

export interface CbcConsistencyFinding {
  rowIndex: number;
  sampleName: string;
  severity: 'critical' | 'warning';
  findings: string[];
  recordedValues: Record<string, number | null>;
  expectedFromWbcDiff?: Record<string, number>;
  handling: string;
}

export interface NlrAuditSummary {
  computed: boolean;
  numeratorColumn: string | null;
  denominatorColumn: string | null;
  unitCheck: string;
  zeroOrNearZeroDenominators: number;
  missingNlrCount: number;
  minNlr: number | null;
  maxNlr: number | null;
  medianNlr: number | null;
  pctCrossCheckDiscrepancies: {
    sampleName: string;
    nlrFromAbsolute: number;
    nlrFromPercent: number;
    relativeDiffPct: number;
  }[];
  notes: string[];
}

export interface CbcModelSnapshotMetrics {
  sampleCount: number;
  flaggedCount: number;
  flaggedSamples: string[];
  thresholdScore: number;
  nlrMin: number | null;
  nlrMedian: number | null;
  nlrMax: number | null;
  mpvMean: number | null;
  mpvStd: number | null;
  plateletMean: number | null;
  plateletStd: number | null;
  seedSpearman: number;
  seedJaccard: number;
}

export interface CbcIntegrityComparison {
  excludeSuspectApplied: boolean;
  suspectSampleNames: string[];
  verifiedRowCount: number;
  suspectRowCount: number;
  withSuspect: CbcModelSnapshotMetrics;
  withoutSuspect: CbcModelSnapshotMetrics;
  note: string;
}

export interface MmashWindowComparison {
  activeMode: MmashWindowMode;
  windowSeconds: number;
  rawZipAvailable: boolean;
  colabReferenceWindows: number;
  activeRowCount: number;
  activeSubjectCount: number;
  epoch20RowCount?: number;
  window60sRowCount?: number;
  deltaVsColabWindows?: number | null;
  validationStatus: 'validated_against_zip' | 'awaiting_raw_zip' | 'epoch_20_overview';
  featureDistributionComparisons: {
    feature: string;
    epoch20Mean?: number | null;
    epoch20Std?: number | null;
    window60sMean?: number | null;
    window60sStd?: number | null;
  }[];
  notes: string[];
}

export interface ImmuneAnalyteSummary {
  analyte: string;
  unit: string | null;
  rowCount: number;
  missingCount: number;
  leftCensoredCount: number;
  rightCensoredCount: number;
  median: number | null;
  iqr: number | null;
  ifAnomalyCount: number;
  madFlagCount: number;
  anomalyPct: number;
}

export interface ImmuneProcessingAudit {
  activeMode: ImmuneProcessingMode;
  hasAnalyteColumn: boolean;
  analyteCount: number;
  censoredValuesSummary: {
    leftCensoredCount: number;
    rightCensoredCount: number;
    missingCount: number;
    handlingRule: string;
  };
  pooledVsNormalizedComparison?: {
    pooledIfFlags: number;
    pooledMadFlags: number;
    normalizedIfFlags: number;
    normalizedMadFlags: number;
    widePivotSampleCount?: number;
    widePivotFeatureCount?: number;
    jaccardOverlap: number;
    spearmanRankCorr: number;
    note: string;
  };
  perAnalyteSummary: ImmuneAnalyteSummary[];
  notes: string[];
}

export interface DataQualityAudit {
  missingCellsBeforeInFeatures: number;
  missingCellsBeforeTotal: number;
  missingCellsAfter: number;
  excludedReferenceRangeColumns: string[];
  excludedNonMeasurementColumns: string[];
  excludedHighMissingColumns: string[];
  excludedZeroVarianceColumns: string[];
  cbcConsistencyFindings: CbcConsistencyFinding[];
  cbcIntegrityComparison?: CbcIntegrityComparison | null;
  nlrAudit: NlrAuditSummary | null;
  mmashWindowComparison?: MmashWindowComparison | null;
  immuneAudit?: ImmuneProcessingAudit | null;
  windowingNote: string | null;
  cohortIsolationNote: string;
}

export interface DatasetMetadata {
  id: string;
  domain: DatasetDomain;
  filename: string;
  fileType: 'csv' | 'zip' | 'colab_bundle';
  provenanceNote: string;
  uploadedAt: string;
  rowCount: number;
  rawRowCount: number;
  duplicateCount: number;
  columnCount: number;
  subjectCount: number;
  subjectIds: string[];
  subjectIdColumn: string | null;
  hasTimestamps: boolean;
  timestampColumn: string | null;
  timestampRange: [string, string] | null;
  columns: ColumnProfile[];
  droppedHighMissingColumns: string[];
  imputedCellCount: number;
  engineeredFeatures: string[];
  supervisedLabelAudit: SupervisedLabelAudit;
  qualityNotes: string[];
  dataQualityAudit: DataQualityAudit;
  zipManifest?: ZipEntryInfo[];
}

export interface FeatureContribution {
  feature: string;
  value: number;
  cohortMean: number;
  cohortStd: number;
  zScore: number;
  isolationContribution: number;
  contributionPct: number;
  direction: 'elevated' | 'depressed' | 'nominal';
}

export interface AnalyzedObservation {
  index: number;
  subjectId: string;
  timestamp: string | null;
  analyte?: string | null;
  integrityStatus?: 'verified' | 'suspected_corrupted';
  values: Record<string, number>;
  anomalyScore: number;
  decisionScore: number;
  isAnomaly: boolean;
  baselineMaxModifiedZ: number;
  baselineFlag: boolean;
  featureContributions: FeatureContribution[];
  explanation: string;
}

export interface ScoreHistogramBin {
  binLabel: string;
  binStart: number;
  binEnd: number;
  normalCount: number;
  anomalyCount: number;
}

export interface ContaminationSensitivityPoint {
  contamination: number;
  flaggedCount: number;
  flaggedPct: number;
  thresholdScore: number;
  baselineOverlapPct: number;
}

export interface StabilityMetrics {
  numSeeds: number;
  meanJaccardOverlap: number;
  meanSpearmanRankCorr: number;
  scoreStdAcrossSeeds: number;
}

export interface BaselineComparison {
  bothFlagged: number;
  onlyIsolationForest: number;
  onlyStatisticalBaseline: number;
  neitherFlagged: number;
  agreementPct: number;
  scoreCorrelation: number;
}

export interface CorrelationMatrixData {
  features: string[];
  matrix: number[][];
}

export interface FeatureImportanceItem {
  feature: string;
  importance: number;
  meanAnomalyAbsZ: number;
  meanNormalAbsZ: number;
  method: 'IsolationPathAttribution' | 'SHAP';
}

export interface ModelHyperparameters {
  algorithm: string;
  nEstimators: number;
  maxSamples: number;
  maxDepth: number;
  contamination: number;
  randomSeed: number;
  scaler: string;
  imputer: string;
}

export interface ScoreSummaryStats {
  min: number;
  q25: number;
  median: number;
  mean: number;
  q75: number;
  p95: number;
  max: number;
}

export interface DomainAnalysisResult {
  domain: DatasetDomain;
  trained: boolean;
  source: 'local_ts_engine' | 'colab_python_sklearn';
  modelType: string;
  baselineType: string;
  modelParams: ModelHyperparameters;
  scoreSummary: ScoreSummaryStats;
  trainedAt: string;
  sampleCount: number;
  featureColumns: string[];
  contamination: number;
  thresholdScore: number;
  anomalyCount: number;
  normalCount: number;
  anomalyPercentage: number;
  scoreDistribution: ScoreHistogramBin[];
  featureImportance: FeatureImportanceItem[];
  contaminationSensitivity: ContaminationSensitivityPoint[];
  stabilityAnalysis: StabilityMetrics;
  baselineComparison: BaselineComparison;
  correlationMatrix: CorrelationMatrixData;
  records: AnalyzedObservation[];
  supervisedStatus: SupervisedLabelAudit;
  evaluationNotes: string[];
}

export interface SimulationEvent {
  id: string;
  timestamp: string;
  domain: DatasetDomain;
  subjectId: string;
  severity: 'info' | 'warning' | 'anomaly';
  anomalyScore: number;
  message: string;
}

export interface SimulationState {
  running: boolean;
  domain: DatasetDomain;
  cursorIndex: number;
  totalRecords: number;
  intervalMs: number;
  startedAt: string | null;
  history: AnalyzedObservation[];
  events: SimulationEvent[];
}
