"""PII agent: regex first (cheap, predictable), LLM second (names, addresses), plus literals we already know
(the reporter's own name/phone from the encrypted payload). Output: tagged spans and a redacted text.

Policy: services see only the redacted summary. Everything tagged here is stored sealed and revealed to an
admin only through the audited reveal action.
"""
from __future__ import annotations

import re

from app.agents.llm import LLM
from app.agents.schemas import PiiTag

PATTERNS: list[tuple[str, re.Pattern]] = [
    ("email", re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")),
    ("phone", re.compile(r"(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)")),
    ("aadhaar", re.compile(r"(?<!\d)\d{4}\s\d{4}\s\d{4}(?!\d)|(?<!\d)\d{12}(?!\d)")),
    ("plate", re.compile(r"\b[A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{4}\b")),
]
LABELS = {"phone": "[PHONE]", "email": "[EMAIL]", "aadhaar": "[ID]", "plate": "[PLATE]",
          "name": "[NAME]", "address": "[ADDRESS]", "other": "[REDACTED]"}


def _overlaps(a: PiiTag, b: PiiTag) -> bool:
    return a.start < b.end and b.start < a.end


def detect(text: str, llm: LLM, known: list[tuple[str, str]] | None = None) -> list[PiiTag]:
    """known = [(type, literal)] such as ("name", "Anu Menon"). Returns non-overlapping tags sorted by start."""
    tags: list[PiiTag] = []

    def add(tag: PiiTag) -> None:
        if tag.end > tag.start and not any(_overlaps(tag, t) for t in tags):
            tags.append(tag)

    for ptype, rx in PATTERNS:
        for m in rx.finditer(text):
            add(PiiTag(type=ptype, text=m.group(0), start=m.start(), end=m.end()))
    for ptype, literal in known or []:
        if not literal:
            continue
        for m in re.finditer(re.escape(literal), text, re.I):
            add(PiiTag(type=ptype, text=m.group(0), start=m.start(), end=m.end()))
    for tag in llm.tag_pii(text):
        if text[tag.start:tag.end] == tag.text:  # drop hallucinated offsets
            add(tag)
    return sorted(tags, key=lambda t: t.start)


def redact(text: str, tags: list[PiiTag], extra_literals: list[PiiTag] | None = None) -> str:
    """Replace tagged spans. `extra_literals` are tags found in another text (e.g. the transcript) whose
    wording may also appear in a derived text such as the summary."""
    out = text
    for tag in sorted(tags, key=lambda t: t.start, reverse=True):
        out = out[:tag.start] + LABELS[tag.type] + out[tag.end:]
    for tag in extra_literals or []:
        out = re.sub(re.escape(tag.text), LABELS[tag.type], out, flags=re.I)
    for ptype, rx in PATTERNS:  # belt and braces on derived text
        out = rx.sub(LABELS[ptype], out)
    return out
