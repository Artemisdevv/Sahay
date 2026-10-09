from datetime import datetime
from typing import Literal
from uuid import UUID
import base64
import binascii

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=200)


class DeviceRegistrationRequest(BaseModel):
    device_id: UUID
    ed25519_public_key: str
    language: str = Field(default="en", min_length=2, max_length=12)

    @field_validator("ed25519_public_key")
    @classmethod
    def validate_public_key(cls, value: str) -> str:
        try:
            decoded = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("ed25519_public_key must be standard base64") from exc
        if len(decoded) != 32:
            raise ValueError("ed25519_public_key must decode to 32 bytes")
        return value
