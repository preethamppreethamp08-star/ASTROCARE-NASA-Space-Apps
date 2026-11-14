import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api';
import { EmptyDatasetNotice } from '../components/EmptyDatasetNotice';
import type {
  DatasetDomain,
  ImmuneProcessingMode,
  MmashWindowMode,
  ModelMetricSummary,
  PageId,
} from '../types';

interface ModelPerformancePageProps {
  models: ModelMetricSummary[];
  onRefresh: () => Promise<void>;
  onNavigate: (page: PageId) => void;
}

export const ModelPerformancePage: React.FC<ModelPerformancePageProps> = ({
  models,
  onRefresh,
  onNavigate,
}) => {
  const trainedModels = models.filter((m) => m.trained);
  const [selectedDomain, setSelectedDomain] = useState<DatasetDomain>(
    trainedModels[0]?.domain || 'physiological'
  );
  const [contamination, setContamination] = useState<number>(0.05);
  const [running, setRunning] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  if (trainedModels.length === 0) {
    return (
      <EmptyDatasetNotice
        domain="all"
        title="Model Performance & Evaluation"
        description="No ML models have been trained yet. Upload your dataset(s) in Data Management or import a Colab-trained astrocare_bundle.json to inspect anomaly score distributions, contamination sensitivity, seed stability, and feature importance."
        expectedFiles={['MMASH ZIP / CSV', 'LSDS-7 CBC CSV', 'LSDS-8 Immune CSV', 'astrocare_bundle.json']}
        onNavigate={onNavigate}
      />
    );
  }

  const activeModel =
    trainedModels.find((m) => m.domain === selectedDomain) || trainedModels[0];
  const audit = activeModel.dataQualityAudit;

  const handleRetrain = async (overrideCfg?: {
    mmashWindowMode?: MmashWindowMode;
    immuneProcessingMode?: ImmuneProcessingMode;
    cbcExcludeSuspectRows?: boolean;
  }) => {
    setRunning(true);
    setStatusMsg(null);
    try {
      await api.runAnalyze(activeModel.domain, contamination, overrideCfg);
      await onRefresh();
      setStatusMsg(
        `Re-trained ${activeModel.domain} Isolation Forest at ${(contamination * 100).toFixed(1)}% contamination.`
      );
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : 'Re-analysis failed.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Domain Tabs & Contamination Calibration Control */}
      <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {trainedModels.map((m) => (
            <button
              key={m.domain}
              onClick={() => setSelectedDomain(m.domain)}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md border transition-colors capitalize whitespace-nowrap ${
                activeModel.domain === m.domain
                  ? 'bg-cyan-500 text-slate-950 border-cyan-500'
                  : 'bg-slate-900 text-slate-300 border-slate-700 hover:text-slate-100'
              }`}
            >
              {m.domain} ({m.sampleCount} rows · {m.featureCount} features)
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {activeModel.domain === 'physiological' && audit?.mmashWindowComparison?.rawZipAvailable && (
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <span className="text-slate-400">MMASH Mode</span>
              <select
                value={audit.mmashWindowComparison.activeMode}
                disabled={running}
                onChange={(e) =>
                  handleRetrain({ mmashWindowMode: e.target.value as MmashWindowMode })
                }
                className="bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-xs text-slate-100"
              >
                <option value="window_60s">60s Windows</option>
                <option value="epoch_20">20-Epoch (440)</option>
              </select>
            </label>
          )}

          {activeModel.domain === 'cbc' && audit?.cbcIntegrityComparison && (
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={audit.cbcIntegrityComparison.excludeSuspectApplied}
                disabled={running}
                onChange={(e) => handleRetrain({ cbcExcludeSuspectRows: e.target.checked })}
                className="accent-cyan-500"
              />
              <span className="text-slate-300">Exclude Suspect Row #17</span>
            </label>
          )}

          {activeModel.domain === 'immune' && audit?.immuneAudit?.hasAnalyteColumn && (
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <span className="text-slate-400">Immune Mode</span>
              <select
                value={audit.immuneAudit.activeMode}
                disabled={running}
                onChange={(e) =>
                  handleRetrain({ immuneProcessingMode: e.target.value as ImmuneProcessingMode })
                }
                className="bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-xs text-slate-100"
              >
                <option value="per_analyte">Per-Analyte Z-Norm</option>
                <option value="wide_pivot">Wide-Format Pivot</option>
                <option value="pooled">Pooled Legacy</option>
              </select>
            </label>
          )}

          <label className="flex items-center gap-2 text-xs text-slate-300 font-mono tabular-nums">
            <span className="font-sans text-slate-400">Contamination</span>
            <select
              value={contamination}
              onChange={(e) => setContamination(Number(e.target.value))}
              className="bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-xs text-slate-100"
            >
              {[0.01, 0.03, 0.05, 0.08, 0.1, 0.15].map((c) => (
                <option key={c} value={c}>
                  {(c * 100).toFixed(0)}%
                </option>
              ))}
            </select>
          </label>

          <button
            onClick={() => handleRetrain()}
            disabled={running}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 rounded-md transition-colors whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} />
            <span>{running ? 'Training...' : 'Re-train Model'}</span>
          </button>
        </div>
      </section>

      {statusMsg && (
        <div className="bg-cyan-500/10 border border-cyan-500/30 rounded-md px-4 py-2.5 text-xs text-cyan-200">
          {statusMsg}
        </div>
      )}

      {/* Cross-Cohort Model Audit Comparison Table */}
      <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            Cohort Isolation & Per-Model Training Audit
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Each model is trained strictly on its own cohort dataset with zero cross-study mixing.
            Classification accuracy/precision/recall/F1 are omitted because no ground-truth labels
            exist.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono tabular-nums">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="py-2 pr-3 font-sans font-medium">Cohort</th>
                <th className="py-2 pr-3 font-sans font-medium">Dataset Source</th>
                <th className="py-2 pr-3 text-right font-medium">Rows</th>
                <th className="py-2 pr-3 text-right font-medium">Features</th>
                <th className="py-2 pr-3 text-right font-medium">Missing (Before→After)</th>
                <th className="py-2 pr-3 text-right font-medium">Flagged</th>
                <th className="py-2 pr-3 text-right font-medium">Seed Spearman</th>
                <th className="py-2 text-right font-medium">Seed Jaccard</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {trainedModels.map((m) => (
                <tr
                  key={m.domain}
                  onClick={() => setSelectedDomain(m.domain)}
                  className={`cursor-pointer ${
                    activeModel.domain === m.domain ? 'bg-cyan-500/10' : 'hover:bg-slate-800/30'
                  }`}
                >
                  <td className="py-2 pr-3 font-sans capitalize text-cyan-400 font-medium">
                    {m.domain}
                  </td>
                  <td className="py-2 pr-3 text-slate-200 truncate max-w-[200px]">
                    {m.datasetName || '—'}
                  </td>
                  <td className="py-2 pr-3 text-right text-slate-100">
                    {m.sampleCount?.toLocaleString()}
                  </td>
                  <td className="py-2 pr-3 text-right text-slate-100">{m.featureCount}</td>
                  <td className="py-2 pr-3 text-right text-slate-300">
                    {m.dataQualityAudit
                      ? `${m.dataQualityAudit.missingCellsBeforeInFeatures} → ${m.dataQualityAudit.missingCellsAfter}`
                      : '—'}
                  </td>
                  <td className="py-2 pr-3 text-right text-amber-400">
                    {m.anomalyCount} ({m.anomalyPercentage?.toFixed(2)}%)
                  </td>
                  <td className="py-2 pr-3 text-right text-emerald-400">
                    {m.stabilityAnalysis?.meanSpearmanRankCorr.toFixed(4)}
                  </td>
                  <td className="py-2 text-right text-slate-200">
                    {m.stabilityAnalysis?.meanJaccardOverlap.toFixed(4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Unsupervised Evaluation Summary KPIs */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4">
          <div className="text-xs text-slate-400">Model Parameters</div>
          <div className="mt-1.5 text-sm font-mono font-semibold text-slate-100">
            n_estimators={activeModel.modelParams?.nEstimators ?? 100} · max_samples=
            {activeModel.modelParams?.maxSamples ?? '—'}
          </div>
          <div className="mt-1 text-xs font-mono text-cyan-400">
            max_depth={activeModel.modelParams?.maxDepth ?? '—'} · seed=
            {activeModel.modelParams?.randomSeed ?? 42} · threshold=
            {activeModel.thresholdScore?.toFixed(4)}
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4">
          <div className="text-xs text-slate-400">Anomaly Score Distribution</div>
          <div className="mt-1.5 text-sm font-mono font-semibold tabular-nums text-slate-100">
            {activeModel.scoreSummary
              ? `${activeModel.scoreSummary.min.toFixed(3)} – ${activeModel.scoreSummary.max.toFixed(3)}`
              : '—'}
          </div>
          <div className="mt-1 text-xs font-mono tabular-nums text-slate-400">
            Median: {activeModel.scoreSummary?.median.toFixed(3) ?? '—'} · P95:{' '}
            {activeModel.scoreSummary?.p95.toFixed(3) ?? '—'}
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4">
          <div className="text-xs text-slate-400">
            Seed Stability ({activeModel.stabilityAnalysis?.numSeeds ?? 5} seeds)
          </div>
          <div className="mt-1.5 text-2xl font-mono font-semibold tabular-nums text-emerald-400">
            {activeModel.stabilityAnalysis?.meanSpearmanRankCorr.toFixed(4) ?? '—'}
          </div>
          <div className="mt-1 text-xs font-mono tabular-nums text-slate-400">
            Jaccard: {activeModel.stabilityAnalysis?.meanJaccardOverlap.toFixed(3) ?? '—'} · Std:{' '}
            {activeModel.stabilityAnalysis?.scoreStdAcrossSeeds.toFixed(4) ?? '—'}
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4">
          <div className="text-xs text-slate-400">Baseline Agreement (MAD &gt; 3.5)</div>
          <div className="mt-1.5 text-2xl font-mono font-semibold tabular-nums text-cyan-400">
            {activeModel.baselineComparison?.agreementPct.toFixed(1)}%
          </div>
          <div className="mt-1 text-xs font-mono tabular-nums text-slate-400">
            Score Pearson r: {activeModel.baselineComparison?.scoreCorrelation.toFixed(3)}
          </div>
        </div>
      </section>

      {/* Score Distribution + Contamination Sensitivity */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-100">Anomaly Score Distribution</h3>
          <p className="text-xs text-slate-400">
            Histogram of Isolation Forest path-length scores across {activeModel.sampleCount}{' '}
            observations
          </p>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={activeModel.scoreDistribution || []}
                margin={{ top: 10, right: 10, left: -14, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" vertical={false} />
                <XAxis dataKey="binLabel" stroke="#94A3B8" fontSize={11} />
                <YAxis stroke="#94A3B8" fontSize={11} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0B0E17',
                    borderColor: '#1E293B',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="normalCount" name="Normal" stackId="a" fill="#06B6D4" />
                <Bar dataKey="anomalyCount" name="Flagged" stackId="a" fill="#F59E0B" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-100">Contamination Sensitivity Curve</h3>
          <p className="text-xs text-slate-400">
            Flagged observation count and MAD baseline overlap across contamination thresholds
          </p>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={activeModel.contaminationSensitivity || []}
                margin={{ top: 10, right: 16, left: -10, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" />
                <XAxis
                  dataKey="contamination"
                  stroke="#94A3B8"
                  fontSize={11}
                  tickFormatter={(v) => `${(Number(v) * 100).toFixed(0)}%`}
                />
                <YAxis stroke="#94A3B8" fontSize={11} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0B0E17',
                    borderColor: '#1E293B',
                    fontSize: '12px',
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="flaggedCount"
                  name="Flagged Count"
                  stroke="#F59E0B"
                  strokeWidth={2}
                />
                <Line
                  type="monotone"
                  dataKey="baselineOverlapPct"
                  name="MAD Overlap %"
                  stroke="#06B6D4"
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* Feature Importance + Baseline Agreement Matrix + Audit Findings */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-100">
            Global Feature Importance ({activeModel.featureImportance?.[0]?.method || 'Model'})
          </h3>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={(activeModel.featureImportance || []).slice(0, 10)}
                layout="vertical"
                margin={{ top: 4, right: 16, left: 24, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" horizontal={false} />
                <XAxis type="number" stroke="#94A3B8" fontSize={11} />
                <YAxis type="category" dataKey="feature" stroke="#94A3B8" fontSize={11} width={110} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0B0E17',
                    borderColor: '#1E293B',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="importance" name="Importance" fill="#06B6D4" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-100">
            Baseline Agreement & Data Quality Audit Findings
          </h3>
          {activeModel.baselineComparison && (
            <div className="grid grid-cols-2 gap-3 text-xs font-mono tabular-nums">
              <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-3">
                <div className="text-slate-400 font-sans">Both Flagged</div>
                <div className="text-xl text-amber-400 mt-1">
                  {activeModel.baselineComparison.bothFlagged}
                </div>
              </div>
              <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-3">
                <div className="text-slate-400 font-sans">Only Isolation Forest</div>
                <div className="text-xl text-cyan-400 mt-1">
                  {activeModel.baselineComparison.onlyIsolationForest}
                </div>
              </div>
              <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-3">
                <div className="text-slate-400 font-sans">Only MAD Baseline</div>
                <div className="text-xl text-blue-400 mt-1">
                  {activeModel.baselineComparison.onlyStatisticalBaseline}
                </div>
              </div>
              <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-3">
                <div className="text-slate-400 font-sans">Both Nominal</div>
                <div className="text-xl text-emerald-400 mt-1">
                  {activeModel.baselineComparison.neitherFlagged}
                </div>
              </div>
            </div>
          )}

          <div className="border-t border-slate-800 pt-3 space-y-2 text-xs text-slate-300">
            <div className="font-semibold text-slate-200">Audit & Supervised Eligibility</div>
            <p className="text-slate-400 leading-relaxed">{activeModel.supervisedStatus?.reason}</p>
            {audit && (
              <div className="space-y-1.5 text-slate-400 bg-[#0B0E17] border border-slate-800 rounded-md p-3">
                <div>
                  <span className="text-slate-200 font-medium">Cohort Isolation:</span>{' '}
                  {audit.cohortIsolationNote}
                </div>
                {audit.windowingNote && (
                  <div>
                    <span className="text-slate-200 font-medium">Windowing Audit:</span>{' '}
                    {audit.windowingNote}
                  </div>
                )}
                {audit.mmashWindowComparison && (
                  <div className="text-cyan-300">
                    <span className="font-semibold">MMASH Benchmark Check:</span>{' '}
                    {audit.mmashWindowComparison.notes.join(' ')}
                  </div>
                )}
                {audit.cbcIntegrityComparison && (
                  <div className="text-amber-300">
                    <span className="font-semibold">CBC With vs Without Suspect Row:</span>{' '}
                    {audit.cbcIntegrityComparison.note}
                  </div>
                )}
                {audit.immuneAudit?.pooledVsNormalizedComparison && (
                  <div className="text-cyan-300">
                    <span className="font-semibold">Immune Normalization Impact:</span>{' '}
                    {audit.immuneAudit.pooledVsNormalizedComparison.note}
                  </div>
                )}
                {audit.excludedReferenceRangeColumns.length > 0 && (
                  <div>
                    <span className="text-slate-200 font-medium">
                      Excluded Reference-Range Columns ({audit.excludedReferenceRangeColumns.length}):
                    </span>{' '}
                    <span className="font-mono text-cyan-400">
                      {audit.excludedReferenceRangeColumns.slice(0, 8).join(', ')}
                      {audit.excludedReferenceRangeColumns.length > 8 ? '…' : ''}
                    </span>
                  </div>
                )}
                {audit.excludedNonMeasurementColumns.length > 0 && (
                  <div>
                    <span className="text-slate-200 font-medium">
                      Excluded Non-Measurement Columns ({audit.excludedNonMeasurementColumns.length}):
                    </span>{' '}
                    <span className="font-mono text-cyan-400">
                      {audit.excludedNonMeasurementColumns.join(', ')}
                    </span>
                  </div>
                )}
                {audit.cbcConsistencyFindings.map((f) => (
                  <div key={f.sampleName} className="text-amber-300">
                    <span className="font-semibold">Suspicious CBC Record ({f.sampleName}):</span>{' '}
                    {f.findings.join(' ')} {f.handling}
                  </div>
                ))}
                {audit.nlrAudit && (
                  <div>
                    <span className="text-slate-200 font-medium">NLR Audit:</span>{' '}
                    {audit.nlrAudit.unitCheck} · min {audit.nlrAudit.minNlr} · median{' '}
                    {audit.nlrAudit.medianNlr} · max {audit.nlrAudit.maxNlr}.{' '}
                    {audit.nlrAudit.notes.join(' ')}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
