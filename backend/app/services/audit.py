"""Write audit events inside the caller's transaction."""

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import request_id_var
from app.models.audit import AuditEvent


def record(
    session: AsyncSession,
    *,
    actor_id: uuid.UUID | None,
    actor_label: str,
    action: str,
    entity_type: str,
    entity_id: Any,
    before: dict | None = None,
    after: dict | None = None,
    reason: str | None = None,
    delegated_worker: str | None = None,
) -> AuditEvent:
    ev = AuditEvent(
        actor_id=actor_id,
        actor_label=actor_label,
        action=action,
        entity_type=entity_type,
        entity_id=str(entity_id),
        before=before,
        after=after,
        reason=reason,
        delegated_worker=delegated_worker,
        request_id=request_id_var.get(),
    )
    session.add(ev)
    return ev
