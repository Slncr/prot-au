from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel


class ProtocolListItem(BaseModel):
    url: str
    fileName: str
    status: str
    analyzedAt: Optional[str] = None
    doctorFio: Optional[str] = None
    patientFio: Optional[str] = None


class AnalyzeRequest(BaseModel):
    url: str
    force: Optional[bool] = False


class FinalCheck(BaseModel):
    ok: bool
    errors: Optional[Union[List[str], str]] = None


class AnalysisResult(BaseModel):
    model_config = {"extra": "allow"}

    dateOfAdmission: Optional[str] = None
    patientFio: Optional[str] = None
    doctorFio: Optional[str] = None

    diagnosisAssessment: Optional[Any] = None
    therapyAssessment: Optional[Any] = None

    recommendations: Optional[str] = None
    sectionsCheck: Optional[Dict[str, str]] = None
    finalCheck: Optional[FinalCheck] = None

    # Отладочно/удобно для UI
    extractedText: Optional[str] = None


class AnalyzeResponse(BaseModel):
    analysis: AnalysisResult


class UploadProtocolResponse(BaseModel):
    url: str
    analysis: AnalysisResult


class DoctorErrorsStat(BaseModel):
    doctorFio: str
    withErrors: int
    total: int


class DoctorProtocolsItem(BaseModel):
    url: str
    fileName: str
    status: str
    analyzedAt: Optional[str] = None


class DoctorProtocolsResponse(BaseModel):
    doctorFio: str
    period: str
    total: int
    items: List[DoctorProtocolsItem]


class DoctorRatingItem(BaseModel):
    doctorFio: str
    withErrors: int
    total: int
    errorRate: float
    okRate: float


class DoctorsRatingResponse(BaseModel):
    minSamples: int
    topBest: List[DoctorRatingItem]
    topWorst: List[DoctorRatingItem]


class ErrorsTimelineItem(BaseModel):
    date: str
    total: int
    withErrors: int
    ok: int
    errorRate: float


class ErrorsTimelineResponse(BaseModel):
    period: str
    items: List[ErrorsTimelineItem]

