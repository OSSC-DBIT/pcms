"""Blocks A and B have a 3rd floor

DBIT, 6 November 2026: Blocks A and B have a 3rd floor (rooms A-301 to A-335 and
B-301 to B-335), reversing part of the 5 November change. Migration 0015 removed floor
"3" from every building; this adds it back to Blocks A and B only, and only where the
floor list is still the seeded one, so a list an admin changed under Admin, Places is
left alone. The floor sits before the terrace.

Revision ID: 0016
Revises: 0015
Create Date: 2026-11-06
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SEEDED = "ARRAY['Ground', '1', '2', 'Terrace']"


def upgrade() -> None:
    op.execute(
        f"""
        UPDATE building
        SET floors = floors[1:array_position(floors, 'Terrace') - 1]
                     || ARRAY['3']
                     || floors[array_position(floors, 'Terrace'):]
        WHERE code IN ('BLOCK_A', 'BLOCK_B') AND floors = {SEEDED}::text[]
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE building
        SET floors = array_remove(floors, '3')
        WHERE code IN ('BLOCK_A', 'BLOCK_B') AND floors = ARRAY['Ground', '1', '2', '3', 'Terrace']::text[]
        """
    )
