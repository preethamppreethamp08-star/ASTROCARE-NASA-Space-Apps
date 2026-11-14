import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { astrocareStore } from './ml/pipeline.ts';
import type {
  DatasetDomain,
  ImmuneProcessingMode,
  MmashWindowMode,
} from './ml/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB for full ZIP/CSV biomedical archives
});

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per chunk (well below 32 MB proxy limit)
});

interface PendingChunkedUpload {
  filename: string;
  domain: DatasetDomain;
  mmashWindowMode?: MmashWindowMode;
  mmashWindowSeconds?: number;
  immuneProcessingMode?: ImmuneProcessingMode;
  cbcExcludeSuspectRows?: boolean;
  totalChunks: number;
  chunks: (Buffer | null)[];
  receivedCount: number;
  createdAt: number;
}

const pendingChunkUploads = new Map<string, PendingChunkedUpload>();

function cleanupExpiredChunkUploads() {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [id, item] of pendingChunkUploads.entries()) {
    if (item.createdAt < cutoff) {
      pendingChunkUploads.delete(id);
    }
  }
}

function parseDomain(raw: unknown): DatasetDomain | undefined {
  if (raw === 'physiological' || raw === 'cbc' || raw === 'immune') return raw;
  return undefined;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  // 1. Health endpoint
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'ASTROCARE Backend API',
      runtime: 'Node/Express + TypeScript ML Engine (FastAPI Python counterpart in /backend)',
      timestamp: new Date().toISOString(),
      datasetsLoaded: astrocareStore.getAllMetadata().length,
    });
  });

  // 2. Mission Overview
  app.get('/api/overview', (_req, res) => {
    res.json(astrocareStore.getOverview());
  });

  // 3. Datasets inspection metadata
  app.get('/api/datasets', (_req, res) => {
    res.json({
      datasets: astrocareStore.getAllMetadata(),
    });
  });

  // 4. Physiological data (MMASH)
  app.get('/api/physiological-data', (_req, res) => {
    res.json(astrocareStore.getDomainPayload('physiological'));
  });

  // 5. CBC data (LSDS-7)
  app.get('/api/cbc-data', (_req, res) => {
    res.json(astrocareStore.getDomainPayload('cbc'));
  });

  // 6. Immune biomarker data (LSDS-8)
  app.get('/api/immune-data', (_req, res) => {
    res.json(astrocareStore.getDomainPayload('immune'));
  });

  // 7. Anomalies across domains or filtered
  app.get('/api/anomalies', (req, res) => {
    const domain = parseDomain(req.query.domain);
    const anomalies = astrocareStore.getAllAnomalies(domain);
    res.json({
      count: anomalies.length,
      anomalies,
    });
  });

  // 8. Model performance & evaluation metrics
  app.get('/api/model-metrics', (_req, res) => {
    res.json({
      models: astrocareStore.getModelMetrics(),
    });
  });

  // 9. Run / re-run ML analysis (with optional contamination & pipeline configuration parameters)
  app.post('/api/analyze', (req, res) => {
    try {
      const domain = parseDomain(req.body?.domain);
      const contaminationRaw = Number(req.body?.contamination ?? 0.05);
      const contamination = Number.isFinite(contaminationRaw)
        ? Math.min(0.25, Math.max(0.01, contaminationRaw))
        : 0.05;

      const mmashWindowMode =
        req.body?.mmashWindowMode === 'window_60s' || req.body?.mmashWindowMode === 'epoch_20'
          ? (req.body.mmashWindowMode as MmashWindowMode)
          : undefined;
      const mmashWindowSecondsRaw = Number(req.body?.mmashWindowSeconds);
      const mmashWindowSeconds =
        Number.isFinite(mmashWindowSecondsRaw) && mmashWindowSecondsRaw >= 10
          ? mmashWindowSecondsRaw
          : undefined;
      const immuneProcessingMode =
        req.body?.immuneProcessingMode === 'per_analyte' ||
        req.body?.immuneProcessingMode === 'wide_pivot' ||
        req.body?.immuneProcessingMode === 'pooled'
          ? (req.body.immuneProcessingMode as ImmuneProcessingMode)
          : undefined;
      const cbcExcludeSuspectRows =
        typeof req.body?.cbcExcludeSuspectRows === 'boolean'
          ? req.body.cbcExcludeSuspectRows
          : undefined;

      const results = astrocareStore.analyze(domain, contamination, {
        mmashWindowMode,
        mmashWindowSeconds,
        immuneProcessingMode,
        cbcExcludeSuspectRows,
      });
      res.json({
        status: 'completed',
        contamination,
        pipelineConfig: astrocareStore.pipelineConfig,
        results,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Analysis failed.',
      });
    }
  });

  // 10. Direct Upload CSV, MMASH ZIP, or Colab bundle JSON
  app.post('/api/upload', upload.single('file'), (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file attached. Send multipart field "file".' });
        return;
      }
      const domain = parseDomain(req.body?.domain);
      if (!domain && !req.file.originalname.toLowerCase().endsWith('.json')) {
        res.status(400).json({
          error: 'Valid "domain" field required ("physiological", "cbc", or "immune").',
        });
        return;
      }

      const mmashWindowMode =
        req.body?.mmashWindowMode === 'window_60s' || req.body?.mmashWindowMode === 'epoch_20'
          ? (req.body.mmashWindowMode as MmashWindowMode)
          : undefined;
      const immuneProcessingMode =
        req.body?.immuneProcessingMode === 'per_analyte' ||
        req.body?.immuneProcessingMode === 'wide_pivot' ||
        req.body?.immuneProcessingMode === 'pooled'
          ? (req.body.immuneProcessingMode as ImmuneProcessingMode)
          : undefined;
      const cbcExcludeSuspectRows =
        req.body?.cbcExcludeSuspectRows === 'true'
          ? true
          : req.body?.cbcExcludeSuspectRows === 'false'
          ? false
          : undefined;

      const result = astrocareStore.uploadAndPreprocess(
        req.file.buffer,
        req.file.originalname,
        domain || 'physiological',
        { mmashWindowMode, immuneProcessingMode, cbcExcludeSuspectRows }
      );

      res.json({
        status: 'uploaded_and_analyzed',
        metadata: result.metadata,
        preview: result.preview,
      });
    } catch (err) {
      console.error('[/api/upload error]:', err);
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to parse uploaded dataset.',
      });
    }
  });

  // 10b. Chunked upload endpoint for large archives (>32MB proxy limit safe)
  app.post('/api/upload/chunk', chunkUpload.single('chunk'), (req, res) => {
    try {
      cleanupExpiredChunkUploads();
      if (!req.file) {
        res.status(400).json({ error: 'Missing chunk binary in field "chunk".' });
        return;
      }
      const uploadId = String(req.body?.uploadId || '').trim();
      const filename = String(req.body?.filename || '').trim();
      const domain = parseDomain(req.body?.domain) || 'physiological';
      const chunkIndex = Number(req.body?.chunkIndex);
      const totalChunks = Number(req.body?.totalChunks);

      if (
        !uploadId ||
        !filename ||
        !Number.isInteger(chunkIndex) ||
        !Number.isInteger(totalChunks) ||
        chunkIndex < 0 ||
        totalChunks < 1 ||
        chunkIndex >= totalChunks
      ) {
        res.status(400).json({ error: 'Invalid chunk metadata parameters.' });
        return;
      }

      let entry = pendingChunkUploads.get(uploadId);
      if (!entry) {
        const mmashWindowMode =
          req.body?.mmashWindowMode === 'window_60s' || req.body?.mmashWindowMode === 'epoch_20'
            ? (req.body.mmashWindowMode as MmashWindowMode)
            : undefined;
        const immuneProcessingMode =
          req.body?.immuneProcessingMode === 'per_analyte' ||
          req.body?.immuneProcessingMode === 'wide_pivot' ||
          req.body?.immuneProcessingMode === 'pooled'
            ? (req.body.immuneProcessingMode as ImmuneProcessingMode)
            : undefined;
        entry = {
          filename,
          domain,
          mmashWindowMode,
          immuneProcessingMode,
          totalChunks,
          chunks: new Array<Buffer | null>(totalChunks).fill(null),
          receivedCount: 0,
          createdAt: Date.now(),
        };
        pendingChunkUploads.set(uploadId, entry);
      }

      if (entry.chunks[chunkIndex] === null) {
        entry.receivedCount += 1;
      }
      entry.chunks[chunkIndex] = req.file.buffer;

      res.json({
        status: 'chunk_received',
        uploadId,
        chunkIndex,
        receivedCount: entry.receivedCount,
        totalChunks: entry.totalChunks,
      });
    } catch (err) {
      console.error('[/api/upload/chunk error]:', err);
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to receive upload chunk.',
      });
    }
  });

  app.post('/api/upload/complete', (req, res) => {
    try {
      const uploadId = String(req.body?.uploadId || '').trim();
      const entry = pendingChunkUploads.get(uploadId);
      if (!entry) {
        res.status(404).json({ error: 'Chunked upload session not found or expired.' });
        return;
      }
      if (entry.receivedCount < entry.totalChunks || entry.chunks.some((c) => c === null)) {
        res.status(400).json({
          error: `Upload incomplete: received ${entry.receivedCount} of ${entry.totalChunks} chunks.`,
        });
        return;
      }

      pendingChunkUploads.delete(uploadId);
      const fullBuffer = Buffer.concat(entry.chunks as Buffer[]);
      const result = astrocareStore.uploadAndPreprocess(
        fullBuffer,
        entry.filename,
        entry.domain,
        {
          mmashWindowMode: entry.mmashWindowMode,
          immuneProcessingMode: entry.immuneProcessingMode,
          cbcExcludeSuspectRows: entry.cbcExcludeSuspectRows,
        }
      );

      res.json({
        status: 'uploaded_and_analyzed',
        metadata: result.metadata,
        preview: result.preview,
      });
    } catch (err) {
      console.error('[/api/upload/complete error]:', err);
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to assemble and process uploaded archive.',
      });
    }
  });

  // 11. Simulation / historical replay controls
  app.post('/api/simulation/start', (req, res) => {
    try {
      const domain = parseDomain(req.body?.domain);
      const intervalMs = Number(req.body?.intervalMs ?? 1000);
      const state = astrocareStore.startSimulation(domain, intervalMs);
      res.json(state);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Could not start replay.',
      });
    }
  });

  app.post('/api/simulation/stop', (_req, res) => {
    res.json(astrocareStore.stopSimulation());
  });

  app.post('/api/simulation/reset', (_req, res) => {
    res.json(astrocareStore.resetSimulation());
  });

  app.get('/api/simulation/state', (_req, res) => {
    res.json(astrocareStore.simulation);
  });

  // 12. Download Google Colab Notebook directly from UI
  app.get('/api/notebook/download', (_req, res) => {
    const nbPath = path.join(__dirname, 'notebooks', 'ASTROCARE_COMPLETE_ML_PIPELINE.ipynb');
    if (!fs.existsSync(nbPath)) {
      res.status(404).json({ error: 'Colab notebook not found.' });
      return;
    }
    res.download(nbPath, 'ASTROCARE_COMPLETE_ML_PIPELINE.ipynb');
  });

  // Ensure unmatched /api/* routes ALWAYS return JSON 404 instead of falling through to Vite SPA HTML
  app.all('/api/*', (req, res) => {
    res.status(404).json({
      error: `API endpoint not found: ${req.method} ${req.originalUrl}`,
    });
  });

  // Global JSON error middleware (catches MulterError, PayloadTooLarge, JSON syntax errors, etc.)
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    console.error(`[Express Error] ${req.method} ${req.originalUrl}:`, err);
    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      res.status(status).json({
        error: `Upload error (${err.code}): ${err.message}`,
      });
      return;
    }
    const statusCode =
      typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status: unknown }).status === 'number'
        ? (err as { status: number }).status
        : 500;
    const message = err instanceof Error ? err.message : 'Internal server error.';
    res.status(statusCode).json({ error: message });
  });

  // Vite middleware in development, static files in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ASTROCARE server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
