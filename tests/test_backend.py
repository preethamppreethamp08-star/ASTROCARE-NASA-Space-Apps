import io
import zipfile
import pandas as pd
from fastapi.testclient import TestClient

from backend.main import app
from backend.preprocessing import parse_uploaded_bytes, preprocess_cohort

client = TestClient(app)


def _build_synthetic_mmash_zip() -> bytes:
    """Synthetic MMASH-structured multi-subject ZIP fixture strictly for unit testing."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for subj in ("user_1", "user_2"):
            rr_rows = []
            act_rows = []
            # 5 chronological minutes (300 seconds) per subject across day 1
            for sec in range(0, 300, 1):
                hh = 9 + (sec // 3600)
                mm = (sec % 3600) // 60
                ss = sec % 60
                t_str = f"{hh:02d}:{mm:02d}:{ss:02d}"
                act_rows.append(
                    f"{10 + (sec % 5)},{12 + (sec % 4)},{15 + (sec % 6)},{1 if sec % 3 == 0 else 0},{72 + (sec % 8)},0,1,0,0,28.5,1,{t_str}"
                )
                base_ibi = 0.82 if subj == "user_1" else 0.74
                jitter = (((sec + (1 if subj == "user_1" else 3)) % 7) - 3) * (0.012 + (sec // 60) * 0.004)
                ibi = round(base_ibi + jitter, 4)
                if sec % 2 == 0:
                    rr_rows.append(f"{ibi},{1},{t_str}")
            zf.writestr(
                f"DataPaper/{subj}/Actigraph.csv",
                "Axis1,Axis2,Axis3,Steps,HR,Inclinometer Off,Inclinometer Standing,Inclinometer Sitting,Inclinometer Lying,Vector Magnitude,day,time\n"
                + "\n".join(act_rows),
            )
            zf.writestr(
                f"DataPaper/{subj}/RR.csv",
                "ibi_s,day,time\n" + "\n".join(rr_rows),
            )
            zf.writestr(
                f"DataPaper/{subj}/sleep.csv",
                "In Bed Date,Out Bed Date,Onset Date,Efficiency,Total Sleep Time (TST)\n2,2,2,88.5,410\n",
            )
    return buf.getvalue()


def test_health_endpoint():
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"


def test_mmash_60s_vs_20epoch_windowing():
    zip_bytes = _build_synthetic_mmash_zip()
    df_60, ftype, manifest, _ = parse_uploaded_bytes(
        zip_bytes, "MMASH_test.zip", "physiological", mmash_window_mode="window_60s", window_seconds=60
    )
    assert ftype == "zip"
    assert len(manifest) == 6
    # 2 subjects * 5 chronological minutes = 10 windows
    assert len(df_60) == 10
    assert list(df_60["subject_id"].unique()) == ["user_1", "user_2"]
    assert "RR_HR_bpm_mean" in df_60.columns
    assert "RR_SDNN_ms" in df_60.columns
    assert "RR_RMSSD_ms" in df_60.columns

    cohort_60 = preprocess_cohort(df_60, "physiological", "MMASH_test.zip", "zip")
    # Non-physiological ordinal/date columns must be excluded
    assert "epoch_index" not in cohort_60.feature_columns
    assert "sleep_In Bed Date" not in cohort_60.feature_columns
    assert "RR_HR_bpm_mean" in cohort_60.feature_columns
    assert "RR_SDNN_ms" in cohort_60.feature_columns

    df_20, _, _, _ = parse_uploaded_bytes(
        zip_bytes, "MMASH_test.zip", "physiological", mmash_window_mode="epoch_20"
    )
    assert len(df_20) == 40  # 2 subjects * 20 epochs


def test_immune_per_analyte_censored_and_wide_pivot():
    rows = []
    subjects = ["C001", "C002", "C003", "C004"]
    timepoints = ["L-92", "R+3"]
    for s in subjects:
        for tp in timepoints:
            # Low-scale analyte (0.2 - 1.0 pg/mL)
            c1 = "<0.14" if (s == "C001" and tp == "L-92") else ("5.8" if (s == "C004" and tp == "R+3") else "0.45")
            rows.append({"ID": s, "Timepoint": tp, "Analyte": "IL-6", "Unit": "pg/mL", "Concentration": c1, "Percent": "100"})
            # High-scale analyte (20,000 - 25,000 pg/mL)
            c2 = ">30000" if (s == "C002" and tp == "R+3") else "22000"
            rows.append({"ID": s, "Timepoint": tp, "Analyte": "MCP-1", "Unit": "pg/mL", "Concentration": c2, "Percent": "105"})
    df = pd.DataFrame(rows)

    cohort_norm = preprocess_cohort(df, "immune", "immune_test.csv", immune_mode="per_analyte")
    assert cohort_norm.analyte_labels is not None
    assert "IL-6" in cohort_norm.analyte_labels
    assert cohort_norm.feature_columns == ["Concentration_analyte_z", "Percent_analyte_z"]
    assert cohort_norm.metadata["dataQualityAudit"]["leftCensoredCount"] == 1
    assert cohort_norm.metadata["dataQualityAudit"]["rightCensoredCount"] == 1

    cohort_wide = preprocess_cohort(df, "immune", "immune_test.csv", immune_mode="wide_pivot")
    assert cohort_wide.metadata["rowCount"] == 8  # 4 subjects * 2 timepoints
    assert set(cohort_wide.feature_columns) == {"IL-6", "MCP-1"}


def test_cbc_integrity_audit_and_suspect_exclusion():
    rows = []
    for i in range(1, 10):
        rows.append({
            "Sample Name": f"S{i:02d}",
            "white_blood_cell_count_value_thousand_per_microliter": 7.0,
            "neutrophils_value_percent": 60.0,
            "lymphocytes_value_percent": 30.0,
            "absolute_neutrophils_value_cells_per_microliter": 4200.0,
            "absolute_lymphocytes_value_cells_per_microliter": 2100.0,
            "platelet_count_value_thousand_per_microliter": 240.0 + i,
            "mpv_value_femtoliter": 10.2,
            "rdw_value_percent": 12.5,
            "hematocrit_range_min_percent": 37.0,
            "hematocrit_range_max_percent": 48.0,
        })
    # Inject synthetic suspect transposed row
    rows.append({
        "Sample Name": "S_SUSPECT",
        "white_blood_cell_count_value_thousand_per_microliter": 9.6,
        "neutrophils_value_percent": 71.1,
        "lymphocytes_value_percent": 20.8,
        "absolute_neutrophils_value_cells_per_microliter": 10.1,
        "absolute_lymphocytes_value_cells_per_microliter": 6826.0,
        "platelet_count_value_thousand_per_microliter": 12.9,
        "mpv_value_femtoliter": 330.0,
        "rdw_value_percent": 32.4,
        "hematocrit_range_min_percent": 37.0,
        "hematocrit_range_max_percent": 48.0,
    })
    df = pd.DataFrame(rows)

    with_suspect = preprocess_cohort(df, "cbc", "cbc_test.csv", cbc_exclude_suspect_rows=False)
    assert "hematocrit_range_min_percent" not in with_suspect.feature_columns
    assert "NLR_engineered" in with_suspect.feature_columns
    assert with_suspect.metadata["rowCount"] == 10
    assert len(with_suspect.metadata["dataQualityAudit"]["cbcConsistencyFindings"]) == 1
    assert with_suspect.integrity_statuses[-1] == "suspected_corrupted"

    without_suspect = preprocess_cohort(df, "cbc", "cbc_test.csv", cbc_exclude_suspect_rows=True)
    assert without_suspect.metadata["rowCount"] == 9
    assert len(without_suspect.metadata["dataQualityAudit"]["cbcConsistencyFindings"]) == 1
    assert all(st == "verified" for st in without_suspect.integrity_statuses)


def test_upload_analyze_and_anomalies():
    df = pd.DataFrame({
        "subject_id": [f"s{i}" for i in range(1, 21)],
        "WBC": [6.1, 5.8, 6.4, 6.0, 5.9, 6.2, 6.3, 5.7, 6.1, 6.0, 5.8, 6.2, 6.1, 5.9, 6.0, 6.3, 5.8, 6.1, 6.2, 18.4],
        "RBC": [4.7, 4.8, 4.6, 4.7, 4.9, 4.8, 4.7, 4.6, 4.8, 4.7, 4.8, 4.7, 4.6, 4.8, 4.7, 4.9, 4.7, 4.8, 4.7, 2.3],
        "Platelets": [245, 250, 238, 242, 260, 255, 248, 240, 252, 247, 244, 251, 249, 246, 243, 254, 241, 248, 250, 95],
    })
    csv_bytes = df.to_csv(index=False).encode("utf-8")

    up_res = client.post(
        "/api/upload",
        data={"domain": "cbc"},
        files={"file": ("test_cbc.csv", io.BytesIO(csv_bytes), "text/csv")},
    )
    assert up_res.status_code == 200
    assert up_res.json()["metadata"]["rowCount"] == 20

    ov_res = client.get("/api/overview")
    assert ov_res.status_code == 200
    assert ov_res.json()["totalObservations"] >= 20

    anom_res = client.get("/api/anomalies?domain=cbc")
    assert anom_res.status_code == 200
    assert anom_res.json()["count"] >= 1
