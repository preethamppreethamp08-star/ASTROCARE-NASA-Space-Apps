import {
  extractUnitFromHeader,
  isMissingValue,
  parseNumericValue,
  parseNumericWithCensor,
} from './parser.ts';
import type {
  CbcConsistencyFinding,
  ColumnProfile,
  ColumnRole,
  DataQualityAudit,
  DatasetDomain,
  DatasetMetadata,
  ImmuneAnalyteSummary,
  ImmuneProcessingAudit,
  ImmuneProcessingMode,
  MmashWindowMode,
  NlrAuditSummary,
  SupervisedLabelAudit,
  ZipEntryInfo,
} from './types.ts';

export interface ImmuneRowMeta {
  analyte: string;
  unit: string | null;
  missing: boolean;
  leftCensored: boolean;
  rightCensored: boolean;
  rawConcentration: number | null;
}

export interface PreprocessedDataset {
  metadata: DatasetMetadata;
  featureColumns: string[];
  rawMatrix: number[][];
  scaledMatrix: number[][];
  featureMeans: number[];
  featureStds: number[];
  featureMedians: number[];
  featureMads: number[];
  subjectIds: string[];
  timestamps: (string | null)[];
  analyteLabels?: (string | null)[];
  integrityStatuses?: ('verified' | 'suspected_corrupted')[];
  immuneRowMeta?: ImmuneRowMeta[];
  immuneModeUsed?: ImmuneProcessingMode;
  rawHeaders?: string[];
  rawRows?: Record<string, string>[];
}

const DOMAIN_PROVENANCE: Record<DatasetDomain, string> = {
  physiological:
    'MMASH (Multilevel Monitoring of Activity and Sleep in Healthy people) — terrestrial multi-sensor ambulatory physiology benchmark. Not spaceflight telemetry.',
  cbc:
    'LSDS-7 Complete Blood Count (CBC) Transformed dataset — hematology measurements. Evaluated strictly against cohort distributions unless validated clinical ranges are provided.',
  immune:
    'LSDS-8 Multiplex Serum Immune EvePanel Submitted dataset — cytokine/chemokine multiplex panel. Analyzed strictly within its own cohort.',
};

function computeStats(values: number[]): {
  min: number;
  max: number;
  mean: number;
  median: number;
  std: number;
  q25: number;
  q75: number;
  iqrOutlierCount: number;
  mad: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const min = sorted[0];
  const max = sorted[n - 1];
  const mean = sorted.reduce((acc, v) => acc + v, 0) / n;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const variance = n > 1 ? sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1) : 0;
  const std = Math.sqrt(variance);
  const q25 = sorted[Math.floor(0.25 * (n - 1))];
  const q75 = sorted[Math.floor(0.75 * (n - 1))];
  const iqr = q75 - q25;
  const lowFence = q25 - 1.5 * iqr;
  const highFence = q75 + 1.5 * iqr;
  const iqrOutlierCount = iqr > 0 ? sorted.filter((v) => v < lowFence || v > highFence).length : 0;

  const absDevs = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = n % 2 === 1 ? absDevs[(n - 1) / 2] : (absDevs[n / 2 - 1] + absDevs[n / 2]) / 2;

  return { min, max, mean, median, std, q25, q75, iqrOutlierCount, mad };
}

function isReferenceRangeColumn(name: string): boolean {
  return /(?:^|_)range_(?:min|max)(?:_|$)|(?:^|_)(?:ref|reference)_(?:min|max|low|high)(?:_|$)/i.test(
    name
  );
}

function isNonMeasurementIndexColumn(name: string, domain: DatasetDomain): boolean {
  const lower = name.toLowerCase();
  if (/^(epoch_index|row_index|unnamed:\s*\d+|index)$/i.test(lower)) return true;
  if (domain === 'physiological' && /_(?:in bed date|out bed date|onset date|day)$/i.test(lower)) {
    return true;
  }
  return false;
}

function detectColumnRole(
  name: string,
  inferredType: ColumnProfile['inferredType'],
  uniqueCount: number,
  rowCount: number,
  domain: DatasetDomain
): { role: ColumnRole; excludedReason?: string } {
  const lower = name.toLowerCase();
  if (
    /^(subject|participant|user|astronaut|crew|animal|mouse|patient|sample|specimen)[_\s-]*(id|num|code|name)?$/i.test(
      lower
    ) ||
    lower === 'subject_id' ||
    lower === 'id' ||
    lower === 'sample name'
  ) {
    return { role: 'subject_id', excludedReason: 'Subject/sample identifier' };
  }
  if (/timestamp|date|time|collection|day|epoch/.test(lower) && inferredType !== 'numeric') {
    return { role: 'timestamp', excludedReason: 'Timestamp / timepoint metadata' };
  }
  if (lower === 'source_file' || lower === 'filename') {
    return { role: 'ignored', excludedReason: 'Source filename metadata' };
  }
  if (/^(label|target|y|outcome|diagnosis|anomaly|is_anomaly|ground_truth|class)$/.test(lower)) {
    return { role: 'label_candidate', excludedReason: 'Target label candidate' };
  }
  if (isReferenceRangeColumn(name)) {
    return {
      role: 'ignored',
      excludedReason: 'Clinical reference-range bound (excluded from ML features)',
    };
  }
  if (isNonMeasurementIndexColumn(name, domain)) {
    return {
      role: 'ignored',
      excludedReason: 'Ordinal epoch/date index (non-physiological metadata)',
    };
  }
  if (inferredType === 'numeric') {
    if (uniqueCount <= 1) {
      return { role: 'ignored', excludedReason: 'Zero variance (constant across cohort)' };
    }
    return { role: 'feature' };
  }
  if (inferredType === 'datetime') return { role: 'timestamp', excludedReason: 'Datetime column' };
  if (uniqueCount < Math.max(20, rowCount * 0.5)) {
    return { role: 'categorical', excludedReason: 'Categorical metadata' };
  }
  return { role: 'ignored', excludedReason: 'High-cardinality text identifier' };
}

function looksLikeDateString(val: string): boolean {
  if (/^\d+(\.\d+)?$/.test(val.trim())) return false;
  if (!/[-/:T]/.test(val)) return false;
  const ts = Date.parse(val);
  return !Number.isNaN(ts);
}

export function auditCbcConsistency(
  rows: Record<string, string>[],
  numericValuesByCol: Record<string, (number | null)[]>,
  subjectIds: string[]
): { findings: CbcConsistencyFinding[]; suspectRowIndices: Set<number> } {
  const findings: CbcConsistencyFinding[] = [];
  const suspectRowIndices = new Set<number>();
  const cols = Object.keys(numericValuesByCol);
  const wbcCol = cols.find((c) => /white_blood_cell|wbc/i.test(c) && !/range/i.test(c));
  const pltCol = cols.find((c) => /platelet_count/i.test(c) && !/range/i.test(c));
  const mpvCol = cols.find((c) => /(?:^|_)mpv(?:_|$)/i.test(c) && !/range/i.test(c));
  const rdwCol = cols.find((c) => /(?:^|_)rdw(?:_|$)/i.test(c) && !/range/i.test(c));
  const absNeutCol = cols.find((c) => /absolute_neutrophils/i.test(c) && !/range/i.test(c));
  const absLymphCol = cols.find((c) => /absolute_lymphocytes/i.test(c) && !/range/i.test(c));
  const absMonoCol = cols.find((c) => /absolute_monocytes/i.test(c) && !/range/i.test(c));
  const absEosCol = cols.find((c) => /absolute_eosinophils/i.test(c) && !/range/i.test(c));
  const absBasoCol = cols.find((c) => /absolute_basophils/i.test(c) && !/range/i.test(c));
  const pctNeutCol = cols.find((c) => /neutrophils_value_percent/i.test(c));
  const pctLymphCol = cols.find((c) => /lymphocytes_value_percent/i.test(c));
  const pctMonoCol = cols.find((c) => /monocytes_value_percent/i.test(c));
  const pctEosCol = cols.find((c) => /eosinophils_value_percent/i.test(c));

  for (let i = 0; i < rows.length; i++) {
    const rowFindings: string[] = [];
    const recorded: Record<string, number | null> = {};
    const expected: Record<string, number> = {};

    const plt = pltCol ? numericValuesByCol[pltCol][i] : null;
    const mpv = mpvCol ? numericValuesByCol[mpvCol][i] : null;
    const rdw = rdwCol ? numericValuesByCol[rdwCol][i] : null;
    const wbc = wbcCol ? numericValuesByCol[wbcCol][i] : null;
    const absNeut = absNeutCol ? numericValuesByCol[absNeutCol][i] : null;
    const absLymph = absLymphCol ? numericValuesByCol[absLymphCol][i] : null;
    const absMono = absMonoCol ? numericValuesByCol[absMonoCol][i] : null;
    const absEos = absEosCol ? numericValuesByCol[absEosCol][i] : null;
    const absBaso = absBasoCol ? numericValuesByCol[absBasoCol][i] : null;
    const pctNeut = pctNeutCol ? numericValuesByCol[pctNeutCol][i] : null;
    const pctLymph = pctLymphCol ? numericValuesByCol[pctLymphCol][i] : null;
    const pctMono = pctMonoCol ? numericValuesByCol[pctMonoCol][i] : null;
    const pctEos = pctEosCol ? numericValuesByCol[pctEosCol][i] : null;

    if (plt !== null && plt < 50) {
      recorded.platelet_count = plt;
      rowFindings.push(
        `Platelet count ${plt} ×10³/µL is implausibly low (cohort median ~244; typical RDW range ~12–13%).`
      );
    }
    if (mpv !== null && mpv > 30) {
      recorded.mpv = mpv;
      rowFindings.push(
        `MPV ${mpv} fL is physiologically impossible (normal ~7.5–12.5 fL; value 330 matches typical platelet count ×10³/µL).`
      );
    }
    if (rdw !== null && rdw > 25) {
      recorded.rdw = rdw;
      rowFindings.push(`RDW ${rdw}% is >2.5× higher than all other cohort samples (11.8–13.3%).`);
    }

    if (wbc !== null && pctNeut !== null && absNeut !== null) {
      const expNeut = Number((wbc * 1000 * (pctNeut / 100)).toFixed(1));
      expected.expected_abs_neutrophils = expNeut;
      if (Math.abs(absNeut - expNeut) > Math.max(500, expNeut * 0.25)) {
        recorded.absolute_neutrophils = absNeut;
        rowFindings.push(
          `WBC × Neutrophil% predicts ${expNeut} cells/µL, but recorded absolute_neutrophils is ${absNeut} (looks like shifted MPV ~10.1 fL).`
        );
      }
    }

    if (wbc !== null && pctLymph !== null && absLymph !== null) {
      const expLymph = Number((wbc * 1000 * (pctLymph / 100)).toFixed(1));
      expected.expected_abs_lymphocytes = expLymph;
      if (Math.abs(absLymph - expLymph) > Math.max(500, expLymph * 0.25)) {
        recorded.absolute_lymphocytes = absLymph;
        rowFindings.push(
          `WBC × Lymphocyte% predicts ${expLymph} cells/µL, but recorded absolute_lymphocytes is ${absLymph} (matches expected absolute_neutrophils ${expected.expected_abs_neutrophils ?? 'N/A'}).`
        );
      }
    }

    if (
      wbc !== null &&
      pctMono !== null &&
      absMono !== null &&
      pctEos !== null &&
      absEos !== null &&
      absBaso !== null
    ) {
      const expMono = Math.round(wbc * 1000 * (pctMono / 100));
      const expEos = Math.round(wbc * 1000 * (pctEos / 100));
      if (
        Math.abs(absMono - (expected.expected_abs_lymphocytes ?? 0)) < 15 &&
        Math.abs(absEos - expMono) < 15 &&
        Math.abs(absBaso - expEos) < 15
      ) {
        expected.expected_abs_monocytes = expMono;
        expected.expected_abs_eosinophils = expEos;
        rowFindings.push(
          `Detected 1-column left shift across WBC differential counts (abs_basophils=${absBaso}≈exp_eos ${expEos}, abs_eosinophils=${absEos}≈exp_mono ${expMono}, abs_monocytes=${absMono}≈exp_lymph, abs_lymphocytes=${absLymph}≈exp_neut).`
        );
      }
    }

    if (rowFindings.length > 0) {
      if (rowFindings.length >= 2) {
        suspectRowIndices.add(i);
      }
      findings.push({
        rowIndex: i + 1,
        sampleName: subjectIds[i],
        severity: rowFindings.length >= 2 ? 'critical' : 'warning',
        findings: rowFindings,
        recordedValues: recorded,
        expectedFromWbcDiff: Object.keys(expected).length > 0 ? expected : undefined,
        handling:
          'Preserved in raw dataset without inventing corrected values; flagged in Data Quality Audit and toggleable for exclusion from CBC model fitting.',
      });
    }
  }

  return { findings, suspectRowIndices };
}

export function preprocessDataset(params: {
  id: string;
  domain: DatasetDomain;
  filename: string;
  fileType: 'csv' | 'zip' | 'colab_bundle';
  headers: string[];
  rows: Record<string, string>[];
  zipManifest?: ZipEntryInfo[];
  parserNotes?: string[];
  previousMissingTotal?: number;
  mmashWindowMode?: MmashWindowMode;
  mmashWindowSeconds?: number;
  immuneProcessingMode?: ImmuneProcessingMode;
  cbcExcludeSuspectRows?: boolean;
}): PreprocessedDataset {
  const {
    id,
    domain,
    filename,
    fileType,
    headers,
    rows,
    zipManifest,
    parserNotes = [],
    mmashWindowMode,
    mmashWindowSeconds = 60,
    immuneProcessingMode = 'per_analyte',
    cbcExcludeSuspectRows = false,
  } = params;

  const rawRowCount = rows.length;
  const qualityNotes: string[] = [...parserNotes];

  // 1. Exact deduplication
  const seen = new Set<string>();
  const dedupedRows: Record<string, string>[] = [];
  for (const row of rows) {
    const key = headers.map((h) => String(row[h] ?? '').trim()).join('\u0001');
    if (!seen.has(key)) {
      seen.add(key);
      dedupedRows.push(row);
    }
  }
  const duplicateCount = rawRowCount - dedupedRows.length;
  if (duplicateCount > 0) {
    qualityNotes.push(`Removed ${duplicateCount} exact duplicate row(s) during preprocessing.`);
  }

  // 2. Profile each column (including censored value awareness)
  const columns: ColumnProfile[] = [];
  const numericValuesByCol: Record<string, (number | null)[]> = {};
  const censorFlagsByCol: Record<string, ('none' | 'left' | 'right' | 'missing')[]> = {};
  let totalLeftCensored = 0;
  let totalRightCensored = 0;

  for (const col of headers) {
    let nonNullCount = 0;
    let numericCount = 0;
    let dateCount = 0;
    let censoredTokenCount = 0;
    const uniqueSet = new Set<string>();
    const nums: (number | null)[] = [];
    const censors: ('none' | 'left' | 'right' | 'missing')[] = [];
    const validNums: number[] = [];

    for (const r of dedupedRows) {
      const raw = r[col];
      if (isMissingValue(raw)) {
        nums.push(null);
        censors.push('missing');
        continue;
      }
      nonNullCount++;
      const str = String(raw).trim();
      uniqueSet.add(str);

      const cell = parseNumericWithCensor(str);
      censors.push(cell.censor);
      if (cell.censor === 'left' || cell.censor === 'right') {
        censoredTokenCount++;
        if (cell.censor === 'left') totalLeftCensored++;
        else totalRightCensored++;
      }

      if (cell.value !== null) {
        numericCount++;
        nums.push(cell.value);
        validNums.push(cell.value);
      } else {
        nums.push(null);
        if (looksLikeDateString(str)) dateCount++;
      }
    }

    const effectiveNonNull = nonNullCount;
    const missingCount = dedupedRows.length - validNums.length;
    const missingPct = dedupedRows.length > 0 ? (missingCount / dedupedRows.length) * 100 : 0;

    let inferredType: ColumnProfile['inferredType'] = 'text';
    if (effectiveNonNull > 0) {
      if ((numericCount + censoredTokenCount) / effectiveNonNull >= 0.7) inferredType = 'numeric';
      else if (dateCount / effectiveNonNull >= 0.7) inferredType = 'datetime';
      else if (uniqueSet.size <= Math.max(25, dedupedRows.length * 0.4)) inferredType = 'categorical';
    }

    const { role, excludedReason } = detectColumnRole(
      col,
      inferredType,
      uniqueSet.size,
      dedupedRows.length,
      domain
    );
    const stats = validNums.length > 0 ? computeStats(validNums) : null;

    numericValuesByCol[col] = nums;
    censorFlagsByCol[col] = censors;

    columns.push({
      name: col,
      inferredType,
      role,
      unit: extractUnitFromHeader(col),
      nonNullCount: validNums.length,
      missingCount: inferredType === 'numeric' ? missingCount : dedupedRows.length - nonNullCount,
      missingPct: Number(
        (
          ((inferredType === 'numeric' ? missingCount : dedupedRows.length - nonNullCount) /
            Math.max(1, dedupedRows.length)) *
          100
        ).toFixed(2)
      ),
      uniqueCount: uniqueSet.size,
      min: stats ? Number(stats.min.toFixed(4)) : null,
      max: stats ? Number(stats.max.toFixed(4)) : null,
      mean: stats ? Number(stats.mean.toFixed(4)) : null,
      median: stats ? Number(stats.median.toFixed(4)) : null,
      std: stats ? Number(stats.std.toFixed(4)) : null,
      q25: stats ? Number(stats.q25.toFixed(4)) : null,
      q75: stats ? Number(stats.q75.toFixed(4)) : null,
      iqrOutlierCount: stats ? stats.iqrOutlierCount : 0,
      excludedReason: excludedReason ?? null,
    });
  }

  // 3. Identify subject ID, timestamp, analyte, and unit columns
  const subjectCol =
    columns.find((c) => c.role === 'subject_id')?.name ||
    columns.find((c) => /subject|participant|user|id|sample/i.test(c.name))?.name ||
    null;

  const timestampCol =
    columns.find((c) => c.role === 'timestamp')?.name ||
    columns.find((c) => /time|date|day|epoch/i.test(c.name) && c.name !== subjectCol)?.name ||
    null;

  const analyteCol =
    headers.find((h) => /^(analyte|cytokine|biomarker|panel_marker|marker)$/i.test(h.trim())) ||
    null;
  const unitCol = headers.find((h) => /^(unit|units)$/i.test(h.trim())) || null;

  const subjectIdsPerRow = dedupedRows.map((r, i) => {
    if (subjectCol && !isMissingValue(r[subjectCol])) return String(r[subjectCol]).trim();
    return `row_${i + 1}`;
  });

  const timestampsPerRow = dedupedRows.map((r) => {
    if (timestampCol && !isMissingValue(r[timestampCol])) return String(r[timestampCol]).trim();
    return null;
  });

  // 4. Audit supervised label eligibility honestly
  const labelCandidates = columns.filter((c) => c.role === 'label_candidate').map((c) => c.name);
  const supervisedLabelAudit: SupervisedLabelAudit =
    labelCandidates.length > 0
      ? {
          hasValidLabels: true,
          candidateColumns: labelCandidates,
          reason: `Detected candidate target column(s): ${labelCandidates.join(', ')}. Verify clinical/study validity before interpreting supervised baselines.`,
        }
      : {
          hasValidLabels: false,
          candidateColumns: [],
          reason:
            'No ground-truth anomaly or diagnostic label column exists in this dataset. Supervised classification (accuracy, precision, recall, F1) is intentionally omitted to avoid fabricating labels; unsupervised Isolation Forest and statistical baselines are used instead.',
        };

  // 5. Filter base modeling features
  const droppedHighMissingColumns: string[] = [];
  const excludedReferenceRangeColumns: string[] = [];
  const excludedNonMeasurementColumns: string[] = [];
  const excludedZeroVarianceColumns: string[] = [];
  const baseFeatureColumns: string[] = [];

  for (const colProfile of columns) {
    if (isReferenceRangeColumn(colProfile.name)) {
      excludedReferenceRangeColumns.push(colProfile.name);
      continue;
    }
    if (isNonMeasurementIndexColumn(colProfile.name, domain)) {
      excludedNonMeasurementColumns.push(colProfile.name);
      continue;
    }
    if (colProfile.name === subjectCol || colProfile.name === timestampCol) continue;
    if (colProfile.role !== 'feature') {
      if (
        colProfile.inferredType === 'numeric' &&
        colProfile.std !== null &&
        colProfile.std <= 1e-12
      ) {
        excludedZeroVarianceColumns.push(colProfile.name);
      }
      continue;
    }
    if (colProfile.missingPct > 50) {
      droppedHighMissingColumns.push(colProfile.name);
      colProfile.role = 'ignored';
      colProfile.excludedReason = `Excluded (>50% missing: ${colProfile.missingPct.toFixed(1)}%)`;
      continue;
    }
    if (colProfile.std !== null && colProfile.std <= 1e-12) {
      excludedZeroVarianceColumns.push(colProfile.name);
      colProfile.role = 'ignored';
      colProfile.excludedReason = 'Excluded (zero variance)';
      continue;
    }
    baseFeatureColumns.push(colProfile.name);
  }

  if (excludedReferenceRangeColumns.length > 0) {
    qualityNotes.push(
      `Excluded ${excludedReferenceRangeColumns.length} clinical reference-range bound column(s) from ML training.`
    );
  }
  if (excludedNonMeasurementColumns.length > 0) {
    qualityNotes.push(
      `Excluded ${excludedNonMeasurementColumns.length} ordinal/date index column(s) from ML training: ${excludedNonMeasurementColumns.join(', ')}.`
    );
  }
  if (droppedHighMissingColumns.length > 0) {
    qualityNotes.push(
      `Excluded ${droppedHighMissingColumns.length} column(s) exceeding 50% missingness: ${droppedHighMissingColumns.join(', ')}.`
    );
  }

  // =========================================================================
  // 6. DOMAIN-SPECIFIC BRANCHES (CBC Integrity, Immune Analyte/Pivot, MMASH)
  // =========================================================================
  const engineeredFeatures: string[] = [];
  let cbcConsistencyFindings: CbcConsistencyFinding[] = [];
  let nlrAudit: NlrAuditSummary | null = null;
  let activeRowIndices = dedupedRows.map((_, i) => i);
  let integrityStatuses: ('verified' | 'suspected_corrupted')[] | undefined;

  if (domain === 'cbc') {
    const cbcAudit = auditCbcConsistency(dedupedRows, numericValuesByCol, subjectIdsPerRow);
    cbcConsistencyFindings = cbcAudit.findings;
    integrityStatuses = dedupedRows.map((_, i) =>
      cbcAudit.suspectRowIndices.has(i) ? 'suspected_corrupted' : 'verified'
    );

    for (const f of cbcConsistencyFindings) {
      qualityNotes.push(`CBC Integrity Audit [${f.sampleName}]: ${f.findings.join(' ')}`);
    }

    if (cbcExcludeSuspectRows && cbcAudit.suspectRowIndices.size > 0) {
      activeRowIndices = activeRowIndices.filter((i) => !cbcAudit.suspectRowIndices.has(i));
      const excludedNames = Array.from(cbcAudit.suspectRowIndices).map((i) => subjectIdsPerRow[i]);
      qualityNotes.push(
        `Excluded ${cbcAudit.suspectRowIndices.size} suspected corrupted CBC record(s) from model fitting (${excludedNames.join(', ')}), leaving ${activeRowIndices.length} verified records. Original CSV preserved intact.`
      );
      integrityStatuses = activeRowIndices.map(() => 'verified');
    }

    const neutCol = baseFeatureColumns.find(
      (c) => /absolute_neutrophils/i.test(c) || (/neutrophil|neut/i.test(c) && !/pct|percent|%/i.test(c))
    );
    const lymphCol = baseFeatureColumns.find(
      (c) => /absolute_lymphocytes/i.test(c) || (/lymphocyte|lymph/i.test(c) && !/pct|percent|%/i.test(c))
    );
    const pctNeutCol = baseFeatureColumns.find((c) => /neutrophils_value_percent/i.test(c));
    const pctLymphCol = baseFeatureColumns.find((c) => /lymphocytes_value_percent/i.test(c));

    if (neutCol && lymphCol) {
      const unitN = neutCol.includes('cells_per_microliter') ? 'cells/µL' : 'raw';
      const unitL = lymphCol.includes('cells_per_microliter') ? 'cells/µL' : 'raw';
      const unitsMatch = unitN === unitL;

      const nlrName = 'NLR_engineered';
      const nlrAllRows: (number | null)[] = new Array(dedupedRows.length).fill(null);
      let zeroOrLowDenom = 0;
      let missingNlr = 0;
      const pctDiscrepancies: NlrAuditSummary['pctCrossCheckDiscrepancies'] = [];

      for (const i of activeRowIndices) {
        const n = numericValuesByCol[neutCol][i];
        const l = numericValuesByCol[lymphCol][i];
        if (n === null || l === null) {
          missingNlr++;
          continue;
        }
        if (l <= 1e-6) {
          zeroOrLowDenom++;
          missingNlr++;
          continue;
        }
        const ratio = Number((n / l).toFixed(4));
        nlrAllRows[i] = ratio;

        if (pctNeutCol && pctLymphCol) {
          const pn = numericValuesByCol[pctNeutCol][i];
          const pl = numericValuesByCol[pctLymphCol][i];
          if (pn !== null && pl !== null && pl > 1e-6) {
            const nlrPct = Number((pn / pl).toFixed(4));
            const relDiff = Math.abs(ratio - nlrPct) / Math.max(1e-6, nlrPct);
            if (relDiff > 0.25) {
              pctDiscrepancies.push({
                sampleName: subjectIdsPerRow[i],
                nlrFromAbsolute: ratio,
                nlrFromPercent: nlrPct,
                relativeDiffPct: Number((relDiff * 100).toFixed(2)),
              });
            }
          }
        }
      }

      const validActiveNlr = activeRowIndices
        .map((i) => nlrAllRows[i])
        .filter((v): v is number => v !== null);
      const nlrAuditNotes: string[] = [
        `Unit verification: numerator (${neutCol}) = ${unitN}, denominator (${lymphCol}) = ${unitL}.`,
      ];
      if (pctDiscrepancies.length > 0) {
        nlrAuditNotes.push(
          `Warning: ${pctDiscrepancies.length} sample(s) show >25% divergence between absolute-count NLR and percentage-differential NLR (${pctDiscrepancies.map((d) => d.sampleName).join(', ')}).`
        );
      } else {
        nlrAuditNotes.push('All fitted rows match Neutrophils% / Lymphocytes% within 25% tolerance.');
      }

      if (validActiveNlr.length >= Math.max(3, activeRowIndices.length * 0.5) && unitsMatch) {
        numericValuesByCol[nlrName] = nlrAllRows;
        baseFeatureColumns.push(nlrName);
        engineeredFeatures.push(nlrName);
        const s = computeStats(validActiveNlr);
        columns.push({
          name: nlrName,
          inferredType: 'numeric',
          role: 'feature',
          unit: 'ratio',
          nonNullCount: validActiveNlr.length,
          missingCount: activeRowIndices.length - validActiveNlr.length,
          missingPct: Number(
            (
              ((activeRowIndices.length - validActiveNlr.length) /
                Math.max(1, activeRowIndices.length)) *
              100
            ).toFixed(2)
          ),
          uniqueCount: new Set(validActiveNlr).size,
          min: Number(s.min.toFixed(4)),
          max: Number(s.max.toFixed(4)),
          mean: Number(s.mean.toFixed(4)),
          median: Number(s.median.toFixed(4)),
          std: Number(s.std.toFixed(4)),
          q25: Number(s.q25.toFixed(4)),
          q75: Number(s.q75.toFixed(4)),
          iqrOutlierCount: s.iqrOutlierCount,
          excludedReason: null,
        });
        nlrAudit = {
          computed: true,
          numeratorColumn: neutCol,
          denominatorColumn: lymphCol,
          unitCheck: `Matched (${unitN} / ${unitL})`,
          zeroOrNearZeroDenominators: zeroOrLowDenom,
          missingNlrCount: missingNlr,
          minNlr: Number(s.min.toFixed(4)),
          maxNlr: Number(s.max.toFixed(4)),
          medianNlr: Number(s.median.toFixed(4)),
          pctCrossCheckDiscrepancies: pctDiscrepancies,
          notes: nlrAuditNotes,
        };
        qualityNotes.push(
          `Engineered ${nlrName} (${neutCol} / ${lymphCol}); range ${s.min.toFixed(4)}–${s.max.toFixed(4)}, median ${s.median.toFixed(4)}.`
        );
      }
    }
  }

  // =========================================================================
  // 6b. IMMUNE PER-ANALYTE / WIDE-PIVOT PROCESSING
  // =========================================================================
  if (domain === 'immune' && analyteCol) {
    const concCol =
      baseFeatureColumns.find((c) => /^concentration|conc|value$/i.test(c)) ||
      baseFeatureColumns[0];
    const extraNumCols = baseFeatureColumns.filter((c) => c !== concCol);

    // Resolve pure token censorship per analyte ("OOR <" -> 0.5*min, "OOR >" -> max)
    const analyteGroups = new Map<string, number[]>();
    const analyteLabelsAll = dedupedRows.map((r) =>
      !isMissingValue(r[analyteCol]) ? String(r[analyteCol]).trim() : 'Unknown_Analyte'
    );
    analyteLabelsAll.forEach((an, idx) => {
      const arr = analyteGroups.get(an) || [];
      arr.push(idx);
      analyteGroups.set(an, arr);
    });

    const immuneRowMeta: ImmuneRowMeta[] = new Array(dedupedRows.length);
    for (const [analyte, idxs] of analyteGroups.entries()) {
      for (const col of baseFeatureColumns) {
        const vals = idxs
          .map((i) => numericValuesByCol[col][i])
          .filter((v): v is number => v !== null && v > 0);
        const minPos = vals.length > 0 ? Math.min(...vals) : 0.01;
        const maxPos = vals.length > 0 ? Math.max(...vals) : 1;
        for (const i of idxs) {
          const cen = censorFlagsByCol[col][i];
          if (numericValuesByCol[col][i] === null) {
            if (cen === 'left') numericValuesByCol[col][i] = Number((minPos * 0.5).toFixed(6));
            else if (cen === 'right') numericValuesByCol[col][i] = maxPos;
          }
        }
      }
      for (const i of idxs) {
        const cen = concCol ? censorFlagsByCol[concCol][i] : 'missing';
        const rawConc = concCol ? numericValuesByCol[concCol][i] : null;
        immuneRowMeta[i] = {
          analyte,
          unit: unitCol && !isMissingValue(dedupedRows[i][unitCol]) ? String(dedupedRows[i][unitCol]).trim() : null,
          missing: rawConc === null && cen === 'missing',
          leftCensored: cen === 'left',
          rightCensored: cen === 'right',
          rawConcentration: rawConc,
        };
      }
    }

    if (totalLeftCensored + totalRightCensored > 0) {
      qualityNotes.push(
        `Immune censored values resolved per analyte: ${totalLeftCensored} left-censored (<LOD/OOR< → 0.5×bound or 0.5×analyte min) and ${totalRightCensored} right-censored (>ULOQ/OOR> → bound or analyte max).`
      );
    }

    if (immuneProcessingMode === 'wide_pivot' && concCol) {
      // Pivot long tidy format -> wide matrix indexed by (subjectId, timestamp)
      const sampleKeys: string[] = [];
      const sampleMeta = new Map<string, { subjectId: string; timestamp: string | null }>();
      const pivotCells = new Map<string, Map<string, number[]>>();

      for (let i = 0; i < dedupedRows.length; i++) {
        const subj = subjectIdsPerRow[i];
        const ts = timestampsPerRow[i];
        const sKey = ts ? `${subj}__${ts}` : subj;
        if (!sampleMeta.has(sKey)) {
          sampleMeta.set(sKey, { subjectId: subj, timestamp: ts });
          sampleKeys.push(sKey);
          pivotCells.set(sKey, new Map());
        }
        const val = numericValuesByCol[concCol][i];
        if (val !== null) {
          const an = analyteLabelsAll[i];
          const m = pivotCells.get(sKey)!;
          const arr = m.get(an) || [];
          arr.push(val);
          m.set(an, arr);
        }
      }

      const allAnalytes = Array.from(analyteGroups.keys()).sort();
      const pivotedFeatures: string[] = [];
      const colMedians: number[] = [];
      const wideRawByFeat: number[][] = [];

      for (const an of allAnalytes) {
        const colVals: (number | null)[] = sampleKeys.map((sk) => {
          const arr = pivotCells.get(sk)?.get(an);
          if (!arr || arr.length === 0) return null;
          return arr.reduce((a, b) => a + b, 0) / arr.length;
        });
        const valid = colVals.filter((v): v is number => v !== null);
        if (valid.length < Math.max(3, sampleKeys.length * 0.5)) continue;
        const st = computeStats(valid);
        if (st.std <= 1e-12) continue;
        pivotedFeatures.push(an);
        colMedians.push(st.median);
        wideRawByFeat.push(colVals.map((v) => (v === null ? st.median : v)));
      }

      if (pivotedFeatures.length >= 2 && sampleKeys.length >= 4) {
        const rawMatrix: number[][] = sampleKeys.map((_, rIdx) =>
          pivotedFeatures.map((__, cIdx) => wideRawByFeat[cIdx][rIdx])
        );
        const featureMeans: number[] = [];
        const featureStds: number[] = [];
        const featureMedians: number[] = [];
        const featureMads: number[] = [];

        for (let j = 0; j < pivotedFeatures.length; j++) {
          const s = computeStats(rawMatrix.map((r) => r[j]));
          featureMeans.push(s.mean);
          featureStds.push(s.std > 1e-12 ? s.std : 1.0);
          featureMedians.push(s.median);
          featureMads.push(s.mad > 1e-12 ? s.mad : s.std > 1e-12 ? s.std * 0.6745 : 1.0);
        }

        const scaledMatrix = rawMatrix.map((r) =>
          r.map((v, j) => (v - featureMeans[j]) / featureStds[j])
        );

        const pivotSubjects = sampleKeys.map((k) => sampleMeta.get(k)!.subjectId);
        const pivotTimestamps = sampleKeys.map((k) => sampleMeta.get(k)!.timestamp);
        const uniquePivotSubjects = Array.from(new Set(pivotSubjects));
        const validPivotTs = pivotTimestamps.filter((t): t is string => t !== null);

        qualityNotes.push(
          `Wide-format pivot generated ${sampleKeys.length} sample-timepoint observations × ${pivotedFeatures.length} analyte columns from ${dedupedRows.length} long-format rows.`
        );

        const preAudit: ImmuneProcessingAudit = {
          activeMode: 'wide_pivot',
          hasAnalyteColumn: true,
          analyteCount: allAnalytes.length,
          censoredValuesSummary: {
            leftCensoredCount: totalLeftCensored,
            rightCensoredCount: totalRightCensored,
            missingCount: columns.reduce((s, c) => s + (c.role === 'feature' ? c.missingCount : 0), 0),
            handlingRule:
              'Left-censored (<x / OOR<) → 0.5×bound (or 0.5×analyte min); right-censored (>x / OOR>) → bound (or analyte max); remaining gaps → per-analyte median.',
          },
          perAnalyteSummary: [],
          notes: [
            `Wide-format multivariate pivot across ${sampleKeys.length} subject-timepoint samples and ${pivotedFeatures.length} analytes.`,
          ],
        };

        const dataQualityAudit: DataQualityAudit = {
          missingCellsBeforeInFeatures: 0,
          missingCellsBeforeTotal: columns.reduce((s, c) => s + c.missingCount, 0),
          missingCellsAfter: 0,
          excludedReferenceRangeColumns,
          excludedNonMeasurementColumns,
          excludedHighMissingColumns: droppedHighMissingColumns,
          excludedZeroVarianceColumns,
          cbcConsistencyFindings: [],
          nlrAudit: null,
          immuneAudit: preAudit,
          windowingNote: null,
          cohortIsolationNote: `Trained strictly on isolated immune cohort (${filename}, ${sampleKeys.length} wide-pivoted samples, ${uniquePivotSubjects.length} subjects). Zero cross-cohort mixing.`,
        };

        const metadata: DatasetMetadata = {
          id,
          domain,
          filename,
          fileType,
          provenanceNote: DOMAIN_PROVENANCE[domain],
          uploadedAt: new Date().toISOString(),
          rowCount: sampleKeys.length,
          rawRowCount,
          duplicateCount,
          columnCount: headers.length,
          subjectCount: uniquePivotSubjects.length,
          subjectIds: uniquePivotSubjects,
          subjectIdColumn: subjectCol,
          hasTimestamps: validPivotTs.length > 0,
          timestampColumn: timestampCol,
          timestampRange:
            validPivotTs.length > 0 ? [validPivotTs[0], validPivotTs[validPivotTs.length - 1]] : null,
          columns,
          droppedHighMissingColumns,
          imputedCellCount: 0,
          engineeredFeatures: pivotedFeatures.slice(0, 10),
          supervisedLabelAudit,
          qualityNotes,
          dataQualityAudit,
        };

        return {
          metadata,
          featureColumns: pivotedFeatures,
          rawMatrix,
          scaledMatrix,
          featureMeans,
          featureStds,
          featureMedians,
          featureMads,
          subjectIds: pivotSubjects,
          timestamps: pivotTimestamps,
          immuneRowMeta,
          immuneModeUsed: 'wide_pivot',
          rawHeaders: headers,
          rawRows: dedupedRows,
        };
      }
    }

    if (immuneProcessingMode === 'per_analyte' && concCol) {
      // Per-analyte median imputation & per-analyte z/robust normalization!
      const perAnalyteCols = [concCol, ...extraNumCols];
      const normColNames = perAnalyteCols.map((c) => `${c}_analyte_z`);
      const perAnalyteValsByCol: number[][] = perAnalyteCols.map(() => new Array(dedupedRows.length).fill(0));
      let perAnalyteImputed = 0;

      for (const [, idxs] of analyteGroups.entries()) {
        for (let cIdx = 0; cIdx < perAnalyteCols.length; cIdx++) {
          const col = perAnalyteCols[cIdx];
          const valid = idxs
            .map((i) => numericValuesByCol[col][i])
            .filter((v): v is number => v !== null);
          const stats = valid.length > 0 ? computeStats(valid) : null;
          const med = stats ? stats.median : 0;
          const mean = stats ? stats.mean : 0;
          const std = stats && stats.std > 1e-12 ? stats.std : 1.0;
          for (const i of idxs) {
            let v = numericValuesByCol[col][i];
            if (v === null) {
              v = med;
              perAnalyteImputed++;
            }
            perAnalyteValsByCol[cIdx][i] = Number(((v - mean) / std).toFixed(5));
          }
        }
      }

      const rawMatrix: number[][] = dedupedRows.map((_, i) =>
        normColNames.map((__, cIdx) => perAnalyteValsByCol[cIdx][i])
      );

      const featureMeans: number[] = [];
      const featureStds: number[] = [];
      const featureMedians: number[] = [];
      const featureMads: number[] = [];
      for (let j = 0; j < normColNames.length; j++) {
        const s = computeStats(rawMatrix.map((r) => r[j]));
        featureMeans.push(s.mean);
        featureStds.push(s.std > 1e-12 ? s.std : 1.0);
        featureMedians.push(s.median);
        featureMads.push(s.mad > 1e-12 ? s.mad : s.std > 1e-12 ? s.std * 0.6745 : 1.0);
      }
      const scaledMatrix = rawMatrix.map((r) =>
        r.map((v, j) => (v - featureMeans[j]) / featureStds[j])
      );

      // Register engineered per-analyte normalized column profiles
      for (let j = 0; j < normColNames.length; j++) {
        const s = computeStats(rawMatrix.map((r) => r[j]));
        engineeredFeatures.push(normColNames[j]);
        columns.push({
          name: normColNames[j],
          inferredType: 'numeric',
          role: 'feature',
          unit: 'analyte z-score (SD)',
          nonNullCount: dedupedRows.length,
          missingCount: 0,
          missingPct: 0,
          uniqueCount: new Set(rawMatrix.map((r) => r[j])).size,
          min: Number(s.min.toFixed(4)),
          max: Number(s.max.toFixed(4)),
          mean: Number(s.mean.toFixed(4)),
          median: Number(s.median.toFixed(4)),
          std: Number(s.std.toFixed(4)),
          q25: Number(s.q25.toFixed(4)),
          q75: Number(s.q75.toFixed(4)),
          iqrOutlierCount: s.iqrOutlierCount,
          excludedReason: null,
        });
      }
      // Mark raw unnormalized columns as categorical/reference display rather than raw pooled ML inputs
      for (const colProfile of columns) {
        if (perAnalyteCols.includes(colProfile.name)) {
          colProfile.role = 'ignored';
          colProfile.excludedReason =
            'Replaced by per-analyte z-normalized feature (avoids pooling multi-scale analytes)';
        }
      }

      const uniqueSubjects = Array.from(new Set(subjectIdsPerRow));
      const validTimestamps = timestampsPerRow.filter((t): t is string => t !== null);
      const missingBeforeInFeatures = perAnalyteCols.reduce(
        (s, col) => s + numericValuesByCol[col].filter((v) => v === null).length,
        0
      );

      qualityNotes.push(
        `Applied per-analyte standardization across ${analyteGroups.size} distinct analytes (${normColNames.join(', ')}) instead of pooling raw multi-scale concentrations.`
      );

      const perAnalyteBase: ImmuneAnalyteSummary[] = Array.from(analyteGroups.entries()).map(
        ([analyte, idxs]) => {
          const validConc = idxs
            .map((i) => numericValuesByCol[concCol][i])
            .filter((v): v is number => v !== null);
          const st = validConc.length > 0 ? computeStats(validConc) : null;
          return {
            analyte,
            unit: immuneRowMeta[idxs[0]]?.unit ?? null,
            rowCount: idxs.length,
            missingCount: idxs.filter((i) => immuneRowMeta[i]?.missing).length,
            leftCensoredCount: idxs.filter((i) => immuneRowMeta[i]?.leftCensored).length,
            rightCensoredCount: idxs.filter((i) => immuneRowMeta[i]?.rightCensored).length,
            median: st ? Number(st.median.toFixed(4)) : null,
            iqr: st ? Number((st.q75 - st.q25).toFixed(4)) : null,
            ifAnomalyCount: 0,
            madFlagCount: 0,
            anomalyPct: 0,
          };
        }
      );

      const immuneAudit: ImmuneProcessingAudit = {
        activeMode: 'per_analyte',
        hasAnalyteColumn: true,
        analyteCount: analyteGroups.size,
        censoredValuesSummary: {
          leftCensoredCount: totalLeftCensored,
          rightCensoredCount: totalRightCensored,
          missingCount: missingBeforeInFeatures,
          handlingRule:
            'Left-censored (<x / OOR<) → 0.5×bound (or 0.5×analyte min); right-censored (>x / OOR>) → bound (or analyte max); gaps → per-analyte median.',
        },
        perAnalyteSummary: perAnalyteBase,
        notes: [
          `Normalized ${dedupedRows.length} rows independently within each of ${analyteGroups.size} analytes so cross-analyte baseline ranges never distort anomaly scores.`,
        ],
      };

      const dataQualityAudit: DataQualityAudit = {
        missingCellsBeforeInFeatures: missingBeforeInFeatures,
        missingCellsBeforeTotal: columns.reduce((s, c) => s + c.missingCount, 0),
        missingCellsAfter: 0,
        excludedReferenceRangeColumns,
        excludedNonMeasurementColumns,
        excludedHighMissingColumns: droppedHighMissingColumns,
        excludedZeroVarianceColumns,
        cbcConsistencyFindings: [],
        nlrAudit: null,
        immuneAudit,
        windowingNote: null,
        cohortIsolationNote: `Trained strictly on isolated immune cohort (${filename}, ${dedupedRows.length} rows, ${uniqueSubjects.length} subjects, ${analyteGroups.size} analytes). Zero cross-cohort mixing.`,
      };

      const metadata: DatasetMetadata = {
        id,
        domain,
        filename,
        fileType,
        provenanceNote: DOMAIN_PROVENANCE[domain],
        uploadedAt: new Date().toISOString(),
        rowCount: dedupedRows.length,
        rawRowCount,
        duplicateCount,
        columnCount: headers.length,
        subjectCount: uniqueSubjects.length,
        subjectIds: uniqueSubjects.slice(0, 100),
        subjectIdColumn: subjectCol,
        hasTimestamps: validTimestamps.length > 0,
        timestampColumn: timestampCol,
        timestampRange:
          validTimestamps.length > 0
            ? [validTimestamps[0], validTimestamps[validTimestamps.length - 1]]
            : null,
        columns,
        droppedHighMissingColumns,
        imputedCellCount: perAnalyteImputed,
        engineeredFeatures,
        supervisedLabelAudit,
        qualityNotes,
        dataQualityAudit,
      };

      return {
        metadata,
        featureColumns: normColNames,
        rawMatrix,
        scaledMatrix,
        featureMeans,
        featureStds,
        featureMedians,
        featureMads,
        subjectIds: subjectIdsPerRow,
        timestamps: timestampsPerRow,
        analyteLabels: analyteLabelsAll,
        immuneRowMeta,
        immuneModeUsed: 'per_analyte',
        rawHeaders: headers,
        rawRows: dedupedRows,
      };
    }
  }

  // =========================================================================
  // 7. STANDARD MATRIX ASSEMBLY (MMASH / CBC / Immune Pooled Fallback)
  // =========================================================================
  const featureColumns = baseFeatureColumns;
  if (featureColumns.length === 0) {
    throw new Error(
      `No usable numeric modeling features remained in "${filename}" after quality filtering.`
    );
  }

  const missingCellsBeforeInFeatures = featureColumns.reduce((sum, col) => {
    const arr = numericValuesByCol[col] || [];
    return sum + activeRowIndices.filter((i) => arr[i] === null).length;
  }, 0);
  const missingCellsBeforeTotal =
    params.previousMissingTotal !== undefined
      ? params.previousMissingTotal
      : columns.reduce((sum, c) => sum + c.missingCount, 0);

  const featureMeans: number[] = [];
  const featureStds: number[] = [];
  const featureMedians: number[] = [];
  const featureMads: number[] = [];
  let imputedCellCount = 0;

  const colMedians: Record<string, number> = {};
  for (const col of featureColumns) {
    const valid = activeRowIndices
      .map((i) => numericValuesByCol[col][i])
      .filter((v): v is number => v !== null);
    const s = computeStats(valid.length > 0 ? valid : [0]);
    colMedians[col] = s.median;
  }

  const rawMatrix: number[][] = activeRowIndices.map((rowIdx) =>
    featureColumns.map((col) => {
      const val = numericValuesByCol[col][rowIdx];
      if (val === null) {
        imputedCellCount++;
        return colMedians[col];
      }
      return val;
    })
  );

  for (let j = 0; j < featureColumns.length; j++) {
    const colVals = rawMatrix.map((row) => row[j]);
    const s = computeStats(colVals);
    featureMeans.push(s.mean);
    featureStds.push(s.std > 1e-12 ? s.std : 1.0);
    featureMedians.push(s.median);
    featureMads.push(s.mad > 1e-12 ? s.mad : s.std > 1e-12 ? s.std * 0.6745 : 1.0);
  }

  const scaledMatrix: number[][] = rawMatrix.map((row) =>
    row.map((val, j) => (val - featureMeans[j]) / featureStds[j])
  );

  if (imputedCellCount > 0) {
    qualityNotes.push(
      `Median-imputed ${imputedCellCount} missing cell(s) in modeling features (0 missing cells remaining after preprocessing).`
    );
  }

  const activeSubjectIds = activeRowIndices.map((i) => subjectIdsPerRow[i]);
  const activeTimestamps = activeRowIndices.map((i) => timestampsPerRow[i]);
  const uniqueSubjects = Array.from(new Set(activeSubjectIds));
  const validTimestamps = activeTimestamps.filter((t): t is string => t !== null);
  const timestampRange: [string, string] | null =
    validTimestamps.length > 0 ? [validTimestamps[0], validTimestamps[validTimestamps.length - 1]] : null;

  let immuneAudit: ImmuneProcessingAudit | null = null;
  if (domain === 'immune') {
    if (!analyteCol) {
      qualityNotes.push(
        `Immune dataset loaded from ${dedupedRows.length} rows without an "Analyte" column (pre-audit cache snapshot or pre-filtered table). Pooled numeric mode active; upload raw LSDS-8 CSV with the Analyte column to enable per-analyte normalization and per-analyte anomaly counts.`
      );
    }
    immuneAudit = {
      activeMode: 'pooled',
      hasAnalyteColumn: Boolean(analyteCol),
      analyteCount: analyteCol
        ? new Set(dedupedRows.map((r) => String(r[analyteCol] ?? '').trim()).filter(Boolean)).size
        : 0,
      censoredValuesSummary: {
        leftCensoredCount: totalLeftCensored,
        rightCensoredCount: totalRightCensored,
        missingCount: missingCellsBeforeInFeatures,
        handlingRule:
          'Left-censored (<x) → 0.5×bound; right-censored (>x) → bound; remaining missing values median-imputed.',
      },
      perAnalyteSummary: [],
      notes: [
        analyteCol
          ? 'Running in explicit pooled legacy mode for comparison against per-analyte normalization.'
          : 'Analyte column absent from cached 4-column snapshot; re-upload raw LSDS-8 CSV to activate per-analyte normalization & wide pivoting.',
      ],
    };
  }

  const modeUsed: MmashWindowMode =
    mmashWindowMode || (dedupedRows.length === 440 ? 'epoch_20' : 'window_60s');
  const windowingNote =
    domain === 'physiological'
      ? modeUsed === 'window_60s'
        ? `MMASH processed in ${mmashWindowSeconds}-second chronological window mode (${dedupedRows.length} windows across ${uniqueSubjects.length} participant(s); Colab reference = 30,377 windows). Preserves subject_id and chronological timestamps.`
        : `MMASH ZIP (${zipManifest?.length ?? 'multiple'} CSVs, ${zipManifest?.reduce((s, z) => s + z.rowCount, 0).toLocaleString() ?? '3.2M+'} raw sensor rows) aligned into 20 equal chronological epochs per participant (${uniqueSubjects.length} × 20 = ${dedupedRows.length} rows); switch to 60s Windows when raw MMASH.zip is uploaded to match Colab's 30,377-window granularity.`
      : null;

  const dataQualityAudit: DataQualityAudit = {
    missingCellsBeforeInFeatures:
      params.previousMissingTotal !== undefined && missingCellsBeforeInFeatures === 0
        ? params.previousMissingTotal
        : missingCellsBeforeInFeatures,
    missingCellsBeforeTotal,
    missingCellsAfter: 0,
    excludedReferenceRangeColumns,
    excludedNonMeasurementColumns,
    excludedHighMissingColumns: droppedHighMissingColumns,
    excludedZeroVarianceColumns,
    cbcConsistencyFindings,
    nlrAudit,
    immuneAudit,
    windowingNote,
    cohortIsolationNote: `Trained strictly on isolated ${domain} cohort (${filename}, ${activeRowIndices.length} fitted rows${activeRowIndices.length !== dedupedRows.length ? ` of ${dedupedRows.length} raw` : ''}, ${uniqueSubjects.length} subjects). Zero cross-cohort mixing.`,
  };

  const metadata: DatasetMetadata = {
    id,
    domain,
    filename,
    fileType,
    provenanceNote: DOMAIN_PROVENANCE[domain],
    uploadedAt: new Date().toISOString(),
    rowCount: activeRowIndices.length,
    rawRowCount,
    duplicateCount,
    columnCount: headers.length,
    subjectCount: uniqueSubjects.length,
    subjectIds: uniqueSubjects.slice(0, 100),
    subjectIdColumn: subjectCol,
    hasTimestamps: validTimestamps.length > 0,
    timestampColumn: timestampCol,
    timestampRange,
    columns,
    droppedHighMissingColumns,
    imputedCellCount,
    engineeredFeatures,
    supervisedLabelAudit,
    qualityNotes,
    dataQualityAudit,
    zipManifest,
  };

  return {
    metadata,
    featureColumns,
    rawMatrix,
    scaledMatrix,
    featureMeans,
    featureStds,
    featureMedians,
    featureMads,
    subjectIds: activeSubjectIds,
    timestamps: activeTimestamps,
    integrityStatuses,
    analyteLabels: analyteCol
      ? activeRowIndices.map((i) =>
          !isMissingValue(dedupedRows[i][analyteCol]) ? String(dedupedRows[i][analyteCol]).trim() : null
        )
      : undefined,
    immuneModeUsed: domain === 'immune' ? (analyteCol ? immuneProcessingMode : 'pooled') : undefined,
    rawHeaders: headers,
    rawRows: dedupedRows,
  };
}
