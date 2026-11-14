# ASTROCARE System Architecture

## Overview
ASTROCARE is a dual-runtime full-stack biomedical anomaly intelligence system designed for independent multi-cohort research (MMASH physiological monitoring, LSDS-7 CBC hematology, and LSDS-8 Multiplex Immune EvePanel).

## Components

1. **Interactive Web Dashboard (`/src`)**
   - Built with React 19, TypeScript, Tailwind CSS v4, and Recharts.
   - 8 mission-control pages: Mission Overview, Physiological Monitoring, CBC Analysis, Immune Biomarkers, AI Anomaly Detection, Simulated Monitoring, Model Performance, and Data Management.
   - Enforces zero fabricated metrics: displays honest empty/awaiting-dataset notices until real CSV/ZIP files or Colab bundles are uploaded.

2. **Live Full-Stack Preview Server (`/server.ts` & `/ml`)**
   - Express + Vite middleware server listening on port 3000.
   - Implements real server-side ZIP extraction (`adm-zip`), CSV parsing (`csv-parse`), preprocessing, deterministic-seeded Isolation Forest ensembles, Modified Z-Score (MAD) baselines, tree-path isolation feature attribution, contamination sensitivity curves, and multi-seed stability evaluation.
   - Serves all required REST API endpoints (`/health`, `/api/overview`, `/api/datasets`, `/api/physiological-data`, `/api/cbc-data`, `/api/immune-data`, `/api/anomalies`, `/api/model-metrics`, `POST /api/analyze`, `POST /api/upload`, `POST /api/simulation/start`, `POST /api/simulation/stop`).

3. **Python FastAPI + Scikit-learn + SHAP Backend (`/backend`)**
   - Production Python backend (`uvicorn backend.main:app --port 8000`) mirroring the exact API contract.
   - Uses `pandas`, `numpy`, `scikit-learn`, `scipy`, `shap`, and `joblib`.
   - Serializes trained models to `/models/*.joblib` only upon successful training.

4. **Google Colab Pipeline (`/notebooks/ASTROCARE_COMPLETE_ML_PIPELINE.ipynb`)**
   - Self-contained notebook for free Colab CPU execution.
   - Exports both `.joblib` model artifacts (for the Python FastAPI backend) and `astrocare_bundle.json` (for direct import into the web dashboard).

## Scientific Boundaries
- Separate cohorts are never merged across unrelated studies.
- Simulated monitoring replays historical observations sequentially and is explicitly separated from genuine live astronaut telemetry.
- ASTROCARE is an independent research prototype, not a NASA-endorsed product or clinically validated medical diagnostic system.
