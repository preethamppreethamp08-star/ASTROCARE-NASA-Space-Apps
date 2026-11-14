# ASTROCARE — Space Health Intelligence

Independent biomedical ML research prototype for multi-cohort physiological, complete blood count (CBC), and immune biomarker preprocessing, unsupervised anomaly detection, and explainable AI.

> **Disclaimer:** ASTROCARE is an independent research prototype, not a NASA-endorsed product or clinically validated medical diagnostic system. Anomaly flags indicate multivariate statistical deviations from learned cohort baselines, not medical diagnoses. MMASH is ground-based human physiological data, and the MMASH, LSDS-7 (CBC), and LSDS-8 (Immune) cohorts are never merged across studies.

## Project Structure

```text
ASTROCARE/
  src/                 # React 19 + TypeScript + Recharts 8-page dashboard
  ml/                  # Live TypeScript preprocessing, audit & Isolation Forest engine
  server.ts            # Express + Vite full-stack server on port 3000
  backend/             # Python FastAPI + scikit-learn + SHAP backend counterpart
  notebooks/           # Reproducible Google Colab notebook (ASTROCARE_COMPLETE_ML_PIPELINE.ipynb)
  models/              # Trained .joblib artifacts (populated after real Colab/Python training)
  data/                # Local dataset & cache directory
  outputs/             # SHAP plots, evaluation outputs, exported astrocare_bundle.json
  docs/                # Architecture, ML methodology, dataset docs, evaluation report, judge demo
  tests/               # TypeScript (tsx) & Python (pytest) verification suites
  requirements.txt     # Python dependencies for backend & Google Colab
```

## Quick Start (Web Dashboard + Live ML Engine)

```bash
npm install
npm run lint
npm run build
npm run dev
```

Open the application on port `3000`, navigate to **Data Management**, and upload or inspect:
- `MMASH.zip` (supports **60-second physiological windows** + HRV extraction or **20-epoch overview**)
- `LSDS-7_Complete_Blood_Count_CBC_TRANSFORMED.csv` (excludes reference-range columns, audits Row #17 transposition error with verified-only toggle)
- `LSDS-8_Multiplex_serum.immune.EvePanel_SUBMITTED.csv` (handles `<LOD`/`OOR` censored tokens and performs **per-analyte normalization** or **wide-format pivoting**)

### Run TypeScript Verification Tests

```bash
npx tsx tests/test_ts_pipeline.ts
```

## Python FastAPI Backend

```bash
pip install -r requirements.txt
pytest -v tests/test_backend.py
uvicorn backend.main:app --reload --port 8000
```

## Google Colab + SHAP Workflow (Free Tier CPU)

1. Open `notebooks/ASTROCARE_COMPLETE_ML_PIPELINE.ipynb` in Google Colab (or download it from **Mission Overview** / **Data Management**).
2. Run all cells to upload `MMASH.zip`, `LSDS-7_Complete_Blood_Count_CBC_TRANSFORMED.csv`, and `LSDS-8_Multiplex_serum.immune.EvePanel_SUBMITTED.csv`.
3. Inspect the generated `shap.TreeExplainer` summary plots (`outputs/shap_summary_*.png`) and download:
   - `physiological_anomaly_model.joblib`
   - `cbc_anomaly_model.joblib`
   - `immune_anomaly_model.joblib`
   - `astrocare_bundle.json`
4. Place `.joblib` files in `models/` for the FastAPI backend, or import `astrocare_bundle.json` in **Data Management** to hydrate and persist Colab-trained results in the web dashboard.

## Documentation & Submission Deliverables
- [System Architecture](docs/ARCHITECTURE.md)
- [ML Methodology & Unsupervised Evaluation](docs/ML_METHODOLOGY.md)
- [Dataset Provenance & Integrity Documentation](docs/DATASET_DOCUMENTATION.md)
- [Final Model Evaluation Report](docs/MODEL_EVALUATION_REPORT.md)
- [Judge Demo Workflow (5-Minute Script)](docs/JUDGE_DEMO_WORKFLOW.md)
