"""Principal role, red/orange/green severity, staff documents, terrace floors

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-30

DBIT changes (2026-10-30):
  - A principal role above institute management. Management may escalate a
    proposal to the principal; the principal approves, rejects or escalates.
  - The reporter picks a colour severity instead of "how serious is it".
    Priority is no longer shown or set; it stays as an internal reminder clock.
  - Staff may attach PDF and Word documents.
  - Buildings with upper floors get a Terrace floor.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

IMPACT_UP = {"safety": "red", "class_interrupted": "orange", "multiple_areas": "orange", "routine": "green"}
IMPACT_DOWN = {"red": "safety", "orange": "class_interrupted", "green": "routine"}
TERRACE_BUILDINGS = ("BLOCK_A", "BLOCK_B", "MBA", "PU", "HOSTEL", "ADMIN_BLOCK")


def _check(table: str, name: str, condition: str) -> None:
    op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {name}")
    op.execute(f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK ({condition})")


def upgrade() -> None:
    _check("app_user", "app_user_role_valid",
           "role IN ('faculty', 'ossc', 'facility_manager', 'management', 'principal')")

    # Severity: drop the old rule, map the values, then add the new rule.
    op.execute("ALTER TABLE ticket DROP CONSTRAINT IF EXISTS ticket_impact_valid")
    conn = op.get_bind()
    for old, new in IMPACT_UP.items():
        conn.execute(sa.text("UPDATE ticket SET impact = :new WHERE impact = :old"), {"old": old, "new": new})
    op.execute("ALTER TABLE ticket ADD CONSTRAINT ticket_impact_valid CHECK (impact IN ('red', 'orange', 'green'))")

    op.add_column("proposal", sa.Column("stage", sa.String(length=12), nullable=False, server_default="management"))
    _check("proposal", "proposal_stage_valid", "stage IN ('management', 'principal')")
    _check("proposal", "proposal_state_valid",
           "state IN ('pending', 'approved', 'rejected', 'clarify', 'defer', 'escalated', 'superseded')")
    _check("decision", "decision_kind_valid", "kind IN ('approved', 'rejected', 'clarify', 'defer', 'escalated')")

    op.alter_column("attachment", "content_type", type_=sa.String(length=100), existing_type=sa.String(length=40),
                    existing_nullable=False)
    _check("attachment", "attachment_kind_valid", "kind IN ('photo', 'video', 'document')")

    # Admin edits are kept: Terrace is only appended where it is missing.
    for code in TERRACE_BUILDINGS:
        conn.execute(sa.text(
            "UPDATE building SET floors = array_append(floors, 'Terrace') "
            "WHERE code = :code AND NOT ('Terrace' = ANY(floors))"), {"code": code})


def downgrade() -> None:
    conn = op.get_bind()
    # Refuse before changing anything. Decisions are append-only, so they cannot be rewritten.
    if conn.scalar(sa.text("SELECT count(*) FROM attachment WHERE kind = 'document'")):
        raise RuntimeError("Staff documents exist; remove them before downgrading below 0010.")
    if conn.scalar(sa.text("SELECT count(*) FROM decision WHERE kind = 'escalated'")):
        raise RuntimeError("Escalated decisions exist; they cannot be represented below 0010.")
    if conn.scalar(sa.text("SELECT count(*) FROM app_user WHERE role = 'principal'")):
        raise RuntimeError("Principal accounts exist; change their role before downgrading below 0010.")

    for code in TERRACE_BUILDINGS:
        conn.execute(sa.text("UPDATE building SET floors = array_remove(floors, 'Terrace') WHERE code = :code"),
                     {"code": code})

    _check("attachment", "attachment_kind_valid", "kind IN ('photo', 'video')")
    op.alter_column("attachment", "content_type", type_=sa.String(length=40), existing_type=sa.String(length=100),
                    existing_nullable=False)

    _check("decision", "decision_kind_valid", "kind IN ('approved', 'rejected', 'clarify', 'defer')")
    _check("proposal", "proposal_state_valid",
           "state IN ('pending', 'approved', 'rejected', 'clarify', 'defer', 'superseded')")
    op.execute("ALTER TABLE proposal DROP CONSTRAINT IF EXISTS proposal_stage_valid")
    op.drop_column("proposal", "stage")

    op.execute("ALTER TABLE ticket DROP CONSTRAINT IF EXISTS ticket_impact_valid")
    for new, old in IMPACT_DOWN.items():
        conn.execute(sa.text("UPDATE ticket SET impact = :old WHERE impact = :new"), {"old": old, "new": new})
    op.execute("ALTER TABLE ticket ADD CONSTRAINT ticket_impact_valid "
               "CHECK (impact IN ('safety', 'class_interrupted', 'multiple_areas', 'routine'))")

    _check("app_user", "app_user_role_valid", "role IN ('faculty', 'ossc', 'facility_manager', 'management')")
