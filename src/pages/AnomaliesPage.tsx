import React, { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { EmptyDatasetNotice } from '../components/EmptyDatasetNotice';
import type {
  AnalyzedObservation,
  DatasetDomain,
  DomainPayload,
  PageId,
} from '../types';

interface AnomaliesPageProps {
  physiological: DomainPayload | null;
  cbc: DomainPayload | null;
  immune: DomainPayload | null;
  onNavigate: (page: PageId) => void;
}

export const AnomaliesPage: React.FC<AnomaliesPageProps> = ({
  physiological,
  cbc,
  immune,
  onNavigate,
}) => {
  const [domainFilter, setDomainFilter] = useState<'all' | DatasetDomain>('all');
  const [onlyFlagged, setOnlyFlagged] = useState<boolean>(true);
  const [selectedKey, setSelectedKey] = useState<string>('');

  const combinedObservations = useMemo(() => {
    const out: (AnalyzedObservation & { domain: DatasetDomain; uid: string })[] = [];
    const pairs: [DatasetDomain, DomainPayload | null][] = [
      ['physiological', physiological],
      ['cbc', cbc],
      ['immune', immune],
    ];
    for (const [d, payload] of pairs) {
      if (domainFilter !== 'all' && d !== domainFilter) continue;
      if (!payload?.analysis) continue;
      for (const r of payload.analysis.records) {
        if (onlyFlagged && !r.isAnomaly && !r.baselineFlag) continue;
        out.push({ ...r, domain: d, uid: `${d}_${r.index}` });
      }
    }
    out.sort((a, b) => b.anomalyScore - a.anomalyScore);
    return out;
  }, [physiological, cbc, immune, domainFilter, onlyFlagged]);

  const anyLoaded = Boolean(physiological?.loaded || cbc?.loaded || immune?.loaded);

  if (!anyLoaded) {
    return (
      <EmptyDatasetNotice
        domain="all"
        title="AI Anomaly Detection & Explainable AI"
        description="Upload at least one dataset (MMASH ZIP, LSDS-7 CBC CSV, or LSDS-8 Immune CSV) to run Isolation Forest anomaly scoring, baseline comparison, and per-observation feature-contribution explanations."
        expectedFiles={[
          'MMASH ZIP / CSV',
          'LSDS-7_Complete_Blood_Count_CBC_TRANSFORMED.csv',
          'LSDS-8_Multiplex_serum.immune.EvePanel_SUBMITTED.csv',
        ]}
        onNavigate={onNavigate}
      />
    );
  }

  const activeObs =
    combinedObservations.find((o) => o.uid === selectedKey) || combinedObservations[0] || null;

  return (
    <div className="space-y-6">
      {/* Filter & Explanation Header */}
      <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-slate-100">
            Multivariate Isolation Forest & Explainable Feature Attribution
          </h2>
          <p className="text-xs text-slate-400">
            Select any observation to inspect feature-level tree isolation contributions and
            standardized cohort deviations. Flags denote statistical anomalies, not medical
            diagnoses.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-md">
            {(['all', 'physiological', 'cbc', 'immune'] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDomainFilter(d)}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors capitalize whitespace-nowrap ${
                  domainFilter === d
                    ? 'bg-cyan-500 text-slate-950'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {d}
              </button>
            ))}
          </div>

          <button
            onClick={() => setOnlyFlagged((v) => !v)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap ${
              onlyFlagged
                ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                : 'bg-slate-900 text-slate-300 border-slate-700'
            }`}
          >
            {onlyFlagged ? 'Showing Flagged Only' : 'Showing All Observations'}
          </button>
        </div>
      </section>

      {/* Main Split: Flagged Table + Individual Explainability Inspector */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6 bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-100">
              Ranked Observations ({combinedObservations.length})
            </span>
            <span className="text-slate-400 font-mono">Sorted by Isolation Score</span>
          </div>

          <div className="overflow-y-auto max-h-[540px]">
            <table className="w-full text-left text-xs font-mono tabular-nums">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2 pr-2 font-medium font-sans">Cohort</th>
                  <th className="py-2 pr-2 font-medium font-sans">Subject</th>
                  <th className="py-2 pr-2 font-medium text-right">IF Score</th>
                  <th className="py-2 pr-2 font-medium text-right">MAD |M|</th>
                  <th className="py-2 font-medium font-sans text-right">Classification</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {combinedObservations.slice(0, 150).map((obs) => {
                  const isSel = activeObs?.uid === obs.uid;
                  return (
                    <tr
                      key={obs.uid}
                      onClick={() => setSelectedKey(obs.uid)}
                      className={`cursor-pointer transition-colors ${
                        isSel ? 'bg-cyan-500/15' : 'hover:bg-slate-800/40'
                      }`}
                    >
                      <td className="py-2 pr-2 font-sans capitalize text-slate-300">
                        {obs.domain}
                      </td>
                      <td className="py-2 pr-2 text-slate-100 truncate max-w-[120px]">
                        {obs.subjectId} #{obs.index}
                      </td>
                      <td className="py-2 pr-2 text-right text-cyan-300">
                        {obs.anomalyScore.toFixed(3)}
                      </td>
                      <td className="py-2 pr-2 text-right text-slate-300">
                        {obs.baselineMaxModifiedZ.toFixed(2)}
                      </td>
                      <td className="py-2 text-right font-sans">
                        {obs.isAnomaly ? (
                          <span className="text-amber-400 font-medium">▲ Flagged</span>
                        ) : obs.baselineFlag ? (
                          <span className="text-cyan-400">● MAD Flag</span>
                        ) : (
                          <span className="text-emerald-400">● Nominal</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {combinedObservations.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-500 font-sans">
                      No observations matched the selected filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Explainable AI Inspector */}
        <div className="lg:col-span-6 bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-5">
          {activeObs ? (
            <>
              <div className="space-y-2 border-b border-slate-800 pb-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-slate-100">
                    Observation #{activeObs.index} · {activeObs.subjectId}
                  </div>
                  <div className="text-xs font-mono tabular-nums text-slate-400">
                    Cohort: <span className="text-cyan-400 capitalize">{activeObs.domain}</span> ·
                    Score:{' '}
                    <span className="text-amber-400 font-semibold">
                      {activeObs.anomalyScore.toFixed(4)}
                    </span>
                  </div>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed bg-[#0B0E17] border border-slate-800 rounded-md p-3">
                  {activeObs.explanation}
                </p>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-slate-300">
                  Local Feature Attribution (% Contribution to Isolation Depth)
                </div>
                <div className="h-56 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={activeObs.featureContributions.slice(0, 8)}
                      layout="vertical"
                      margin={{ top: 4, right: 16, left: 20, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" horizontal={false} />
                      <XAxis type="number" stroke="#94A3B8" fontSize={11} unit="%" />
                      <YAxis
                        type="category"
                        dataKey="feature"
                        stroke="#94A3B8"
                        fontSize={11}
                        width={110}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#0B0E17',
                          borderColor: '#1E293B',
                          fontSize: '12px',
                        }}
                      />
                      <Bar dataKey="contributionPct" name="Attribution %" radius={[0, 3, 3, 0]}>
                        {activeObs.featureContributions.slice(0, 8).map((entry) => (
                          <Cell
                            key={entry.feature}
                            fill={
                              entry.direction === 'elevated'
                                ? '#F59E0B'
                                : entry.direction === 'depressed'
                                ? '#06B6D4'
                                : '#3B82F6'
                            }
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono tabular-nums">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400">
                      <th className="py-2 pr-3 font-sans font-medium">Feature</th>
                      <th className="py-2 pr-3 text-right font-medium">Observed</th>
                      <th className="py-2 pr-3 text-right font-medium">Cohort Mean</th>
                      <th className="py-2 pr-3 text-right font-medium">Z-Score</th>
                      <th className="py-2 text-right font-medium">Attribution</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {activeObs.featureContributions.slice(0, 10).map((fc) => (
                      <tr key={fc.feature}>
                        <td className="py-1.5 pr-3 text-slate-200 truncate max-w-[150px]">
                          {fc.feature}
                        </td>
                        <td className="py-1.5 pr-3 text-right text-slate-100">
                          {fc.value.toFixed(3)}
                        </td>
                        <td className="py-1.5 pr-3 text-right text-slate-400">
                          {fc.cohortMean.toFixed(3)}
                        </td>
                        <td
                          className={`py-1.5 pr-3 text-right ${
                            Math.abs(fc.zScore) >= 2 ? 'text-amber-400' : 'text-slate-300'
                          }`}
                        >
                          {fc.zScore >= 0 ? '+' : ''}
                          {fc.zScore.toFixed(2)}
                        </td>
                        <td className="py-1.5 text-right text-cyan-400">
                          {fc.contributionPct.toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="py-16 text-center text-xs text-slate-500">
              Select an observation from the left table to inspect Explainable AI feature drivers.
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
