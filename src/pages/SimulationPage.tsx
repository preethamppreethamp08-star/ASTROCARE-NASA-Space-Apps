import React, { useEffect, useState } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api';
import { EmptyDatasetNotice } from '../components/EmptyDatasetNotice';
import type {
  DatasetDomain,
  DomainPayload,
  PageId,
  SimulationState,
} from '../types';

interface SimulationPageProps {
  physiological: DomainPayload | null;
  cbc: DomainPayload | null;
  immune: DomainPayload | null;
  onNavigate: (page: PageId) => void;
}

export const SimulationPage: React.FC<SimulationPageProps> = ({
  physiological,
  cbc,
  immune,
  onNavigate,
}) => {
  const availableDomains: DatasetDomain[] = (
    [
      ['physiological', physiological],
      ['cbc', cbc],
      ['immune', immune],
    ] as [DatasetDomain, DomainPayload | null][]
  )
    .filter(([, p]) => Boolean(p?.loaded && p.analysis))
    .map(([d]) => d);

  const [selectedDomain, setSelectedDomain] = useState<DatasetDomain>(
    availableDomains[0] || 'physiological'
  );
  const [intervalMs, setIntervalMs] = useState<number>(1000);
  const [simState, setSimState] = useState<SimulationState | null>(null);
  const [selectedSignal, setSelectedSignal] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (availableDomains.length > 0 && !availableDomains.includes(selectedDomain)) {
      setSelectedDomain(availableDomains[0]);
    }
  }, [availableDomains, selectedDomain]);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const s = await api.getSimulationState();
        if (active) setSimState(s);
      } catch {
        // Ignore transient poll errors
      }
    };
    poll();
    const timer = setInterval(poll, 700);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  if (availableDomains.length === 0) {
    return (
      <EmptyDatasetNotice
        domain="all"
        title="Simulated Sensor Replay"
        description="Simulated monitoring replays historical observations sequentially through the trained Isolation Forest model. Upload at least one dataset first so real recorded observations can be replayed."
        expectedFiles={['MMASH ZIP / CSV', 'LSDS-7 CBC CSV', 'LSDS-8 Immune CSV']}
        onNavigate={onNavigate}
      />
    );
  }

  const activePayload =
    selectedDomain === 'physiological'
      ? physiological
      : selectedDomain === 'cbc'
      ? cbc
      : immune;
  const features = activePayload?.analysis?.featureColumns || [];
  const signalKey =
    selectedSignal && features.includes(selectedSignal) ? selectedSignal : features[0] || '';

  const handleStart = async () => {
    setErrorMsg(null);
    try {
      const s = await api.startSimulation(selectedDomain, intervalMs);
      setSimState(s);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to start replay.');
    }
  };

  const handleStop = async () => {
    setErrorMsg(null);
    try {
      const s = await api.stopSimulation();
      setSimState(s);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to stop replay.');
    }
  };

  const handleReset = async () => {
    setErrorMsg(null);
    try {
      const s = await api.resetSimulation();
      setSimState(s);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to reset replay.');
    }
  };

  const chartPoints = (simState?.history || []).map((obs) => ({
    index: obs.index,
    anomalyScore: obs.anomalyScore,
    signalValue: signalKey ? obs.values[signalKey] : 0,
    isAnomaly: obs.isAnomaly,
  }));

  const latestObs =
    simState && simState.history.length > 0
      ? simState.history[simState.history.length - 1]
      : null;

  return (
    <div className="space-y-6">
      {/* Clear Telemetry Distinction Banner */}
      <section className="bg-[#111827] border border-amber-500/30 rounded-lg p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1 max-w-2xl">
          <div className="text-xs font-mono text-amber-400">
            Historical Dataset Replay · Not Live Astronaut Flight Telemetry
          </div>
          <h2 className="text-sm font-semibold text-slate-100">
            Sequential Observation Stream & Real-Time Anomaly Scoring
          </h2>
          <p className="text-xs text-slate-400">
            Replays preprocessed historical observations sequentially from the loaded dataset. Alerts
            indicate statistical Isolation Forest deviations, not live spacecraft hardware feeds or
            clinical diagnoses.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <select
            value={selectedDomain}
            onChange={(e) => setSelectedDomain(e.target.value as DatasetDomain)}
            disabled={simState?.running}
            className="bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-xs text-slate-100 disabled:opacity-50"
          >
            {availableDomains.map((d) => (
              <option key={d} value={d}>
                Cohort: {d}
              </option>
            ))}
          </select>

          <select
            value={intervalMs}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
            disabled={simState?.running}
            className="bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-xs text-slate-100 disabled:opacity-50"
          >
            <option value={500}>0.5s / step</option>
            <option value={1000}>1.0s / step</option>
            <option value={2000}>2.0s / step</option>
          </select>

          {!simState?.running ? (
            <button
              onClick={handleStart}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-md transition-colors whitespace-nowrap"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Start Monitoring</span>
            </button>
          ) : (
            <button
              onClick={handleStop}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-md transition-colors whitespace-nowrap"
            >
              <Pause className="w-3.5 h-3.5" />
              <span>Pause Monitoring</span>
            </button>
          )}

          <button
            onClick={handleReset}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-md transition-colors whitespace-nowrap"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset</span>
          </button>
        </div>
      </section>

      {errorMsg && (
        <div className="bg-rose-500/10 border border-rose-500/40 rounded-md px-4 py-3 text-xs text-rose-300">
          {errorMsg}
        </div>
      )}

      {/* Live Replay Readout Strip */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4">
          <div className="text-xs text-slate-400">Replay Engine State</div>
          <div className="mt-1.5 text-xl font-mono font-semibold text-slate-100 flex items-center gap-2">
            {simState?.running ? (
              <span className="text-emerald-400">● Replaying</span>
            ) : (
              <span className="text-slate-400">○ Paused / Idle</span>
            )}
          </div>
          <div className="mt-1 text-xs font-mono tabular-nums text-slate-500">
            Cursor: {simState?.cursorIndex ?? 0} / {simState?.totalRecords ?? 0}
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4">
          <div className="text-xs text-slate-400">Current Subject</div>
          <div className="mt-1.5 text-xl font-mono font-semibold text-cyan-400 truncate">
            {latestObs ? latestObs.subjectId : '—'}
          </div>
          <div className="mt-1 text-xs font-mono tabular-nums text-slate-500">
            Observation #{latestObs ? latestObs.index : '—'}
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4">
          <div className="text-xs text-slate-400">Latest Isolation Score</div>
          <div
            className={`mt-1.5 text-xl font-mono font-semibold tabular-nums ${
              latestObs?.isAnomaly ? 'text-amber-400' : 'text-slate-100'
            }`}
          >
            {latestObs ? latestObs.anomalyScore.toFixed(4) : '—'}
          </div>
          <div className="mt-1 text-xs font-mono text-slate-500">
            {latestObs
              ? latestObs.isAnomaly
                ? '▲ Anomaly Flagged'
                : '● Nominal Pattern'
              : 'Press Start Monitoring'}
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded-lg p-4">
          <div className="text-xs text-slate-400">Monitored Signal Channel</div>
          <select
            value={signalKey}
            onChange={(e) => setSelectedSignal(e.target.value)}
            className="mt-1.5 w-full bg-slate-900 border border-slate-700 rounded-md px-2 py-1 text-xs font-mono text-slate-100"
          >
            {features.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <div className="mt-1 text-xs font-mono tabular-nums text-slate-400">
            Value: {latestObs && signalKey ? latestObs.values[signalKey]?.toFixed(3) : '—'}
          </div>
        </div>
      </section>

      {/* Dynamic Replay Charts */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-100">
            Dynamic Signal Stream ({signalKey})
          </h3>
          <div className="h-60 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartPoints} margin={{ top: 10, right: 12, left: -10, bottom: 0 }}>
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
                <Line
                  type="monotone"
                  dataKey="signalValue"
                  name={signalKey}
                  stroke="#06B6D4"
                  strokeWidth={2}
                  isAnimationActive={false}
                  dot={(p) =>
                    p.payload?.isAnomaly && p.cx !== undefined && p.cy !== undefined ? (
                      <circle
                        key={`s-${p.payload.index}`}
                        cx={p.cx}
                        cy={p.cy}
                        r={4.5}
                        fill="#F59E0B"
                      />
                    ) : (
                      <g key={`n-${p.payload?.index}`} />
                    )
                  }
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-100">
            Streaming Isolation Forest Anomaly Score
          </h3>
          <div className="h-60 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartPoints} margin={{ top: 10, right: 12, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" />
                <XAxis dataKey="index" stroke="#94A3B8" fontSize={11} />
                <YAxis stroke="#94A3B8" fontSize={11} domain={[0.25, 0.85]} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0B0E17',
                    borderColor: '#1E293B',
                    fontSize: '12px',
                  }}
                />
                {activePayload?.analysis?.thresholdScore && (
                  <ReferenceLine
                    y={activePayload.analysis.thresholdScore}
                    stroke="#F59E0B"
                    strokeDasharray="4 4"
                  />
                )}
                <Line
                  type="monotone"
                  dataKey="anomalyScore"
                  name="Anomaly Score"
                  stroke="#F59E0B"
                  strokeWidth={2}
                  isAnimationActive={false}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* Event Logs & Alert Notifications */}
      <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-100">
            Replay Event Log & Anomaly Alerts
          </h3>
          <span className="text-xs font-mono text-slate-400">
            {simState?.events.length ?? 0} recent events
          </span>
        </div>
        <div className="max-h-60 overflow-y-auto divide-y divide-slate-800/60 font-mono text-xs tabular-nums">
          {(simState?.events || []).map((evt) => (
            <div key={evt.id} className="py-2 flex flex-col sm:flex-row sm:items-center gap-2">
              <span className="text-slate-500 shrink-0">
                {new Date(evt.timestamp).toLocaleTimeString()}
              </span>
              <span
                className={`shrink-0 font-sans font-medium ${
                  evt.severity === 'anomaly'
                    ? 'text-amber-400'
                    : evt.severity === 'warning'
                    ? 'text-cyan-400'
                    : 'text-emerald-400'
                }`}
              >
                {evt.severity === 'anomaly'
                  ? '▲ ANOMALY'
                  : evt.severity === 'warning'
                  ? '▲ MAD BASELINE'
                  : '● NOMINAL'}
              </span>
              <span className="text-slate-200 font-sans">{evt.message}</span>
            </div>
          ))}
          {(!simState || simState.events.length === 0) && (
            <div className="py-8 text-center text-slate-500 font-sans">
              Press "Start Monitoring" to begin sequential historical replay.
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
