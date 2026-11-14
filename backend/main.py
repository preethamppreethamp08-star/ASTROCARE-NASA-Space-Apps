from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .evaluation import evaluate_unsupervised_model
from .explainability import compute_explanations
from .ml_models import MODELS_DIR, train_and_save_isolation_forest
from .preprocessing import PreprocessedCohort, parse_uploaded_bytes, preprocess_cohort
from .schemas import AnalyzeRequest, DatasetDomain, SimulationStartRequest

app = FastAPI(
    title="ASTROCARE Space Health Intelligence API",
    description="Research-grade biomedical preprocessing, unsupervised anomaly detection, and explainable AI backend.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class BackendState:
    def __init__(self) -> None:
        self.cohorts: Dict[str, PreprocessedCohort] = {}
        self.raw_uploads: Dict[str, Dict[str, Any]] = {}
        self.analyses: Dict[str, Dict[str, Any]] = {}
        self.config: Dict[str, Any] = {
            "mmashWindowMode": "window_60s",
            "mmashWindowSeconds": 60,
            "immuneProcessingMode": "per_analyte",
            "cbcExcludeSuspectRows": False,
        }
        self.simulation: Dict[str, Any] = {
            "running": False,
            "domain": "physiological",
            "cursorIndex": 0,
            "totalRecords": 0,
            "intervalMs": 1000,
            "startedAt": None,
            "history": [],
            "events": [],
        }


state = BackendState()


def _run_domain_pipeline(cohort: PreprocessedCohort, contamination: float = 0.05) -> Dict[str, Any]:
    domain = cohort.metadata["domain"]
    model, scores, decision_scores, is_anomaly, baseline_max_z = train_and_save_isolation_forest(
        cohort, contamination=contamination
    )
    expl = compute_explanations(model, cohort, scores, is_anomaly)
    eval_res = evaluate_unsupervised_model(cohort, scores, is_anomaly, baseline_max_z, contamination)

    threshold_score = float(scores[is_anomaly].min()) if is_anomaly.any() else float(scores.max())
    records: List[Dict[str, Any]] = []
    for i in range(len(scores)):
        contribs = expl["perObsContributions"][i]
        top_txt = "; ".join(
            f"{c['feature']} ({'+' if c['zScore'] >= 0 else ''}{c['zScore']:.2f} SD, {c['contributionPct']:.1f}%)"
            for c in contribs[:3]
        )
        flagged = bool(is_anomaly[i])
        explanation = (
            f"Observation #{i + 1} ({cohort.subject_ids[i]}) was flagged (score {scores[i]:.3f}) because its multivariate measurements differed substantially from the learned baseline. Top drivers: {top_txt}. Statistical anomaly only, not a medical diagnosis."
            if flagged
            else f"Observation #{i + 1} ({cohort.subject_ids[i]}) falls within the learned cohort baseline (score {scores[i]:.3f})."
        )
        rec_item: Dict[str, Any] = {
            "index": i + 1,
            "subjectId": cohort.subject_ids[i],
            "timestamp": cohort.timestamps[i],
            "values": {col: round(float(cohort.raw_df.iloc[i][col]), 4) for col in cohort.feature_columns},
            "anomalyScore": round(float(scores[i]), 6),
            "decisionScore": round(float(decision_scores[i]), 6),
            "isAnomaly": flagged,
            "baselineMaxModifiedZ": round(float(baseline_max_z[i]), 4),
            "baselineFlag": bool(baseline_max_z[i] > 3.5),
            "featureContributions": contribs,
            "explanation": explanation,
        }
        if cohort.analyte_labels is not None:
            rec_item["analyte"] = cohort.analyte_labels[i]
        if cohort.integrity_statuses is not None:
            rec_item["integrityStatus"] = cohort.integrity_statuses[i]
        records.append(rec_item)

    n = len(records)
    anom_count = int(is_anomaly.sum())
    result = {
        "domain": domain,
        "trained": True,
        "source": "fastapi_sklearn_shap",
        "modelType": "sklearn.ensemble.IsolationForest (n_estimators=150)",
        "baselineType": "Modified Z-Score (MAD > 3.5)",
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "sampleCount": n,
        "featureColumns": cohort.feature_columns,
        "contamination": contamination,
        "thresholdScore": round(threshold_score, 6),
        "anomalyCount": anom_count,
        "normalCount": n - anom_count,
        "anomalyPercentage": round(anom_count / max(1, n) * 100.0, 2),
        "scoreDistribution": eval_res["scoreDistribution"],
        "featureImportance": expl["featureImportance"],
        "contaminationSensitivity": eval_res["contaminationSensitivity"],
        "stabilityAnalysis": eval_res["stabilityAnalysis"],
        "baselineComparison": eval_res["baselineComparison"],
        "correlationMatrix": eval_res["correlationMatrix"],
        "records": records,
        "supervisedStatus": cohort.metadata["supervisedLabelAudit"],
        "evaluationNotes": [
            f"Trained scikit-learn IsolationForest on {n} observations and {len(cohort.feature_columns)} features.",
            f"Saved trained model artifact to {MODELS_DIR}.",
            cohort.metadata["supervisedLabelAudit"]["reason"],
        ],
    }
    state.analyses[domain] = result
    return result


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "service": "ASTROCARE FastAPI Backend",
        "models_directory": str(MODELS_DIR),
        "datasets_loaded": len(state.cohorts),
        "trained_models": list(state.analyses.keys()),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/overview")
def get_overview() -> Dict[str, Any]:
    total_obs = sum(a["sampleCount"] for a in state.analyses.values())
    flagged = sum(a["anomalyCount"] for a in state.analyses.values())
    normal = total_obs - flagged
    pct = round(flagged / total_obs * 100.0, 2) if total_obs > 0 else 0.0

    statuses = []
    for d in ("physiological", "cbc", "immune"):
        a = state.analyses.get(d)
        c = state.cohorts.get(d)
        statuses.append({
            "domain": d,
            "datasetLoaded": c is not None,
            "datasetName": c.metadata["filename"] if c else None,
            "trained": bool(a and a["trained"]),
            "modelType": a["modelType"] if a else "Not trained",
            "sampleCount": a["sampleCount"] if a else 0,
            "anomalyCount": a["anomalyCount"] if a else 0,
            "anomalyPercentage": a["anomalyPercentage"] if a else 0.0,
        })

    return {
        "totalObservations": total_obs,
        "normalObservations": normal,
        "flaggedAnomalies": flagged,
        "anomalyPercentage": pct,
        "datasetsLoadedCount": len(state.cohorts),
        "modelsTrainedCount": len(state.analyses),
        "modelStatuses": statuses,
        "simulationRunning": state.simulation["running"],
    }


@app.get("/api/datasets")
def get_datasets() -> Dict[str, Any]:
    return {"datasets": [c.metadata for c in state.cohorts.values()]}


@app.get("/api/physiological-data")
def get_physiological_data() -> Dict[str, Any]:
    c = state.cohorts.get("physiological")
    return {
        "domain": "physiological",
        "loaded": c is not None,
        "metadata": c.metadata if c else None,
        "analysis": state.analyses.get("physiological"),
    }


@app.get("/api/cbc-data")
def get_cbc_data() -> Dict[str, Any]:
    c = state.cohorts.get("cbc")
    return {
        "domain": "cbc",
        "loaded": c is not None,
        "metadata": c.metadata if c else None,
        "analysis": state.analyses.get("cbc"),
    }


@app.get("/api/immune-data")
def get_immune_data() -> Dict[str, Any]:
    c = state.cohorts.get("immune")
    return {
        "domain": "immune",
        "loaded": c is not None,
        "metadata": c.metadata if c else None,
        "analysis": state.analyses.get("immune"),
    }


@app.get("/api/anomalies")
def get_anomalies(domain: Optional[DatasetDomain] = Query(default=None)) -> Dict[str, Any]:
    targets = [domain] if domain else ["physiological", "cbc", "immune"]
    items: List[Dict[str, Any]] = []
    for d in targets:
        a = state.analyses.get(d)
        if not a:
            continue
        for rec in a["records"]:
            if rec["isAnomaly"] or rec["baselineFlag"]:
                items.append({**rec, "domain": d})
    items.sort(key=lambda r: r["anomalyScore"], reverse=True)
    return {"count": len(items), "anomalies": items}


@app.get("/api/model-metrics")
def get_model_metrics() -> Dict[str, Any]:
    out = []
    for d in ("physiological", "cbc", "immune"):
        a = state.analyses.get(d)
        c = state.cohorts.get(d)
        if not a:
            out.append({"domain": d, "trained": False, "datasetName": c.metadata["filename"] if c else None})
        else:
            out.append({
                "domain": d,
                "trained": True,
                "datasetName": c.metadata["filename"] if c else None,
                **{k: v for k, v in a.items() if k != "records"},
            })
    return {"models": out}


@app.post("/api/upload")
async def upload_dataset(
    file: UploadFile = File(...),
    domain: DatasetDomain = Form(...),
    mmashWindowMode: Optional[str] = Form(default=None),
    immuneProcessingMode: Optional[str] = Form(default=None),
    cbcExcludeSuspectRows: Optional[bool] = Form(default=None),
) -> Dict[str, Any]:
    try:
        raw_bytes = await file.read()
        fname = file.filename or "upload.csv"
        w_mode = mmashWindowMode if mmashWindowMode in {"window_60s", "epoch_20"} else state.config["mmashWindowMode"]
        i_mode = immuneProcessingMode if immuneProcessingMode in {"per_analyte", "wide_pivot", "pooled"} else state.config["immuneProcessingMode"]
        excl = bool(cbcExcludeSuspectRows) if cbcExcludeSuspectRows is not None else state.config["cbcExcludeSuspectRows"]
        state.config.update({"mmashWindowMode": w_mode, "immuneProcessingMode": i_mode, "cbcExcludeSuspectRows": excl})

        df, file_type, manifest, notes = parse_uploaded_bytes(
            raw_bytes, fname, domain, mmash_window_mode=w_mode, window_seconds=state.config["mmashWindowSeconds"]
        )
        state.raw_uploads[domain] = {"raw_bytes": raw_bytes, "filename": fname, "df": df, "file_type": file_type, "manifest": manifest, "notes": notes}
        cohort = preprocess_cohort(
            df, domain, fname, file_type, manifest, notes,
            immune_mode=i_mode, cbc_exclude_suspect_rows=excl,
        )
        state.cohorts[domain] = cohort
        _run_domain_pipeline(cohort, contamination=0.05)
        preview = df.head(12).fillna("").to_dict(orient="records")
        return {"status": "uploaded_and_analyzed", "metadata": cohort.metadata, "preview": preview}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/analyze")
def analyze_models(req: AnalyzeRequest) -> Dict[str, Any]:
    if req.mmashWindowMode is not None:
        state.config["mmashWindowMode"] = req.mmashWindowMode
    if req.mmashWindowSeconds:
        state.config["mmashWindowSeconds"] = req.mmashWindowSeconds
    if req.immuneProcessingMode is not None:
        state.config["immuneProcessingMode"] = req.immuneProcessingMode
    if req.cbcExcludeSuspectRows is not None:
        state.config["cbcExcludeSuspectRows"] = req.cbcExcludeSuspectRows

    targets = [req.domain] if req.domain else list(state.cohorts.keys())
    if not targets:
        raise HTTPException(status_code=400, detail="No datasets loaded yet.")
    updated = {}
    for d in targets:
        if d in state.raw_uploads:
            raw = state.raw_uploads[d]
            if d == "physiological" and raw["file_type"] == "zip":
                df, ft, mf, notes = parse_uploaded_bytes(
                    raw["raw_bytes"], raw["filename"], d,
                    mmash_window_mode=state.config["mmashWindowMode"],
                    window_seconds=state.config["mmashWindowSeconds"],
                )
            else:
                df, ft, mf, notes = raw["df"], raw["file_type"], raw["manifest"], raw["notes"]
            state.cohorts[d] = preprocess_cohort(
                df, d, raw["filename"], ft, mf, notes,
                immune_mode=state.config["immuneProcessingMode"],
                cbc_exclude_suspect_rows=state.config["cbcExcludeSuspectRows"],
            )
        if d in state.cohorts:
            updated[d] = _run_domain_pipeline(state.cohorts[d], contamination=req.contamination)
    return {"status": "completed", "contamination": req.contamination, "pipelineConfig": state.config, "results": updated}


@app.post("/api/simulation/start")
def start_simulation(req: SimulationStartRequest) -> Dict[str, Any]:
    domain = req.domain or next(iter(state.analyses.keys()), None)
    if not domain or domain not in state.analyses:
        raise HTTPException(status_code=400, detail="No trained dataset available to replay.")
    records = state.analyses[domain]["records"]
    state.simulation.update({
        "running": True,
        "domain": domain,
        "cursorIndex": 1,
        "totalRecords": len(records),
        "intervalMs": req.interval_ms,
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "history": records[:1],
        "events": [{
            "id": f"evt_{records[0]['index']}",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "domain": domain,
            "subjectId": records[0]["subjectId"],
            "severity": "anomaly" if records[0]["isAnomaly"] else "info",
            "anomalyScore": records[0]["anomalyScore"],
            "message": records[0]["explanation"],
        }],
    })
    return state.simulation


@app.post("/api/simulation/stop")
def stop_simulation() -> Dict[str, Any]:
    state.simulation["running"] = False
    return state.simulation


@app.get("/api/simulation/state")
def get_simulation_state() -> Dict[str, Any]:
    return state.simulation
