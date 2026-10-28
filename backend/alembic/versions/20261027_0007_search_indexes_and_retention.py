"""search indexes and a retention-aware append-only guard

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-27

Two independent changes:

1. Trigram indexes for the staff search. `GET /tickets?search=` matches title,
   token and room with ILIKE '%term%', which no btree index can serve, so every
   search was a sequential scan over `ticket`.

2. A retention path through the append-only triggers. History tables block
   UPDATE and DELETE outright, which is the right default but left the audit
   trail, timelines and outbox growing without bound. The guard now still
   blocks every UPDATE, and blocks DELETE unless the transaction has opted in
   by setting `pcms.retention = 'on'`. Only the scheduler's prune does that
   (services/scheduler.py), so an application bug or a stray console DELETE is
   refused exactly as before.
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

HISTORY_TABLES = ("audit_event", "ticket_event", "ticket_comment", "decision", "delivery_attempt")

# Blocks UPDATE always. Blocks DELETE unless this transaction set
# pcms.retention = 'on' (SET LOCAL, so it expires with the transaction).
GUARD_WITH_RETENTION = """
CREATE OR REPLACE FUNCTION pcms_block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_setting('pcms.retention', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
"""

# The original from migration 0001, for downgrade.
GUARD_ABSOLUTE = """
CREATE OR REPLACE FUNCTION pcms_block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
"""


def upgrade() -> None:
    # ---- 1. trigram search ----
    # CREATE EXTENSION needs a superuser or an owner with rights; the migrate
    # container connects as the database owner, which is enough.
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    # Not CONCURRENTLY: alembic runs inside a transaction, and these tables are
    # small at pilot scale. On a large live database, build them by hand with
    # CREATE INDEX CONCURRENTLY first; the IF NOT EXISTS below then skips them.
    op.execute("CREATE INDEX IF NOT EXISTS ix_ticket_title_trgm ON ticket USING gin (title gin_trgm_ops)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_ticket_token_trgm ON ticket USING gin (token gin_trgm_ops)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_ticket_room_trgm ON ticket USING gin (room gin_trgm_ops)")

    # ---- 2. retention-aware guard ----
    op.execute(GUARD_WITH_RETENTION)
    # Indexes the prune walks: without them each nightly pass seq-scans history.
    op.execute("CREATE INDEX IF NOT EXISTS ix_ticket_event_at ON ticket_event (at)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_ticket_comment_created ON ticket_comment (created_at)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_outbox_created ON outbox (created_at)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_provider_event_received ON provider_event (received_at)")
    # Closed-at drives which tickets are old enough to prune history for.
    op.execute("CREATE INDEX IF NOT EXISTS ix_ticket_closed_at ON ticket (closed_at)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_ticket_closed_at")
    op.execute("DROP INDEX IF EXISTS ix_provider_event_received")
    op.execute("DROP INDEX IF EXISTS ix_outbox_created")
    op.execute("DROP INDEX IF EXISTS ix_ticket_comment_created")
    op.execute("DROP INDEX IF EXISTS ix_ticket_event_at")
    op.execute(GUARD_ABSOLUTE)
    op.execute("DROP INDEX IF EXISTS ix_ticket_room_trgm")
    op.execute("DROP INDEX IF EXISTS ix_ticket_token_trgm")
    op.execute("DROP INDEX IF EXISTS ix_ticket_title_trgm")
    # pg_trgm is left installed: dropping it would break any other index built
    # on it, and an unused extension costs nothing.
