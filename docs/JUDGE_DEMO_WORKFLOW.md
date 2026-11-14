# ASTROCARE — NASA Space Apps Judge Demo Workflow (5 Minutes)

## Opening Framing (30s)
- State the challenge: Long-duration spaceflight stresses cardiovascular autonomic regulation, hematology, and immune equilibrium simultaneously, yet mission datasets are fragmented across heterogeneous studies without pre-labeled "sick vs. healthy" tags.
- State the scientific boundary clearly: **ASTROCARE is an independent research prototype**, not a NASA-endorsed diagnostic tool. It keeps three distinct cohorts strictly isolated:
  1. **MMASH** (ground-based human ambulatory physiology — heart rate, HRV, actigraphy, sleep)
  2. **LSDS-7** (complete blood count hematology)
  3. **LSDS-8** (multiplex serum immune cytokines)

---

## Walkthrough Across the 8 Dashboard Pages (3.5 min)

1. **Mission Overview**
   - Show the KPI strip (`2,456` processed observations across `3/3` trained Isolation Forest models, `122` flagged anomalies at `5%` contamination) and the cohort breakdown chart.
2. **Data Management**
   - Demonstrate dataset inspection, missingness before/after preprocessing (`0` missing cells post-imputation), and the **CBC Source Integrity Audit**:
     - Show how Row #17 (`C003_whole-blood_L-92_cbc`) is flagged automatically (`Platelet=12.9`, `MPV=330 fL`, `RDW=32.4%`, `NLR=0.0015`) without fabricating replacement values.
     - Toggle **"Exclude Suspect Row #17"** to show live model refitting (`n=28` → `n=27` verified rows, MPV std dropping from `60.401` to `0.387`).
   - Point out **MMASH Windowing (`60s Physiological Windows` vs `20-Epoch Overview`)** and **Immune Mode (`Per-Analyte Z-Norm` / `Wide-Format Pivot`)** controls.
3. **Physiological Monitoring (MMASH)**
   - Filter by individual participant (`user_1`…`user_22`) and inspect Heart Rate / HRV (`SDNN`, `RMSSD`) trajectories with anomaly overlay markers and ZIP manifest inspection.
4. **CBC Analysis (LSDS-7) & Immune Biomarkers (LSDS-8)**
   - Inspect hematology parameter distributions (`NLR_engineered`) and verified vs. suspected-corrupted status.
   - Show immune cytokine correlation heatmap and per-analyte stratification readiness.
5. **AI Anomaly Detection (Explainable AI)**
   - Click any high-scoring observation in the ranked table to inspect its **Local Feature Attribution (% isolation depth contribution + z-score direction)** and human-readable scientific explanation.
6. **Simulated Monitoring**
   - Click **Start Monitoring** to stream sequential historical observations through the trained model with live anomaly alerts — pointing out the explicit banner disclosing this is **historical dataset replay, not live flight telemetry**.
7. **Model Performance**
   - Review the **Supervised Label Audit** (explaining why Accuracy/F1 are omitted without ground truth), **Contamination Sensitivity curve (`1%–15%`)**, **5-Seed Stability (`Spearman ρ`, `Jaccard`)**, **Isolation Forest vs. MAD Baseline agreement**, and side-by-side **CBC Integrity Comparison**.

---

## Reproducible Google Colab + SHAP Workflow (1 min)
- Click **Colab Notebook** on Mission Overview (or open `notebooks/ASTROCARE_COMPLETE_ML_PIPELINE.ipynb`).
- Explain how running it in free Google Colab trains `scikit-learn` `IsolationForest`, computes `shap.TreeExplainer` attributions + summary plots, and exports `models/*.joblib` + `astrocare_bundle.json`, which can be imported back into **Data Management** with zero paid APIs.
