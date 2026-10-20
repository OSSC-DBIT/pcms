# PCMS plan: repair ratings and manual worker handling

Written 20 October 2026 against branch `feat/part1-reports-audit-pagination`.

This plan answers two requests:

1. Add a rating system to PCMS.
2. Remove the worker list, because facility managers will contact workers directly and update the
   ticket state by hand. Everything else should stay the same.

The plan below is the recommended implementation. It is written so it can be reviewed and then
executed without re-discovering the codebase.

---

## 1. At a glance

### What we add

- A reporter rates a completed repair with **1-5 stars** and an optional comment.
- One rating per ticket, only by the person who reported it, only after the ticket is **Closed**.
- Ratings are immutable. No edit or delete endpoint.
- Staff see the rating on the ticket. Reports show the average, the distribution and recent low
  ratings (1-2 stars).
- A low rating queues a notification to facility managers through the existing outbox.

### What we remove

- The **Workers** page, route and navigation item.
- The `/workers` API and the `worker.directory` and `worker.manage` capabilities.
- Worker selection, automatic SMS/WhatsApp dispatch, acceptance tracking and release.
- The "Not accepted by worker" report tile and queue tile.
- The worker filter that uses worker ids. It becomes a free-text name filter.

### What we keep

- The status names and the rest of the lifecycle.
- Faculty isolation, reporter notifications, management approvals, audit and history rules.
- The existing `worker`, `worker_skill` and `assignment` tables and rows. They become legacy
  history and are **not dropped**. No new rows are written to them by the normal flow.
- Twilio webhook handling for messages that were already sent before this change. It is legacy
  only after this change.

### Assumption to confirm

The rating is a rating of the **repair or service**, not of an individual worker. This is the only
design that makes sense after the worker list is removed. If the intent is to rate individual
workers, the worker identity has to stay, and the data model changes.

---

## 2. Current state

| Area | Where it lives now | What changes |
|---|---|---|
| Worker directory | `frontend/src/pages/staff/Workers.tsx`, `backend/app/routers/directory.py` (`/workers`) | Delete the page, routes and API |
| Worker roles | `backend/app/security/roles.py`, `frontend/src/lib/types.ts` | Remove `worker.directory` and `worker.manage` |
| Assignment UI | `frontend/src/pages/staff/StaffTicket.tsx` (`AssignStep`, `AssignmentsCard`) | Replace with an optional free-text worker name and manual status buttons |
| Assignment API | `backend/app/routers/tickets.py` (`/assignments`, `/accept`, `/release`) | Remove; state changes go through the existing transitions endpoint |
| Assignment service | `backend/app/services/workflow.py` (`assign`, `accept`, `release`) | Remove the new-flow parts; keep a small legacy `accept` for Twilio webhooks |
| Assessment | `backend/app/services/workflow.py` (`record_assessment`) | Drop the required `worker_id`; keep the assessment itself |
| Dispatch | `backend/app/services/notify.py` (`dispatch_worker`), `backend/app/services/scheduler.py` (`acceptance_fallbacks`) | Remove new worker dispatch and the fallback task |
| Ticket serialization | `backend/app/services/tickets.py` (`assignments`) | Remove `assignments` from API responses; add staff-only `workerName` |
| Queue | `frontend/src/pages/staff/Queue.tsx` | Remove the worker select and the "Not accepted" logic |
| Reports | `backend/app/routers/admin_ops.py`, `frontend/src/pages/staff/Reports.tsx` | Remove `unaccepted`; add rating aggregates |
| Verification | `frontend/src/pages/faculty/TicketView.tsx`, `backend/app/services/lifecycle.py` (`verify`) | Keep; add the rating card after the ticket is Closed |

Important existing issue: `backend/app/services/tickets.py` includes active assignments (with
`workerName`) even when the caller is faculty. That conflicts with the rule that faculty never see
worker names. Removing assignments from the ticket response fixes this leak. Add a regression test.

---

## 3. Target flow

```
Faculty submits a report
  -> Facility manager triages it (priority) or rejects it (reason)
  -> Facility manager contacts a worker directly, outside PCMS
  -> Facility manager records an optional worker or vendor name and marks the ticket Assigned
  -> Facility manager may mark the work started (InProgress)
  -> Facility manager records an assessment and the I / C / P flag
       I Immediate -> fix and mark Resolved
       C Critical  -> send to management for a decision
       P Postpone  -> OnHold with a reason and review date
  -> Reporter checks the work
       Yes, fixed -> Closed -> rate 1-5 stars with an optional comment
       Still broken -> dispute within 7 days
```

The status names do not change. The only semantic change is that `Assigned` and `InProgress` are
recorded by the facility manager, not by a worker tapping a message button.

---

## 4. Data model

### 4.1 Ticket gets a manual worker name

Add one nullable column to `ticket`:

```python
worker_name: Mapped[str | None] = mapped_column(String(120))
```

- It is free text: a person, a vendor, or a team ("Carpentry vendor", "Ramesh K").
- It is internal. It is serialized only to staff, never to faculty.
- There is no phone number, no login, no skill table and no worker foreign key.
- It is optional. A manager may mark a ticket Assigned without recording a name.

Why a column instead of reusing `assignment`: an assignment requires a `worker` row and a
directory. The manager does not need a directory, and old assignments must stay untouched.

### 4.2 New table: `ticket_rating`

New file `backend/app/models/rating.py`:

```python
"""Reporter ratings for completed repairs. One immutable row per ticket."""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import uuid_pk


class TicketRating(Base):
    __tablename__ = "ticket_rating"
    __table_args__ = (
        UniqueConstraint("ticket_id", name="uq_ticket_rating_ticket"),
        CheckConstraint("stars BETWEEN 1 AND 5", name="ticket_rating_stars"),
        CheckConstraint("char_length(comment) <= 1000", name="ticket_rating_comment_length"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    ticket_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ticket.id"), nullable=False
    )
    reporter_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("app_user.id"), nullable=False
    )
    stars: Mapped[int] = mapped_column(Integer, nullable=False)
    comment: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
```

Register it in `backend/app/models/__init__.py`.

Rules:

- `ticket_id` is unique. A second rating is rejected with `409 already_rated`.
- `stars` is 1-5. The database and Pydantic both enforce it.
- `comment` is optional, trimmed, maximum 1000 characters.
- No update or delete endpoint. If a correction is ever needed, add a versioned rating later; do
  not silently overwrite history.
- `reporter_id` is stored for audit and query clarity, even though the ticket already has one.

### 4.3 Migration `0005`

Create
`backend/alembic/versions/20261020_0005_ticket_rating_and_manual_worker.py`:

```python
revision = "0005"
down_revision = "0004"
```

Upgrade:

1. `op.add_column("ticket", sa.Column("worker_name", sa.String(120), nullable=True))`
2. `op.create_table("ticket_rating", ...)` with the columns and constraints above.
3. `op.create_index("ix_ticket_rating_created", "ticket_rating", ["created_at"])`
4. Backfill tickets from the lead active assignment, so in-flight work keeps its name. This also
   covers tickets that are On hold, Awaiting approval or Resolved, where an active assignment can
   still exist.

```sql
UPDATE ticket t
SET worker_name = x.name
FROM (
    SELECT DISTINCT ON (a.ticket_id) a.ticket_id, w.name
    FROM assignment a
    JOIN worker w ON w.id = a.worker_id
    WHERE a.released_at IS NULL
    ORDER BY a.ticket_id, a.lead DESC, a.assigned_at
) x
WHERE t.id = x.ticket_id
  AND t.worker_name IS NULL;
```

5. Optional but recommended: expire pending worker messages so no automatic message goes out
   after the change. The manager will call instead.

```sql
UPDATE outbox
SET state = 'expired',
    last_error = 'Worker dispatch retired; the manager contacts workers directly'
WHERE channel IN ('whatsapp', 'sms')
  AND state = 'pending'
  AND template IN ('job_dispatch', 'job_fallback');
```

Downgrade:

1. Drop `ticket_rating`.
2. Drop `ticket.worker_name`.

Do **not** drop `worker`, `worker_skill` or `assignment` in either direction. They contain history
and are referenced by the legacy outbox and webhook code.

### 4.4 Legacy tables

`worker`, `worker_skill` and `assignment` stay in the schema:

- `assignment` is still read by the Twilio webhook, the legacy outbox and `lifecycle._release_all`
  (when an old ticket is rejected or cancelled).
- No new assignment rows are created by the normal flow.
- No worker rows are created by the normal flow.
- The old rows remain available for audit and for any future export.
- A later cleanup release may drop them after a backup and after all legacy messages are drained.
  That is not part of this change.

---

## 5. Backend changes

### 5.1 Lifecycle actions

Extend `backend/app/security/roles.py`? No new capability is needed. Use the existing
`ticket.assign` for assignment actions and `ticket.triage` for resolve.

Add these rules in `backend/app/services/lifecycle.py`:

```python
"assign":     Rule("ticket.assign", ("Triaged", "OnHold")),
"start":      Rule("ticket.assign", ("Assigned",)),
"set_worker": Rule("ticket.assign", ("Assigned", "InProgress", "OnHold")),
```

| Action | Capability | From | Effect |
|---|---|---|---|
| `assign` | `ticket.assign` | Triaged, OnHold | Set optional `worker_name`, clear hold fields, set status Assigned |
| `start` | `ticket.assign` | Assigned | Set status InProgress |
| `set_worker` | `ticket.assign` | Assigned, InProgress, OnHold | Change or clear `worker_name`; status does not change |
| `resume` | `ticket.assign` | OnHold | Set status Assigned; no longer requires an active assignment |
| `resolve` | `ticket.triage` | Assigned, InProgress | Unchanged |
| `verify` | reporter only | Resolved | Unchanged |

`assign` updates `worker_name` only when the field is present, so resuming an On hold ticket does
not erase the name. `set_worker` always replaces the value, and a blank value clears it.

Implementation notes:

- Add `worker_name: str | None = Field(default=None, max_length=120)` to `TransitionIn`.
- Add `assign`, `start` and `set_worker` to the `TransitionIn.action` literal.
- Clean `worker_name` with the existing `_clean` helper.
- For `assign`:
  - Write a public event "A worker was assigned" with `public=True` and no name.
  - If a name is present, write a second internal event with the name and `public=False`.
  - Clear `hold_reason`, `hold_owner`, `hold_next_action` and `hold_review_date`.
  - Audit with `after={"status": "Assigned", "worker_name": ...}`.
  - Notify the reporter with the existing `status_assigned` template.
- For `start`:
  - Set status InProgress.
  - The normal public event "Work started" is enough.
  - Notify the reporter with the existing `status_inprogress` template.
- For `set_worker`:
  - Set `t.worker_name` and write an internal event "Worker updated" with the new name.
  - Do not change the status.
  - Audit the old and new name.
- For `resume`:
  - Remove the `Assignment` existence check at `backend/app/services/lifecycle.py:128-130`.
  - Set status Assigned and clear hold fields.
- Keep `_release_all` as-is. It releases legacy assignments when an old ticket is rejected or
  cancelled. It does nothing for new tickets because they have no assignment rows.

`backend/app/services/workflow.py`:

- Delete `workers_out`, `create_worker`, `update_worker`, `_trade_ids`, `normalise_phone`,
  `mask_phone`, `_place`, `assign` and `release`.
- Keep `get_assignment` and `accept`. They are legacy and are used only by the Twilio webhook.
  Add a comment saying so.
- `record_assessment`:
  - Remove the `worker_id` requirement and the "worker is not assigned" check.
  - Remove the `Worker` lookup and the `delegated_worker` field on the new event.
  - Keep the status check: only Assigned or InProgress.
  - Audit the assessment and note as before, without a worker name.
- `create_proposal`:
  - Remove the "Assign a worker before..." wording. Use something like "A ticket can be sent to
    management while it is Assigned, In progress or On hold."
  - Keep the status check exactly as it is.

### 5.2 Rating API

Add to `backend/app/routers/tickets.py`:

```python
@router.post("/{ticket_id}/rating", response_model=TicketOut)
async def rate(ticket_id: uuid.UUID, body: RatingIn, p: Principal = Depends(current_principal),
               db: AsyncSession = Depends(get_session)) -> TicketOut:
    t = await svc.get_visible(db, p, ticket_id, lock=True)
    if t.reporter_id != p.user.id:
        raise forbidden("Only the person who reported this can rate the repair.")
    if t.status != "Closed":
        raise ApiError(409, "invalid_transition", "A repair can be rated after the ticket is closed.")
    if await db.scalar(select(TicketRating.id).where(TicketRating.ticket_id == t.id)):
        raise conflict("already_rated", "You already rated this repair.")
    db.add(TicketRating(ticket_id=t.id, reporter_id=p.user.id, stars=body.stars, comment=body.comment))
    add_event(db, t, p.user, "Rating submitted", detail=f"{body.stars}/5", public=True)
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="ticket.rated",
                 entity_type="ticket", entity_id=t.id,
                 after={"stars": body.stars, "has_comment": bool(body.comment)})
    if body.stars <= 2:
        await notify.notify_role(db, "facility_manager", t, template="low_rating",
                                 title=f"{t.token}: low rating ({body.stars}/5)",
                                 body="Open the ticket to read the comment.",
                                 key_suffix=":rating")
    await db.commit()
    return await svc.ticket_out(db, p, t)
```

Schemas in `backend/app/schemas/ticket.py`:

```python
class RatingIn(CamelModel):
    stars: int = Field(ge=1, le=5)
    comment: str | None = Field(default=None, max_length=1000)

    _c = field_validator("comment", mode="after")(lambda v: _clean(v))


class RatingOut(CamelModel):
    stars: int
    comment: str | None = None
    created_at: datetime
```

Add `rating: RatingOut | None = None` to `TicketOut`.

Rules:

- The rating endpoint does not need `expected_version`. It is a one-time insert and does not change
  the ticket status. The unique constraint is the concurrency guard.
- If a race slips past the pre-check, catch the database unique violation and return
  `409 already_rated`. Do not return a 500.
- `get_visible` returns 404 for a faculty member who is not the reporter, so the ownership check
  does not leak the existence of another person's ticket.
- Staff get 403 from the ownership check because they can see the ticket but cannot rate it.
- The public timeline event records the star count. The comment is not copied into the timeline.
- The audit record stores the stars and whether a comment exists. The comment stays only in
  `ticket_rating`.
- Low-rating notification: stars only in the push/email body. Do not put the comment in a push
  payload. Pass `exclude_user=p.user.id` so a staff member who reported a ticket does not notify
  themselves.

### 5.3 Serialization and privacy

`backend/app/schemas/ticket.py`:

- Remove `AssignmentOut` and the `assignments` field from `TicketSummaryOut`.
- Remove `AssignIn`, `AcceptIn` and `ReleaseIn`.
- Remove `WorkerOut`, `WorkerIn` and `WorkerPatch`.
- Add `worker_name: str | None = None` to `TicketSummaryOut`.
- Add `rating: RatingOut | None = None` to `TicketOut`.
- `AssessmentIn`: remove `worker_id`; keep `assessments`, `via`, `note`, `expected_version`.

`backend/app/services/tickets.py`:

- Remove the `Assignment` and `Worker` imports and the `Lookups.assignments` field.
- Remove the assignment loading query in `Lookups.load`.
- Remove the assignments list from `_summary_fields`.
- Set `worker_name=t.worker_name if staff else None`.
- In `ticket_out`, load the rating and pass it to `TicketOut`. The rating belongs only to the
  reporter and staff, and `get_visible` already limits who can load the ticket.
- Keep `EventOut.delegated_worker` staff-only. Legacy events keep their names; new events have
  `None`.

Expected API shape after the change:

```json
{
  "token": "C26-0001",
  "status": "Assigned",
  "workerName": "Ramesh K",
  "rating": null
}
```

For a faculty caller, `workerName` is `null` and there is no `assignments` key at all. Add a test
for this.

### 5.4 Remove worker endpoints and capabilities

- `backend/app/routers/directory.py`: keep the proposals router; delete the `workers` router and
  all worker imports.
- `backend/app/main.py`: remove `app.include_router(directory.workers, prefix=API_PREFIX)`.
- `backend/app/security/roles.py`:
  - Remove `worker.directory` and `worker.manage` from `CAPABILITIES`.
  - Remove them from `facility_manager`.
  - Update the module docstring that says facility managers maintain the worker directory.
- `backend/app/routers/tickets.py`:
  - Remove `assign`, `accept` and `release` routes.
  - Remove the `Assignment` and `Worker` imports.
  - Change the `worker` query parameter from `uuid.UUID | None` to `str | None` with
    `max_length=120`, and filter `Ticket.worker_name.ilike(_like(worker), escape="\\")`.
  - Remove `AssignIn`, `AcceptIn` and `ReleaseIn` imports.
- `backend/app/routers/admin_ops.py`:
  - Remove the `unaccepted` field from `ReportOut`.
  - Remove the `Assignment` import and the unaccepted query.
  - Add the rating aggregate fields described in section 5.5.

The `/workers` API is removed, not hidden. Old clients get 404. The frontend is the only client in
this repository, and it is updated in the same change.

### 5.5 Reports

Add a nested rating payload to `ReportOut`:

```python
class LowRating(CamelModel):
    ticket_id: uuid.UUID
    token: str
    title: str
    stars: int
    comment: str | None
    created_at: datetime
    category: str | None
    building: str | None
    room: str | None


class RatingReport(CamelModel):
    count: int
    average: float | None
    distribution: dict[str, int]
    low: list[LowRating]
```

Add `ratings: RatingReport` to `ReportOut` and remove `unaccepted`.

Query rules:

- Use ratings created within the same `days` window, but do not apply the open-ticket status
  filter. Ratings are on Closed tickets and would otherwise always be zero.
- Apply the same `building` and `category` filters when they are present.
- `average` is rounded to 2 decimals, or `null` when there are no ratings.
- `distribution` always has keys `"1"` to `"5"`, with zero for missing stars.
- `low` returns up to 10 ratings with 1 or 2 stars, newest first. Include the ticket id so the UI
  can link to the ticket. Do not include the reporter name.
- A low rating also queues a facility-manager notification at submit time, as described above.

### 5.6 Background jobs and notifications

- `backend/app/services/notify.py`: remove `dispatch_worker` and the `Assignment`/`Worker` imports.
  Keep `notify_user`, `notify_reporter` and `notify_role`. Keep `_enqueue` working for user
  channels.
- `backend/app/services/scheduler.py`: remove `acceptance_fallbacks` and the now-unused imports.
  Keep `verification_reminders`, `hold_reviews`, `scan_quarantine` and `housekeeping`.
- `backend/app/jobs/scheduler.py`: remove the `(60, "acceptance", scheduler.acceptance_fallbacks)`
  entry from `TASKS`.
- `backend/app/services/outbox.py`: leave the legacy worker-delivery branches in place so any
  already-queued row can drain. Add a comment that new worker jobs are no longer created.
- `backend/app/routers/webhooks.py`: leave the Twilio handlers in place for messages sent before
  the cutover. Add a comment that this is legacy. `workflow.accept` remains the only new-flow-free
  writer to `assignment`.
- `backend/app/providers.py` and the Twilio settings stay for legacy delivery. They can be removed
  in a later cleanup release.

### 5.7 CLI and fixtures

- `backend/app/cli.py`: remove worker creation from `create-test-accounts` and
  `create-smoke-accounts`. Update the printed instructions, which currently mention the test
  worker phone number.
- `backend/app/seed.py`: no worker data is expected; confirm nothing is seeded.
- `backend/tests/factories.py`: remove `make_worker` if no test needs it. If a legacy webhook test
  remains, keep a clearly named `make_legacy_worker_and_assignment` helper and use it only there.

---

## 6. Frontend changes

### 6.1 Remove the worker screens

- Delete `frontend/src/pages/staff/Workers.tsx`.
- Delete `frontend/src/lib/contacts.ts` (only used by the worker import).
- `frontend/src/App.tsx`: remove the lazy `Workers` import and the `/staff/workers` route.
- `frontend/src/components/AppShell.tsx`: remove the `Users` icon import and the `nav.workers`
  item.
- `frontend/src/lib/i18n.tsx`: remove `'nav.workers'`.
- `frontend/src/lib/api.ts`: remove `listWorkers`, `createWorker`, `updateWorker` and
  `importWorkers`.
- `frontend/src/lib/types.ts`: remove `Worker` and the worker capabilities.
- `frontend/src/pages/Landing.tsx`: change the `Fix` copy from "A worker is assigned and gets an
  SMS" to a manual-flow sentence, for example "Facilities arranges the work and updates the
  ticket. You can rate the repair when it is done."
- `frontend/src/lib/i18n.tsx`: change `receipt.body` so it no longer says the worker sees the same
  number.

### 6.2 Staff ticket page

`frontend/src/pages/staff/StaffTicket.tsx`:

- Remove the `workers` state, the `api.listWorkers` effect and the `Worker` type import.
- Remove `AssignmentsCard`, the acceptance button, the release dialog and the active-assignment
  calculations.
- Replace `AssignStep` with a manual form:

```
Step 2: Who is doing the work?
  Worker or vendor (optional) [________________]
  PCMS does not send messages to workers. Contact them by phone, WhatsApp or in person,
  then record the state here.
  [Mark as assigned]  or  [Resume work] when the ticket is On hold
```

- The button calls:

```ts
api.transition(ticket, { action: 'assign', workerName: name.trim() || undefined })
```

- Show this step when the status is `Triaged` or `OnHold`.
- For `Assigned` and `InProgress`, show a compact line:

```
Worker: Ramesh K   [Change]
```

If no name is recorded, show "No worker recorded" and a "Add worker name" button. Both open a
small dialog that calls `{ action: 'set_worker', workerName }`. Clearing the field clears the name.
- Add a small optional card for `Assigned`:

```
Work started? [Mark work started]
```

It calls `{ action: 'start' }`. It is not required; `resolve` already works from `Assigned`.
- `AssessStep`:
  - Remove the active assignment lookup and the `workerId` state.
  - Remove the "Worker who looked at it" select.
  - Keep the assessment checkboxes, the "How it was reported" select, and the internal note.
  - Call `api.recordAssessment(ticket, picked, via, note.trim())`.
- Update the module comment at the top: the manager contacts workers directly; no SMS is sent.
- Add a "Reporter rating" card when `ticket.rating` exists. Show stars, comment and date. When the
  ticket is Closed and has no rating, show "Not rated yet." This is read-only for staff.

### 6.3 Faculty rating card

`frontend/src/pages/faculty/TicketView.tsx`:

- Keep the existing verify/dispute flow.
- After the ticket becomes `Closed`, show a rating card when the caller is the reporter and
  `ticket.rating` is null:

```
How was the repair?
  [1] [2] [3] [4] [5]
  Anything else? (optional) [________________]
  [Send rating]
```

- Star controls:
  - Use five buttons in a `role="radiogroup"` with `aria-label="Rating"`.
  - Each button has `role="radio"`, `aria-checked`, and an accessible label such as "4 stars".
  - Minimum touch target 44px.
  - Show the selected value as text, for example "4 of 5".
- The submit button is disabled until at least one star is selected.
- On success, the API returns the updated ticket, so the card changes to a read-only summary.
- If the ticket is `Closed` and already rated, show "Your rating" with the stars and comment.
- If the ticket is reopened after a rating, keep showing the historical rating. Do not delete it.
- Use `api.rate(ticket, stars, comment)`.
- Add a reusable `RatingSummary` to `frontend/src/components/ticket.tsx` so the faculty view and the
  staff view render stars the same way.

### 6.4 Queue

`frontend/src/pages/staff/Queue.tsx`:

- Remove the `Worker` type, the `workers` state and the `api.listWorkers` effect.
- Remove the `unaccepted` helper and the `!x.assignments` access.
- Replace the "Not accepted" tile with an "Assigned" tile using
  `data.openByStatus.Assigned ?? 0`.
- Replace the worker select with a free-text input:

```
Worker name [________________]
```

- Pass it as `worker` in `UseTicketsOptions`; the server matches `ticket.worker_name` with ILIKE.
- Add it to `filtering` and `clear`.

### 6.5 Reports

`frontend/src/pages/staff/Reports.tsx`:

- Remove the "Not accepted by worker" stat.
- Add an "Average rating" stat. `Stat` must accept `string | number` because the average is a float.
- Add a "Ratings" card:
  - Show the count and average.
  - Show a 5-to-1 star distribution bar list. Do not reuse the existing `Bars` sort order because
    it sorts by count; write a small `RatingBars` that keeps 5, 4, 3, 2, 1 order.
  - Show a "Recent low ratings" table with token, stars, comment and date. Link the token to
    `/staff/t/{ticketId}`.
- Empty states: "No ratings in this window." and "No low ratings in this window."

### 6.6 Types and API client

`frontend/src/lib/types.ts`:

- Remove the worker capabilities.
- Remove `Assignment` and the `assignments` field from `TicketSummary`.
- Add `workerName?: string | null` to `TicketSummary`.
- Remove the `Worker` interface.
- Add:

```ts
export interface Rating {
  stars: number
  comment?: string | null
  createdAt: string
}

export interface LowRating {
  ticketId: string
  token: string
  title: string
  stars: number
  comment?: string | null
  createdAt: string
  category?: string | null
  building?: string | null
  room?: string | null
}
```

- Add `rating?: Rating | null` to `Ticket`.
- Add to `Report`:

```ts
ratings: {
  count: number
  average: number | null
  distribution: Record<string, number>
  low: LowRating[]
}
```

- Remove `Report.unaccepted`.

`frontend/src/lib/api.ts`:

- Keep `TicketFilters.worker` as a string; it now carries a name substring, not a worker id.
- Remove `Channel` from the worker assignment methods; keep it for assessment "via".
- Add rating actions to `TransitionAction`:

```ts
| { action: 'assign'; workerName?: string }
| { action: 'start' }
| { action: 'set_worker'; workerName?: string }
```

- Remove `assign`, `recordAcceptance`, `releaseAssignment` and all worker methods.
- Change `recordAssessment` to:

```ts
recordAssessment(ticket, assessments, via, note)
```

- Add:

```ts
rate(ticket: Pick<Ticket, 'id'>, stars: number, comment?: string): Promise<Ticket> {
  return request('POST', `/tickets/${ticket.id}/rating`, {
    body: { stars, comment: comment?.trim() || null },
  })
}
```

### 6.7 i18n

Add these keys in both English and Hindi in `frontend/src/lib/i18n.tsx`:

- `ticket.rateTitle`: "How was the repair?"
- `ticket.rateBody`: "Your rating helps facilities improve. It is optional."
- `ticket.rateStars`: "Rating"
- `ticket.rateComment`: "Anything else? (optional)"
- `ticket.rateSubmit`: "Send rating"
- `ticket.rateThanks`: "Thanks for rating this repair."
- `ticket.yourRating`: "Your rating"
- `ticket.notRated`: "Not rated yet."

Remove `nav.workers`. Update `receipt.body`.

---

## 7. Security and privacy checklist

- [x] Faculty responses never contain `workerName`, `assignments`, worker phone numbers, staff
      names, internal notes or costs.
- [x] Only the reporter can rate a ticket. Other faculty get 404 through `get_visible`. Staff get
      403 from the ownership check.
- [x] Only a Closed ticket can be rated. A Resolved ticket returns 409.
- [x] A second rating returns 409. The database unique constraint backs this up.
- [x] Rating comments are visible only to the reporter and staff. They are not in list responses,
      public timeline entries, push payloads or audit snapshots.
- [x] `worker_name` is internal and staff-only. It is not in public timeline events.
- [x] The low-rating notification body contains the star count, not the comment.
- [x] `ticket.rated` is written to the audit log.
- [x] All new writes go through the existing transaction and `expected_version` rules. The rating
      is the one exception because it is a one-time insert, not a status change.
- [x] No secrets or phone numbers are added to the repository.
- [x] No demo data is added to seeds or migrations. The backfill copies real existing data only.

---

## 8. Test plan

### 8.1 Backend tests to add or update

New `backend/tests/test_ratings.py`:

1. Reporter rates a Closed ticket. Assert 200, `rating.stars`, `rating.comment`, and the ticket
   detail contains the rating.
2. A second rating returns 409 `already_rated`.
3. Rating a Resolved ticket returns 409.
4. Rating a ticket that belongs to another faculty member returns 404.
5. A facility manager cannot rate (403), and a management user cannot rate (403).
6. Stars 0, 6 and a comment longer than 1000 characters return 422.
7. The rating writes a `ticket.rated` audit event and a public "Rating submitted" timeline event.
8. A low rating (1 or 2 stars) queues a `low_rating` outbox row for facility managers. A 5-star
   rating does not.
9. `GET /reports` returns the correct count, average, distribution and low-rating list.
10. A faculty ticket list response never contains another reporter's rating and never contains
    `workerName` or `assignments`.

Update `backend/tests/test_workflow.py`:

- Full journey without a worker row:
  - triage -> assign with `workerName` -> start -> resolve -> verify -> rate.
  - Assert statuses and `workerName` for staff.
  - Assert no `job_dispatch` or `job_fallback` outbox row was created.
- `assign` from a wrong state returns 409.
- `set_worker` changes the name without changing the status; clearing it works.
- `resume` works without any assignment.
- Assessment works without a worker id.
- Faculty ticket detail has no `assignments` key, `workerName` is null, and no worker name appears
  in events.
- Keep the existing stale version, internal note, dispute window, critical/approval and permission
  tests. Update them to use the manual assignment flow.
- Delete the one-active-lead, inactive-worker, WhatsApp-mode and worker import tests; those
  behaviors no longer exist.

Update `backend/tests/test_ticket_search.py`:

- Replace the worker-id filter test with a free-text `worker` filter test:
  - Assign "Ramesh K"; `GET /tickets?scope=queue&worker=ram` returns 1.
  - `set_worker` to "Suresh"; the same search returns 0.
  - A faculty caller cannot use `scope=queue`.
- Remove `make_worker` from the imports.

Update `backend/tests/test_reports_admin.py`:

- Assessment tests use the manual assignment flow and no worker id.
- Delete the "worker is not assigned" test.
- Keep the critical approval test and update its setup.

Update `backend/tests/test_reports.py`:

- The existing counts and CSV tests still pass.
- Add a rating aggregate test or put it in `test_ratings.py`.
- Remove any assertion about `unaccepted` if one is added.

Update `backend/tests/test_auth.py`:

- Remove the `worker.manage` and `worker.directory` assertions.
- Assert that facility managers still have `ticket.assign` and that faculty do not.
- Assert that the OSSC capability set no longer contains worker capabilities.

Update `backend/tests/test_messaging.py`:

- Keep the webhook signature test, the rollback test and the verification reminder test.
- Remove the tests for worker dispatch, retry, reassignment, acceptance, fallback and messaging
  off, because those product paths no longer exist.
- If the Twilio webhook code stays for legacy messages, add one small test that inserts a legacy
  `Assignment` and `Outbox` row directly and checks that a valid Accept tap still works. Mark it
  clearly as legacy.

Update `backend/tests/test_tickets.py`:

- Add the faculty privacy regression test for `workerName` and `assignments`.
- Add a rating test if it fits better here than in `test_ratings.py`; otherwise keep ratings in the
  new file.

### 8.2 Frontend checks

- `npm run lint` must pass with no unused imports or types.
- `npm run build` must pass.
- Manually check:
  - No Workers item in the sidebar or phone tab bar.
  - `/staff/workers` redirects to the staff home.
  - A manager can move a ticket through Triaged -> Assigned -> InProgress -> Resolved without a
    worker directory.
  - The worker name is visible to staff and hidden from faculty.
  - A reporter can verify and then rate. The rating is shown back to them.
  - A reporter cannot rate twice.
  - Reports show the average, distribution and low ratings.

### 8.3 Browser test

Update `e2e/smoke.spec.ts`:

- Remove the `/staff/workers` step and the "Add worker" assertion.
- In the staff ticket flow:
  - Fill the worker name field.
  - Click "Mark as assigned".
  - Click "Mark work started".
  - Continue with the flag, resolve and verify flow.
- In the faculty flow:
  - After verification, choose 5 stars, add a short comment, and submit.
  - Assert that "Your rating" is visible.
- Update the screenshot names.

### 8.4 Commands

Run the full checks before calling the change done:

```sh
docker compose -f compose.dev.yml --profile jobs --profile nginx up -d --build
docker compose -f compose.dev.yml exec -T api pytest -q
cd frontend && npm run lint && npm run build
```

Then run the Playwright e2e job the same way CI does.

---

## 9. Execution order

Work on a branch. Do not push to `main`. Suggested branch name:
`feat/ratings-and-manual-workers`.

### Phase 1 - Data model and migration (about 0.5 day)

- [x] Add `Ticket.worker_name`.
- [x] Add `TicketRating` and register it in `models/__init__.py`.
- [x] Create migration `0005` with the table, the column, the index, the backfill and the optional
      pending-message expiry.
- [x] Run `alembic upgrade head` on the dev database.
- [x] Add `RatingIn`, `RatingOut`, `Rating` types and the API field.
- [x] Add a quick model test or a smoke query.

### Phase 2 - Backend manual flow (about 1 day)

- [x] Add `assign`, `start` and `set_worker` lifecycle rules and handlers.
- [x] Remove the assignment check from `resume`.
- [x] Remove the worker id from assessment.
- [x] Remove the worker routes, schemas and capabilities.
- [x] Remove `assign`, `accept` and `release` from the ticket router. Keep the legacy `accept`
      helper for webhooks.
- [x] Remove `dispatch_worker`, `acceptance_fallbacks` and the scheduler task.
- [x] Replace the worker id filter with the free-text `worker` filter.
- [x] Remove `unaccepted` from reports.
- [x] Update the CLI fixtures.
- [x] Run the backend tests and fix the expected failures.

### Phase 3 - Rating API and reports (about 1 day)

- [x] Add `POST /tickets/{id}/rating`.
- [x] Load and serialize the rating in `ticket_out`.
- [x] Add rating aggregates to `GET /reports`.
- [x] Add the low-rating notification.
- [x] Add the rating tests.
- [x] Run the backend tests.

### Phase 4 - Frontend removal (about 1 day)

- [x] Delete the Workers page and contacts helper.
- [x] Remove the route, nav item, capabilities, types and API methods.
- [x] Rework `StaffTicket.tsx` for the manual flow.
- [x] Rework `Queue.tsx` for the free-text worker filter and the Assigned tile.
- [x] Update the copy in `Landing.tsx` and `i18n.tsx`.
- [x] Run lint and build.

### Phase 5 - Frontend rating UI (about 1 day)

- [x] Add the rating card to `TicketView.tsx`.
- [x] Add `RatingSummary` to `components/ticket.tsx`.
- [x] Add the rating card to `StaffTicket.tsx`.
- [x] Add the ratings section to `Reports.tsx`.
- [x] Add the i18n keys in English and Hindi.
- [x] Run lint and build.

### Phase 6 - Tests and docs (about 1 day)

- [x] Update the e2e smoke test.
- [x] Update `AGENTS.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`,
      `docs/USER-GUIDE.md` and the Twilio section of `docs/DEPLOYMENT.md`.
- [x] Run the full backend test suite.
- [x] Run the full frontend lint and build.
- [x] Run the e2e smoke test.
- [x] Review the diff for accidental data drops, leaked names and unused worker code.

### Phase 7 - Optional later cleanup (not this change)

- [ ] Remove the Twilio webhooks for worker replies.
- [ ] Remove worker provider settings and the outbox worker-delivery branches.
- [ ] Drop `worker`, `worker_skill` and `assignment` after a backup and after all legacy messages
      are drained.
- [ ] Remove the legacy `assignment` rows from the API entirely.

---

## 10. Acceptance criteria

The change is done when all of these are true:

1. There is no Workers page, route, navigation item or API.
2. A facility manager can move a ticket through the normal statuses without a worker directory:
   Triage -> Assign -> Start -> Resolve -> Verify.
3. No SMS or WhatsApp is sent to a worker when a ticket is assigned.
4. The worker or vendor name is optional, staff-only and visible on the staff ticket.
5. The reporter can rate a Closed ticket once with 1-5 stars and an optional comment.
6. A second rating, a rating before Closed, a rating by another faculty member and a rating by
   staff are all rejected correctly.
7. Staff see the rating on the ticket. Reports show count, average, distribution and low ratings.
8. Faculty API responses never contain worker names, assignments, worker phone numbers, internal
   notes, costs or staff names.
9. The existing reporter, management and audit flows still work.
10. `pytest -q`, `npm run lint`, `npm run build` and the e2e smoke test pass.
11. The migration upgrades and downgrades cleanly on a scratch database.
12. No historical worker or assignment rows are deleted.

---

## 11. Open questions to confirm before coding

The plan uses the recommended answer in each case. If any answer changes, say so before Phase 1.

1. **Rating target:** rate the repair/service (recommended) or rate an individual worker?
   Rating an individual worker requires keeping worker identity and changes the whole removal
   design.
2. **Rating timing:** only after `Closed` (recommended), or also at `Resolved` before verification?
3. **Rating editing:** one immutable rating (recommended), or allow the reporter to change it for
   a short time?
4. **Worker name:** keep an optional free-text name on the ticket (recommended), or record only
   the status and no name at all?
5. **Legacy data:** keep the `worker`, `worker_skill` and `assignment` tables for history
   (recommended), or drop them in this change? Dropping them loses history and breaks the legacy
   outbox and webhook code.
6. **Twilio:** stop new worker messages but keep the old webhook handlers for one release
   (recommended), or remove Twilio worker messaging completely now?
7. **Low ratings:** notify facility managers on 1-2 stars (recommended), or keep ratings passive
   in the reports only?
8. **Rating in lists:** add a "Rate this repair" prompt on the faculty home or list (nice to have),
   or keep the prompt only on the ticket detail (recommended for the first version)?

If the answers are the recommended ones, the phases above can be executed as written.

---

## 12. Rollback

- Code rollback: revert the branch.
- Data rollback: run `alembic downgrade 0004`. That drops the rating table and the `worker_name`
  column.
- The `worker`, `worker_skill` and `assignment` tables are untouched, so the old flow can be
  restored with the previous code.
- If the migration expired pending worker messages, those rows stay expired. The manager can call
  the worker manually. If the old flow is restored, new messages will be queued again by the old
  code.
