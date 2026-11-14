from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Tuple

import joblib
import numpy as np
from sklearn.ensemble import IsolationForest

from .preprocessing import PreprocessedCohort

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"


def train_and_save_isolation_forest(
    cohort: PreprocessedCohort,
    contamination: float = 0.05,
    random_state: int = 42,
) -> Tuple[IsolationForest, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Train IsolationForest on standardized cohort features and export .joblib artifact."""
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    clamped = float(np.clip(contamination, 0.01, 0.25))

    model = IsolationForest(
        n_estimators=150,
        max_samples=min(256, len(cohort.scaled_matrix)),
        contamination=clamped,
        random_state=random_state,
        n_jobs=-1,
    )
    model.fit(cohort.scaled_matrix)

    # Convert sklearn score_samples (higher=normal) into intuitive anomaly score [0, 1] (higher=more anomalous)
    raw_scores = -model.score_samples(cohort.scaled_matrix)
    decision_scores = model.decision_function(cohort.scaled_matrix)
    is_anomaly = model.predict(cohort.scaled_matrix) == -1

    # Statistical baseline: Modified Z-Score using Median & MAD (Iglewicz & Hoaglin > 3.5)
    mod_z_matrix = np.abs(
        0.6745 * (cohort.raw_df.values - cohort.feature_medians) / cohort.feature_mads
    )
    baseline_max_z = mod_z_matrix.max(axis=1)

    artifact = {
        "domain": cohort.metadata["domain"],
        "model": model,
        "scaler": cohort.scaler,
        "imputer": cohort.imputer,
        "feature_columns": cohort.feature_columns,
        "feature_means": cohort.feature_means,
        "feature_stds": cohort.feature_stds,
        "feature_medians": cohort.feature_medians,
        "feature_mads": cohort.feature_mads,
        "contamination": clamped,
        "trained_at": cohort.metadata["uploadedAt"],
    }

    filename_map = {
        "physiological": "physiological_anomaly_model.joblib",
        "cbc": "cbc_anomaly_model.joblib",
        "immune": "immune_anomaly_model.joblib",
    }
    out_path = MODELS_DIR / filename_map[cohort.metadata["domain"]]
    joblib.dump(artifact, out_path)

    return model, raw_scores, decision_scores, is_anomaly, baseline_max_z
