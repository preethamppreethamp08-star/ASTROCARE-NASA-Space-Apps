# Trained Model Artifacts Directory

This directory stores serialized `.joblib` artifacts generated **only after genuine model training**:

- `physiological_anomaly_model.joblib`
- `cbc_anomaly_model.joblib`
- `immune_anomaly_model.joblib`

No placeholder or fabricated `.joblib` binaries are committed prior to training on real datasets. Run either the FastAPI backend (`POST /api/upload`) or `notebooks/ASTROCARE_COMPLETE_ML_PIPELINE.ipynb` in Google Colab and place downloaded `.joblib` files here.
