import React, { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { EmptyDatasetNotice } from '../components/EmptyDatasetNotice';
import type { DomainPayload, PageId } from '../types';

interface PhysiologicalPageProps {
  data: DomainPayload | null;
  onNavigate: (page: PageId) => void;
}

export const PhysiologicalPage: React.FC<PhysiologicalPageProps> = ({ data, onNavigate }) => {
  const [selectedSubject, setSelectedSubject] = useState<string>('ALL');
  const [selectedFeature, setSelectedFeature] = useState<string>('');

  const analysis = data?.analysis;
  const metadata = data?.metadata;

  const featureList = analysis?.featureColumns || [];
  const activeFeature = useMemo(() => {
    if (selectedFeature && featureList.includes(selectedFeature)) return selectedFeature;
    const preferred = featureList.find((f) => /hr|heart|bpm|ibi|rr|rmssd|sdnn|activity|sleep/i.test(f));
    return preferred || featureList[0] || '';
  }, [featureList, selectedFeature]);

  const subjectOptions = useMemo(() => {
    if (!analysis) return [];
    return Array.from(new Set(analysis.records.map((r) => r.subjectId)));
  }, [analysis]);

  const filteredRecords = useMemo(() => {
    if (!analysis) return [];
    const base =
      selectedSubject === 'ALL'
        ? analysis.records
        : analysis.records.filter((r) => r.subjectId === selectedSubject);
    return base.slice(0, 250);
  }, [analysis, selectedSubject]);

  if (!data?.loaded || !analysis || !metadata) {
    return (
      <EmptyDatasetNotice
        domain="physiological"
        title="Physiological Monitoring (MMASH)"
        description="Upload the MMASH ZIP archive (or extracted physiological CSV / Colab bundle) to inspect heart rate, heart-rate variability, sleep, and physical activity trajectories with Isolation Forest anomaly highlighting."
        expectedFiles={['MMASH dataset (.zip archive)', 'Extracted physiological .csv', 'astrocare_bundle.json']}
        onNavigate={onNavigate}
      />
    );
  }

  const hrCol = featureList.find((f) => /\bhr\b|heart[_\s-]?rate|bpm/i.test(f));
  const hrvCol = featureList.find((f) => /rmssd|sdnn|hrv|nn50|pnn50/i.test(f));
  const sleepCol = featureList.find((f) => /sleep|efficiency|latency|tst|awake/i.test(f));
  const activityCol = featureList.find((f) => /act|step|axis|vm|vector|met|kcal/i.test(f));

  const chartSeries = filteredRecords.map((r) => ({
    index: r.index,
    label: r.timestamp || `#${r.index}`,
    subjectId: r.subjectId,
    value: activeFeature ? r.values[activeFeature] : 0,
    anomalyScore: r.anomalyScore,
    isAnomaly: r.isAnomaly,
    anomalyPoint: r.isAnomaly && activeFeature ? r.values[activeFeature] : null,
  }));

  const featureStats = metadata.columns.find((c) => c.name === activeFeature);

  return (
    <div className="space-y-6">
      {/* Header Metadata & Controls */}
      <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="text-xs font-mono text-cyan-400">
            {metadata.filename} · {metadata.rowCount.toLocaleString()} observations ·{' '}
            {metadata.subjectCount} subject(s)
          </div>
          <p className="text-xs text-slate-400 max-w-2xl">{metadata.provenanceNote}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <span className="text-slate-400">Subject</span>
            <select
              value={selectedSubject}
              onChange={(e) => setSelectedSubject(e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"
            >
              <option value="ALL">All Subjects ({subjectOptions.length})</option>
              {subjectOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 text-xs text-slate-300">
            <span className="text-slate-400">Signal</span>
            <select
              value={activeFeature}
              onChange={(e) => setSelectedFeature(e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-cyan-500 max-w-[220px]"
            >
              {featureList.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {/* Auto-Detected Domain Signals Strip */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {[
          { label: 'Heart Rate Signal', col: hrCol },
          { label: 'HRV Signal', col: hrvCol },
          { label: 'Sleep Metric', col: sleepCol },
          { label: 'Activity Metric', col: activityCol },
        ].map((slot) => {
          const colMeta = slot.col ? metadata.columns.find((c) => c.name === slot.col) : null;
          return (
            <div key={slot.label} className="bg-[#111827] border border-slate-800 rounded-lg p-4">
              <div className="text-xs text-slate-400">{slot.label}</div>
              {colMeta ? (
                <>
                  <div className="mt-1.5 text-xl font-mono font-semibold tabular-nums text-slate-100">
                    {colMeta.mean?.toFixed(2) ?? '—'}
                    {colMeta.unit && (
                      <span className="text-xs text-slate-400 ml-1.5">{colMeta.unit}</span>
                    )}
                  </div>
                  <div className="mt-1 text-xs font-mono text-cyan-400 truncate" title={colMeta.name}>
                    {colMeta.name} (med {colMeta.median?.toFixed(2)})
                  </div>
                </>
              ) : (
                <>
                  <div className="mt-1.5 text-sm font-mono text-slate-500">Not in columns</div>
                  <div className="mt-1 text-xs text-slate-500">
                    Select any detected signal above
                  </div>
                </>
              )}
            </div>
          );
        })}
      </section>

      {/* Primary Signal Trend + Anomaly Overlay */}
      <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">
              Signal Trajectory: {activeFeature}
            </h3>
            <p className="text-xs text-slate-400">
              Showing {filteredRecords.length} observation(s) · Mean{' '}
              <span className="font-mono text-slate-300">
                {featureStats?.mean?.toFixed(3) ?? '—'}
              </span>{' '}
              · Amber markers indicate Isolation Forest flags
            </p>
          </div>
          <div className="text-xs font-mono tabular-nums text-slate-400">
            Anomalies in cohort: {analysis.anomalyCount} ({analysis.anomalyPercentage}%)
          </div>
        </div>

        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartSeries} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" />
              <XAxis dataKey="index" stroke="#94A3B8" fontSize={11} />
              <YAxis stroke="#94A3B8" fontSize={11} domain={['auto', 'auto']} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#0B0E17',
                  borderColor: '#1E293B',
                  fontSize: '12px',
                }}
              />
              {featureStats?.mean !== null && featureStats?.mean !== undefined && (
                <ReferenceLine
                  y={featureStats.mean}
                  stroke="#334155"
                  strokeDasharray="4 4"
                />
              )}
              <Line
                type="monotone"
                dataKey="value"
                name={activeFeature}
                stroke="#06B6D4"
                strokeWidth={1.75}
                dot={(props) => {
                  const { cx, cy, payload } = props;
                  if (payload?.isAnomaly && cx !== undefined && cy !== undefined) {
                    return (
                      <circle
                        key={`anom-${payload.index}`}
                        cx={cx}
                        cy={cy}
                        r={4.5}
                        fill="#F59E0B"
                        stroke="#07090E"
                        strokeWidth={1.5}
                      />
                    );
                  }
                  return <g key={`ok-${payload?.index}`} />;
                }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Anomaly Score Trajectory + ZIP Manifest */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-100">
            Isolation Forest Anomaly Score vs Observation
          </h3>
          <p className="text-xs text-slate-400">
            Threshold = <span className="font-mono text-amber-400">{analysis.thresholdScore}</span>
          </p>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" />
                <XAxis type="number" dataKey="index" name="Obs #" stroke="#94A3B8" fontSize={11} />
                <YAxis
                  type="number"
                  dataKey="anomalyScore"
                  name="Score"
                  stroke="#94A3B8"
                  fontSize={11}
                  domain={['auto', 'auto']}
                />
                <Tooltip
                  cursor={{ strokeDasharray: '3 3' }}
                  contentStyle={{
                    backgroundColor: '#0B0E17',
                    borderColor: '#1E293B',
                    fontSize: '12px',
                  }}
                />
                <ReferenceLine y={analysis.thresholdScore} stroke="#F59E0B" strokeDasharray="4 4" />
                <Scatter
                  name="Normal"
                  data={chartSeries.filter((d) => !d.isAnomaly)}
                  fill="#06B6D4"
                />
                <Scatter
                  name="Flagged"
                  data={chartSeries.filter((d) => d.isAnomaly)}
                  fill="#F59E0B"
                />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-100">
            {metadata.zipManifest ? 'Extracted ZIP Archive Files' : 'Physiological Feature Summary'}
          </h3>
          <div className="overflow-y-auto max-h-60">
            {metadata.zipManifest ? (
              <table className="w-full text-left text-xs font-mono tabular-nums">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-2 pr-3 font-medium">Entry Path</th>
                    <th className="py-2 pr-3 font-medium">Subject</th>
                    <th className="py-2 pr-3 font-medium text-right">Rows</th>
                    <th className="py-2 font-medium text-right">Cols</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {metadata.zipManifest.map((z) => (
                    <tr key={z.path}>
                      <td className="py-1.5 pr-3 text-slate-200 truncate max-w-[200px]" title={z.path}>
                        {z.path}
                      </td>
                      <td className="py-1.5 pr-3 text-cyan-400">{z.inferredSubjectId || '—'}</td>
                      <td className="py-1.5 pr-3 text-right text-slate-300">{z.rowCount}</td>
                      <td className="py-1.5 text-right text-slate-400">{z.columns.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="w-full text-left text-xs font-mono tabular-nums">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-2 pr-3 font-medium">Feature</th>
                    <th className="py-2 pr-3 font-medium text-right">Mean</th>
                    <th className="py-2 pr-3 font-medium text-right">Std</th>
                    <th className="py-2 font-medium text-right">IQR Outliers</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {metadata.columns
                    .filter((c) => c.role === 'feature')
                    .map((c) => (
                      <tr key={c.name}>
                        <td className="py-1.5 pr-3 text-slate-200 truncate max-w-[180px]" title={c.name}>
                          {c.name}
                        </td>
                        <td className="py-1.5 pr-3 text-right text-slate-300">
                          {c.mean?.toFixed(2) ?? '—'}
                        </td>
                        <td className="py-1.5 pr-3 text-right text-slate-400">
                          {c.std?.toFixed(2) ?? '—'}
                        </td>
                        <td className="py-1.5 text-right text-amber-400">{c.iqrOutlierCount}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
