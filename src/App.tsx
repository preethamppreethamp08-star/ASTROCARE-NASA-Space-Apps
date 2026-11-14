import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { Layout } from './components/Layout';
import { AnomaliesPage } from './pages/AnomaliesPage';
import { CbcPage } from './pages/CbcPage';
import { DataManagementPage } from './pages/DataManagementPage';
import { ImmunePage } from './pages/ImmunePage';
import { ModelPerformancePage } from './pages/ModelPerformancePage';
import { OverviewPage } from './pages/OverviewPage';
import { PhysiologicalPage } from './pages/PhysiologicalPage';
import { SimulationPage } from './pages/SimulationPage';
import type {
  DatasetMetadata,
  DomainPayload,
  ModelMetricSummary,
  OverviewResponse,
  PageId,
} from './types';

export default function App() {
  const [activePage, setActivePage] = useState<PageId>('overview');
  const [loading, setLoading] = useState<boolean>(true);
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [datasets, setDatasets] = useState<DatasetMetadata[]>([]);
  const [physiological, setPhysiological] = useState<DomainPayload | null>(null);
  const [cbc, setCbc] = useState<DomainPayload | null>(null);
  const [immune, setImmune] = useState<DomainPayload | null>(null);
  const [models, setModels] = useState<ModelMetricSummary[]>([]);

  const refreshAll = useCallback(async () => {
    try {
      const [ov, ds, phys, cbcRes, immRes, modRes] = await Promise.all([
        api.getOverview(),
        api.getDatasets(),
        api.getPhysiological(),
        api.getCbc(),
        api.getImmune(),
        api.getModelMetrics(),
      ]);
      setOverview(ov);
      setDatasets(ds.datasets);
      setPhysiological(phys);
      setCbc(cbcRes);
      setImmune(immRes);
      setModels(modRes.models);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  return (
    <Layout activePage={activePage} onNavigate={setActivePage} overview={overview}>
      {activePage === 'overview' && (
        <OverviewPage
          overview={overview}
          datasets={datasets}
          loading={loading}
          onNavigate={setActivePage}
        />
      )}
      {activePage === 'physiological' && (
        <PhysiologicalPage data={physiological} onNavigate={setActivePage} />
      )}
      {activePage === 'cbc' && <CbcPage data={cbc} onNavigate={setActivePage} />}
      {activePage === 'immune' && <ImmunePage data={immune} onNavigate={setActivePage} />}
      {activePage === 'anomalies' && (
        <AnomaliesPage
          physiological={physiological}
          cbc={cbc}
          immune={immune}
          onNavigate={setActivePage}
        />
      )}
      {activePage === 'simulation' && (
        <SimulationPage
          physiological={physiological}
          cbc={cbc}
          immune={immune}
          onNavigate={setActivePage}
        />
      )}
      {activePage === 'performance' && (
        <ModelPerformancePage
          models={models}
          onRefresh={refreshAll}
          onNavigate={setActivePage}
        />
      )}
      {activePage === 'data' && (
        <DataManagementPage datasets={datasets} onRefresh={refreshAll} />
      )}
    </Layout>
  );
}
