import React, { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { EmptyDatasetNotice } from '../components/EmptyDatasetNotice';
import type { DomainPayload, PageId } from '../types';

interface CbcPageProps {
  data: DomainPayload | null;
  onNavigate: (page: PageId) => void;
}

export const CbcPage: React.FC<CbcPageProps> = ({ data, onNavigate }) => {
  const [selectedParam, setSelectedParam] = useState<string>('');

  const analysis = data?.analysis;
  const metadata = data?.metadata;

  const featureCols = analysis?.featureColumns || [];
  const activeParam =
    selectedParam && featureCols.includes(selectedParam) ? selectedParam : featureCols[0] || '';

  const distributionBins = useMemo(() => {
    if (!analysis || !activeParam) return [];
    const vals = analysis.records.map((r) => r.values[activeParam]).filter((v) => Number.isFinite(v));
    if (vals.length === 0) return [];
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const numBins = 10;
    const step = Math.max(1e-6, (max - min) / numBins);
    const bins = Array.from({ length: numBins }, (_, i) => ({
      range: `${(min + i * step).toFixed(2)}`,
      normal: 0,
      flagged: 0,
    }));

    for (const r of analysis.records) {
      const v = r.values[activeParam];
      if (!Number.isFinite(v)) continue;
      const idx = Math.min(numBins - 1, Math.floor((v - min) / step));
      if (r.isAnomaly) bins[idx].flagged++;
      else bins[idx].normal++;
    }
    return bins;
  }, [analysis, activeParam]);

  if (!data?.loaded || !analysis || !metadata) {
    return (
      <EmptyDatasetNotice
        domain="cbc"
        title="Complete Blood Count (CBC) Analysis"
        description="Upload LSDS-7_Complete_Blood_Count_CBC_TRANSFORMED.csv (or a Colab bundle) to inspect hematology distributions, descriptive statistics, and robust cohort outlier indicators without inventing reference ranges."
        expectedFiles={['LSDS-7_Complete_Blood_Count_CBC_TRANSFORMED.csv', 'astrocare_bundle.json']}
        onNavigate={onNavigate}
      />
    );
  }

  const featureProfiles = metadata.columns.filter((c) => c.role === 'feature');
  const scatterData = analysis.records.map((r) => ({
    index: r.index,
    subjectId: r.subjectId,
    value: activeParam ? r.values[activeParam] : 0,
    score: r.anomalyScore,
    isAnomaly: r.isAnomaly,
  }));

  return (
    <div className="space-y-6">
      <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="text-xs font-mono text-cyan-400">
            {metadata.filename} · {metadata.rowCount} samples · {featureCols.length} numeric
            parameters
          </div>
          <p className="text-xs text-slate-400 max-w-2xl">
            {metadata.provenanceNote} Abnormality flags represent cohort-relative statistical
            deviations (IQR / Modified Z-Score / Isolation Forest), not fabricated clinical reference
            ranges.
          </p>
          {metadata.dataQualityAudit?.cbcIntegrityComparison && (
            <div className="text-xs font-mono text-amber-300 pt-1">
              Integrity Audit: {metadata.dataQualityAudit.cbcIntegrityComparison.verifiedRowCount}{' '}
              verified measurement(s) ·{' '}
              {metadata.dataQualityAudit.cbcIntegrityComparison.suspectRowCount} suspected corrupted
              record ({metadata.dataQualityAudit.cbcIntegrityComparison.suspectSampleNames.join(', ')}
              ) —{' '}
              {metadata.dataQualityAudit.cbcIntegrityComparison.excludeSuspectApplied
                ? 'excluded from model fitting'
                : 'included in model fitting'}
              .
            </div>
          )}
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-300 shrink-0">
          <span className="text-slate-400">Blood Parameter</span>
          <select
            value={activeParam}
            onChange={(e) => setSelectedParam(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-cyan-500 max-w-[240px]"
          >
            {featureCols.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      </section>

      {/* Interactive Distribution + Sample Scatter */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-100">
            Parameter Distribution: {activeParam}
          </h3>
          <p className="text-xs text-slate-400">
            Cohort histogram split by normal baseline vs Isolation Forest flagged observations
          </p>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={distributionBins} margin={{ top: 10, right: 10, left: -14, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" vertical={false} />
                <XAxis dataKey="range" stroke="#94A3B8" fontSize={11} />
                <YAxis stroke="#94A3B8" fontSize={11} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0B0E17',
                    borderColor: '#1E293B',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="normal" name="Normal" stackId="a" fill="#2563EB" />
                <Bar dataKey="flagged" name="Flagged" stackId="a" fill="#F59E0B" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-100">
            Sample Values vs Isolation Score ({activeParam})
          </h3>
          <p className="text-xs text-slate-400">
            Identifies whether extreme parameter values drive multivariate isolation
          </p>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 10, left: -6, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" />
                <XAxis type="number" dataKey="value" name={activeParam} stroke="#94A3B8" fontSize={11} />
                <YAxis type="number" dataKey="score" name="Anomaly Score" stroke="#94A3B8" fontSize={11} domain={['auto', 'auto']} />
                <Tooltip
                  cursor={{ strokeDasharray: '3 3' }}
                  contentStyle={{
                    backgroundColor: '#0B0E17',
                    borderColor: '#1E293B',
                    fontSize: '12px',
                  }}
                />
                <Scatter
                  name="Normal"
                  data={scatterData.filter((d) => !d.isAnomaly)}
                  fill="#06B6D4"
                />
                <Scatter
                  name="Flagged"
                  data={scatterData.filter((d) => d.isAnomaly)}
                  fill="#F59E0B"
                />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* Statistical Summary & Cohort Outlier Table */}
      <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-100">
            CBC Descriptive Statistics & Cohort Outlier Indicators
          </h3>
          <span className="text-xs font-mono text-slate-400">
            1.5× IQR fence used for univariate outlier audit
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono tabular-nums">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="py-2.5 pr-4 font-medium font-sans">Parameter</th>
                <th className="py-2.5 pr-4 font-medium">Unit</th>
                <th className="py-2.5 pr-4 font-medium text-right">Mean</th>
                <th className="py-2.5 pr-4 font-medium text-right">Median</th>
                <th className="py-2.5 pr-4 font-medium text-right">Std Dev</th>
                <th className="py-2.5 pr-4 font-medium text-right">IQR (Q25–Q75)</th>
                <th className="py-2.5 pr-4 font-medium text-right">Missing</th>
                <th className="py-2.5 font-medium text-right">IQR Outliers</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {featureProfiles.map((col) => (
                <tr
                  key={col.name}
                  onClick={() => setSelectedParam(col.name)}
                  className={`cursor-pointer transition-colors ${
                    col.name === activeParam ? 'bg-cyan-500/10' : 'hover:bg-slate-800/30'
                  }`}
                >
                  <td className="py-2 pr-4 text-slate-100 font-medium">{col.name}</td>
                  <td className="py-2 pr-4 text-slate-400">{col.unit || '—'}</td>
                  <td className="py-2 pr-4 text-right text-slate-200">
                    {col.mean?.toFixed(3) ?? '—'}
                  </td>
                  <td className="py-2 pr-4 text-right text-slate-200">
                    {col.median?.toFixed(3) ?? '—'}
                  </td>
                  <td className="py-2 pr-4 text-right text-slate-400">
                    {col.std?.toFixed(3) ?? '—'}
                  </td>
                  <td className="py-2 pr-4 text-right text-slate-400">
                    {col.q25 !== null && col.q75 !== null
                      ? `${col.q25.toFixed(2)}–${col.q75.toFixed(2)}`
                      : '—'}
                  </td>
                  <td className="py-2 pr-4 text-right text-slate-400">
                    {col.missingPct.toFixed(1)}%
                  </td>
                  <td
                    className={`py-2 text-right font-medium ${
                      col.iqrOutlierCount > 0 ? 'text-amber-400' : 'text-emerald-400'
                    }`}
                  >
                    {col.iqrOutlierCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
