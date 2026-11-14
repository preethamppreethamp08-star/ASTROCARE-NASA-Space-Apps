# ASTROCARE Final Model Evaluation Report

> **Important Evaluation Rule:** None of the three cohorts (`MMASH`, `LSDS-7`, `LSDS-8`) contain validated clinical ground-truth anomaly or diagnostic labels. Accordingly, supervised classification metrics (**Accuracy, Precision, Recall, F1, ROC-AUC**) are intentionally **omitted** rather than fabricated. All models are evaluated using unsupervised Isolation Forest score distributions, Modified Z-Score (MAD > 3.5) baseline agreement, contamination sensitivity, and 5-seed stability (`Spearman ρ`, `Jaccard overlap`).

---

## 1. Cohort Summary (Live Runtime State Verified on `http://localhost:3000`)

| Cohort | Source Cached | Rows (`n`) | ML Features (`p`) | Model & Parameters | Flagged (`5%`) | Threshold Score |
|---|---|---:|---:|---|---:|---:|
| **Physiological** (`MMASH`) | `MMASH.zip` (`epoch_20` cache) | 440 (22 subjects) | 26 | IsolationForest (`n_estimators=100`, `max_samples=256`, `seed=42`) | 22 (5.00%) | — |
| **CBC Hematology** (`LSDS-7`) | `LSDS-7_Complete_Blood_Count_CBC_TRANSFORMED.csv` | 28 (`27` verified + `1` suspect) | 21 (incl. `NLR_engineered`) | IsolationForest (`n_estimators=100`, `max_samples=28`, `seed=42`) | 1 (3.57%) | 0.713417 |
| **Immune Panel** (`LSDS-8`) | `LSDS-8_Multiplex_serum.immune.EvePanel_SUBMITTED.csv` (4-col cached snapshot) | 1,988 | 2 | IsolationForest (`n_estimators=100`, `max_samples=256`, `seed=42`) | 99 (4.98%) | — |
| **Total Active** | — | **2,456** | — | **3/3 Isolated Models** | **122** | — |

---

## 2. Live CBC Source Integrity Comparison (`LSDS-7`, `n=28` vs `n=27`)

| Metric | With Suspect Row #17 (`n=28`) | Verified Only (`n=27`, Row #17 Excluded) |
|---|---:|---:|
| **Top Flagged Sample** | `C003_whole-blood_L-92_cbc` (`suspected_corrupted`) | `C003_whole-blood_L-44_cbc` (`verified`) |
| **Isolation Score Threshold** | `0.713417` | `0.54319` |
| **NLR Min / Median / Max** | `0.0015` / `1.6928` / `3.0763` | `0.9185` / `1.7485` / `3.0763` |
| **MPV Mean ± Std (fL)** | `21.811 ± 60.401` | `10.396 ± 0.387` |
| **Platelet Mean ± Std (×10³/µL)** | `253.961 ± 70.651` | `262.889 ± 53.532` |
| **5-Seed Spearman Rank Corr** | `0.8289` | `0.8416` |
| **5-Seed Top-k Jaccard** | `1.0000` | `0.2000` |

**Interpretation:** Including Row #17 forces the anomaly detector to isolate the glaring column-transposition artifact (`MPV=330`, `NLR=0.0015`, `Platelets=12.9`) while inflating cohort MPV standard deviation by >150× (`60.401` vs `0.387`). Excluding Row #17 restores normal hematology dispersion and surfaces genuine cohort variation (`C003_whole-blood_L-44_cbc`), while keeping Row #17 transparently documented in Data Quality Audit without altering source files.

---

## 3. Feature Engineering & Parser Validation (`tests/test_ts_pipeline.ts`)
Verified on deterministic unit fixtures in TypeScript:
- **MMASH `window_60s` vs `epoch_20`:** Correctly splits multi-subject ZIP streams (`Actigraph.csv`, `RR.csv`, `sleep.csv`) into chronological 60-second windows (`10` windows for 2 × 5-min subjects), derives `RR_HR_bpm_mean`, `RR_SDNN_ms`, `RR_RMSSD_ms`, preserves subject IDs & timestamps, and excludes `epoch_index` and `sleep_In Bed Date`.
- **Immune `per_analyte` & `wide_pivot`:** Resolves `<0.14` (left-censored) and `>30000` (right-censored) tokens, normalizes within analyte (`Concentration_analyte_z`, `Percent_analyte_z`), and builds `(ID, Timepoint) × Analyte` wide matrices cleanly.
- **CBC Integrity:** Automatically filters reference-range columns (`hematocrit_range_min_percent`), computes `NLR_engineered`, flags `suspected_corrupted` rows, and filters them cleanly on `cbcExcludeSuspectRows: true`.

---

## 4. Honest Verification Boundaries
1. **MMASH `30,377`-Window Live Comparison:** The raw `MMASH.zip` binary is not stored on the runtime server disk; only the pre-audit `440`-epoch cache snapshot is persisted in `data/cache/astrocare_datasets.json`. Live validation against Colab's `30,377` windows requires uploading `MMASH.zip` in **Data Management** with `60s Physiological Windows` active (or running `notebooks/ASTROCARE_COMPLETE_ML_PIPELINE.ipynb` in Colab and importing `astrocare_bundle.json`).
2. **Immune `Analyte` Column in Cached Snapshot:** The cached `1,988`-row snapshot has 4 columns (`ID`, `Timepoint`, `Concentration`, `Percent`). Re-uploading the raw `LSDS-8` CSV with `Analyte` activates live per-analyte z-normalization and per-analyte anomaly counts.
3. **Python FastAPI & SHAP Runtime:** `backend/*.py` and `tests/test_backend.py` pass Python syntax compilation (`py_compile`), while full `pytest` + `shap.TreeExplainer` execution requires running in a Python environment with `requirements.txt` installed (such as free Google Colab).
