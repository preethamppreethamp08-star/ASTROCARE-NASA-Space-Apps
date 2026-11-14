import React, { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Cpu,
  Database,
  Droplets,
  LayoutDashboard,
  Menu,
  Radio,
  ShieldAlert,
  Upload,
  X,
} from 'lucide-react';
import type { OverviewResponse, PageId } from '../types';

interface LayoutProps {
  activePage: PageId;
  onNavigate: (page: PageId) => void;
  overview: OverviewResponse | null;
  children: React.ReactNode;
}

const NAV_ITEMS: { id: PageId; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'overview', label: 'Mission Overview', icon: LayoutDashboard },
  { id: 'physiological', label: 'Physiological Monitoring', icon: Activity },
  { id: 'cbc', label: 'CBC Analysis', icon: Droplets },
  { id: 'immune', label: 'Immune Biomarkers', icon: ShieldAlert },
  { id: 'anomalies', label: 'AI Anomaly Detection', icon: AlertTriangle },
  { id: 'simulation', label: 'Simulated Monitoring', icon: Radio },
  { id: 'performance', label: 'Model Performance', icon: BarChart3 },
  { id: 'data', label: 'Data Management', icon: Database },
];

export const Layout: React.FC<LayoutProps> = ({
  activePage,
  onNavigate,
  overview,
  children,
}) => {
  const [mobileOpen, setMobileOpen] = useState(false);

  const currentNav = NAV_ITEMS.find((n) => n.id === activePage) || NAV_ITEMS[0];

  const handleNav = (id: PageId) => {
    onNavigate(id);
    setMobileOpen(false);
  };

  return (
    <div className="min-h-screen bg-[#07090E] text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 bg-[#0B0E17] border-r border-slate-800/80 z-30">
        <div className="px-6 py-5 border-b border-slate-800/80">
          <div className="text-lg font-semibold tracking-tight text-slate-100">ASTROCARE</div>
          <div className="text-xs text-cyan-400 tracking-wide mt-0.5">
            Space Health Intelligence
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto" aria-label="Primary Navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = item.id === activePage;
            return (
              <button
                key={item.id}
                onClick={() => handleNav(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 text-left ${
                  active
                    ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/30'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/50 border border-transparent'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-cyan-400' : 'text-slate-500'}`} />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="px-5 py-4 border-t border-slate-800/80 text-xs text-slate-400 space-y-2">
          <div className="flex items-center gap-2 text-slate-300 font-medium">
            <Cpu className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span>Research Prototype</span>
          </div>
          <p className="leading-relaxed text-slate-500">
            Independent ML research prototype. Not a NASA-endorsed product or medical diagnostic device.
          </p>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative w-72 max-w-[85vw] bg-[#0B0E17] border-r border-slate-800 flex flex-col z-10">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <div className="text-base font-semibold text-slate-100">ASTROCARE</div>
                <div className="text-xs text-cyan-400">Space Health Intelligence</div>
              </div>
              <button
                onClick={() => setMobileOpen(false)}
                className="p-2 text-slate-400 hover:text-slate-100"
                aria-label="Close navigation menu"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = item.id === activePage;
                return (
                  <button
                    key={item.id}
                    onClick={() => handleNav(item.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap text-left ${
                      active
                        ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/30'
                        : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/50 border border-transparent'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        {/* Clean 3-Zone Top Header */}
        <header className="sticky top-0 z-20 bg-[#0B0E17]/95 backdrop-blur border-b border-slate-800/80 px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between gap-6">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-400 hover:text-slate-100"
              aria-label="Open navigation menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-500 hidden sm:inline">ASTROCARE</span>
              <span className="text-slate-600 hidden sm:inline" aria-hidden="true">/</span>
              <h1 className="font-semibold text-slate-100 truncate">{currentNav.label}</h1>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-3 text-xs text-slate-400 font-mono tabular-nums whitespace-nowrap">
            <span>
              Observations:{' '}
              <strong className="text-slate-200 font-medium">
                {overview ? overview.totalObservations.toLocaleString() : '0'}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Flagged:{' '}
              <strong className="text-amber-400 font-medium">
                {overview ? overview.flaggedAnomalies.toLocaleString() : '0'}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Models Trained:{' '}
              <strong className="text-cyan-400 font-medium">
                {overview ? `${overview.modelsTrainedCount}/3` : '0/3'}
              </strong>
            </span>
          </div>

          <div className="shrink-0">
            <button
              onClick={() => handleNav('data')}
              className="inline-flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Upload Dataset</span>
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1440px] w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
};
