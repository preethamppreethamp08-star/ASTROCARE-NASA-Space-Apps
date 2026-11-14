import React from 'react';
import { Database, FileCode2, Upload } from 'lucide-react';
import type { DatasetDomain, PageId } from '../types';

interface EmptyDatasetNoticeProps {
  domain: DatasetDomain | 'all';
  title: string;
  description: string;
  expectedFiles: string[];
  onNavigate: (page: PageId) => void;
}

export const EmptyDatasetNotice: React.FC<EmptyDatasetNoticeProps> = ({
  title,
  description,
  expectedFiles,
  onNavigate,
}) => {
  return (
    <div className="bg-[#111827] border border-slate-800 rounded-lg p-6 sm:p-8">
      <div className="max-w-2xl space-y-4">
        <div className="flex items-center gap-2.5 text-cyan-400 text-sm font-medium">
          <Database className="w-4 h-4 shrink-0" />
          <span>Awaiting Verified Dataset Upload</span>
        </div>
        <h2 className="text-xl font-semibold text-slate-100 text-balance">{title}</h2>
        <p className="text-sm text-slate-400 leading-relaxed">{description}</p>

        <div className="pt-2 space-y-2">
          <div className="text-xs font-medium text-slate-300">Expected Dataset Artifact(s)</div>
          <ul className="space-y-1.5 text-xs font-mono text-slate-400">
            {expectedFiles.map((file) => (
              <li key={file} className="flex items-center gap-2">
                <span className="text-cyan-400" aria-hidden="true">—</span>
                <span>{file}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="pt-3 flex flex-wrap items-center gap-3">
          <button
            onClick={() => onNavigate('data')}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-md transition-colors whitespace-nowrap"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Open Data Management</span>
          </button>
          <a
            href="/api/notebook/download"
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-md transition-colors whitespace-nowrap"
          >
            <FileCode2 className="w-3.5 h-3.5 text-cyan-400" />
            <span>Download Colab Pipeline (.ipynb)</span>
          </a>
        </div>
      </div>
    </div>
  );
};
