import React from 'react';
import {
  Activity,
  ArrowRight,
  Database,
  Droplets,
  FileCode2,
  ShieldAlert,
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
import type { DatasetDomain, DatasetMetadata, OverviewResponse, PageId } from '../types';

interface OverviewPageProps {
  overview: OverviewResponse | null;
  datasets: DatasetMetadata[];
  loading: boolean;
  onNavigate: (page: PageId) => void;
}

const DOMAIN_META: Record<
  DatasetDomain,
  {
    title: string;
    datasetLabel: string;
    targetPage: PageId;
    icon: React.ComponentType<{ className?: string }>;
    scope: string;
  }
> = {
  physiological: {
    title: 'Physiological Monitoring',
    datasetLabel: 'MMASH ZIP / CSV',
    targetPage: 'physiological',
    icon: Activity,
    scope: 'Heart rate, HRV, actigraphy, and sleep window telemetry.',
  },
  cbc: {
    title: 'CBC Blood Biomarkers',
    datasetLabel: 'LSDS-7 Complete Blood Count',
    targetPage: 'cbc',
    icon: Droplets,
    scope: 'Hematology counts, distributions, and robust cohort outlier audit.',
  },
  immune: {
    title: 'Immune Cytokine Panel',
    datasetLabel: 'LSDS-8 Multiplex EvePanel',
    targetPage: 'immune',
    icon: ShieldAlert,
    scope: 'Multiplex serum immune biomarker correlations and anomaly scoring.',
  },
};

export const OverviewPage: React.FC<OverviewPageProps> = ({
  overview,
  datasets,
  loading,
  onNavigate,
}) => {
  if (loading && !overview) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-28 bg-[#111827] border border-slate-800 rounded-lg" />
          ))}
        </div>
        <div className="h-72 bg-[#111827] border border-slate-800 rounded-lg" />
      </div>
    );
  }

  const total = overview?.totalObservations ?? 0;
  const normal = overview?.normalObservations ?? 0;
  const flagged = overview?.flaggedAnomalies ?? 0;
  const pct = overview?.anomalyPercentage ?? 0;

  const chartData = (overview?.modelStatuses || []).map((m) => ({
    name: DOMAIN_META[m.domain].title.split(' ')[0],
    normal: Math.max(0, m.sampleCount - m.anomalyCount),
    anomalies: m.anomalyCount,
  }));

  return (
    <div className="space-y-6">
      {/* Scientific Scope Notice */}
      <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1 max-w-3xl">
          <div className="text-xs font-mono text-cyan-400">
            Research Prototype · Multi-Cohort Biomedical Anomaly Intelligence
          </div>
          <h2 className="text-lg font-semibold text-slate-100 text-balance">
            Independent ML pipeline for physiological, hematological, and immune monitoring
          </h2>
          <p className="text-xs text-slate-400 leading-relaxed">
            ASTROCARE models physiological (ground-based MMASH human cohort), hematological (LSDS-7
            CBC), and immune (LSDS-8 EvePanel) datasets in strictly isolated pipelines without
            cross-study merging. Anomaly flags reflect multivariate statistical isolation rather than
            clinical diagnoses or live flight telemetry.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            onClick={() => onNavigate('data')}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-md transition-colors whitespace-nowrap"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Upload Datasets</span>
          </button>
          <a
            href="/api/notebook/download"
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-md transition-colors whitespace-nowrap"
          >
            <FileCode2 className="w-3.5 h-3.5 text-cyan-400" />
            <span>Colab Notebook</span>
          </a>
        </div>
      </section>

      {/* Primary KPI Strip */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-5">
          <div className="text-xs text-slate-400">Total Processed Observations</div>
          <div className="mt-2 text-3xl font-mono font-semibold tabular-nums text-slate-100">
            {total.toLocaleString()}
          </div>
          <div className="mt-2 text-xs text-slate-500 font-mono tabular-nums">
            Datasets Loaded: {overview?.datasetsLoadedCount ?? 0} of 3
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded-lg p-5">
          <div className="text-xs text-slate-400">Normal-Pattern Observations</div>
          <div className="mt-2 text-3xl font-mono font-semibold tabular-nums text-emerald-400">
            {normal.toLocaleString()}
          </div>
          <div className="mt-2 text-xs text-slate-500 font-mono tabular-nums">
            Within learned Isolation Forest baseline
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded-lg p-5">
          <div className="text-xs text-slate-400">Flagged Statistical Anomalies</div>
          <div className="mt-2 text-3xl font-mono font-semibold tabular-nums text-amber-400">
            {flagged.toLocaleString()}
          </div>
          <div className="mt-2 text-xs text-slate-500 font-mono tabular-nums">
            Multivariate isolation threshold
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded-lg p-5">
          <div className="text-xs text-slate-400">Cohort Anomaly Rate</div>
          <div className="mt-2 text-3xl font-mono font-semibold tabular-nums text-cyan-400">
            {total > 0 ? `${pct.toFixed(2)}%` : '—'}
          </div>
          <div className="mt-2 text-xs text-slate-500 font-mono tabular-nums">
            Models Trained: {overview?.modelsTrainedCount ?? 0} of 3
          </div>
        </div>
      </section>

      {/* Pipeline Status Cards + Observation Distribution */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Isolated Cohort Model Pipelines
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Live training and inspection status per biomedical dataset
              </p>
            </div>
            <button
              onClick={() => onNavigate('performance')}
              className="text-xs text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span>Evaluation Metrics</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="divide-y divide-slate-800/80 border-t border-slate-800/80">
            {(overview?.modelStatuses || []).map((status) => {
              const cfg = DOMAIN_META[status.domain];
              const Icon = cfg.icon;
              return (
                <div
                  key={status.domain}
                  className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="p-2 bg-slate-900 border border-slate-800 rounded-md shrink-0">
                      <Icon className="w-4 h-4 text-cyan-400" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 text-sm font-medium text-slate-100">
                        <span>{cfg.title}</span>
                        <span className="text-slate-600" aria-hidden="true">·</span>
                        <span className="text-xs font-mono text-slate-400">
                          {status.datasetName || cfg.datasetLabel}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">{cfg.scope}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs font-mono tabular-nums text-slate-400">
                        <span
                          className={
                            status.trained ? 'text-emerald-400' : 'text-slate-500'
                          }
                        >
                          {status.trained ? '● Trained' : '○ Awaiting Data'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>Model: {status.modelType}</span>
                        {status.trained && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>
                              {status.sampleCount.toLocaleString()} obs ({status.anomalyCount}{' '}
                              flagged)
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="shrink-0">
                    <button
                      onClick={() =>
                        onNavigate(status.datasetLoaded ? cfg.targetPage : 'data')
                      }
                      className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-md transition-colors whitespace-nowrap"
                    >
                      {status.datasetLoaded ? 'Inspect Cohort' : 'Upload File'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Observations vs Flagged Chart */}
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-5 flex flex-col justify-between space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">
              Cohort Observation Breakdown
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Normal baseline vs flagged anomalies per domain
            </p>
          </div>

          {total > 0 ? (
            <div className="h-60 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 10, right: 10, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" vertical={false} />
                  <XAxis dataKey="name" stroke="#94A3B8" fontSize={11} tickLine={false} />
                  <YAxis stroke="#94A3B8" fontSize={11} tickLine={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0B0E17',
                      borderColor: '#1E293B',
                      fontSize: '12px',
                      color: '#F1F5F9',
                    }}
                  />
                  <Bar dataKey="normal" name="Normal" stackId="a" fill="#06B6D4" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="anomalies" name="Anomalies" stackId="a" fill="#F59E0B" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center py-10 text-center space-y-2 border border-dashed border-slate-800 rounded-md">
              <Database className="w-6 h-6 text-slate-600" />
              <div className="text-xs text-slate-400 max-w-[220px]">
                No dataset observations loaded yet. Upload your MMASH ZIP, LSDS-7 CBC CSV, or
                LSDS-8 Immune CSV to populate live telemetry.
              </div>
            </div>
          )}

          <div className="pt-2 border-t border-slate-800/80 text-xs text-slate-500 flex items-center justify-between font-mono tabular-nums">
            <span>Active Replay: {overview?.simulationRunning ? 'Running' : 'Idle'}</span>
            <button
              onClick={() => onNavigate('simulation')}
              className="text-cyan-400 hover:text-cyan-300 font-sans"
            >
              Open Replay Console
            </button>
          </div>
        </div>
      </section>

      {/* Loaded Dataset Inventory */}
      {datasets.length > 0 && (
        <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-100">Loaded Dataset Registry</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2.5 pr-4 font-medium">Domain</th>
                  <th className="py-2.5 pr-4 font-medium">Source File</th>
                  <th className="py-2.5 pr-4 font-medium text-right">Rows</th>
                  <th className="py-2.5 pr-4 font-medium text-right">Subjects</th>
                  <th className="py-2.5 pr-4 font-medium text-right">Features</th>
                  <th className="py-2.5 pr-4 font-medium">Supervised Labels</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
                {datasets.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-800/30">
                    <td className="py-2.5 pr-4 text-cyan-400 font-sans capitalize">{d.domain}</td>
                    <td className="py-2.5 pr-4 text-slate-200">{d.filename}</td>
                    <td className="py-2.5 pr-4 text-right text-slate-200">
                      {d.rowCount.toLocaleString()}
                    </td>
                    <td className="py-2.5 pr-4 text-right text-slate-200">{d.subjectCount}</td>
                    <td className="py-2.5 pr-4 text-right text-slate-200">{d.columnCount}</td>
                    <td className="py-2.5 pr-4 font-sans text-slate-400">
                      {d.supervisedLabelAudit.hasValidLabels
                        ? d.supervisedLabelAudit.candidateColumns.join(', ')
                        : 'None (Unsupervised)'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
};
