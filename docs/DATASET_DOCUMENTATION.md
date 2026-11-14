# ASTROCARE Dataset Documentation

> **Scientific Provenance Disclosure:** ASTROCARE integrates three independent biomedical datasets into strictly separate cohort pipelines. Cohorts are never concatenated across unrelated studies or subjects. ASTROCARE is an independent research prototype and does not represent live spacecraft telemetry or clinical diagnostic data.

---

## 1. Physiological Cohort — MMASH (`MMASH.zip`)
- **Full Name:** Multilevel Monitoring of Activity and Sleep in Healthy people (PhysioNet).
- **Origin:** Ground-based human ambulatory monitoring benchmark (22 terrestrial participants, multi-sensor wearable recordings; **not** astronaut spaceflight telemetry).
- **Archive Structure:** Multi-subject ZIP (`DataPaper/user_1` … `user_22`) containing `Actigraph.csv`, `RR.csv`, `sleep.csv`, `saliva.csv`, `Activity.csv`, and questionnaire/metadata tables (`user_info.csv`, `questionnaire.csv` skipped from physiological sensor features).
- **Temporal Windowing Modes:**
  - **`window_60s` (60-Second Physiological Windows):** Groups `Actigraph.csv` and `RR.csv` chronologically by `(day, time)` / ISO timestamps / cumulative IBI fallback across 60-second windows (~30,377 windows in the full Colab reference run). Extracts per-window numeric means plus heart-rate variability features (`RR_HR_bpm_mean`, `RR_SDNN_ms`, `RR_RMSSD_ms`), and merges subject summary metrics (`sleep_Efficiency`, `sleep_Total Sleep Time (TST)`).
  - **`epoch_20` (20-Epoch Overview Mode):** Aggregates each subject into 20 fixed chronological segments (`22 × 20 = 440` rows) for rapid low-memory preview.
- **Excluded Metadata:** Ordinal `epoch_index`, `sleep_In Bed Date`, `sleep_Out Bed Date`, `sleep_Onset Date`, and `subject_id` are retained for inspection/ordering and excluded from Isolation Forest features.
- **Target Labels:** None.

---

## 2. Hematology Cohort — LSDS-7 (`LSDS-7_Complete_Blood_Count_CBC_TRANSFORMED.csv`)
- **Origin:** Complete Blood Count (CBC) hematology dataset (`28` samples × `61` raw columns).
- **Feature Selection Audit:**
  - **Included:** Measured hematology values (`WBC`, `RBC`, `Hemoglobin`, `Hematocrit`, `MCV`, `MCH`, `MCHC`, `RDW`, `Platelet Count`, `MPV`, differential `%` and absolute counts) plus engineered Neutrophil-to-Lymphocyte Ratio (`NLR_engineered = absolute_neutrophils / absolute_lymphocytes`).
  - **Excluded:** Reference-range columns (`*_range_min_*`, `*_range_max_*`), identifiers (`Sample Name`), and categorical metadata (`Unit`, `Type`).
- **Source Integrity Audit (Row #17 — `C003_whole-blood_L-92_cbc`):**
  - Automated hematology cross-check flags Row #17 as `suspected_corrupted` due to a suspected column-transposition error:
    - Recorded `platelet_count = 12.9` (cohort median ~244 ×10³/µL; matches RDW range)
    - Recorded `mpv = 330` fL (physically impossible; matches platelet count scale)
    - Recorded `rdw = 32.4%` (>2.5× rest of cohort)
    - `WBC × Neutrophil%` predicts ~`6,825.6` cells/µL, whereas recorded `absolute_neutrophils = 10.1` and `absolute_lymphocytes = 6,826` (`NLR_engineered = 0.0015`).
  - **Handling:** ASTROCARE preserves the raw CSV unmodified and never invents corrected numbers. A toggle (`Exclude Suspect Row #17`) lets investigators fit Isolation Forest on verified rows only (`n=27`) while keeping the flagged record in the data-quality report.
- **Target Labels:** None.

---

## 3. Immune Cytokine Cohort — LSDS-8 (`LSDS-8_Multiplex_serum.immune.EvePanel_SUBMITTED.csv`)
- **Origin:** Multiplex serum immune cytokine/chemokine panel (`1,988` observations across subjects, timepoints, and analytes).
- **Preserved Identifiers:** Subject `ID`, longitudinal `Timepoint`, and `Analyte`.
- **Censored & Missing Value Handling:**
  - Left-censored values (`<x`, `<=x`, `OOR <`, `BLQ`, `<LOD`) are parsed cleanly and resolved to `0.5 × lower bound` (or `0.5 × minimum positive analyte value` when no explicit bound is given).
  - Right-censored values (`>x`, `>=x`, `OOR >`) resolve to the upper bound (or analyte maximum).
  - Remaining missing cells are median-imputed per analyte.
- **Stratification & Normalization Modes:**
  - **`per_analyte` (Default):** Standardizes `Concentration` and `Percent` *within each `Analyte`* (`Concentration_analyte_z`, `Percent_analyte_z`) so high-abundance analytes (e.g., pg/mL in tens of thousands) do not dominate low-abundance cytokines (<1 pg/mL). Reports Isolation Forest and MAD anomaly counts separately per analyte.
  - **`wide_pivot`:** Pivots `(ID, Timepoint) × Analyte` into a multivariate biomarker profile matrix.
  - **`pooled`:** Legacy unstratified pooling retained only for side-by-side audit comparison.
- **Target Labels:** None.
