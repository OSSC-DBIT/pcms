"""no building has a 3rd floor

DBIT, 5 November 2026: remove floor "3" from every building's list of floors, so it is no
longer offered when reporting. Tickets already reported on the 3rd floor keep their floor
as it was written (ticket.floor is free text and history is not rewritten). Team OSSC can add a
floor back under Admin, Places.

Revision ID: 0015
Revises: 0014
Create Date: 2026-11-05
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # A building's floor list may not be empty (the API requires at least one), and every
    # building also has "Ground", so removing "3" never empties a list.
    op.execute("UPDATE building SET floors = array_remove(floors, '3') WHERE '3' = ANY(floors)")


def downgrade() -> None:
    # Which buildings had a 3rd floor is not recorded; add it back under Admin, Places if needed.
    pass
