import React, { useState } from 'react';
import {
  CheckCircle2,
  FileCode2,
  Play,
  Upload,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api';
import type {
  DatasetDomain,
  DatasetMetadata,
  ImmuneProcessingMode,
  MmashWindowMode,
} from '../types';

interface DataManagementPageProps {
  datasets: DatasetMetadata[];
  onRefresh: () => Promise<void>;
}

const UPLOAD_SLOTS: {
  domain: DatasetDomain;
  title: string;
  accept: string;
  expectedFilename: string;
  description: string;
}[] = [
  {
    domain: 'physiological',
    title: 'Physiological Cohort (MMASH)',
    accept: '.zip,.csv,.tsv',
    expectedFilename: 'MMASH.zip or extracted .csv',
    description:
      'Extracts ZIP archives automatically, aligns 60-second physiological windows or 20-epoch overview bins, preserves subject IDs and timestamps, and trains Physiological Isolation Forest.',
  },
  {
    domain: 'cbc',
    title: 'Blood Biomarkers (LSDS-7 CBC)',
    accept: '.csv,.tsv',
    expectedFilename: 'LSDS-7_Complete_Blood_Count_CBC_TRANSFORMED.csv',
    description:
      'Preserves raw CSV unchanged, excludes reference-range bounds, flags suspected column-transposition errors (Row 17), computes NLR, and compares models with/without suspect records.',
  },
  {
    domain: 'immune',
    title: 'Immune Panel (LSDS-8 Multiplex)',
    accept: '.csv,.tsv',
    expectedFilename: 'LSDS-8_Multiplex_serum.immune.EvePanel_SUBMITTED.csv',
    description:
      'Preserves Analyte identifiers, resolves censored values (<LOD / OOR<), performs per-analyte normalization or wide-format pivoting, and reports anomaly counts per analyte.',
  },
];

export const DataManagementPage: React.FC<DataManagementPageProps> = ({
  datasets,
  onRefresh,
}) => {
  const [uploadingDomain, setUploadingDomain] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [previewRows, setPreviewRows] = useState<Record<string, unknown>[]>([]);
  const [selectedInspectDomain, setSelectedInspectDomain] = useState<DatasetDomain>('physiological');

  const physMeta = datasets.find((d) => d.domain === 'physiological');
  const cbcMeta = datasets.find((d) => d.domain === 'cbc');
  const immuneMeta = datasets.find((d) => d.domain === 'immune');

  const [mmashMode, setMmashMode] = useState<MmashWindowMode>(
    physMeta?.dataQualityAudit?.mmashWindowComparison?.activeMode || 'window_60s'
  );
  const [immuneMode, setImmuneMode] = useState<ImmuneProcessingMode>(
    immuneMeta?.dataQualityAudit?.immuneAudit?.activeMode || 'per_analyte'
  );
  const [cbcExcludeSuspect, setCbcExcludeSuspect] = useState<boolean>(
    Boolean(cbcMeta?.dataQualityAudit?.cbcIntegrityComparison?.excludeSuspectApplied)
  );

  const handleFileUpload = async (file: File | undefined, domain: DatasetDomain) => {
    if (!file) return;
    setUploadingDomain(domain);
    setMessage(null);
    try {
      const res = await api.uploadDataset(file, domain, {
        mmashWindowMode: domain === 'physiological' ? mmashMode : undefined,
        immuneProcessingMode: domain === 'immune' ? immuneMode : undefined,
        cbcExcludeSuspectRows: domain === 'cbc' ? cbcExcludeSuspect : undefined,
      });
      setPreviewRows(res.preview || []);
      setSelectedInspectDomain(res.metadata.domain);
      await onRefresh();
      setMessage({
        type: 'success',
        text: `Processed "${res.metadata.filename}" (${res.metadata.rowCount} rows, ${res.metadata.columnCount} columns) and trained ${res.metadata.domain} anomaly model.`,
      });
    } catch (e) {
      setMessage({
        type: 'error',
        text: e instanceof Error ? e.message : 'Upload failed.',
      });
    } finally {
      setUploadingDomain(null);
    }
  };

  const handleApplyDomainConfig = async (
    domain: DatasetDomain,
    cfg: {
      mmashWindowMode?: MmashWindowMode;
      immuneProcessingMode?: ImmuneProcessingMode;
      cbcExcludeSuspectRows?: boolean;
    }
  ) => {
    setUploadingDomain(domain);
    setMessage(null);
    try {
      await api.runAnalyze(domain, 0.05, cfg);
      await onRefresh();
      setSelectedInspectDomain(domain);
      setMessage({
        type: 'success',
        text: `Updated ${domain} preprocessing configuration and re-trained cohort model.`,
      });
    } catch (e) {
      setMessage({
        type: 'error',
        text: e instanceof Error ? e.message : 'Configuration update failed.',
      });
    } finally {
      setUploadingDomain(null);
    }
  };

  const handleBundleImport = async (file: File | undefined) => {
    if (!file) return;
    setUploadingDomain('bundle');
    setMessage(null);
    try {
      const res = await api.uploadDataset(file, 'physiological');
      setSelectedInspectDomain(res.metadata.domain);
      await onRefresh();
      setMessage({
        type: 'success',
        text: `Imported Google Colab analysis bundle "${file.name}".`,
      });
    } catch (e) {
      setMessage({
        type: 'error',
        text: e instanceof Error ? e.message : 'Bundle import failed.',
      });
    } finally {
      setUploadingDomain(null);
    }
  };

  const handleReRunAll = async () => {
    setUploadingDomain('analyze');
    setMessage(null);
    try {
      await api.runAnalyze(undefined, 0.05, {
        mmashWindowMode: mmashMode,
        immuneProcessingMode: immuneMode,
        cbcExcludeSuspectRows: cbcExcludeSuspect,
      });
      await onRefresh();
      setMessage({
        type: 'success',
        text: 'Executed full ML training and evaluation across all loaded cohorts.',
      });
    } catch (e) {
      setMessage({
        type: 'error',
        text: e instanceof Error ? e.message : 'Execution failed.',
      });
    } finally {
      setUploadingDomain(null);
    }
  };

  const inspectedDataset =
    datasets.find((d) => d.domain === selectedInspectDomain) || datasets[0] || null;
  const audit = inspectedDataset?.dataQualityAudit;

  const missingChartData = inspectedDataset
    ? inspectedDataset.columns
        .filter((c) => c.missingCount > 0)
        .slice(0, 15)
        .map((c) => ({ column: c.name, missingPct: c.missingPct }))
    : [];

  return (
    <div className="space-y-6">
      {message && (
        <div
          className={`rounded-md px-4 py-3 text-xs border ${
            message.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
              : 'bg-rose-500/10 border-rose-500/40 text-rose-300'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Upload Cards Grid */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {UPLOAD_SLOTS.map((slot) => {
          const loaded = datasets.find((d) => d.domain === slot.domain);
          const busy = uploadingDomain === slot.domain;
          return (
            <div
              key={slot.domain}
              className="bg-[#111827] border border-slate-800 rounded-lg p-5 flex flex-col justify-between space-y-4"
            >
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-100">{slot.title}</h3>
                  {loaded && (
                    <span className="text-xs font-mono text-emerald-400 inline-flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Loaded</span>
                    </span>
                  )}
                </div>
                <div className="text-xs font-mono text-cyan-400 truncate">
                  {loaded ? loaded.filename : slot.expectedFilename}
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">{slot.description}</p>

                {/* Domain-specific pipeline selector */}
                {slot.domain === 'physiological' && (
                  <div className="pt-1 flex items-center justify-between gap-2 text-xs">
                    <span className="text-slate-400">Windowing:</span>
                    <select
                      value={mmashMode}
                      disabled={busy}
                      onChange={(e) => {
                        const mode = e.target.value as MmashWindowMode;
                        setMmashMode(mode);
                        if (loaded?.dataQualityAudit?.mmashWindowComparison?.rawZipAvailable) {
                          handleApplyDomainConfig('physiological', { mmashWindowMode: mode });
                        }
                      }}
                      className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100"
                    >
                      <option value="window_60s">60-second Windows (Colab-aligned)</option>
                      <option value="epoch_20">20-Epoch Overview (440 rows)</option>
                    </select>
                  </div>
                )}

                {slot.domain === 'cbc' && (
                  <label className="pt-1 flex items-center justify-between gap-2 text-xs text-slate-300 cursor-pointer">
                    <span className="text-slate-400">Exclude suspect Row #17 from fit:</span>
                    <input
                      type="checkbox"
                      checked={cbcExcludeSuspect}
                      disabled={busy}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setCbcExcludeSuspect(checked);
                        if (loaded) {
                          handleApplyDomainConfig('cbc', { cbcExcludeSuspectRows: checked });
                        }
                      }}
                      className="accent-cyan-500 h-3.5 w-3.5"
                    />
                  </label>
                )}

                {slot.domain === 'immune' && (
                  <div className="pt-1 flex items-center justify-between gap-2 text-xs">
                    <span className="text-slate-400">Normalization:</span>
                    <select
                      value={immuneMode}
                      disabled={busy}
                      onChange={(e) => {
                        const mode = e.target.value as ImmuneProcessingMode;
                        setImmuneMode(mode);
                        if (loaded?.dataQualityAudit?.immuneAudit?.hasAnalyteColumn) {
                          handleApplyDomainConfig('immune', { immuneProcessingMode: mode });
                        }
                      }}
                      className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100"
                    >
                      <option value="per_analyte">Per-Analyte Z-Normalized</option>
                      <option value="wide_pivot">Wide-Format Pivot (Multivariate)</option>
                      <option value="pooled">Pooled Legacy Comparison</option>
                    </select>
                  </div>
                )}
              </div>

              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between gap-3">
                <span className="text-xs font-mono tabular-nums text-slate-500">
                  {loaded ? `${loaded.rowCount} rows · ${loaded.columnCount} cols` : 'No file uploaded'}
                </span>
                <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-md transition-colors whitespace-nowrap">
                  <Upload className="w-3.5 h-3.5" />
                  <span>{busy ? 'Processing...' : loaded ? 'Replace File' : 'Select File'}</span>
                  <input
                    type="file"
                    accept={slot.accept}
                    disabled={busy}
                    className="hidden"
                    onChange={(e) => {
                      handleFileUpload(e.target.files?.[0], slot.domain);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
            </div>
          );
        })}
      </section>

      {/* Google Colab Bundle Import & Notebook Download */}
      <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1 max-w-2xl">
          <h3 className="text-sm font-semibold text-slate-100">
            Google Colab Pipeline Integration (Scikit-learn + SHAP)
          </h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Run <span className="font-mono text-slate-300">ASTROCARE_COMPLETE_ML_PIPELINE.ipynb</span>{' '}
            in free Google Colab to train scikit-learn Isolation Forest + SHAP explainers, export{' '}
            <span className="font-mono text-slate-300">.joblib</span> models for the Python FastAPI
            backend, and import <span className="font-mono text-slate-300">astrocare_bundle.json</span>{' '}
            here.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <a
            href="/api/notebook/download"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-md transition-colors whitespace-nowrap"
          >
            <FileCode2 className="w-3.5 h-3.5 text-cyan-400" />
            <span>Download .ipynb</span>
          </a>

          <label className="cursor-pointer inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-md transition-colors whitespace-nowrap">
            <Upload className="w-3.5 h-3.5 text-cyan-400" />
            <span>{uploadingDomain === 'bundle' ? 'Importing...' : 'Import Colab JSON'}</span>
            <input
              type="file"
              accept=".json"
              className="hidden"
              onChange={(e) => {
                handleBundleImport(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>

          <button
            onClick={handleReRunAll}
            disabled={datasets.length === 0 || uploadingDomain === 'analyze'}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-slate-950 rounded-md transition-colors whitespace-nowrap"
          >
            <Play className="w-3.5 h-3.5" />
            <span>Run ML Analysis</span>
          </button>
        </div>
      </section>

      {/* Data Quality & Feature Selection Audit Panel */}
      {inspectedDataset && (
        <div className="space-y-6">
          <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  Dataset Validation, Feature Audit & Column Inspection
                </h3>
                <div className="text-xs font-mono text-slate-400 mt-0.5">
                  {inspectedDataset.filename} · Raw: {inspectedDataset.rawRowCount} · Modeled:{' '}
                  {inspectedDataset.rowCount} · Subjects: {inspectedDataset.subjectCount} · Missing
                  (Features Before→After):{' '}
                  {audit
                    ? `${audit.missingCellsBeforeInFeatures} → ${audit.missingCellsAfter}`
                    : `${inspectedDataset.imputedCellCount} → 0`}
                </div>
              </div>

              <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-md">
                {datasets.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => setSelectedInspectDomain(d.domain)}
                    className={`px-3 py-1 text-xs font-medium rounded capitalize transition-colors ${
                      inspectedDataset.domain === d.domain
                        ? 'bg-cyan-500 text-slate-950'
                        : 'text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    {d.domain}
                  </button>
                ))}
              </div>
            </div>

            {audit && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
                <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-4 space-y-2">
                  <div className="font-semibold text-cyan-400">
                    Feature Selection & Cohort Audit
                  </div>
                  <div className="text-slate-300">{audit.cohortIsolationNote}</div>
                  {audit.windowingNote && (
                    <div className="text-slate-400">
                      <span className="text-slate-200 font-medium">Windowing Strategy:</span>{' '}
                      {audit.windowingNote}
                    </div>
                  )}
                  <div className="text-slate-400 font-mono tabular-nums">
                    Active ML Features:{' '}
                    <span className="text-emerald-400">
                      {inspectedDataset.columns.filter((c) => c.role === 'feature').length}
                    </span>{' '}
                    · Ref-Range Excluded:{' '}
                    <span className="text-amber-400">
                      {audit.excludedReferenceRangeColumns.length}
                    </span>{' '}
                    · Index/Date Excluded:{' '}
                    <span className="text-amber-400">
                      {audit.excludedNonMeasurementColumns.length}
                    </span>{' '}
                    · &gt;50% Missing Excluded:{' '}
                    <span className="text-amber-400">
                      {audit.excludedHighMissingColumns.length}
                    </span>
                  </div>
                </div>

                <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-4 space-y-2">
                  <div className="font-semibold text-amber-400">
                    Data Quality & Consistency Findings
                  </div>
                  {audit.cbcConsistencyFindings.length > 0 ? (
                    audit.cbcConsistencyFindings.map((f) => (
                      <div key={f.sampleName} className="space-y-1 text-slate-300">
                        <div className="font-mono text-amber-300">
                          Row #{f.rowIndex} ({f.sampleName}) — Suspected Corrupted:
                        </div>
                        <ul className="list-disc pl-4 space-y-0.5 text-slate-400">
                          {f.findings.map((msg, i) => (
                            <li key={i}>{msg}</li>
                          ))}
                        </ul>
                        <div className="text-emerald-400/90">{f.handling}</div>
                      </div>
                    ))
                  ) : (
                    <div className="text-slate-400">
                      No cross-column shift anomalies flagged in this cohort.
                    </div>
                  )}
                  {audit.nlrAudit && (
                    <div className="pt-2 border-t border-slate-800/80 text-slate-400 space-y-1">
                      <div className="text-slate-200 font-medium">
                        NLR_engineered Verification ({audit.nlrAudit.unitCheck})
                      </div>
                      <div>
                        Zero/near-zero denominators: {audit.nlrAudit.zeroOrNearZeroDenominators} ·
                        Missing NLR: {audit.nlrAudit.missingNlrCount} · Range:{' '}
                        {audit.nlrAudit.minNlr}–{audit.nlrAudit.maxNlr}
                      </div>
                      {audit.nlrAudit.pctCrossCheckDiscrepancies.map((d) => (
                        <div key={d.sampleName} className="text-amber-300 font-mono">
                          {d.sampleName}: abs NLR={d.nlrFromAbsolute} vs pct NLR={d.nlrFromPercent}{' '}
                          ({d.relativeDiffPct}% divergence)
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Priority 1: MMASH Temporal Resolution Comparison */}
            {audit?.mmashWindowComparison && (
              <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-4 space-y-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold text-cyan-400">
                    MMASH Temporal Resolution & Colab Benchmark Audit
                  </div>
                  <div className="font-mono text-slate-400">
                    Active: {audit.mmashWindowComparison.activeMode} ({audit.mmashWindowComparison.activeRowCount.toLocaleString()} rows) · Colab Ref: {audit.mmashWindowComparison.colabReferenceWindows.toLocaleString()} windows
                  </div>
                </div>
                {audit.mmashWindowComparison.notes.map((n, i) => (
                  <div key={i} className="text-slate-300">
                    — {n}
                  </div>
                ))}
                {audit.mmashWindowComparison.featureDistributionComparisons.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left font-mono tabular-nums text-xs">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-400">
                          <th className="py-1.5 pr-3 font-sans">Feature</th>
                          <th className="py-1.5 pr-3 text-right">20-Epoch Mean (±Std)</th>
                          <th className="py-1.5 text-right">60s Window Mean (±Std)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {audit.mmashWindowComparison.featureDistributionComparisons.map((fc) => (
                          <tr key={fc.feature}>
                            <td className="py-1.5 pr-3 text-slate-200">{fc.feature}</td>
                            <td className="py-1.5 pr-3 text-right text-slate-300">
                              {fc.epoch20Mean !== null && fc.epoch20Mean !== undefined
                                ? `${fc.epoch20Mean} (±${fc.epoch20Std})`
                                : '—'}
                            </td>
                            <td className="py-1.5 text-right text-cyan-400">
                              {fc.window60sMean !== null && fc.window60sMean !== undefined
                                ? `${fc.window60sMean} (±${fc.window60sStd})`
                                : 'Upload raw MMASH.zip to compare'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Priority 2: Immune Per-Analyte & Censored Audit */}
            {audit?.immuneAudit && (
              <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-4 space-y-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold text-cyan-400">
                    Immune Analyte Stratification & Censored-Value Audit
                  </div>
                  <div className="font-mono text-slate-400">
                    Mode: {audit.immuneAudit.activeMode} · Analytes: {audit.immuneAudit.analyteCount || 'N/A (upload raw CSV)'} · Censored (&lt;LOD / &gt;ULOQ):{' '}
                    {audit.immuneAudit.censoredValuesSummary.leftCensoredCount} /{' '}
                    {audit.immuneAudit.censoredValuesSummary.rightCensoredCount}
                  </div>
                </div>
                {audit.immuneAudit.notes.map((n, i) => (
                  <div key={i} className="text-slate-300">
                    — {n}
                  </div>
                ))}
                {audit.immuneAudit.pooledVsNormalizedComparison && (
                  <div className="bg-slate-900/60 border border-slate-800 rounded p-3 text-slate-300 space-y-1 font-mono">
                    <div>
                      Pooled IF Flags: {audit.immuneAudit.pooledVsNormalizedComparison.pooledIfFlags} · Pooled MAD Flags:{' '}
                      <span className="text-amber-400">
                        {audit.immuneAudit.pooledVsNormalizedComparison.pooledMadFlags}
                      </span>{' '}
                      → Per-Analyte IF Flags: {audit.immuneAudit.pooledVsNormalizedComparison.normalizedIfFlags} · Per-Analyte MAD Flags:{' '}
                      <span className="text-emerald-400">
                        {audit.immuneAudit.pooledVsNormalizedComparison.normalizedMadFlags}
                      </span>
                    </div>
                    <div className="font-sans text-slate-400">
                      {audit.immuneAudit.pooledVsNormalizedComparison.note}
                    </div>
                  </div>
                )}
                {audit.immuneAudit.perAnalyteSummary.length > 0 && (
                  <div className="overflow-x-auto max-h-60">
                    <table className="w-full text-left font-mono tabular-nums text-xs">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-400">
                          <th className="py-1.5 pr-3 font-sans">Analyte</th>
                          <th className="py-1.5 pr-3 text-right">Rows</th>
                          <th className="py-1.5 pr-3 text-right">Censored (L/R)</th>
                          <th className="py-1.5 pr-3 text-right">Median (IQR)</th>
                          <th className="py-1.5 pr-3 text-right">IF Anomalies</th>
                          <th className="py-1.5 text-right">MAD Flags</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {audit.immuneAudit.perAnalyteSummary.slice(0, 25).map((an) => (
                          <tr key={an.analyte}>
                            <td className="py-1 pr-3 text-slate-200">{an.analyte}</td>
                            <td className="py-1 pr-3 text-right text-slate-400">{an.rowCount}</td>
                            <td className="py-1 pr-3 text-right text-slate-400">
                              {an.leftCensoredCount}/{an.rightCensoredCount}
                            </td>
                            <td className="py-1 pr-3 text-right text-slate-300">
                              {an.median ?? '—'} ({an.iqr ?? '—'})
                            </td>
                            <td className="py-1 pr-3 text-right text-amber-400">
                              {an.ifAnomalyCount} ({an.anomalyPct}%)
                            </td>
                            <td className="py-1 text-right text-cyan-400">{an.madFlagCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Priority 3: CBC With vs Without Suspect Row Comparison */}
            {audit?.cbcIntegrityComparison && (
              <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-4 space-y-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold text-amber-400">
                    CBC Integrity Comparison: Verified Measurements ({audit.cbcIntegrityComparison.verifiedRowCount}) vs Suspected Corrupted ({audit.cbcIntegrityComparison.suspectRowCount})
                  </div>
                  <div className="font-mono text-slate-300">
                    Active Fit: {audit.cbcIntegrityComparison.excludeSuspectApplied ? 'Verified Only (Suspect Excluded)' : 'All Rows (Suspect Included)'}
                  </div>
                </div>
                <p className="text-slate-300">{audit.cbcIntegrityComparison.note}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-left font-mono tabular-nums text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400">
                        <th className="py-1.5 pr-3 font-sans">Cohort Fit Mode</th>
                        <th className="py-1.5 pr-3 text-right">Rows Fitted</th>
                        <th className="py-1.5 pr-3 text-right">Flagged</th>
                        <th className="py-1.5 pr-3 font-sans">Flagged Sample(s)</th>
                        <th className="py-1.5 pr-3 text-right">NLR Min–Max</th>
                        <th className="py-1.5 pr-3 text-right">MPV Mean (±Std)</th>
                        <th className="py-1.5 text-right">Seed Spearman</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {[
                        { label: 'With Suspect Row #17', m: audit.cbcIntegrityComparison.withSuspect },
                        { label: 'Verified Only (Excl. Row #17)', m: audit.cbcIntegrityComparison.withoutSuspect },
                      ].map((row) => (
                        <tr key={row.label}>
                          <td className="py-1.5 pr-3 font-sans text-slate-200">{row.label}</td>
                          <td className="py-1.5 pr-3 text-right text-slate-300">{row.m.sampleCount}</td>
                          <td className="py-1.5 pr-3 text-right text-amber-400">{row.m.flaggedCount}</td>
                          <td className="py-1.5 pr-3 font-sans text-cyan-400">
                            {row.m.flaggedSamples.join(', ') || 'None'}
                          </td>
                          <td className="py-1.5 pr-3 text-right text-slate-300">
                            {row.m.nlrMin}–{row.m.nlrMax}
                          </td>
                          <td className="py-1.5 pr-3 text-right text-slate-300">
                            {row.m.mpvMean} (±{row.m.mpvStd})
                          </td>
                          <td className="py-1.5 text-right text-emerald-400">{row.m.seedSpearman}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="space-y-1.5 text-xs text-slate-300 bg-[#0B0E17] border border-slate-800 rounded-md p-3">
              {inspectedDataset.qualityNotes.map((note, idx) => (
                <div key={idx}>— {note}</div>
              ))}
              <div>— {inspectedDataset.supervisedLabelAudit.reason}</div>
            </div>

            <div className="overflow-x-auto max-h-80">
              <table className="w-full text-left text-xs font-mono tabular-nums">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-2 pr-3 font-sans font-medium">Column Name</th>
                    <th className="py-2 pr-3 font-sans font-medium">Type</th>
                    <th className="py-2 pr-3 font-sans font-medium">Role / ML Status</th>
                    <th className="py-2 pr-3 font-medium">Unit</th>
                    <th className="py-2 pr-3 text-right font-medium">Missing</th>
                    <th className="py-2 pr-3 text-right font-medium">Min / Max</th>
                    <th className="py-2 text-right font-medium">IQR Outliers</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {inspectedDataset.columns.map((c) => (
                    <tr key={c.name} className="hover:bg-slate-800/30">
                      <td className="py-1.5 pr-3 text-slate-100 font-medium">{c.name}</td>
                      <td className="py-1.5 pr-3 font-sans text-slate-400">{c.inferredType}</td>
                      <td className="py-1.5 pr-3 font-sans">
                        <span className={c.role === 'feature' ? 'text-emerald-400' : 'text-slate-400'}>
                          {c.role}
                        </span>
                        {c.excludedReason && (
                          <span className="text-slate-500 ml-1.5">({c.excludedReason})</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-slate-400">{c.unit || '—'}</td>
                      <td
                        className={`py-1.5 pr-3 text-right ${
                          c.missingPct > 0 ? 'text-amber-400' : 'text-emerald-400'
                        }`}
                      >
                        {c.missingCount} ({c.missingPct.toFixed(1)}%)
                      </td>
                      <td className="py-1.5 pr-3 text-right text-slate-300">
                        {c.min !== null && c.max !== null
                          ? `${c.min.toFixed(2)} / ${c.max.toFixed(2)}`
                          : '—'}
                      </td>
                      <td className="py-1.5 text-right text-slate-300">{c.iqrOutlierCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {missingChartData.length > 0 && (
            <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
              <h3 className="text-sm font-semibold text-slate-100">
                Missing Value Report (% Missing by Column Before Imputation)
              </h3>
              <div className="h-52 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={missingChartData}
                    margin={{ top: 10, right: 10, left: -12, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" vertical={false} />
                    <XAxis dataKey="column" stroke="#94A3B8" fontSize={10} />
                    <YAxis stroke="#94A3B8" fontSize={11} unit="%" />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#0B0E17',
                        borderColor: '#1E293B',
                        fontSize: '12px',
                      }}
                    />
                    <Bar dataKey="missingPct" name="Missing %" fill="#F59E0B" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}

          {previewRows.length > 0 && (
            <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
              <h3 className="text-sm font-semibold text-slate-100">
                Raw Dataset Preview (First {previewRows.length} Rows)
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono tabular-nums">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400">
                      {Object.keys(previewRows[0])
                        .slice(0, 10)
                        .map((k) => (
                          <th key={k} className="py-2 pr-3 font-medium">
                            {k}
                          </th>
                        ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {previewRows.map((row, idx) => (
                      <tr key={idx}>
                        {Object.keys(previewRows[0])
                          .slice(0, 10)
                          .map((k) => (
                            <td key={k} className="py-1.5 pr-3 text-slate-300 whitespace-nowrap">
                              {String(row[k] ?? '')}
                            </td>
                          ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
};
