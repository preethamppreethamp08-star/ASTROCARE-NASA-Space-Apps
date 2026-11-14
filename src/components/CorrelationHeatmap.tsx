import React from 'react';
import type { CorrelationMatrixData } from '../types';

interface CorrelationHeatmapProps {
  data: CorrelationMatrixData;
}

function getCorrelationColor(r: number): string {
  // Cyan for positive correlation, Amber/Rose for negative correlation, Slate for near zero
  const clamped = Math.max(-1, Math.min(1, r));
  if (clamped >= 0) {
    const alpha = Math.max(0.08, clamped * 0.78);
    return `rgba(6, 182, 212, ${alpha.toFixed(2)})`;
  }
  const alpha = Math.max(0.08, Math.abs(clamped) * 0.78);
  return `rgba(245, 158, 11, ${alpha.toFixed(2)})`;
}

export const CorrelationHeatmap: React.FC<CorrelationHeatmapProps> = ({ data }) => {
  if (!data || data.features.length === 0) {
    return (
      <div className="text-xs text-slate-500 py-8 text-center">
        Insufficient numeric features to compute a correlation matrix.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>Pearson Correlation Matrix (Top {data.features.length} Features)</span>
        <div className="flex items-center gap-4 font-mono tabular-nums">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 inline-block bg-amber-500/75 rounded-xs" />
            <span>-1.0</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 inline-block bg-slate-800 rounded-xs" />
            <span>0.0</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 inline-block bg-cyan-500/75 rounded-xs" />
            <span>+1.0</span>
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="border-collapse text-xs font-mono tabular-nums">
          <thead>
            <tr>
              <th className="p-1.5 text-left text-slate-500 font-normal min-w-[120px]" />
              {data.features.map((f) => (
                <th
                  key={f}
                  title={f}
                  className="p-1.5 text-center text-slate-400 font-normal max-w-[76px] truncate"
                >
                  {f}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.features.map((rowFeat, rIdx) => (
              <tr key={rowFeat}>
                <td
                  title={rowFeat}
                  className="p-1.5 text-slate-300 font-medium max-w-[140px] truncate pr-3"
                >
                  {rowFeat}
                </td>
                {data.matrix[rIdx].map((val, cIdx) => (
                  <td
                    key={`${rIdx}-${cIdx}`}
                    title={`${rowFeat} vs ${data.features[cIdx]}: r = ${val.toFixed(3)}`}
                    style={{ backgroundColor: getCorrelationColor(val) }}
                    className="p-1.5 text-center text-slate-100 border border-[#07090E] min-w-[54px]"
                  >
                    {val.toFixed(2)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
