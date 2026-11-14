import type {
  AnalyzedObservation,
  DatasetDomain,
  DatasetMetadata,
  DomainPayload,
  ModelMetricSummary,
  OverviewResponse,
  SimulationState,
} from './types';

const CHUNK_THRESHOLD_BYTES = 15 * 1024 * 1024; // 15 MB (safely below 32 MB proxy limit)
const CHUNK_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB per chunk

async function parseApiResponse<T>(res: Response): Promise<T> {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const rawText = await res.text();

  const looksLikeHtml =
    contentType.includes('text/html') || /^\s*<(?:!doctype|html)/i.test(rawText);

  if (looksLikeHtml) {
    if (res.status === 413) {
      throw new Error(
        'Upload rejected by reverse proxy (HTTP 413 Request Entity Too Large). Retry so ASTROCARE uses chunked upload.'
      );
    }
    throw new Error(
      `API returned HTML instead of JSON (HTTP ${res.status} from ${res.url || 'server'}). The request may have hit a proxy error page or SPA fallback.`
    );
  }

  let parsed: unknown = null;
  if (rawText.trim().length > 0) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error(
        `Invalid JSON response from server (HTTP ${res.status}): ${rawText.slice(0, 140)}`
      );
    }
  }

  if (!res.ok) {
    const errMsg =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : parsed && typeof parsed === 'object' && 'detail' in parsed
        ? String((parsed as { detail: unknown }).detail)
        : `Request failed (HTTP ${res.status})`;
    throw new Error(errMsg);
  }

  return parsed as T;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  return parseApiResponse<T>(res);
}

export interface UploadResponse {
  status: string;
  metadata: DatasetMetadata;
  preview: Record<string, unknown>[];
}

export const api = {
  getOverview: () => requestJson<OverviewResponse>('/api/overview'),
  getDatasets: () => requestJson<{ datasets: DatasetMetadata[] }>('/api/datasets'),
  getPhysiological: () => requestJson<DomainPayload>('/api/physiological-data'),
  getCbc: () => requestJson<DomainPayload>('/api/cbc-data'),
  getImmune: () => requestJson<DomainPayload>('/api/immune-data'),
  getAnomalies: (domain?: DatasetDomain) =>
    requestJson<{ count: number; anomalies: (AnalyzedObservation & { domain: DatasetDomain })[] }>(
      domain ? `/api/anomalies?domain=${domain}` : '/api/anomalies'
    ),
  getModelMetrics: () => requestJson<{ models: ModelMetricSummary[] }>('/api/model-metrics'),
  runAnalyze: (
    domain?: DatasetDomain,
    contamination = 0.05,
    config?: {
      mmashWindowMode?: 'window_60s' | 'epoch_20';
      mmashWindowSeconds?: number;
      immuneProcessingMode?: 'per_analyte' | 'wide_pivot' | 'pooled';
      cbcExcludeSuspectRows?: boolean;
    }
  ) =>
    requestJson<{ status: string; contamination: number }>('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, contamination, ...config }),
    }),
  uploadDataset: async (
    file: File,
    domain: DatasetDomain,
    config?: {
      mmashWindowMode?: 'window_60s' | 'epoch_20';
      immuneProcessingMode?: 'per_analyte' | 'wide_pivot' | 'pooled';
      cbcExcludeSuspectRows?: boolean;
    }
  ): Promise<UploadResponse> => {
    // Standard single-POST FormData upload for files <= 15 MB
    if (file.size <= CHUNK_THRESHOLD_BYTES) {
      const form = new FormData();
      form.append('file', file);
      form.append('domain', domain);
      if (config?.mmashWindowMode) form.append('mmashWindowMode', config.mmashWindowMode);
      if (config?.immuneProcessingMode) form.append('immuneProcessingMode', config.immuneProcessingMode);
      if (typeof config?.cbcExcludeSuspectRows === 'boolean') {
        form.append('cbcExcludeSuspectRows', String(config.cbcExcludeSuspectRows));
      }
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: form,
      });
      return parseApiResponse<UploadResponse>(res);
    }

    // Transparent chunked upload for large archives (e.g. >15 MB MMASH ZIP) to bypass 32 MB proxy limits
    const uploadId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE_BYTES);

    for (let idx = 0; idx < totalChunks; idx++) {
      const start = idx * CHUNK_SIZE_BYTES;
      const end = Math.min(file.size, start + CHUNK_SIZE_BYTES);
      const slice = file.slice(start, end);

      const form = new FormData();
      form.append('chunk', slice, file.name);
      form.append('uploadId', uploadId);
      form.append('filename', file.name);
      form.append('domain', domain);
      if (config?.mmashWindowMode) form.append('mmashWindowMode', config.mmashWindowMode);
      if (config?.immuneProcessingMode) form.append('immuneProcessingMode', config.immuneProcessingMode);
      form.append('chunkIndex', String(idx));
      form.append('totalChunks', String(totalChunks));

      const chunkRes = await fetch('/api/upload/chunk', {
        method: 'POST',
        body: form,
      });
      await parseApiResponse<{ status: string }>(chunkRes);
    }

    const completeRes = await fetch('/api/upload/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
    return parseApiResponse<UploadResponse>(completeRes);
  },
  startSimulation: (domain?: DatasetDomain, intervalMs = 1000) =>
    requestJson<SimulationState>('/api/simulation/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, intervalMs }),
    }),
  stopSimulation: () =>
    requestJson<SimulationState>('/api/simulation/stop', {
      method: 'POST',
    }),
  resetSimulation: () =>
    requestJson<SimulationState>('/api/simulation/reset', {
      method: 'POST',
    }),
  getSimulationState: () => requestJson<SimulationState>('/api/simulation/state'),
};
