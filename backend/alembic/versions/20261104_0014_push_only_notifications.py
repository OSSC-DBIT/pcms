"""web push is the only notification channel: expire queued email, WhatsApp and SMS

DBIT, 4 November 2026: email and Twilio are removed. Rows already queued for those
channels would never be sent, so they are expired here with a clear reason. Nothing is
deleted: outbox history, delivery_attempt (append-only), worker, worker_skill, assignment
and provider_event stay as they are.

Revision ID: 0014
Revises: 0013
Create Date: 2026-11-04
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

REASON = "Email and WhatsApp/SMS were removed on 2026-11-04; web push is the only channel"


def upgrade() -> None:
    op.execute(sa.text("""
        UPDATE outbox
        SET state = 'expired', last_error = :reason, locked_until = NULL, acknowledged = true
        WHERE channel IN ('email', 'whatsapp', 'sms')
          AND state IN ('pending', 'sending', 'action_required')
    """).bindparams(reason=REASON))


def downgrade() -> None:
    # Expired rows are not re-queued: the code that sent them is gone.
    pass
