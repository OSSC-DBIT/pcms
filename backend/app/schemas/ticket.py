"""Ticket and proposal schemas. Mirrors frontend/src/lib/types.ts."""

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import Field, field_validator

from app.schemas import CamelModel

StatusName = Literal["Submitted", "Triaged", "Assigned", "InProgress", "OnHold", "AwaitingApproval",
                     "Resolved", "Closed", "Cancelled", "Rejected", "Duplicate"]
ImpactName = Literal["safety", "class_interrupted", "multiple_areas", "routine"]
PriorityName = Literal["P1", "P2", "P3", "P4"]
FlagName = Literal["I", "C", "P"]
AssessmentName = Literal["simple", "workforce", "parts", "expenditure"]


def _clean(v: str | None) -> str | None:
    if v is None:
        return None
    v = "".join(ch for ch in v if ch == "\n" or ch >= " ").strip()
    return v or None


class LocationIn(CamelModel):
    building: str = Field(default="", max_length=20)
    # Only used when building is the CUSTOM sentinel. It never becomes a Building row.
    custom_location: str | None = Field(default=None, max_length=120)
    # A configured department/area for a building, or free text for Custom Location.
    department: str | None = Field(default=None, max_length=120)
    floor: str = Field(default="", max_length=20)
    room: str = Field(default="", max_length=60)
    outdoors: bool = False
    landmark: str | None = Field(default=None, max_length=120)


class LocationOut(CamelModel):
    building: str
    custom_location: str | None = None
    department: str = ""
    floor: str
    room: str
    outdoors: bool
    landmark: str | None = None


class TicketRequestIn(CamelModel):
    """Fields the reporter supplies, shared by create and edit."""

    category_code: str = Field(min_length=1, max_length=40)
    subtype: str | None = Field(default=None, max_length=160)
    # Required when the chosen issue contains "Other": what the thing is.
    other_detail: str | None = Field(default=None, max_length=120)
    location: LocationIn
    title: str = Field(max_length=200)
    description: str = Field(default="", max_length=4000)
    impact: ImpactName
    access_note: str | None = Field(default=None, max_length=200)
    alt_contact: str | None = Field(default=None, max_length=120)

    _c = field_validator("subtype", "access_note", "alt_contact", mode="after")(lambda v: _clean(v))


class TicketCreateIn(TicketRequestIn):
    client_request_id: uuid.UUID


class TicketUpdateIn(TicketRequestIn):
    expected_version: int = Field(ge=1)


class TicketCreatedOut(CamelModel):
    id: uuid.UUID
    token: str
    status: StatusName
    version: int
    created_at: datetime
    attachment_upload_allowed: bool


class ProposalLineIO(CamelModel):
    label: str = Field(min_length=1, max_length=200)
    paise: int = Field(ge=0, le=10_000_000_000)

    _c = field_validator("label", mode="after")(lambda v: _clean(v) or "")


class ProposalOut(CamelModel):
    id: uuid.UUID
    version: int
    lines: list[ProposalLineIO]
    total_paise: int
    requested_date: date
    requested_by: str
    requested_by_id: uuid.UUID
    remedy: str
    state: str
    ceiling_paise: int | None = None
    conditions: str | None = None
    decided_by: str | None = None
    decided_at: datetime | None = None
    reason: str | None = None
    review_date: date | None = None


class EventOut(CamelModel):
    id: str
    at: datetime
    actor: str
    action: str
    detail: str | None = None
    delegated_worker: str | None = None


class CommentOut(CamelModel):
    id: uuid.UUID
    at: datetime
    actor: str
    body: str
    internal: bool


class AttachmentOut(CamelModel):
    id: uuid.UUID
    kind: Literal["photo", "video"]
    name: str
    size_bytes: int
    state: Literal["pending", "scanning", "available", "failed"]
    failure_reason: str | None = None
    url: str | None = None


class RatingIn(CamelModel):
    stars: int = Field(ge=1, le=5)
    comment: str | None = Field(default=None, max_length=1000)

    _c = field_validator("comment", mode="after")(lambda v: _clean(v))


class RatingOut(CamelModel):
    stars: int
    comment: str | None = None
    created_at: datetime


class TicketSummaryOut(CamelModel):
    id: uuid.UUID
    token: str
    reporter_id: uuid.UUID
    reporter_name: str
    original_category_code: str
    category_code: str
    subtype: str | None = None
    location: LocationOut
    title: str
    impact: ImpactName
    priority: PriorityName
    flag: FlagName | None = None
    assessments: list[AssessmentName]
    status: StatusName
    version: int
    created_at: datetime
    updated_at: datetime
    next_update_due: datetime | None = None
    duplicate_of: uuid.UUID | None = None
    verified_by_reporter: bool | None = None
    worker_name: str | None = None
    proposal: ProposalOut | None = None


class TicketOut(TicketSummaryOut):
    description: str
    access_note: str | None = None
    alt_contact: str | None = None
    attachments: list[AttachmentOut]
    events: list[EventOut]
    comments: list[CommentOut]
    hold_reason: str | None = None
    hold_review_date: date | None = None
    rating: RatingOut | None = None


class TicketPage(CamelModel):
    items: list[TicketSummaryOut]
    total: int
    page: int
    page_size: int


class DuplicateOut(CamelModel):
    token: str
    title: str
    status: StatusName


class TransitionIn(CamelModel):
    action: Literal["triage", "set_priority", "set_flag", "recategorise", "hold", "resume", "assign", "start",
                    "set_worker", "resolve", "verify", "dispute", "reopen", "duplicate", "reject", "cancel",
                    "close_unverified"]
    expected_version: int = Field(ge=1)
    priority: PriorityName | None = None
    flag: FlagName | None = None
    category_code: str | None = Field(default=None, max_length=40)
    reason: str | None = Field(default=None, max_length=1000)
    owner: str | None = Field(default=None, max_length=120)
    next_action: str | None = Field(default=None, max_length=500)
    review_date: date | None = None
    note: str | None = Field(default=None, max_length=1000)
    canonical_token: str | None = Field(default=None, max_length=16)
    worker_name: str | None = Field(default=None, max_length=120)

    _c = field_validator("reason", "owner", "next_action", "note", "canonical_token", "worker_name", mode="after")(lambda v: _clean(v))


class CommentIn(CamelModel):
    body: str = Field(min_length=1, max_length=2000)
    internal: bool = False

    _c = field_validator("body", mode="after")(lambda v: _clean(v) or "")


class AssessmentIn(CamelModel):
    assessments: list[AssessmentName] = Field(min_length=1, max_length=4)
    via: Literal["whatsapp", "sms", "call", "card", "in_person"]
    note: str = Field(min_length=2, max_length=1000)
    expected_version: int = Field(ge=1)


class ProposalIn(CamelModel):
    lines: list[ProposalLineIO] = Field(default_factory=list, max_length=30)
    requested_date: date
    remedy: str = Field(min_length=2, max_length=1000)
    expected_version: int = Field(ge=1)


class DecisionIn(CamelModel):
    kind: Literal["approved", "rejected", "clarify", "defer"]
    proposal_version: int = Field(ge=1)
    ceiling_paise: int | None = Field(default=None, gt=0, le=10_000_000_000)
    conditions: str | None = Field(default=None, max_length=500)
    reason: str | None = Field(default=None, max_length=1000)
    review_date: date | None = None

    _c = field_validator("conditions", "reason", mode="after")(lambda v: _clean(v))
