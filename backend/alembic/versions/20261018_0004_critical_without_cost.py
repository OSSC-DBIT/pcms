"""critical escalation without a cost estimate

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-18
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("proposal_total_positive", "proposal", type_="check")
    op.create_check_constraint("proposal_total_non_negative", "proposal", "total_paise >= 0")
    op.drop_constraint("decision_approval_has_ceiling", "decision", type_="check")


def downgrade() -> None:
    op.create_check_constraint("decision_approval_has_ceiling", "decision", "kind <> 'approved' OR ceiling_paise IS NOT NULL")
    op.drop_constraint("proposal_total_non_negative", "proposal", type_="check")
    op.create_check_constraint("proposal_total_positive", "proposal", "total_paise > 0")
