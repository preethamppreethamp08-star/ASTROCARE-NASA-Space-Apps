from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler

DOMAIN_PROVENANCE = {
    "physiological": (
        "MMASH (Multilevel Monitoring of Activity and Sleep in Healthy people) — "
        "terrestrial ambulatory physiology benchmark. Not live spaceflight telemetry."
    ),
    "cbc": (
        "LSDS-7 Complete Blood Count (CBC) Transformed dataset — hematology measurements. "
        "Evaluated strictly against cohort distributions unless validated clinical ranges are supplied."
    ),
    "immune": (
        "LSDS-8 Multiplex Serum Immune EvePanel Submitted dataset — cytokine/chemokine multiplex panel. "
        "Analyzed strictly within its own cohort."
    ),
}

MISSING_TOKENS = {"", "na", "n/a", "nan", "null", "none", "nil", ".", "-", "nd", "missing"}


@dataclass
class PreprocessedCohort:
    metadata: Dict[str, Any]
    feature_columns: List[str]
    raw_df: pd.DataFrame
    scaled_matrix: np.ndarray
    scaler: StandardScaler
    imputer: SimpleImputer
    feature_means: np.ndarray
    feature_stds: np.ndarray
    feature_medians: np.ndarray
    feature_mads: np.ndarray
    subject_ids: List[str]
    timestamps: List[Optional[str]]
    analyte_labels: Optional[List[Optional[str]]] = None
    integrity_statuses: Optional[List[str]] = None
    immune_row_meta: List[Dict[str, Any]] = field(default_factory=list)


def _extract_unit(header: str) -> Optional[str]:
    m = re.search(r"\(([^)]+)\)\s*$", header)
    if m:
        return m.group(1).strip()
    m = re.search(r"\[([^\]]+)\]\s*$", header)
    if m:
        return m.group(1).strip()
    return None


def _infer_subject_from_path(path: str) -> Optional[str]:
    m = re.search(r"(user[_-]?\d+|subject[_-]?\d+|sub[_-]?\d+|participant[_-]?\d+|s\d{1,3})", path, re.I)
    return m.group(1) if m else None


def parse_numeric_with_censor(val: Any) -> Tuple[Optional[float], str]:
    if val is None or (isinstance(val, float) and np.isnan(val)):
        return None, "missing"
    s = str(val).strip()
    if s.lower() in MISSING_TOKENS:
        return None, "missing"
    clean = s.replace(",", "")

    if re.match(r"^(?:oor\s*<|blq|lod|<\s*lod|<\s*lloq|<\s*dl|below\s*(?:lod|dl|range))$", clean, re.I):
        return None, "left"
    if re.match(r"^(?:oor\s*>|>\s*uloq|above\s*(?:uloq|range)|alr)$", clean, re.I):
        return None, "right"

    m_left = re.match(r"^(?:oor\s*)?<=?\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$", clean, re.I)
    if m_left:
        return round(float(m_left.group(1)) * 0.5, 6), "left"

    m_right = re.match(r"^(?:oor\s*)?>=?\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$", clean, re.I)
    if m_right:
        return float(m_right.group(1)), "right"

    stripped = re.sub(r"\*+$", "", clean)
    try:
        num = float(stripped)
        if np.isfinite(num):
            return num, "none"
    except ValueError:
        pass
    return None, "missing"


def _compute_hrv_stats(ibi_values: np.ndarray) -> Optional[Tuple[float, float, float]]:
    if len(ibi_values) < 2:
        return None
    ms = np.where(ibi_values < 10.0, ibi_values * 1000.0, ibi_values)
    valid = ms[(ms >= 250.0) & (ms <= 2500.0)]
    if len(valid) < 2:
        return None
    mean_ms = float(valid.mean())
    hr_mean = round(60000.0 / mean_ms, 3)
    sdnn = round(float(valid.std(ddof=1)), 3)
    rmssd = round(float(np.sqrt(np.mean(np.diff(valid) ** 2))), 3)
    return hr_mean, sdnn, rmssd


def _parse_time_seconds(raw: Any) -> Optional[float]:
    if raw is None or (isinstance(raw, float) and np.isnan(raw)):
        return None
    s = str(raw).strip()
    m = re.match(r"^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$", s)
    if m:
        hh, mm = int(m.group(1)), int(m.group(2))
        ss = int(m.group(3)) if m.group(3) is not None else 0
        if 0 <= hh < 48 and 0 <= mm < 60 and 0 <= ss < 60:
            return float(hh * 3600 + mm * 60 + ss)
    try:
        dt = pd.to_datetime(s, errors="coerce")
        if pd.notna(dt):
            return dt.timestamp()
    except Exception:
        pass
    return None


def _format_window_label(bucket_sec: int, is_epoch: bool) -> str:
    if is_epoch:
        return datetime.fromtimestamp(bucket_sec, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    day = bucket_sec // 86400 + 1
    rem = bucket_sec % 86400
    hh = rem // 3600
    mm = (rem % 3600) // 60
    ss = rem % 60
    return f"D{day} {hh:02d}:{mm:02d}:{ss:02d}"


def _summarize_file_windows(
    entry_name: str,
    sub_df: pd.DataFrame,
    window_mode: str = "window_60s",
    window_seconds: int = 60,
    num_epochs: int = 20,
) -> Tuple[List[Dict[str, Any]], bool, List[int]]:
    base = entry_name.split("/")[-1].rsplit(".", 1)[0]
    num_cols = [
        c for c in sub_df.select_dtypes(include=[np.number]).columns
        if not re.match(r"^(day|unnamed|index)$", c.strip(), re.I)
    ]
    time_col = next((c for c in sub_df.columns if re.match(r"^(time|timestamp|datetime|date_time|start)$", c.strip(), re.I)), None)
    day_col = next((c for c in sub_df.columns if re.match(r"^(day|day_index)$", c.strip(), re.I)), None)
    ibi_col = next((c for c in num_cols if re.search(r"ibi|rr", c, re.I)), None)

    if len(sub_df) <= 25:
        summary: Dict[str, Any] = {}
        for nc in num_cols:
            if sub_df[nc].notna().any():
                summary[f"{base}_{nc}"] = float(sub_df[nc].mean())
        return [summary], True, []

    def build_row(sl: pd.DataFrame, w_idx: int, explicit_ts: Optional[str] = None) -> Dict[str, Any]:
        row_dict: Dict[str, Any] = {"epoch_index": w_idx + 1}
        if explicit_ts:
            row_dict[f"{base}_time"] = explicit_ts
        elif time_col and sl[time_col].notna().any():
            row_dict[f"{base}_time"] = str(sl[time_col].iloc[0])
        for nc in num_cols:
            if sl[nc].notna().any():
                row_dict[f"{base}_{nc}_mean"] = round(float(sl[nc].mean()), 4)
        if ibi_col and sl[ibi_col].notna().sum() >= 2:
            hrv = _compute_hrv_stats(sl[ibi_col].dropna().values)
            if hrv:
                row_dict[f"{base}_HR_bpm_mean"] = hrv[0]
                row_dict[f"{base}_SDNN_ms"] = hrv[1]
                row_dict[f"{base}_RMSSD_ms"] = hrv[2]
        return row_dict

    if window_mode == "window_60s":
        bucket_ids: List[int] = []
        day_rollover = 0
        prev_hms: Optional[float] = None
        cum_ibi = 0.0
        is_epoch = False

        for idx in range(len(sub_df)):
            b_num: Optional[int] = None
            if time_col:
                psec = _parse_time_seconds(sub_df[time_col].iloc[idx])
                if psec is not None:
                    if psec > 1e8:
                        is_epoch = True
                        b_num = int(psec // window_seconds)
                    else:
                        d_off = 0
                        if day_col and pd.notna(sub_df[day_col].iloc[idx]):
                            try:
                                d_off = max(0, int(float(sub_df[day_col].iloc[idx])) - 1)
                            except (ValueError, TypeError):
                                d_off = 0
                        else:
                            if prev_hms is not None and psec < prev_hms - 43200:
                                day_rollover += 1
                            d_off = day_rollover
                            prev_hms = psec
                        b_num = int((d_off * 86400 + psec) // window_seconds)
            if b_num is None:
                if ibi_col and pd.notna(sub_df[ibi_col].iloc[idx]):
                    v = float(sub_df[ibi_col].iloc[idx])
                    ibi_sec = v / 1000.0 if v > 10.0 else v
                    b_num = int(cum_ibi // window_seconds)
                    cum_ibi += ibi_sec
                else:
                    b_num = idx // window_seconds
            bucket_ids.append(b_num)

        work_df = sub_df.copy()
        work_df["_bucket_id"] = bucket_ids
        sorted_keys = sorted(work_df["_bucket_id"].unique().tolist())
        grouped = work_df.groupby("_bucket_id", sort=True)
        rows_out: List[Dict[str, Any]] = []
        for idx, b_key in enumerate(sorted_keys):
            sl = grouped.get_group(b_key)
            label = _format_window_label(int(b_key) * window_seconds, is_epoch)
            rows_out.append(build_row(sl, idx, label))
        return rows_out, False, sorted_keys

    # Fallback 'epoch_20' chronological binning
    eff = min(num_epochs, len(sub_df))
    step = int(np.ceil(len(sub_df) / max(1, eff)))
    rows_out = []
    keys = []
    for w in range(eff):
        sl = sub_df.iloc[w * step : (w + 1) * step]
        if sl.empty:
            continue
        rows_out.append(build_row(sl, w))
        keys.append(w + 1)
    return rows_out, False, keys


def parse_uploaded_bytes(
    raw_bytes: bytes,
    filename: str,
    domain: str,
    mmash_window_mode: str = "window_60s",
    window_seconds: int = 60,
) -> Tuple[pd.DataFrame, str, Optional[List[Dict[str, Any]]], List[str]]:
    lower = filename.lower()
    notes: List[str] = []

    if lower.endswith((".csv", ".tsv", ".txt")):
        sep = "\t" if lower.endswith(".tsv") else None
        df = pd.read_csv(io.BytesIO(raw_bytes), sep=sep, engine="python", na_values=list(MISSING_TOKENS))
        if df.empty:
            raise ValueError(f"Uploaded file '{filename}' contains no rows.")
        notes.append(f"Parsed CSV '{filename}' with {len(df)} raw rows and {len(df.columns)} columns.")
        return df, "csv", None, notes

    if lower.endswith(".zip"):
        zf = zipfile.ZipFile(io.BytesIO(raw_bytes))
        csv_entries = [
            name for name in zf.namelist()
            if name.lower().endswith(".csv") and "__MACOSX" not in name and not name.split("/")[-1].startswith(".")
        ]
        if not csv_entries:
            raise ValueError(f"ZIP archive '{filename}' contains no CSV files.")

        manifest: List[Dict[str, Any]] = []
        by_subject: Dict[str, Dict[str, Any]] = {}

        for entry_name in csv_entries:
            with zf.open(entry_name) as f:
                sub_df = pd.read_csv(f, engine="python", na_values=list(MISSING_TOKENS))
            subj = _infer_subject_from_path(entry_name) or entry_name.split("/")[-2] if "/" in entry_name else "subject_1"
            manifest.append({
                "path": entry_name,
                "rowCount": int(len(sub_df)),
                "columns": list(sub_df.columns),
                "inferredSubjectId": subj,
            })
            if sub_df.empty:
                continue
            fname_l = entry_name.lower()
            if domain == "physiological" and ("user_info" in fname_l or "questionnaire" in fname_l):
                continue

            if subj not in by_subject:
                by_subject[subj] = {"buckets": {}, "summary": {}, "flat": []}

            if _infer_subject_from_path(entry_name) is None and len(csv_entries) <= 3 and len(sub_df) <= 2000:
                sub_copy = sub_df.copy()
                sub_copy["subject_id"] = subj
                by_subject[subj]["flat"].append(sub_copy)
                continue

            ep_rows, is_summary, b_keys = _summarize_file_windows(
                entry_name, sub_df, window_mode=mmash_window_mode, window_seconds=window_seconds
            )
            if is_summary:
                by_subject[subj]["summary"].update(ep_rows[0])
            else:
                for idx, r in enumerate(ep_rows):
                    k = b_keys[idx] if b_keys else idx + 1
                    bucket = by_subject[subj]["buckets"].setdefault(k, {"subject_id": subj})
                    bucket.update(r)

        aligned: List[Dict[str, Any]] = []
        for subj in sorted(by_subject.keys()):
            sdata = by_subject[subj]
            for flat_df in sdata["flat"]:
                aligned.extend(flat_df.to_dict(orient="records"))
            if sdata["buckets"]:
                seq = 1
                for b_key in sorted(sdata["buckets"].keys()):
                    merged = {**sdata["buckets"][b_key], **sdata["summary"], "epoch_index": seq}
                    seq += 1
                    tkey = next((k for k in merged if k.endswith("_time") and merged[k]), None)
                    if tkey and "timestamp" not in merged:
                        merged["timestamp"] = merged[tkey]
                    aligned.append(merged)
            elif sdata["summary"]:
                aligned.append({"subject_id": subj, **sdata["summary"]})

        if not aligned:
            raise ValueError(f"No usable tabular observations extracted from '{filename}'.")

        combined = pd.DataFrame(aligned)
        notes.append(
            f"Extracted ZIP '{filename}' ({mmash_window_mode}): inspected {len(csv_entries)} CSVs -> {len(combined)} aligned rows across {len(by_subject)} subjects."
        )
        return combined, "zip", manifest, notes

    raise ValueError(f"Unsupported file type for '{filename}'. Provide .csv or .zip.")


def _audit_cbc_consistency(df_clean: pd.DataFrame, subject_ids: List[str]) -> Tuple[List[Dict[str, Any]], set[int]]:
    cols = list(df_clean.columns)
    plt_col = next((c for c in cols if re.search(r"platelet_count", c, re.I) and "range" not in c.lower()), None)
    mpv_col = next((c for c in cols if re.search(r"(?:^|_)mpv(?:_|$)", c, re.I) and "range" not in c.lower()), None)
    rdw_col = next((c for c in cols if re.search(r"(?:^|_)rdw(?:_|$)", c, re.I) and "range" not in c.lower()), None)
    wbc_col = next((c for c in cols if re.search(r"white_blood_cell|wbc", c, re.I) and "range" not in c.lower()), None)
    abs_neut_col = next((c for c in cols if re.search(r"absolute_neutrophils", c, re.I) and "range" not in c.lower()), None)
    pct_neut_col = next((c for c in cols if re.search(r"neutrophils_value_percent", c, re.I)), None)
    abs_lymph_col = next((c for c in cols if re.search(r"absolute_lymphocytes", c, re.I) and "range" not in c.lower()), None)
    pct_lymph_col = next((c for c in cols if re.search(r"lymphocytes_value_percent", c, re.I)), None)

    findings: List[Dict[str, Any]] = []
    suspect_rows: set[int] = set()

    for i in range(len(df_clean)):
        row_findings: List[str] = []
        rec_vals: Dict[str, Any] = {}
        plt = pd.to_numeric(df_clean[plt_col].iloc[i], errors="coerce") if plt_col else np.nan
        mpv = pd.to_numeric(df_clean[mpv_col].iloc[i], errors="coerce") if mpv_col else np.nan
        rdw = pd.to_numeric(df_clean[rdw_col].iloc[i], errors="coerce") if rdw_col else np.nan
        wbc = pd.to_numeric(df_clean[wbc_col].iloc[i], errors="coerce") if wbc_col else np.nan
        abs_neut = pd.to_numeric(df_clean[abs_neut_col].iloc[i], errors="coerce") if abs_neut_col else np.nan
        pct_neut = pd.to_numeric(df_clean[pct_neut_col].iloc[i], errors="coerce") if pct_neut_col else np.nan
        abs_lymph = pd.to_numeric(df_clean[abs_lymph_col].iloc[i], errors="coerce") if abs_lymph_col else np.nan
        pct_lymph = pd.to_numeric(df_clean[pct_lymph_col].iloc[i], errors="coerce") if pct_lymph_col else np.nan

        if pd.notna(plt) and float(plt) < 50:
            rec_vals["platelet_count"] = float(plt)
            row_findings.append(f"Platelet count {plt} is implausibly low.")
        if pd.notna(mpv) and float(mpv) > 30:
            rec_vals["mpv"] = float(mpv)
            row_findings.append(f"MPV {mpv} fL is physiologically impossible (matches typical platelet scale).")
        if pd.notna(rdw) and float(rdw) > 25:
            rec_vals["rdw"] = float(rdw)
            row_findings.append(f"RDW {rdw}% is >2.5x cohort baseline.")
        if pd.notna(wbc) and pd.notna(pct_neut) and pd.notna(abs_neut):
            exp_neut = float(wbc) * 1000.0 * (float(pct_neut) / 100.0)
            if abs(float(abs_neut) - exp_neut) > max(500.0, exp_neut * 0.25):
                rec_vals["absolute_neutrophils"] = float(abs_neut)
                row_findings.append(f"WBC × Neut% predicts {exp_neut:.1f}, recorded {abs_neut}.")
        if pd.notna(wbc) and pd.notna(pct_lymph) and pd.notna(abs_lymph):
            exp_lymph = float(wbc) * 1000.0 * (float(pct_lymph) / 100.0)
            if abs(float(abs_lymph) - exp_lymph) > max(500.0, exp_lymph * 0.25):
                rec_vals["absolute_lymphocytes"] = float(abs_lymph)
                row_findings.append(f"WBC × Lymph% predicts {exp_lymph:.1f}, recorded {abs_lymph}.")

        if row_findings:
            if len(row_findings) >= 2:
                suspect_rows.add(i)
            findings.append({
                "rowIndex": i + 1,
                "sampleName": subject_ids[i],
                "severity": "critical" if len(row_findings) >= 2 else "warning",
                "findings": row_findings,
                "recordedValues": rec_vals,
                "handling": "Preserved intact in source table; toggleable for exclusion from CBC model fitting.",
            })

    return findings, suspect_rows


def preprocess_cohort(
    df: pd.DataFrame,
    domain: str,
    filename: str,
    file_type: str = "csv",
    zip_manifest: Optional[List[Dict[str, Any]]] = None,
    parser_notes: Optional[List[str]] = None,
    immune_mode: str = "per_analyte",
    cbc_exclude_suspect_rows: bool = False,
) -> PreprocessedCohort:
    notes = list(parser_notes or [])
    raw_row_count = int(len(df))

    # 1. Exact duplicate removal
    df_clean = df.drop_duplicates().reset_index(drop=True)
    duplicate_count = raw_row_count - int(len(df_clean))
    if duplicate_count > 0:
        notes.append(f"Removed {duplicate_count} exact duplicate row(s).")

    # 2. Identify subject ID, timestamp, analyte, and unit columns
    cols = list(df_clean.columns)
    subject_col = next(
        (c for c in cols if re.match(r"^(subject|participant|user|astronaut|crew|animal|mouse|patient|sample|specimen)[_\s-]*(id|num|code|name)?$", c, re.I) or c.lower() in {"subject_id", "id", "sample name"}),
        None,
    )
    timestamp_col = next(
        (c for c in cols if c != subject_col and re.search(r"timestamp|date|time|collection|day|epoch", c, re.I) and not pd.api.types.is_numeric_dtype(df_clean[c])),
        None,
    )
    analyte_col = next((c for c in cols if re.match(r"^(analyte|cytokine|biomarker|panel_marker|marker)$", c.strip(), re.I)), None)
    unit_col = next((c for c in cols if re.match(r"^(unit|units)$", c.strip(), re.I)), None)

    label_candidates = [
        c for c in cols
        if re.match(r"^(label|target|y|outcome|diagnosis|anomaly|is_anomaly|ground_truth|class)$", c, re.I)
    ]

    if label_candidates:
        supervised_audit = {
            "hasValidLabels": True,
            "candidateColumns": label_candidates,
            "reason": f"Candidate target column(s) detected: {', '.join(label_candidates)}. Verify ground-truth validity before supervised modeling.",
        }
    else:
        supervised_audit = {
            "hasValidLabels": False,
            "candidateColumns": [],
            "reason": "No ground-truth diagnostic or anomaly label column exists; supervised models are omitted to avoid fabricating labels.",
        }

    # 3. Coerce numeric feature columns with censored-value tracking
    dropped_high_missing: List[str] = []
    base_feature_columns: List[str] = []
    column_profiles: List[Dict[str, Any]] = []
    censor_tracking: Dict[str, List[str]] = {}
    left_censored_total = 0
    right_censored_total = 0

    for c in cols:
        series = df_clean[c]
        parsed_vals: List[Optional[float]] = []
        censors: List[str] = []
        censored_tokens = 0
        for raw in series.tolist():
            val, cen = parse_numeric_with_censor(raw)
            parsed_vals.append(val)
            censors.append(cen)
            if cen in {"left", "right"}:
                censored_tokens += 1
                if cen == "left":
                    left_censored_total += 1
                else:
                    right_censored_total += 1

        censor_tracking[c] = censors
        coerced = pd.Series(parsed_vals, dtype="float64")
        non_null_raw = int(series.notna().sum())
        numeric_ratio = float((coerced.notna().sum() + censored_tokens) / max(1, non_null_raw))
        is_num = pd.api.types.is_numeric_dtype(series) or (non_null_raw > 0 and numeric_ratio >= 0.7)

        missing_count = int(coerced.isna().sum()) if is_num else int(series.isna().sum())
        missing_pct = round(missing_count / max(1, len(df_clean)) * 100.0, 2)

        is_ref_range = bool(re.search(r"(?:^|_)range_(?:min|max)(?:_|$)|(?:^|_)(?:ref|reference)_(?:min|max|low|high)(?:_|$)", c, re.I))
        is_index_date = bool(re.match(r"^(epoch_index|row_index|unnamed:\s*\d+|index)$", c, re.I)) or (
            domain == "physiological" and bool(re.search(r"_(?:in bed date|out bed date|onset date|day)$", c, re.I))
        )

        role = "ignored"
        if c == subject_col:
            role = "subject_id"
        elif c == timestamp_col:
            role = "timestamp"
        elif c in label_candidates:
            role = "label_candidate"
        elif is_ref_range or is_index_date:
            role = "ignored"
        elif is_num:
            role = "feature"

        stats_dict: Dict[str, Any] = {
            "min": None, "max": None, "mean": None, "median": None,
            "std": None, "q25": None, "q75": None, "iqrOutlierCount": 0,
        }

        if is_num:
            valid = coerced.dropna()
            if len(valid) > 0:
                q25 = float(valid.quantile(0.25))
                q75 = float(valid.quantile(0.75))
                iqr = q75 - q25
                outliers = int(((valid < q25 - 1.5 * iqr) | (valid > q75 + 1.5 * iqr)).sum()) if iqr > 0 else 0
                stats_dict = {
                    "min": round(float(valid.min()), 4),
                    "max": round(float(valid.max()), 4),
                    "mean": round(float(valid.mean()), 4),
                    "median": round(float(valid.median()), 4),
                    "std": round(float(valid.std(ddof=1)) if len(valid) > 1 else 0.0, 4),
                    "q25": round(q25, 4),
                    "q75": round(q75, 4),
                    "iqrOutlierCount": outliers,
                }
            if role == "feature":
                if missing_pct > 50.0:
                    dropped_high_missing.append(c)
                elif stats_dict["std"] is not None and stats_dict["std"] > 1e-12:
                    df_clean[c] = coerced
                    base_feature_columns.append(c)
                else:
                    notes.append(f"Excluded zero-variance column '{c}' from modeling.")

        column_profiles.append({
            "name": c,
            "inferredType": "numeric" if is_num else ("datetime" if c == timestamp_col else "categorical"),
            "role": role,
            "unit": _extract_unit(c),
            "nonNullCount": int(len(df_clean) - missing_count),
            "missingCount": missing_count,
            "missingPct": missing_pct,
            "uniqueCount": int(series.nunique(dropna=True)),
            **stats_dict,
        })

    subject_ids_all = (
        df_clean[subject_col].fillna("unknown").astype(str).tolist()
        if subject_col
        else [f"row_{i + 1}" for i in range(len(df_clean))]
    )
    timestamps_all = (
        [None if pd.isna(v) else str(v) for v in df_clean[timestamp_col].tolist()]
        if timestamp_col
        else [None] * len(df_clean)
    )

    # 4. CBC Source Data Integrity Audit & Optional Suspect-Row Exclusion
    cbc_findings: List[Dict[str, Any]] = []
    integrity_statuses: Optional[List[str]] = None
    if domain == "cbc":
        cbc_findings, suspect_rows = _audit_cbc_consistency(df_clean, subject_ids_all)
        integrity_statuses = [
            "suspected_corrupted" if i in suspect_rows else "verified" for i in range(len(df_clean))
        ]
        if cbc_exclude_suspect_rows and suspect_rows:
            keep_mask = [i not in suspect_rows for i in range(len(df_clean))]
            df_clean = df_clean.loc[keep_mask].reset_index(drop=True)
            subject_ids_all = [s for idx, s in enumerate(subject_ids_all) if idx not in suspect_rows]
            timestamps_all = [t for idx, t in enumerate(timestamps_all) if idx not in suspect_rows]
            integrity_statuses = ["verified"] * len(df_clean)
            notes.append(f"Excluded {len(suspect_rows)} suspect CBC record(s) from model fitting while retaining audit findings.")

    # 5. Immune Per-Analyte Normalization / Wide Pivot
    analyte_labels: Optional[List[Optional[str]]] = None
    immune_row_meta: List[Dict[str, Any]] = []
    engineered: List[str] = []
    feature_columns = list(base_feature_columns)

    if domain == "immune" and analyte_col:
        analyte_labels = df_clean[analyte_col].fillna("Unknown_Analyte").astype(str).tolist()
        conc_col = next((c for c in feature_columns if re.match(r"^(concentration|conc|value)$", c, re.I)), feature_columns[0] if feature_columns else None)

        # Resolve pure OOR< / OOR> tokens per analyte
        for analyte, grp_idx in df_clean.groupby(analyte_col, sort=False).groups.items():
            idx_list = list(grp_idx)
            for fc in feature_columns:
                pos_vals = df_clean.loc[idx_list, fc].dropna()
                pos_vals = pos_vals[pos_vals > 0]
                min_pos = float(pos_vals.min()) if len(pos_vals) > 0 else 0.01
                max_pos = float(pos_vals.max()) if len(pos_vals) > 0 else 1.0
                for r_i in idx_list:
                    if pd.isna(df_clean.at[r_i, fc]):
                        cen = censor_tracking[fc][r_i]
                        if cen == "left":
                            df_clean.at[r_i, fc] = round(min_pos * 0.5, 6)
                        elif cen == "right":
                            df_clean.at[r_i, fc] = max_pos

        if immune_mode == "wide_pivot" and conc_col:
            pivot_df = df_clean.copy()
            pivot_df["_subj"] = subject_ids_all
            pivot_df["_ts"] = [t or "" for t in timestamps_all]
            piv = pivot_df.pivot_table(index=["_subj", "_ts"], columns=analyte_col, values=conc_col, aggfunc="mean")
            valid_cols = [c for c in piv.columns if piv[c].notna().sum() >= max(3, int(0.5 * len(piv))) and piv[c].std(ddof=1) > 1e-12]
            if len(valid_cols) >= 2 and len(piv) >= 4:
                piv = piv[valid_cols]
                imputer = SimpleImputer(strategy="median")
                imputed_matrix = imputer.fit_transform(piv.values)
                scaler = StandardScaler()
                scaled_matrix = scaler.fit_transform(imputed_matrix)
                means = imputed_matrix.mean(axis=0)
                stds = np.where(imputed_matrix.std(axis=0, ddof=1) > 1e-12, imputed_matrix.std(axis=0, ddof=1), 1.0)
                medians = np.median(imputed_matrix, axis=0)
                mads = np.median(np.abs(imputed_matrix - medians), axis=0)
                mads = np.where(mads > 1e-12, mads, stds * 0.6745)
                piv_subj = [idx[0] for idx in piv.index]
                piv_ts = [idx[1] if idx[1] else None for idx in piv.index]
                notes.append(f"Wide-format pivot constructed {len(piv)} samples × {len(valid_cols)} analyte features.")
                metadata = {
                    "id": f"{domain}_{int(datetime.now(timezone.utc).timestamp())}",
                    "domain": domain, "filename": filename, "fileType": file_type,
                    "provenanceNote": DOMAIN_PROVENANCE[domain],
                    "uploadedAt": datetime.now(timezone.utc).isoformat(),
                    "rowCount": int(len(piv)), "rawRowCount": raw_row_count,
                    "duplicateCount": duplicate_count, "columnCount": int(len(cols)),
                    "subjectCount": int(len(set(piv_subj))), "subjectIds": list(dict.fromkeys(piv_subj))[:100],
                    "subjectIdColumn": subject_col, "hasTimestamps": any(t is not None for t in piv_ts),
                    "timestampColumn": timestamp_col, "timestampRange": None,
                    "columns": column_profiles, "droppedHighMissingColumns": dropped_high_missing,
                    "imputedCellCount": int(piv.isna().sum().sum()), "engineeredFeatures": list(valid_cols[:10]),
                    "supervisedLabelAudit": supervised_audit, "qualityNotes": notes, "zipManifest": zip_manifest,
                }
                return PreprocessedCohort(
                    metadata=metadata, feature_columns=list(valid_cols),
                    raw_df=pd.DataFrame(imputed_matrix, columns=list(valid_cols)),
                    scaled_matrix=scaled_matrix, scaler=scaler, imputer=imputer,
                    feature_means=means, feature_stds=stds, feature_medians=medians, feature_mads=mads,
                    subject_ids=piv_subj, timestamps=piv_ts,
                )

        if immune_mode == "per_analyte" and feature_columns:
            norm_cols: List[str] = []
            for fc in feature_columns:
                norm_name = f"{fc}_analyte_z"
                norm_vals = np.zeros(len(df_clean), dtype="float64")
                for analyte, grp_idx in df_clean.groupby(analyte_col, sort=False).groups.items():
                    idx_list = list(grp_idx)
                    vals = df_clean.loc[idx_list, fc]
                    med = float(vals.median()) if vals.notna().any() else 0.0
                    filled = vals.fillna(med)
                    mean = float(filled.mean())
                    std = float(filled.std(ddof=1)) if len(filled) > 1 else 1.0
                    if std <= 1e-12:
                        std = 1.0
                    norm_vals[idx_list] = (filled.values - mean) / std
                df_clean[norm_name] = norm_vals
                norm_cols.append(norm_name)
                engineered.append(norm_name)
            feature_columns = norm_cols
            notes.append(f"Applied per-analyte standardization across {df_clean[analyte_col].nunique()} analytes ({', '.join(norm_cols)}).")

    # 6. Domain-safe CBC NLR ratio engineering if neutrophils & lymphocytes exist
    if domain == "cbc":
        neut = next((c for c in feature_columns if re.search(r"absolute_neutrophils", c, re.I) or (re.search(r"neutrophil|neut", c, re.I) and not re.search(r"pct|percent|%", c, re.I))), None)
        lymph = next((c for c in feature_columns if re.search(r"absolute_lymphocytes", c, re.I) or (re.search(r"lymphocyte|lymph", c, re.I) and not re.search(r"pct|percent|%", c, re.I))), None)
        if neut and lymph:
            denom = df_clean[lymph].where(df_clean[lymph] > 1e-6, np.nan)
            nlr = df_clean[neut] / denom
            if nlr.notna().sum() >= max(3, int(0.5 * len(df_clean))):
                df_clean["NLR_engineered"] = nlr
                feature_columns.append("NLR_engineered")
                engineered.append("NLR_engineered")
                notes.append(f"Engineered NLR_engineered from '{neut}' / '{lymph}'.")

    if not feature_columns:
        raise ValueError(f"No usable numeric modeling features remained in '{filename}'.")

    # 7. Median imputation and StandardScaler normalization
    feature_df = df_clean[feature_columns].copy()
    imputed_cells = int(feature_df.isna().sum().sum())
    imputer = SimpleImputer(strategy="median")
    imputed_matrix = imputer.fit_transform(feature_df)

    scaler = StandardScaler()
    scaled_matrix = scaler.fit_transform(imputed_matrix)

    means = imputed_matrix.mean(axis=0)
    stds = np.where(imputed_matrix.std(axis=0, ddof=1) > 1e-12, imputed_matrix.std(axis=0, ddof=1), 1.0)
    medians = np.median(imputed_matrix, axis=0)
    mads = np.median(np.abs(imputed_matrix - medians), axis=0)
    mads = np.where(mads > 1e-12, mads, stds * 0.6745)

    valid_ts = [t for t in timestamps_all if t is not None]
    ts_range = [valid_ts[0], valid_ts[-1]] if valid_ts else None

    metadata = {
        "id": f"{domain}_{int(datetime.now(timezone.utc).timestamp())}",
        "domain": domain,
        "filename": filename,
        "fileType": file_type,
        "provenanceNote": DOMAIN_PROVENANCE[domain],
        "uploadedAt": datetime.now(timezone.utc).isoformat(),
        "rowCount": int(len(df_clean)),
        "rawRowCount": raw_row_count,
        "duplicateCount": duplicate_count,
        "columnCount": int(len(cols)),
        "subjectCount": int(len(set(subject_ids_all))),
        "subjectIds": list(dict.fromkeys(subject_ids_all))[:100],
        "subjectIdColumn": subject_col,
        "hasTimestamps": len(valid_ts) > 0,
        "timestampColumn": timestamp_col,
        "timestampRange": ts_range,
        "columns": column_profiles,
        "droppedHighMissingColumns": dropped_high_missing,
        "imputedCellCount": imputed_cells,
        "engineeredFeatures": engineered,
        "supervisedLabelAudit": supervised_audit,
        "qualityNotes": notes,
        "dataQualityAudit": {
            "cbcConsistencyFindings": cbc_findings,
            "leftCensoredCount": left_censored_total,
            "rightCensoredCount": right_censored_total,
        },
        "zipManifest": zip_manifest,
    }

    return PreprocessedCohort(
        metadata=metadata,
        feature_columns=feature_columns,
        raw_df=pd.DataFrame(imputed_matrix, columns=feature_columns),
        scaled_matrix=scaled_matrix,
        scaler=scaler,
        imputer=imputer,
        feature_means=means,
        feature_stds=stds,
        feature_medians=medians,
        feature_mads=mads,
        subject_ids=subject_ids_all,
        timestamps=timestamps_all,
        analyte_labels=analyte_labels,
        integrity_statuses=integrity_statuses,
        immune_row_meta=immune_row_meta,
    )
