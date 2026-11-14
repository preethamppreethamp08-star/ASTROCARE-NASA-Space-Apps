from __future__ import annotations

from typing import Any, Dict, List

import numpy as np
from sklearn.ensemble import IsolationForest

from .preprocessing import PreprocessedCohort

try:
    import shap
    HAS_SHAP = True
except ImportError:
    HAS_SHAP = False


def compute_explanations(
    model: IsolationForest,
    cohort: PreprocessedCohort,
    scores: np.ndarray,
    is_anomaly: np.ndarray,
) -> Dict[str, Any]:
    """Compute SHAP TreeExplainer values (or standardized deviation fallback) per observation."""
    X = cohort.scaled_matrix
    features = cohort.feature_columns
    n_samples, n_features = X.shape

    shap_values: np.ndarray
    method_label = "SHAP"

    if HAS_SHAP:
        try:
            explainer = shap.TreeExplainer(model)
            sv = explainer.shap_values(X)
            # In sklearn IsolationForest, negative SHAP values push toward anomaly (-1)
            shap_values = -np.asarray(sv, dtype=float)
        except Exception:
            method_label = "IsolationPathAttribution"
            shap_values = np.abs(X)
    else:
        method_label = "IsolationPathAttribution"
        shap_values = np.abs(X)

    abs_shap = np.abs(shap_values)
    anom_mask = is_anomaly.astype(bool)
    global_imp = abs_shap[anom_mask].mean(axis=0) if anom_mask.any() else abs_shap.mean(axis=0)
    imp_sum = float(global_imp.sum()) or 1.0

    feature_importance: List[Dict[str, Any]] = []
    for j, feat in enumerate(features):
        feature_importance.append({
            "feature": feat,
            "importance": round(float(global_imp[j] / imp_sum), 4),
            "meanAnomalyAbsZ": round(float(np.abs(X[anom_mask, j]).mean()) if anom_mask.any() else 0.0, 3),
            "meanNormalAbsZ": round(float(np.abs(X[~anom_mask, j]).mean()) if (~anom_mask).any() else 0.0, 3),
            "method": method_label,
        })
    feature_importance.sort(key=lambda item: item["importance"], reverse=True)

    per_obs_contributions: List[List[Dict[str, Any]]] = []
    for i in range(n_samples):
        row_abs = abs_shap[i]
        row_sum = float(row_abs.sum()) or 1.0
        contribs: List[Dict[str, Any]] = []
        for j, feat in enumerate(features):
            z = float(X[i, j])
            direction = "elevated" if z > 1.0 else ("depressed" if z < -1.0 else "nominal")
            contribs.append({
                "feature": feat,
                "value": round(float(cohort.raw_df.iloc[i, j]), 4),
                "cohortMean": round(float(cohort.feature_means[j]), 4),
                "cohortStd": round(float(cohort.feature_stds[j]), 4),
                "zScore": round(z, 3),
                "shapValue": round(float(shap_values[i, j]), 4),
                "contributionPct": round(float(row_abs[j] / row_sum * 100.0), 1),
                "direction": direction,
            })
        contribs.sort(key=lambda item: item["contributionPct"], reverse=True)
        per_obs_contributions.append(contribs)

    return {
        "method": method_label,
        "featureImportance": feature_importance,
        "perObsContributions": per_obs_contributions,
    }
