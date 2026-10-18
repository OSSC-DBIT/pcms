"""Ticket, worker and proposal schemas. Mirrors frontend/src/lib/types.ts."""

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
ChannelName = Literal["whatsapp", "sms", "call", "card"]


def _clean(v: str | None) -> str | None:
    if v is None:
        return None
    v = "".join(ch for ch in v if ch == "\n" or ch >= " ").strip()
    return v or None


class LocationIn(CamelModel):
    building: str = Field(default="", max_length=20)
    floor: str = Field(default="", max_length=20)
    room: str = Field(default="", max_length=60)
    outdoors: bool = False
    landmark: str | None = Field(default=None, max_length=120)


class LocationOut(CamelModel):
    building: str
    floor: str
    room: str
    outdoors: bool
    landmark: str | None = None


class TicketCreateIn(CamelModel):
    client_request_id: uuid.UUID
    category_code: str = Field(min_length=1, max_length=40)
    subtype: str | None = Field(default=None, max_length=80)
    # Required when subtype is "Other" (or for the Other category): what the thing is.
    other_detail: str | None = Field(default=None, max_length=70)
    location: LocationIn
    title: str = Field(max_length=200)
    description: str = Field(default="", max_length=4000)
    impact: ImpactName
    access_note: str | None = Field(default=None, max_length=200)
    alt_contact: str | None = Field(default=None, max_length=120)

    _c = field_validator("subtype", "access_note", "alt_contact", mode="after")(lambda v: _clean(v))


class TicketCreatedOut(CamelModel):
    id: uuid.UUID
    token: str
    status: StatusName
    version: int
    created_at: datetime
    attachment_upload_allowed: bool


class AssignmentOut(CamelModel):
    id: uuid.UUID
    worker_id: uuid.UUID
    worker_name: str
    lead: bool
    assigned_at: datetime
    accepted_at: datetime | None = None
    started_at: datetime | None = None
    released_at: datetime | None = None
    channel: ChannelName
    delivery: str
    accepted: bool


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
    assignments: list[AssignmentOut]
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
    action: Literal["triage", "set_priority", "set_flag", "recategorise", "hold", "resume", "resolve", "verify",
                    "dispute", "reopen", "duplicate", "reject", "cancel", "close_unverified"]
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

    _c = field_validator("reason", "owner", "next_action", "note", "canonical_token", mode="after")(lambda v: _clean(v))


class CommentIn(CamelModel):
    body: str = Field(min_length=1, max_length=2000)
    internal: bool = False

    _c = field_validator("body", mode="after")(lambda v: _clean(v) or "")


class AssignIn(CamelModel):
    worker_ids: list[uuid.UUID] = Field(min_length=1, max_length=8)
    lead_worker_id: uuid.UUID
    channel: ChannelName
    expected_version: int = Field(ge=1)


class AcceptIn(CamelModel):
    via: Literal["call", "in_person", "sms"]
    expected_version: int = Field(ge=1)


class ReleaseIn(CamelModel):
    reason: str = Field(min_length=2, max_length=500)
    expected_version: int = Field(ge=1)


class AssessmentIn(CamelModel):
    assessments: list[AssessmentName] = Field(min_length=1, max_length=4)
    worker_id: uuid.UUID
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


class WorkerOut(CamelModel):
    id: uuid.UUID
    name: str
    phone_masked: str
    trades: list[str]
    area: str
    language: str
    mode: Literal["whatsapp", "sms", "call"]
    kind: Literal["employee", "vendor"]
    active: bool
    workload: int
    last_verified: datetime | None = None
    version: int


class WorkerIn(CamelModel):
    name: str = Field(min_length=2, max_length=120)
    phone: str = Field(min_length=1, max_length=24)
    trades: list[str] = Field(min_length=1, max_length=9)
    area: str = Field(default="", max_length=120)
    language: Literal["hi", "en", "kn", "mr", "ta", "te"] = "kn"
    mode: Literal["whatsapp", "sms", "call"]
    kind: Literal["employee", "vendor"]


class WorkerPatch(CamelModel):
    expected_version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=2, max_length=120)
    phone: str | None = Field(default=None, min_length=8, max_length=20)
    trades: list[str] | None = Field(default=None, min_length=1, max_length=9)
    area: str | None = Field(default=None, max_length=120)
    language: Literal["hi", "en", "kn", "mr", "ta", "te"] | None = None
    mode: Literal["whatsapp", "sms", "call"] | None = None
    kind: Literal["employee", "vendor"] | None = None
    active: bool | None = None
    verified: bool | None = None
