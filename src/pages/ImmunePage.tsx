import React, { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CorrelationHeatmap } from '../components/CorrelationHeatmap';
import { EmptyDatasetNotice } from '../components/EmptyDatasetNotice';
import type { DomainPayload, PageId } from '../types';

interface ImmunePageProps {
  data: DomainPayload | null;
  onNavigate: (page: PageId) => void;
}

export const ImmunePage: React.FC<ImmunePageProps> = ({ data, onNavigate }) => {
  const [selectedBiomarker, setSelectedBiomarker] = useState<string>('');

  const analysis = data?.analysis;
  const metadata = data?.metadata;

  const featureCols = analysis?.featureColumns || [];
  const activeBiomarker =
    selectedBiomarker && featureCols.includes(selectedBiomarker)
      ? selectedBiomarker
      : featureCols[0] || '';

  const comparativeBySubject = useMemo(() => {
    if (!analysis || !activeBiomarker) return [];
    const grouped = new Map<string, { sum: number; count: number; flagged: number }>();
    for (const r of analysis.records) {
      const val = r.values[activeBiomarker];
      if (!Number.isFinite(val)) continue;
      const cur = grouped.get(r.subjectId) || { sum: 0, count: 0, flagged: 0 };
      cur.sum += val;
      cur.count += 1;
      if (r.isAnomaly) cur.flagged += 1;
      grouped.set(r.subjectId, cur);
    }
    return Array.from(grouped.entries())
      .slice(0, 24)
      .map(([subjectId, g]) => ({
        subjectId,
        meanValue: Number((g.sum / g.count).toFixed(3)),
        flagged: g.flagged,
      }));
  }, [analysis, activeBiomarker]);

  if (!data?.loaded || !analysis || !metadata) {
    return (
      <EmptyDatasetNotice
        domain="immune"
        title="Immune Biomarker Analysis"
        description="Upload LSDS-8_Multiplex_serum.immune.EvePanel_SUBMITTED.csv (or a Colab bundle) to examine cytokine/chemokine distributions, Pearson correlations, subject-level comparisons, and multivariate anomaly flags."
        expectedFiles={[
          'LSDS-8_Multiplex_serum.immune.EvePanel_SUBMITTED.csv',
          'astrocare_bundle.json',
        ]}
        onNavigate={onNavigate}
      />
    );
  }

  const featureProfiles = metadata.columns.filter((c) => c.role === 'feature');

  return (
    <div className="space-y-6">
      <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="text-xs font-mono text-cyan-400">
            {metadata.filename} · {metadata.rowCount} records · {metadata.subjectCount} subject(s) ·{' '}
            {featureCols.length} immune features
          </div>
          <p className="text-xs text-slate-400 max-w-2xl">{metadata.provenanceNote}</p>
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-300 shrink-0">
          <span className="text-slate-400">Immune Biomarker</span>
          <select
            value={activeBiomarker}
            onChange={(e) => setSelectedBiomarker(e.target.value)}
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

      {/* Comparative Chart + Top Ranked Feature Importance */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-100">
            Subject / Sample Comparison: {activeBiomarker}
          </h3>
          <p className="text-xs text-slate-400">
            Mean biomarker level across up to 24 subjects/samples in the cohort
          </p>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={comparativeBySubject} margin={{ top: 10, right: 10, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" vertical={false} />
                <XAxis dataKey="subjectId" stroke="#94A3B8" fontSize={10} interval={0} angle={-25} textAnchor="end" height={48} />
                <YAxis stroke="#94A3B8" fontSize={11} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0B0E17',
                    borderColor: '#1E293B',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="meanValue" name={activeBiomarker} fill="#06B6D4" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-100">
            Biomarker Anomaly Attribution Ranking
          </h3>
          <p className="text-xs text-slate-400">
            Relative contribution of immune markers to Isolation Forest anomaly separation
          </p>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={analysis.featureImportance.slice(0, 10)}
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
                <Bar dataKey="importance" name="Importance" fill="#2563EB" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* Correlation Heatmap */}
      <section className="bg-[#111827] border border-slate-800 rounded-lg p-5">
        <CorrelationHeatmap data={analysis.correlationMatrix} />
      </section>

      {/* Statistical Summaries */}
      <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-100">Immune Panel Statistical Summary</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono tabular-nums">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="py-2.5 pr-4 font-medium font-sans">Biomarker</th>
                <th className="py-2.5 pr-4 font-medium text-right">Min</th>
                <th className="py-2.5 pr-4 font-medium text-right">Median</th>
                <th className="py-2.5 pr-4 font-medium text-right">Mean</th>
                <th className="py-2.5 pr-4 font-medium text-right">Max</th>
                <th className="py-2.5 pr-4 font-medium text-right">Std Dev</th>
                <th className="py-2.5 font-medium text-right">IQR Outliers</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {featureProfiles.map((col) => (
                <tr
                  key={col.name}
                  onClick={() => setSelectedBiomarker(col.name)}
                  className={`cursor-pointer ${
                    col.name === activeBiomarker ? 'bg-cyan-500/10' : 'hover:bg-slate-800/30'
                  }`}
                >
                  <td className="py-2 pr-4 text-slate-100 font-medium">{col.name}</td>
                  <td className="py-2 pr-4 text-right text-slate-400">
                    {col.min?.toFixed(2) ?? '—'}
                  </td>
                  <td className="py-2 pr-4 text-right text-slate-200">
                    {col.median?.toFixed(2) ?? '—'}
                  </td>
                  <td className="py-2 pr-4 text-right text-slate-200">
                    {col.mean?.toFixed(2) ?? '—'}
                  </td>
                  <td className="py-2 pr-4 text-right text-slate-400">
                    {col.max?.toFixed(2) ?? '—'}
                  </td>
                  <td className="py-2 pr-4 text-right text-slate-400">
                    {col.std?.toFixed(2) ?? '—'}
                  </td>
                  <td
                    className={`py-2 text-right ${
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

      {/* Per-Analyte Stratification & Anomaly Counts */}
      {metadata.dataQualityAudit?.immuneAudit && (
        <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-100">
              Per-Analyte Normalization &amp; Anomaly Counts
            </h3>
            <span className="text-xs font-mono text-slate-400">
              Mode: {metadata.dataQualityAudit.immuneAudit.activeMode} · Censored (Left/Right):{' '}
              {metadata.dataQualityAudit.immuneAudit.censoredValuesSummary.leftCensoredCount}/
              {metadata.dataQualityAudit.immuneAudit.censoredValuesSummary.rightCensoredCount}
            </span>
          </div>
          {metadata.dataQualityAudit.immuneAudit.perAnalyteSummary.length > 0 ? (
            <div className="overflow-x-auto max-h-64">
              <table className="w-full text-left text-xs font-mono tabular-nums">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-2 pr-4 font-sans font-medium">Analyte</th>
                    <th className="py-2 pr-4 text-right">Rows</th>
                    <th className="py-2 pr-4 text-right">Censored (L/R)</th>
                    <th className="py-2 pr-4 text-right">Median (IQR)</th>
                    <th className="py-2 pr-4 text-right">IF Anomalies</th>
                    <th className="py-2 text-right">MAD Flags</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {metadata.dataQualityAudit.immuneAudit.perAnalyteSummary.map((an) => (
                    <tr key={an.analyte} className="hover:bg-slate-800/30">
                      <td className="py-1.5 pr-4 text-slate-100 font-medium">{an.analyte}</td>
                      <td className="py-1.5 pr-4 text-right text-slate-400">{an.rowCount}</td>
                      <td className="py-1.5 pr-4 text-right text-slate-400">
                        {an.leftCensoredCount}/{an.rightCensoredCount}
                      </td>
                      <td className="py-1.5 pr-4 text-right text-slate-300">
                        {an.median ?? '—'} ({an.iqr ?? '—'})
                      </td>
                      <td className="py-1.5 pr-4 text-right text-amber-400">
                        {an.ifAnomalyCount} ({an.anomalyPct}%)
                      </td>
                      <td className="py-1.5 text-right text-cyan-400">{an.madFlagCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-xs text-slate-400">
              {metadata.dataQualityAudit.immuneAudit.notes.join(' ')}
            </div>
          )}
        </section>
      )}
    </div>
  );
};
