"""Structured outputs for the agents (Pydantic). Same shapes whether produced by rules or an LLM."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Category = Literal["accident", "fire", "medical", "crime", "flood", "other"]
Service = Literal["ambulance", "police", "fire", "municipal"]
PiiType = Literal["phone", "email", "aadhaar", "plate", "name", "address", "other"]


class IntakeResult(BaseModel):
    incident_type: Category
    severity: int = Field(ge=1, le=5)
    people_count: int = Field(ge=0, default=1)
    hazards: list[str] = Field(default_factory=list)
    location_hint: str | None = None
    summary: str = Field(max_length=500)
    confidence: float = Field(ge=0, le=1)


class PiiTag(BaseModel):
    type: PiiType
    text: str
    start: int = Field(ge=0)
    end: int = Field(ge=0)


class TriageResult(BaseModel):
    needed_services: list[Service]
    urgency_score: float = Field(ge=0, le=1)
    reason: str = Field(max_length=250)
