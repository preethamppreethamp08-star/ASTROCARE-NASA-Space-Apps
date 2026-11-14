from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field

DatasetDomain = Literal["physiological", "cbc", "immune"]
MmashWindowMode = Literal["window_60s", "epoch_20"]
ImmuneProcessingMode = Literal["per_analyte", "wide_pivot", "pooled"]


class AnalyzeRequest(BaseModel):
    domain: Optional[DatasetDomain] = None
    contamination: float = Field(default=0.05, ge=0.01, le=0.25)
    mmashWindowMode: Optional[MmashWindowMode] = None
    mmashWindowSeconds: int = Field(default=60, ge=10, le=3600)
    immuneProcessingMode: Optional[ImmuneProcessingMode] = None
    cbcExcludeSuspectRows: Optional[bool] = None


class SimulationStartRequest(BaseModel):
    domain: Optional[DatasetDomain] = None
    interval_ms: int = Field(default=1000, ge=250, le=5000)


class HealthResponse(BaseModel):
    status: str
    service: str
    models_directory: str
    datasets_loaded: int
    trained_models: List[str]
    timestamp: str


class FeatureContributionOut(BaseModel):
    feature: str
    value: float
    cohortMean: float
    cohortStd: float
    zScore: float
    shapValue: Optional[float] = None
    contributionPct: float
    direction: Literal["elevated", "depressed", "nominal"]


class AnalyzedObservationOut(BaseModel):
    index: int
    subjectId: str
    timestamp: Optional[str] = None
    analyte: Optional[str] = None
    integrityStatus: Optional[Literal["verified", "suspected_corrupted"]] = None
    values: Dict[str, float]
    anomalyScore: float
    decisionScore: float
    isAnomaly: bool
    baselineMaxModifiedZ: float
    baselineFlag: bool
    featureContributions: List[FeatureContributionOut]
    explanation: str


class GenericJsonResponse(BaseModel):
    data: Dict[str, Any]
