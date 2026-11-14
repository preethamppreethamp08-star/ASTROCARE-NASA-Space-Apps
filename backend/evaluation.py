from __future__ import annotations

from typing import Any, Dict, List

import numpy as np
from scipy.stats import spearmanr
from sklearn.ensemble import IsolationForest

from .preprocessing import PreprocessedCohort


def evaluate_unsupervised_model(
    cohort: PreprocessedCohort,
    scores: np.ndarray,
    is_anomaly: np.ndarray,
    baseline_max_z: np.ndarray,
    contamination: float,
) -> Dict[str, Any]:
    """Run score distribution, contamination sensitivity, seed stability, and baseline comparison."""
    n = len(scores)
    baseline_flags = baseline_max_z > 3.5

    # 1. Score distribution histogram
    counts, edges = np.histogram(scores, bins=12)
    hist_bins: List[Dict[str, Any]] = []
    for b in range(len(counts)):
        lo, hi = float(edges[b]), float(edges[b + 1])
        mask = (scores >= lo) & (scores <= hi if b == len(counts) - 1 else scores < hi)
        hist_bins.append({
            "binLabel": f"{lo:.2f}",
            "binStart": round(lo, 4),
            "binEnd": round(hi, 4),
            "normalCount": int((mask & ~is_anomaly).sum()),
            "anomalyCount": int((mask & is_anomaly).sum()),
        })

    # 2. Contamination sensitivity
    sensitivity: List[Dict[str, Any]] = []
    sorted_desc = np.sort(scores)[::-1]
    for rate in [0.01, 0.03, 0.05, 0.08, 0.10, 0.15]:
        k = max(1, int(round(n * rate)))
        thr = float(sorted_desc[min(n - 1, k - 1)])
        flags = scores >= thr
        inter = int((flags & baseline_flags).sum())
        uni = int((flags | baseline_flags).sum())
        sensitivity.append({
            "contamination": rate,
            "flaggedCount": int(flags.sum()),
            "flaggedPct": round(float(flags.sum() / n * 100.0), 2),
            "thresholdScore": round(thr, 4),
            "baselineOverlapPct": round(float(inter / uni * 100.0) if uni > 0 else 100.0, 1),
        })

    # 3. Seed stability across 5 random initializations
    seeds = [42, 101, 202, 303, 404]
    seed_scores: List[np.ndarray] = [scores]
    k_target = max(1, int(round(n * contamination)))
    seed_sets = [set(np.argsort(scores)[::-1][:k_target].tolist())]

    for s in seeds[1:]:
        m = IsolationForest(
            n_estimators=100,
            max_samples=min(256, n),
            contamination=contamination,
            random_state=s,
        )
        m.fit(cohort.scaled_matrix)
        sc = -m.score_samples(cohort.scaled_matrix)
        seed_scores.append(sc)
        seed_sets.append(set(np.argsort(sc)[::-1][:k_target].tolist()))

    jaccards: List[float] = []
    spearmans: List[float] = []
    for i in range(len(seeds)):
        for j in range(i + 1, len(seeds)):
            inter = len(seed_sets[i] & seed_sets[j])
            uni = len(seed_sets[i] | seed_sets[j])
            jaccards.append(inter / uni if uni > 0 else 1.0)
            rho, _ = spearmanr(seed_scores[i], seed_scores[j])
            spearmans.append(float(rho) if np.isfinite(rho) else 0.0)

    stability = {
        "numSeeds": len(seeds),
        "meanJaccardOverlap": round(float(np.mean(jaccards)), 4),
        "meanSpearmanRankCorr": round(float(np.mean(spearmans)), 4),
        "scoreStdAcrossSeeds": round(float(np.std(np.vstack(seed_scores), axis=0).mean()), 5),
    }

    # 4. Baseline agreement matrix
    both = int((is_anomaly & baseline_flags).sum())
    only_if = int((is_anomaly & ~baseline_flags).sum())
    only_base = int((~is_anomaly & baseline_flags).sum())
    neither = int((~is_anomaly & ~baseline_flags).sum())
    corr_val = float(np.corrcoef(scores, baseline_max_z)[0, 1]) if n > 1 and np.std(baseline_max_z) > 0 else 0.0

    baseline_cmp = {
        "bothFlagged": both,
        "onlyIsolationForest": only_if,
        "onlyStatisticalBaseline": only_base,
        "neitherFlagged": neither,
        "agreementPct": round((both + neither) / max(1, n) * 100.0, 2),
        "scoreCorrelation": round(corr_val if np.isfinite(corr_val) else 0.0, 4),
    }

    # 5. Pearson correlation matrix (top 14 features)
    corr_feats = cohort.feature_columns[:14]
    corr_df = cohort.raw_df[corr_feats].corr().fillna(0.0)
    corr_matrix = {
        "features": corr_feats,
        "matrix": [[round(float(v), 4) for v in row] for row in corr_df.values],
    }

    return {
        "scoreDistribution": hist_bins,
        "contaminationSensitivity": sensitivity,
        "stabilityAnalysis": stability,
        "baselineComparison": baseline_cmp,
        "correlationMatrix": corr_matrix,
    }
