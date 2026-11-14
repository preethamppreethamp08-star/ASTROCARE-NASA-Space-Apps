import fs from 'fs';
import path from 'path';
import { parseUploadedFile } from './parser.ts';
import { preprocessDataset, type PreprocessedDataset } from './preprocessing.ts';
import { runDomainMLAnalysis } from './isolationForest.ts';
import type {
  AnalyzedObservation,
  CbcIntegrityComparison,
  CbcModelSnapshotMetrics,
  DatasetDomain,
  DatasetMetadata,
  DomainAnalysisResult,
  ImmuneAnalyteSummary,
  ImmuneProcessingMode,
  MmashWindowComparison,
  MmashWindowMode,
  PipelineConfig,
  SimulationEvent,
  SimulationState,
} from './types.ts';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'cache');
const UPLOADS_DIR = path.join(CACHE_DIR, 'uploads');
const CACHE_FILE = path.join(CACHE_DIR, 'astrocare_datasets.json');
const COLAB_CACHE_FILE = path.join(CACHE_DIR, 'astrocare_colab_bundle.json');
const CONFIG_FILE = path.join(CACHE_DIR, 'astrocare_config.json');

interface PersistedDomainInput {
  id: string;
  domain: DatasetDomain;
  filename: string;
  fileType: 'csv' | 'zip' | 'colab_bundle';
  headers: string[];
  rows: Record<string, string>[];
  zipManifest?: DatasetMetadata['zipManifest'];
  parserNotes?: string[];
  previousMissingTotal?: number;
  rawUploadPath?: string;
}

function spearmanFromScores(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const rank = (arr: number[]) => {
    const indexed = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const r = new Array<number>(arr.length);
    let i = 0;
    while (i < indexed.length) {
      let j = i;
      while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[indexed[k].i] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs.slice(0, n));
  const ry = rank(ys.slice(0, n));
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - mx;
    const b = ry[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den > 1e-12 ? Number((num / den).toFixed(4)) : 0;
}

function buildCbcSnapshotMetrics(
  ds: PreprocessedDataset,
  res: DomainAnalysisResult
): CbcModelSnapshotMetrics {
  const nlrCol = ds.metadata.columns.find((c) => c.name === 'NLR_engineered');
  const mpvCol = ds.metadata.columns.find((c) => /(?:^|_)mpv(?:_|$)/i.test(c.name) && !/range/i.test(c.name));
  const pltCol = ds.metadata.columns.find((c) => /platelet_count/i.test(c.name) && !/range/i.test(c.name));

  // Recompute mean/std directly from active rows for exactness when suspect rows are excluded
  const computeActiveMeanStd = (colName?: string): { mean: number | null; std: number | null } => {
    if (!colName) return { mean: null, std: null };
    const idx = ds.featureColumns.indexOf(colName);
    if (idx === -1) return { mean: null, std: null };
    return {
      mean: Number(ds.featureMeans[idx].toFixed(3)),
      std: Number(ds.featureStds[idx].toFixed(3)),
    };
  };

  const mpvStats = computeActiveMeanStd(mpvCol?.name);
  const pltStats = computeActiveMeanStd(pltCol?.name);

  return {
    sampleCount: res.sampleCount,
    flaggedCount: res.anomalyCount,
    flaggedSamples: res.records.filter((r) => r.isAnomaly).map((r) => r.subjectId),
    thresholdScore: res.thresholdScore,
    nlrMin: nlrCol?.min ?? null,
    nlrMedian: nlrCol?.median ?? null,
    nlrMax: nlrCol?.max ?? null,
    mpvMean: mpvStats.mean,
    mpvStd: mpvStats.std,
    plateletMean: pltStats.mean,
    plateletStd: pltStats.std,
    seedSpearman: res.stabilityAnalysis.meanSpearmanRankCorr,
    seedJaccard: res.stabilityAnalysis.meanJaccardOverlap,
  };
}

class AstrocareStore {
  datasets: Partial<Record<DatasetDomain, PreprocessedDataset>> = {};
  colabImportedMetadata: Partial<Record<DatasetDomain, DatasetMetadata>> = {};
  analyses: Partial<Record<DatasetDomain, DomainAnalysisResult>> = {};
  persistedInputs: Partial<Record<DatasetDomain, PersistedDomainInput>> = {};
  pipelineConfig: PipelineConfig = {
    mmashWindowMode: 'epoch_20',
    mmashWindowSeconds: 60,
    immuneProcessingMode: 'per_analyte',
    cbcExcludeSuspectRows: false,
  };
  simulation: SimulationState = {
    running: false,
    domain: 'physiological',
    cursorIndex: 0,
    totalRecords: 0,
    intervalMs: 1000,
    startedAt: null,
    history: [],
    events: [],
  };
  private simTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.restoreFromDisk();
  }

  private saveToDisk() {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(this.persistedInputs));
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.pipelineConfig, null, 2));
      const colabDomains = Object.keys(this.colabImportedMetadata) as DatasetDomain[];
      if (colabDomains.length > 0) {
        const colabAnalyses: Partial<Record<DatasetDomain, DomainAnalysisResult>> = {};
        for (const d of colabDomains) {
          if (this.analyses[d]) colabAnalyses[d] = this.analyses[d];
        }
        fs.writeFileSync(
          COLAB_CACHE_FILE,
          JSON.stringify({ datasets: this.colabImportedMetadata, analyses: colabAnalyses })
        );
      } else if (fs.existsSync(COLAB_CACHE_FILE)) {
        fs.unlinkSync(COLAB_CACHE_FILE);
      }
    } catch (err) {
      console.error('[AstrocareStore] Failed to persist cache:', err);
    }
  }

  private saveRawBuffer(domain: DatasetDomain, filename: string, buffer: Buffer): string {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const ext = path.extname(filename) || '.dat';
    const targetPath = path.join(UPLOADS_DIR, `${domain}_raw${ext}`);
    fs.writeFileSync(targetPath, buffer);
    return targetPath;
  }

  private enrichCbcIntegrityComparison(
    entry: PersistedDomainInput,
    activeDs: PreprocessedDataset,
    activeRes: DomainAnalysisResult,
    contamination: number
  ) {
    if (!activeDs.metadata.dataQualityAudit) return;
    const suspectFindings = activeDs.metadata.dataQualityAudit.cbcConsistencyFindings;
    const suspectNames = suspectFindings
      .filter((f) => f.severity === 'critical')
      .map((f) => f.sampleName);

    if (suspectFindings.length === 0) {
      return;
    }

    const withDs = this.pipelineConfig.cbcExcludeSuspectRows
      ? preprocessDataset({
          ...entry,
          previousMissingTotal: entry.previousMissingTotal,
          cbcExcludeSuspectRows: false,
        })
      : activeDs;
    const withRes = this.pipelineConfig.cbcExcludeSuspectRows
      ? runDomainMLAnalysis(withDs, contamination)
      : activeRes;

    const withoutDs = this.pipelineConfig.cbcExcludeSuspectRows
      ? activeDs
      : preprocessDataset({
          ...entry,
          previousMissingTotal: entry.previousMissingTotal,
          cbcExcludeSuspectRows: true,
        });
    const withoutRes = this.pipelineConfig.cbcExcludeSuspectRows
      ? activeRes
      : runDomainMLAnalysis(withoutDs, contamination);

    const withMetrics = buildCbcSnapshotMetrics(withDs, withRes);
    const withoutMetrics = buildCbcSnapshotMetrics(withoutDs, withoutRes);

    const comparison: CbcIntegrityComparison = {
      excludeSuspectApplied: this.pipelineConfig.cbcExcludeSuspectRows,
      suspectSampleNames: suspectNames.length > 0 ? suspectNames : suspectFindings.map((f) => f.sampleName),
      verifiedRowCount: withoutDs.metadata.rowCount,
      suspectRowCount: Math.max(0, withDs.metadata.rowCount - withoutDs.metadata.rowCount),
      withSuspect: withMetrics,
      withoutSuspect: withoutMetrics,
      note:
        `With suspect record(s) included (${withMetrics.sampleCount} rows), Isolation Forest flags ${withMetrics.flaggedSamples.join(', ') || 'none'} with MPV std=${withMetrics.mpvStd} and NLR min=${withMetrics.nlrMin}. ` +
        `Excluding suspect record(s) (${withoutMetrics.sampleCount} verified rows) restores MPV std=${withoutMetrics.mpvStd}, NLR min=${withoutMetrics.nlrMin}, and flags ${withoutMetrics.flaggedSamples.join(', ') || 'none'}. Raw CSV remains untouched.`,
    };

    activeDs.metadata.dataQualityAudit.cbcIntegrityComparison = comparison;
  }

  private enrichImmuneAudit(
    entry: PersistedDomainInput,
    activeDs: PreprocessedDataset,
    activeRes: DomainAnalysisResult,
    contamination: number
  ) {
    const audit = activeDs.metadata.dataQualityAudit?.immuneAudit;
    if (!audit) return;

    const hasAnalyte = audit.hasAnalyteColumn;
    if (!hasAnalyte) {
      return;
    }

    // Populate per-analyte IF & MAD anomaly counts
    if (activeDs.immuneModeUsed === 'per_analyte' && activeDs.analyteLabels) {
      const countsByAnalyte = new Map<string, { ifCount: number; madCount: number; total: number }>();
      for (let i = 0; i < activeRes.records.length; i++) {
        const rec = activeRes.records[i];
        const an = activeDs.analyteLabels[i] || 'Unknown_Analyte';
        const cur = countsByAnalyte.get(an) || { ifCount: 0, madCount: 0, total: 0 };
        cur.total += 1;
        if (rec.isAnomaly) cur.ifCount += 1;
        if (rec.baselineFlag) cur.madCount += 1;
        countsByAnalyte.set(an, cur);
      }

      audit.perAnalyteSummary = audit.perAnalyteSummary
        .map((item): ImmuneAnalyteSummary => {
          const c = countsByAnalyte.get(item.analyte);
          const ifCount = c?.ifCount ?? 0;
          const madCount = c?.madCount ?? 0;
          const total = Math.max(1, item.rowCount);
          return {
            ...item,
            ifAnomalyCount: ifCount,
            madFlagCount: madCount,
            anomalyPct: Number(((ifCount / total) * 100).toFixed(2)),
          };
        })
        .sort((a, b) => b.ifAnomalyCount - a.ifAnomalyCount || b.madFlagCount - a.madFlagCount);
    }

    // Compare pooled vs per-analyte normalized vs wide-pivot
    const pooledDs =
      activeDs.immuneModeUsed === 'pooled'
        ? activeDs
        : preprocessDataset({ ...entry, immuneProcessingMode: 'pooled' });
    const pooledRes =
      activeDs.immuneModeUsed === 'pooled'
        ? activeRes
        : runDomainMLAnalysis(pooledDs, contamination);

    const normDs =
      activeDs.immuneModeUsed === 'per_analyte'
        ? activeDs
        : preprocessDataset({ ...entry, immuneProcessingMode: 'per_analyte' });
    const normRes =
      activeDs.immuneModeUsed === 'per_analyte'
        ? activeRes
        : runDomainMLAnalysis(normDs, contamination);

    const wideDs =
      activeDs.immuneModeUsed === 'wide_pivot'
        ? activeDs
        : preprocessDataset({ ...entry, immuneProcessingMode: 'wide_pivot' });

    const pooledSet = new Set(pooledRes.records.filter((r) => r.isAnomaly).map((r) => r.index));
    const normSet = new Set(normRes.records.filter((r) => r.isAnomaly).map((r) => r.index));
    let inter = 0;
    pooledSet.forEach((idx) => {
      if (normSet.has(idx)) inter++;
    });
    const union = new Set([...pooledSet, ...normSet]).size;
    const jaccardOverlap = union > 0 ? Number((inter / union).toFixed(4)) : 1;
    const spearmanRankCorr = spearmanFromScores(
      pooledRes.records.map((r) => r.anomalyScore),
      normRes.records.map((r) => r.anomalyScore)
    );
    const pooledMadFlags = pooledRes.records.filter((r) => r.baselineFlag).length;
    const normMadFlags = normRes.records.filter((r) => r.baselineFlag).length;

    audit.pooledVsNormalizedComparison = {
      pooledIfFlags: pooledRes.anomalyCount,
      pooledMadFlags,
      normalizedIfFlags: normRes.anomalyCount,
      normalizedMadFlags: normMadFlags,
      widePivotSampleCount: wideDs.immuneModeUsed === 'wide_pivot' ? wideDs.metadata.rowCount : undefined,
      widePivotFeatureCount:
        wideDs.immuneModeUsed === 'wide_pivot' ? wideDs.featureColumns.length : undefined,
      jaccardOverlap,
      spearmanRankCorr,
      note: `Unnormalized pooling produced ${pooledMadFlags} MAD baseline flags (skewed by high-abundance analytes) vs ${normMadFlags} MAD flags after per-analyte standardization. Flagged set Jaccard overlap between pooled and per-analyte IF = ${jaccardOverlap} (Spearman rho = ${spearmanRankCorr}).`,
    };
  }

  private enrichMmashWindowComparison(
    entry: PersistedDomainInput,
    activeDs: PreprocessedDataset
  ) {
    if (!activeDs.metadata.dataQualityAudit) return;
    const rawZipExists = Boolean(entry.rawUploadPath && fs.existsSync(entry.rawUploadPath));
    const keyFeatures = [
      'RR_HR_bpm_mean',
      'RR_SDNN_ms',
      'RR_RMSSD_ms',
      'Actigraph_HR_mean',
      'Actigraph_Steps_mean',
      'Actigraph_Vector Magnitude_mean',
      'sleep_Efficiency',
    ];

    let epoch20Ds: PreprocessedDataset | null =
      this.pipelineConfig.mmashWindowMode === 'epoch_20' ? activeDs : null;
    let window60Ds: PreprocessedDataset | null =
      this.pipelineConfig.mmashWindowMode === 'window_60s' ? activeDs : null;

    if (rawZipExists && entry.rawUploadPath) {
      const zipBuf = fs.readFileSync(entry.rawUploadPath);
      if (!epoch20Ds) {
        const parsedEp = parseUploadedFile(zipBuf, entry.filename, 'physiological', {
          mmashWindowMode: 'epoch_20',
        });
        epoch20Ds = preprocessDataset({
          id: entry.id,
          domain: 'physiological',
          filename: entry.filename,
          fileType: parsedEp.fileType,
          headers: parsedEp.headers,
          rows: parsedEp.rows,
          zipManifest: parsedEp.zipManifest,
          parserNotes: parsedEp.notes,
          mmashWindowMode: 'epoch_20',
        });
      }
      if (!window60Ds) {
        const parsed60 = parseUploadedFile(zipBuf, entry.filename, 'physiological', {
          mmashWindowMode: 'window_60s',
          windowSeconds: this.pipelineConfig.mmashWindowSeconds,
        });
        window60Ds = preprocessDataset({
          id: entry.id,
          domain: 'physiological',
          filename: entry.filename,
          fileType: parsed60.fileType,
          headers: parsed60.headers,
          rows: parsed60.rows,
          zipManifest: parsed60.zipManifest,
          parserNotes: parsed60.notes,
          mmashWindowMode: 'window_60s',
          mmashWindowSeconds: this.pipelineConfig.mmashWindowSeconds,
        });
      }
    }

    const featureDistributionComparisons = keyFeatures
      .filter(
        (f) =>
          epoch20Ds?.featureColumns.includes(f) || window60Ds?.featureColumns.includes(f)
      )
      .map((f) => {
        const epIdx = epoch20Ds ? epoch20Ds.featureColumns.indexOf(f) : -1;
        const wIdx = window60Ds ? window60Ds.featureColumns.indexOf(f) : -1;
        return {
          feature: f,
          epoch20Mean: epIdx >= 0 && epoch20Ds ? Number(epoch20Ds.featureMeans[epIdx].toFixed(3)) : null,
          epoch20Std: epIdx >= 0 && epoch20Ds ? Number(epoch20Ds.featureStds[epIdx].toFixed(3)) : null,
          window60sMean:
            wIdx >= 0 && window60Ds ? Number(window60Ds.featureMeans[wIdx].toFixed(3)) : null,
          window60sStd:
            wIdx >= 0 && window60Ds ? Number(window60Ds.featureStds[wIdx].toFixed(3)) : null,
        };
      });

    const w60Count = window60Ds?.metadata.rowCount;
    const ep20Count = epoch20Ds?.metadata.rowCount;
    const colabRef = 30377;

    const notes: string[] = [];
    if (rawZipExists && w60Count !== undefined) {
      const delta = w60Count - colabRef;
      notes.push(
        `60-second ZIP parser produced ${w60Count.toLocaleString()} chronological windows across ${window60Ds?.metadata.subjectCount} participants vs ${colabRef.toLocaleString()} Colab windows (delta ${delta >= 0 ? '+' : ''}${delta}).`
      );
      if (ep20Count !== undefined) {
        notes.push(
          `Alternative 20-epoch overview mode yields ${ep20Count} rows (${window60Ds?.metadata.subjectCount} × 20) — coarser temporal smoothing alters feature variance compared to 60s windows.`
        );
      }
    } else {
      notes.push(
        `Active state restored from 440-epoch cache (${ep20Count ?? activeDs.metadata.rowCount} rows, 22 × 20 epochs). Re-upload raw MMASH.zip in Data Management to run and validate 60-second chronological windows directly against the 30,377-window Colab benchmark.`
      );
    }

    const validationStatus: MmashWindowComparison['validationStatus'] = rawZipExists
      ? 'validated_against_zip'
      : this.pipelineConfig.mmashWindowMode === 'window_60s'
      ? 'awaiting_raw_zip'
      : 'epoch_20_overview';

    activeDs.metadata.dataQualityAudit.mmashWindowComparison = {
      activeMode: this.pipelineConfig.mmashWindowMode,
      windowSeconds: this.pipelineConfig.mmashWindowSeconds,
      rawZipAvailable: rawZipExists,
      colabReferenceWindows: colabRef,
      activeRowCount: activeDs.metadata.rowCount,
      activeSubjectCount: activeDs.metadata.subjectCount,
      epoch20RowCount: ep20Count,
      window60sRowCount: w60Count,
      deltaVsColabWindows: w60Count !== undefined ? w60Count - colabRef : null,
      validationStatus,
      featureDistributionComparisons,
      notes,
    };
  }

  private runAndEnrichDomain(
    domain: DatasetDomain,
    entry: PersistedDomainInput,
    contamination = 0.05
  ): { ds: PreprocessedDataset; res: DomainAnalysisResult } {
    let activeEntry = entry;
    if (
      domain === 'physiological' &&
      entry.rawUploadPath &&
      fs.existsSync(entry.rawUploadPath) &&
      entry.fileType === 'zip'
    ) {
      const buf = fs.readFileSync(entry.rawUploadPath);
      const parsed = parseUploadedFile(buf, entry.filename, 'physiological', {
        mmashWindowMode: this.pipelineConfig.mmashWindowMode,
        windowSeconds: this.pipelineConfig.mmashWindowSeconds,
      });
      activeEntry = {
        ...entry,
        headers: parsed.headers,
        rows: parsed.rows,
        zipManifest: parsed.zipManifest,
        parserNotes: parsed.notes,
      };
      this.persistedInputs[domain] = activeEntry;
    }

    const ds = preprocessDataset({
      id: activeEntry.id,
      domain,
      filename: activeEntry.filename,
      fileType: activeEntry.fileType,
      headers: activeEntry.headers,
      rows: activeEntry.rows,
      zipManifest: activeEntry.zipManifest,
      parserNotes: activeEntry.parserNotes,
      previousMissingTotal: activeEntry.previousMissingTotal,
      mmashWindowMode: this.pipelineConfig.mmashWindowMode,
      mmashWindowSeconds: this.pipelineConfig.mmashWindowSeconds,
      immuneProcessingMode: this.pipelineConfig.immuneProcessingMode,
      cbcExcludeSuspectRows: this.pipelineConfig.cbcExcludeSuspectRows,
    });

    const res = runDomainMLAnalysis(ds, contamination);

    if (domain === 'cbc') {
      this.enrichCbcIntegrityComparison(activeEntry, ds, res, contamination);
    } else if (domain === 'immune') {
      this.enrichImmuneAudit(activeEntry, ds, res, contamination);
    } else if (domain === 'physiological') {
      this.enrichMmashWindowComparison(activeEntry, ds);
    }

    this.datasets[domain] = ds;
    this.analyses[domain] = res;
    return { ds, res };
  }

  private restoreFromDisk() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as Partial<PipelineConfig>;
        this.pipelineConfig = { ...this.pipelineConfig, ...cfg };
      }
      if (fs.existsSync(CACHE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as Partial<
          Record<DatasetDomain, PersistedDomainInput>
        >;
        for (const domain of ['physiological', 'cbc', 'immune'] as DatasetDomain[]) {
          const entry = raw[domain];
          if (!entry || !entry.rows || entry.rows.length === 0) continue;
          this.persistedInputs[domain] = entry;
          this.runAndEnrichDomain(domain, entry, 0.05);
        }
      }
      if (fs.existsSync(COLAB_CACHE_FILE)) {
        const colab = JSON.parse(fs.readFileSync(COLAB_CACHE_FILE, 'utf-8')) as {
          datasets?: Partial<Record<DatasetDomain, DatasetMetadata>>;
          analyses?: Partial<Record<DatasetDomain, DomainAnalysisResult>>;
        };
        for (const domain of ['physiological', 'cbc', 'immune'] as DatasetDomain[]) {
          if (!this.datasets[domain] && colab.datasets?.[domain]) {
            this.colabImportedMetadata[domain] = colab.datasets[domain];
            if (colab.analyses?.[domain]) {
              this.analyses[domain] = colab.analyses[domain];
            }
          }
        }
      }
      console.log(
        `[AstrocareStore] Restored ${this.getAllMetadata().length} dataset(s) from cache.`
      );
    } catch (err) {
      console.error('[AstrocareStore] Cache restore skipped:', err);
    }
  }

  uploadAndPreprocess(
    buffer: Buffer,
    filename: string,
    domain: DatasetDomain,
    options?: {
      mmashWindowMode?: MmashWindowMode;
      mmashWindowSeconds?: number;
      immuneProcessingMode?: ImmuneProcessingMode;
      cbcExcludeSuspectRows?: boolean;
    }
  ): { metadata: DatasetMetadata; preview: Record<string, unknown>[] } {
    if (filename.toLowerCase().endsWith('.json')) {
      const parsed = JSON.parse(buffer.toString('utf-8')) as {
        datasets?: Partial<Record<DatasetDomain, DatasetMetadata>>;
        analyses?: Partial<Record<DatasetDomain, DomainAnalysisResult>>;
      };
      if (!parsed.datasets && !parsed.analyses) {
        throw new Error(
          'JSON file does not match ASTROCARE Colab export schema (expected "datasets" and "analyses" keys).'
        );
      }
      let primaryMeta: DatasetMetadata | null = null;
      (['physiological', 'cbc', 'immune'] as DatasetDomain[]).forEach((d) => {
        if (parsed.datasets?.[d] || parsed.analyses?.[d]) {
          delete this.datasets[d];
          delete this.persistedInputs[d];
        }
        if (parsed.datasets?.[d]) {
          this.colabImportedMetadata[d] = parsed.datasets[d];
          if (!primaryMeta) primaryMeta = parsed.datasets[d]!;
        }
        if (parsed.analyses?.[d]) {
          this.analyses[d] = parsed.analyses[d];
        }
      });
      if (!primaryMeta) {
        throw new Error('Colab bundle JSON contained no valid domain dataset metadata.');
      }
      this.saveToDisk();
      return { metadata: primaryMeta, preview: [] };
    }

    if (options?.mmashWindowMode) {
      this.pipelineConfig.mmashWindowMode = options.mmashWindowMode;
    } else if (domain === 'physiological' && filename.toLowerCase().endsWith('.zip')) {
      // Default newly uploaded MMASH ZIP archives to 60s physiological windows unless epoch_20 explicitly selected
      this.pipelineConfig.mmashWindowMode = 'window_60s';
    }
    if (options?.mmashWindowSeconds) {
      this.pipelineConfig.mmashWindowSeconds = options.mmashWindowSeconds;
    }
    if (options?.immuneProcessingMode) {
      this.pipelineConfig.immuneProcessingMode = options.immuneProcessingMode;
    }
    if (typeof options?.cbcExcludeSuspectRows === 'boolean') {
      this.pipelineConfig.cbcExcludeSuspectRows = options.cbcExcludeSuspectRows;
    }

    const rawUploadPath = this.saveRawBuffer(domain, filename, buffer);
    const parsed = parseUploadedFile(buffer, filename, domain, {
      mmashWindowMode: this.pipelineConfig.mmashWindowMode,
      windowSeconds: this.pipelineConfig.mmashWindowSeconds,
    });
    const id = `${domain}_${Date.now()}`;
    const entry: PersistedDomainInput = {
      id,
      domain,
      filename,
      fileType: parsed.fileType,
      headers: parsed.headers,
      rows: parsed.rows,
      zipManifest: parsed.zipManifest,
      parserNotes: parsed.notes,
      rawUploadPath,
    };

    delete this.colabImportedMetadata[domain];
    this.persistedInputs[domain] = entry;
    const { ds } = this.runAndEnrichDomain(domain, entry, 0.05);
    this.saveToDisk();

    if (this.simulation.domain === domain) {
      this.stopSimulation();
    }

    const preview = parsed.rows.slice(0, 12);
    return { metadata: ds.metadata, preview };
  }

  analyze(
    domain?: DatasetDomain,
    contamination = 0.05,
    options?: Partial<PipelineConfig>
  ): Record<string, DomainAnalysisResult> {
    if (options?.mmashWindowMode) {
      this.pipelineConfig.mmashWindowMode = options.mmashWindowMode;
    }
    if (options?.mmashWindowSeconds) {
      this.pipelineConfig.mmashWindowSeconds = options.mmashWindowSeconds;
    }
    if (options?.immuneProcessingMode) {
      this.pipelineConfig.immuneProcessingMode = options.immuneProcessingMode;
    }
    if (typeof options?.cbcExcludeSuspectRows === 'boolean') {
      this.pipelineConfig.cbcExcludeSuspectRows = options.cbcExcludeSuspectRows;
    }

    const targets: DatasetDomain[] = domain ? [domain] : ['physiological', 'cbc', 'immune'];
    const updated: Record<string, DomainAnalysisResult> = {};

    for (const d of targets) {
      const entry = this.persistedInputs[d];
      if (entry) {
        const { res } = this.runAndEnrichDomain(d, entry, contamination);
        updated[d] = res;
      } else if (this.datasets[d]) {
        const res = runDomainMLAnalysis(this.datasets[d]!, contamination);
        this.analyses[d] = res;
        updated[d] = res;
      } else if (this.analyses[d]) {
        updated[d] = this.analyses[d]!;
      }
    }

    if (Object.keys(updated).length === 0) {
      throw new Error(
        'No datasets are loaded yet. Upload a CSV/ZIP dataset or Colab bundle JSON first.'
      );
    }

    this.saveToDisk();
    return updated;
  }

  getAllMetadata(): DatasetMetadata[] {
    const out: DatasetMetadata[] = [];
    for (const d of ['physiological', 'cbc', 'immune'] as DatasetDomain[]) {
      if (this.datasets[d]) out.push(this.datasets[d]!.metadata);
      else if (this.colabImportedMetadata[d]) out.push(this.colabImportedMetadata[d]!);
    }
    return out;
  }

  getOverview() {
    const datasets = this.getAllMetadata();
    const analyses = Object.values(this.analyses).filter(
      (a): a is DomainAnalysisResult => Boolean(a && a.trained)
    );

    const totalObservations = analyses.reduce((sum, a) => sum + a.sampleCount, 0);
    const flaggedAnomalies = analyses.reduce((sum, a) => sum + a.anomalyCount, 0);
    const normalObservations = totalObservations - flaggedAnomalies;
    const anomalyPercentage =
      totalObservations > 0 ? Number(((flaggedAnomalies / totalObservations) * 100).toFixed(2)) : 0;

    const modelStatuses = (['physiological', 'cbc', 'immune'] as DatasetDomain[]).map((d) => {
      const analysis = this.analyses[d];
      const meta = this.datasets[d]?.metadata || this.colabImportedMetadata[d];
      return {
        domain: d,
        datasetLoaded: Boolean(meta),
        datasetName: meta?.filename ?? null,
        trained: Boolean(analysis?.trained),
        modelType: analysis?.modelType ?? 'Not trained',
        sampleCount: analysis?.sampleCount ?? 0,
        anomalyCount: analysis?.anomalyCount ?? 0,
        anomalyPercentage: analysis?.anomalyPercentage ?? 0,
        source: analysis?.source ?? null,
      };
    });

    return {
      totalObservations,
      normalObservations,
      flaggedAnomalies,
      anomalyPercentage,
      datasetsLoadedCount: datasets.length,
      modelsTrainedCount: analyses.length,
      pipelineConfig: this.pipelineConfig,
      modelStatuses,
      simulationRunning: this.simulation.running,
    };
  }

  getDomainPayload(domain: DatasetDomain) {
    const metadata = this.datasets[domain]?.metadata || this.colabImportedMetadata[domain] || null;
    const analysis = this.analyses[domain] || null;
    return {
      domain,
      loaded: Boolean(metadata),
      metadata,
      analysis,
    };
  }

  getAllAnomalies(domainFilter?: DatasetDomain) {
    const domains: DatasetDomain[] = domainFilter
      ? [domainFilter]
      : ['physiological', 'cbc', 'immune'];
    const items: (AnalyzedObservation & { domain: DatasetDomain })[] = [];

    for (const d of domains) {
      const a = this.analyses[d];
      if (!a) continue;
      for (const rec of a.records) {
        if (rec.isAnomaly || rec.baselineFlag) {
          items.push({ ...rec, domain: d });
        }
      }
    }

    items.sort((a, b) => b.anomalyScore - a.anomalyScore);
    return items;
  }

  getModelMetrics() {
    return (['physiological', 'cbc', 'immune'] as DatasetDomain[]).map((d) => {
      const a = this.analyses[d];
      const meta = this.datasets[d]?.metadata || this.colabImportedMetadata[d];
      if (!a) {
        return {
          domain: d,
          trained: false,
          datasetName: meta?.filename ?? null,
          pipelineConfig: this.pipelineConfig,
          message: 'Awaiting dataset upload or Colab artifact import.',
        };
      }
      return {
        domain: d,
        trained: a.trained,
        source: a.source,
        datasetName: meta?.filename ?? null,
        modelType: a.modelType,
        baselineType: a.baselineType,
        modelParams: a.modelParams,
        scoreSummary: a.scoreSummary,
        trainedAt: a.trainedAt,
        sampleCount: a.sampleCount,
        featureCount: a.featureColumns.length,
        featureColumns: a.featureColumns,
        contamination: a.contamination,
        thresholdScore: a.thresholdScore,
        anomalyCount: a.anomalyCount,
        normalCount: a.normalCount,
        anomalyPercentage: a.anomalyPercentage,
        scoreDistribution: a.scoreDistribution,
        featureImportance: a.featureImportance,
        contaminationSensitivity: a.contaminationSensitivity,
        stabilityAnalysis: a.stabilityAnalysis,
        baselineComparison: a.baselineComparison,
        supervisedStatus: a.supervisedStatus,
        evaluationNotes: a.evaluationNotes,
        dataQualityAudit: meta?.dataQualityAudit ?? null,
        pipelineConfig: this.pipelineConfig,
      };
    });
  }

  startSimulation(domain?: DatasetDomain, intervalMs = 1000): SimulationState {
    const targetDomain: DatasetDomain | undefined =
      domain && this.analyses[domain]
        ? domain
        : (['physiological', 'cbc', 'immune'] as DatasetDomain[]).find((d) => this.analyses[d]);

    if (!targetDomain || !this.analyses[targetDomain]) {
      throw new Error(
        'Cannot start historical replay: no processed dataset is available. Upload a dataset first.'
      );
    }

    const records = this.analyses[targetDomain]!.records;
    if (records.length === 0) {
      throw new Error('Selected dataset has zero observations to replay.');
    }

    this.stopTimerOnly();

    if (this.simulation.domain !== targetDomain || this.simulation.cursorIndex >= records.length) {
      this.simulation.history = [];
      this.simulation.events = [];
      this.simulation.cursorIndex = 0;
    }

    this.simulation.domain = targetDomain;
    this.simulation.totalRecords = records.length;
    this.simulation.intervalMs = Math.min(5000, Math.max(250, intervalMs));
    this.simulation.running = true;
    this.simulation.startedAt = new Date().toISOString();

    this.pushSimulationStep();
    this.simTimer = setInterval(() => {
      this.pushSimulationStep();
    }, this.simulation.intervalMs);

    return this.simulation;
  }

  private pushSimulationStep() {
    const analysis = this.analyses[this.simulation.domain];
    if (!analysis || !this.simulation.running) {
      this.stopSimulation();
      return;
    }
    const records = analysis.records;
    if (this.simulation.cursorIndex >= records.length) {
      this.simulation.events.unshift({
        id: `evt_loop_${Date.now()}`,
        timestamp: new Date().toISOString(),
        domain: this.simulation.domain,
        subjectId: 'REPLAY_ENGINE',
        severity: 'info',
        anomalyScore: 0,
        message: `Completed full historical replay of ${records.length} observations; restarting replay loop.`,
      });
      this.simulation.cursorIndex = 0;
    }

    const obs = records[this.simulation.cursorIndex];
    this.simulation.cursorIndex += 1;
    this.simulation.history.push(obs);
    if (this.simulation.history.length > 60) {
      this.simulation.history = this.simulation.history.slice(-60);
    }

    let severity: SimulationEvent['severity'] = 'info';
    let message = `Replayed obs #${obs.index} (${obs.subjectId}) — nominal pattern (score ${obs.anomalyScore.toFixed(3)}).`;
    if (obs.isAnomaly) {
      severity = 'anomaly';
      const top = obs.featureContributions[0];
      message = `Statistical anomaly flagged on obs #${obs.index} (${obs.subjectId}): score ${obs.anomalyScore.toFixed(3)}${top ? `, primary driver ${top.feature} (${top.zScore >= 0 ? '+' : ''}${top.zScore.toFixed(2)} SD)` : ''}.`;
    } else if (obs.baselineFlag) {
      severity = 'warning';
      message = `Univariate MAD baseline deviation on obs #${obs.index} (${obs.subjectId}): max |M| = ${obs.baselineMaxModifiedZ.toFixed(2)}.`;
    }

    this.simulation.events.unshift({
      id: `evt_${obs.index}_${Date.now()}`,
      timestamp: new Date().toISOString(),
      domain: this.simulation.domain,
      subjectId: obs.subjectId,
      severity,
      anomalyScore: obs.anomalyScore,
      message,
    });
    if (this.simulation.events.length > 50) {
      this.simulation.events = this.simulation.events.slice(0, 50);
    }
  }

  private stopTimerOnly() {
    if (this.simTimer) {
      clearInterval(this.simTimer);
      this.simTimer = null;
    }
  }

  stopSimulation(): SimulationState {
    this.stopTimerOnly();
    this.simulation.running = false;
    return this.simulation;
  }

  resetSimulation(): SimulationState {
    this.stopTimerOnly();
    this.simulation.running = false;
    this.simulation.cursorIndex = 0;
    this.simulation.history = [];
    this.simulation.events = [];
    return this.simulation;
  }
}

export const astrocareStore = new AstrocareStore();
