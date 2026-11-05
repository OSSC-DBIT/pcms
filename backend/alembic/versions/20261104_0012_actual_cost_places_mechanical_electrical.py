"""actual cost on a fixed ticket, new places, Mechanical / Electrical type name

DBIT, 4 November 2026:
  - The facility manager records the exact cost (optional) when a ticket is marked fixed.
  - Block B gets the Library. The Administrator Block gets the Placement Department,
    Dean's Room, R&D Department, Board Room and Server Room.
  - The Mechanical type is shown as "Mechanical / Electrical".

Catalog rows are changed only where they still hold the seeded values, so edits
Team OSSC made in the admin portal are kept. app/seed.py carries the same values
for rows it inserts.

Revision ID: 0012
Revises: 0011
Create Date: 2026-11-04
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import bindparam
from sqlalchemy.dialects import postgresql

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# (building code, [(English, Kannada)], insert before this English entry if present)
NEW_PLACES = {
    "BLOCK_B": ([("Library", "ಗ್ರಂಥಾಲಯ")], None),
    "ADMIN_BLOCK": ([
        ("Placement Department", "ಪ್ಲೇಸ್ಮೆಂಟ್ ವಿಭಾಗ"),
        ("Dean's Room", "ಡೀನ್ ಅವರ ಕೊಠಡಿ"),
        ("R&D Department", "ಸಂಶೋಧನೆ ಮತ್ತು ಅಭಿವೃದ್ಧಿ ವಿಭಾಗ"),
        ("Board Room", "ಬೋರ್ಡ್ ಕೊಠಡಿ"),
        ("Server Room", "ಸರ್ವರ್ ಕೊಠಡಿ"),
    ], "Other Area"),
}

MECH_OLD = ("Mechanical", "यांत्रिक", "ಯಾಂತ್ರಿಕ")
MECH_NEW = ("Mechanical / Electrical", "यांत्रिक / विद्युत", "ಯಾಂತ್ರಿಕ / ವಿದ್ಯುತ್")

_ARR = postgresql.ARRAY(sa.Text())


def _set_places(conn, code: str, en: list[str], kn: list[str]) -> None:
    stmt = sa.text("UPDATE building SET departments = :en, departments_kn = :kn WHERE code = :code").bindparams(
        bindparam("en", type_=_ARR), bindparam("kn", type_=_ARR))
    conn.execute(stmt, {"code": code, "en": en, "kn": kn})


def _rename(conn, old: tuple[str, str, str], new: tuple[str, str, str]) -> None:
    conn.execute(sa.text(
        "UPDATE category SET name_en = :en, name_hi = :hi, name_kn = :kn "
        "WHERE code = 'mechanical' AND name_en = :old_en"),
        {"en": new[0], "hi": new[1], "kn": new[2], "old_en": old[0]})


def upgrade() -> None:
    op.add_column("ticket", sa.Column("actual_cost_paise", sa.BigInteger(), nullable=True))
    op.create_check_constraint("ticket_actual_cost_non_negative", "ticket",
                               "actual_cost_paise IS NULL OR actual_cost_paise >= 0")

    conn = op.get_bind()
    for code, (places, before) in NEW_PLACES.items():
        row = conn.execute(sa.text("SELECT departments, departments_kn FROM building WHERE code = :c"),
                           {"c": code}).first()
        if row is None:
            continue
        en, kn = list(row[0] or []), list(row[1] or [])
        parallel = len(kn) == len(en)
        for name, name_kn in places:
            if name in en:
                continue
            at = en.index(before) if before in en else len(en)
            en.insert(at, name)
            if parallel:
                kn.insert(at, name_kn)
        _set_places(conn, code, en, kn)
    _rename(conn, MECH_OLD, MECH_NEW)


def downgrade() -> None:
    conn = op.get_bind()
    _rename(conn, MECH_NEW, MECH_OLD)
    for code, (places, _before) in NEW_PLACES.items():
        row = conn.execute(sa.text("SELECT departments, departments_kn FROM building WHERE code = :c"),
                           {"c": code}).first()
        if row is None:
            continue
        en, kn = list(row[0] or []), list(row[1] or [])
        parallel = len(kn) == len(en)
        for name, _kn in places:
            if name in en:
                i = en.index(name)
                en.pop(i)
                if parallel:
                    kn.pop(i)
        _set_places(conn, code, en, kn)
    op.drop_constraint("ticket_actual_cost_non_negative", "ticket", type_="check")
    op.drop_column("ticket", "actual_cost_paise")
