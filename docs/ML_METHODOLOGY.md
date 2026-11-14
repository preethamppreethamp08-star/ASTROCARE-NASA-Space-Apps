# ASTROCARE Machine Learning Methodology

## 1. Cohort Isolation & Provenance
ASTROCARE processes three heterogeneous biomedical datasets strictly in separate pipelines:
- **MMASH (Physiological)**: Terrestrial ambulatory multi-sensor recordings (ZIP archive of per-subject CSV files).
- **LSDS-7 (CBC)**: Hematology complete blood count measurements.
- **LSDS-8 (Immune)**: Multiplex serum cytokine/chemokine panel.

Cohorts are never concatenated across unrelated studies or subjects.

## 2. Preprocessing Pipeline
1. **Deduplication**: Exact duplicate rows are identified and removed.
2. **Type Coercion & Censored Values**: Non-numeric tokens (`NA`, `NaN`, `null`, `<LOD`) are standardized as missing rather than fabricated.
3. **High-Missingness Filtering**: Columns exceeding 50% missingness are excluded from multivariate modeling and logged in the data quality report.
4. **Imputation & Scaling**: Remaining missing numeric values are median-imputed; features are standardized (`StandardScaler`: zero mean, unit variance) and profiled with robust median/MAD statistics.
5. **Domain Feature Engineering**: When CBC datasets contain both Neutrophil and Lymphocyte absolute counts, the Neutrophil-to-Lymphocyte Ratio (`NLR_engineered`) is computed automatically.

## 3. Unsupervised Anomaly Detection & Baselines
- **Supervised Eligibility Audit**: Before modeling, each dataset is audited for valid ground-truth target/label columns. Because MMASH, LSDS-7, and LSDS-8 lack validated clinical anomaly labels, supervised classification accuracy/precision/recall/ROC-AUC are intentionally omitted rather than fabricated.
- **Primary Model — Isolation Forest**: Isolates observations via random recursive feature partitioning. Observations with shorter average path lengths $E(h(x))$ yield higher anomaly scores $s(x, \psi) = 2^{-E(h(x))/c(\psi)}$.
- **Statistical Baseline — Modified Z-Score (MAD)**: Computes $M_{ij} = \frac{0.6745 (x_{ij} - \tilde{x}_j)}{\text{MAD}_j}$ and flags $\max_j |M_{ij}| > 3.5$ per Iglewicz & Hoaglin.

## 4. Explainable AI
- **Python Backend / Colab**: Computes `shap.TreeExplainer` attributions for the trained `IsolationForest` alongside summary plots.
- **TypeScript Engine**: Computes tree-path isolation depth gain per splitting feature combined with standardized cohort deviation ($z$-score) to identify top contributing drivers for every observation.

## 5. Unsupervised Evaluation
1. **Score Distribution Histogram**: Separates nominal vs thresholded tail scores.
2. **Contamination Sensitivity**: Evaluates flagged counts and MAD baseline overlap across `[1%, 3%, 5%, 8%, 10%, 15%]`.
3. **Seed Stability Analysis**: Trains 5 independent ensembles with distinct random seeds and reports mean pairwise Spearman rank correlation and top-$k$ Jaccard overlap.
4. **Baseline Agreement Matrix**: Quantifies exact concordance between multivariate Isolation Forest and univariate MAD flags.
