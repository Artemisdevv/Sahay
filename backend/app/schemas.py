from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Location(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class ReportAudio(BaseModel):
    mime: str
    data: str
    duration_s: float = Field(ge=0)


class ReportPayload(BaseModel):
    schema_version: int = Field(default=1, alias="schema")
    kind: Literal["report", "sos"] = "report"
    category: Literal["accident", "fire", "medical", "crime", "flood", "other"]
    language: str = "en"
    captured_at: datetime
    location: Location
    audio: ReportAudio | None = None
    text: str | None = None
    reporter: dict | None = None
    emergency_contact: dict | None = None
    model_config = ConfigDict(populate_by_name=True)

    @model_validator(mode="after")
    def has_content(self):
        if self.audio is None and not self.text:
            raise ValueError("audio or text must be present")
        return self


class MockReportRequest(ReportPayload):
    report_id: str | None = None
    severity: int = Field(default=3, ge=1, le=5)
    people_count: int = Field(default=1, ge=0)
    summary_redacted: str | None = None
    needed_services: list[Literal["ambulance", "police", "fire", "municipal"]] | None = None


class LoginRequest(BaseModel):
    username: str
    password: str
