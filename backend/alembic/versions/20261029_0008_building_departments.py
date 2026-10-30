"""building departments and ticket location department

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-29
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import bindparam
from sqlalchemy.dialects import postgresql

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD_ADMIN_AREAS = [
    "Ground Floor", "First Floor", "Second Floor", "Administration Office",
    "Principal's Office", "Faculty Rooms", "Conference Room", "Other Areas",
]

NEW_ADMIN_AREAS = [
    "Principal's Office", "Administration Office", "Faculty Rooms", "Conference Room", "Other Area",
]

DEPARTMENTS = {
    "BLOCK_A": [
        "Computer Science and Engineering (CSE)",
        "Information Science and Engineering (ISE)",
        "Electronics and Communication Engineering (ECE)",
        "Physics",
        "Chemistry",
    ],
    "BLOCK_B": [
        "Artificial Intelligence and Machine Learning (AI/ML)",
        "Artificial Intelligence and Data Science (AI&DS)",
        "Electrical and Electronics Engineering (EEE)",
        "Cybersecurity and IoT",
    ],
    "MBA": ["MBA Department", "Research Area", "Other Area"],
    "PU": ["PU Classrooms", "Laboratories", "Staff Room", "Office", "Other Area"],
    "HOSTEL": ["Boys Hostel", "Girls Hostel"],
    "ADMIN_BLOCK": NEW_ADMIN_AREAS,
}


def _update_building(conn, code: str, departments: list[str], floors: list[str] | None = None) -> None:
    if floors is None:
        stmt = sa.text(
            "UPDATE building SET departments = :departments WHERE code = :code"
        ).bindparams(bindparam("departments", type_=postgresql.ARRAY(sa.Text())))
        conn.execute(stmt, {"code": code, "departments": departments})
    else:
        stmt = sa.text(
            "UPDATE building SET departments = :departments, floors = :floors WHERE code = :code"
        ).bindparams(
            bindparam("departments", type_=postgresql.ARRAY(sa.Text())),
            bindparam("floors", type_=postgresql.ARRAY(sa.Text())),
        )
        conn.execute(stmt, {"code": code, "departments": departments, "floors": floors})


def upgrade() -> None:
    op.add_column(
        "building",
        sa.Column("departments", postgresql.ARRAY(sa.Text()), nullable=False,
                  server_default=sa.text("'{}'::text[]")),
    )
    op.add_column("ticket", sa.Column("department", sa.String(length=120), nullable=True))

    conn = op.get_bind()
    for code, departments in DEPARTMENTS.items():
        if code == "ADMIN_BLOCK":
            # The old admin screen stored the configured areas in `floors`.
            # Keep those edits as departments, then give the block real floors.
            current = conn.execute(
                sa.text("SELECT floors FROM building WHERE code = 'ADMIN_BLOCK'")
            ).scalar()
            configured = list(current or [])
            if configured and configured != OLD_ADMIN_AREAS:
                _update_building(conn, code, configured, ["Ground", "1", "2"])
            else:
                _update_building(conn, code, departments, ["Ground", "1", "2"])
        else:
            _update_building(conn, code, departments)


def downgrade() -> None:
    conn = op.get_bind()
    # Put the administrator areas back where the previous schema kept them.
    conn.execute(sa.text(
        "UPDATE building SET floors = departments WHERE code = 'ADMIN_BLOCK'"
    ))
    op.drop_column("ticket", "department")
    op.drop_column("building", "departments")
