"""category and building refresh plus reporter ticket edits

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-28
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import bindparam
from sqlalchemy.dialects import postgresql

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LEGACY_CATEGORIES = (
    "carpentry", "plumbing", "internet", "phone", "projector", "flooring", "toilets", "electrical", "other",
)
LEGACY_BUILDINGS = (
    "ADMIN", "CSE", "ISE", "ECE", "EEE", "AI", "MECH", "CIVIL", "BSH", "LIB", "AUD", "FOOD", "SPORTS", "TRANS",
)

ADMIN_AREAS = [
    "Ground Floor", "First Floor", "Second Floor", "Administration Office",
    "Principal's Office", "Faculty Rooms", "Conference Room", "Other Areas",
]

CATEGORIES = [
    ("it_services", "S", "IT Services", "आईटी सेवाएं", [
        "Computer / Laptop", "Wi-Fi / Internet", "Projector", "Printer / Scanner",
        "Smart Board / Display", "Software / Login Issue", "Network / LAN", "Other IT Issue",
    ], [
        "कंप्यूटर / लैपटॉप", "वाई-फाई / इंटरनेट", "प्रोजेक्टर", "प्रिंटर / स्कैनर",
        "स्मार्ट बोर्ड / डिस्प्ले", "सॉफ्टवेयर / लॉगिन समस्या", "नेटवर्क / लैन", "अन्य आईटी समस्या",
    ]),
    ("civil", "V", "Civil", "सिविल", [
        "Desk / Chair / Furniture", "Door / Window / Lock", "Wall / Ceiling / Floor",
        "Plumbing / Water Leak", "Toilet / Washroom", "Roof / Waterproofing", "Other Civil Issue",
    ], [
        "डेस्क / कुर्सी / फर्नीचर", "दरवाजा / खिड़की / ताला", "दीवार / छत / फर्श",
        "प्लंबिंग / पानी का रिसाव", "शौचालय / वॉशरूम", "छत / वॉटरप्रूफिंग", "अन्य सिविल समस्या",
    ]),
    ("mechanical", "M", "Mechanical", "मैकेनिकल", [
        "Fan / Light / Electrical", "AC / Cooling", "Lab Equipment", "Machine / Tool",
        "Other Mechanical Issue",
    ], [
        "पंखा / लाइट / बिजली", "एसी / कूलिंग", "लैब उपकरण", "मशीन / उपकरण",
        "अन्य मैकेनिकल समस्या",
    ]),
]

BUILDINGS = [
    ("BLOCK_A", "Block A", "ब्लॉक ए", ["Ground", "1", "2", "3"]),
    ("BLOCK_B", "Block B", "ब्लॉक बी", ["Ground", "1", "2", "3"]),
    ("MBA", "PG Block (MBA & Research)", "पीजी ब्लॉक (एमबीए और रिसर्च)", ["Ground", "1", "2"]),
    ("PU", "PU Block", "पीयू ब्लॉक", ["Ground", "1", "2", "3"]),
    ("HOSTEL", "Hostel", "हॉस्टल", ["Ground", "1", "2", "3"]),
    ("ADMIN_BLOCK", "Administrator Block", "प्रशासक ब्लॉक", ADMIN_AREAS),
]


def _insert_category(conn, row, active: bool, sort_order: int) -> None:
    code, letter, name_en, name_hi, subtypes_en, subtypes_hi = row
    stmt = sa.text(
        "INSERT INTO category (code, letter, name_en, name_hi, subtypes_en, subtypes_hi, active, sort_order) "
        "VALUES (:code, :letter, :name_en, :name_hi, :subtypes_en, :subtypes_hi, :active, :sort_order) "
        "ON CONFLICT (code) DO NOTHING"
    ).bindparams(
        bindparam("subtypes_en", type_=postgresql.ARRAY(sa.String())),
        bindparam("subtypes_hi", type_=postgresql.ARRAY(sa.String())),
    )
    conn.execute(stmt, {
        "code": code, "letter": letter, "name_en": name_en, "name_hi": name_hi,
        "subtypes_en": subtypes_en, "subtypes_hi": subtypes_hi, "active": active, "sort_order": sort_order,
    })


def _insert_building(conn, row, active: bool, sort_order: int) -> None:
    code, name_en, name_hi, floors = row
    stmt = sa.text(
        "INSERT INTO building (code, name_en, name_hi, floors, active, sort_order) "
        "VALUES (:code, :name_en, :name_hi, :floors, :active, :sort_order) "
        "ON CONFLICT (code) DO NOTHING"
    ).bindparams(bindparam("floors", type_=postgresql.ARRAY(sa.String())))
    conn.execute(stmt, {
        "code": code, "name_en": name_en, "name_hi": name_hi, "floors": floors,
        "active": active, "sort_order": sort_order,
    })


def upgrade() -> None:
    op.add_column("ticket", sa.Column("custom_location", sa.String(length=120), nullable=True))
    op.alter_column("ticket", "subtype", existing_type=sa.String(length=80), type_=sa.String(length=160))

    conn = op.get_bind()
    for i, code in enumerate(LEGACY_CATEGORIES):
        conn.execute(
            sa.text("UPDATE category SET active = false, sort_order = :sort_order WHERE code = :code"),
            {"sort_order": 100 + i, "code": code},
        )
    for i, code in enumerate(LEGACY_BUILDINGS):
        conn.execute(
            sa.text("UPDATE building SET active = false, sort_order = :sort_order WHERE code = :code"),
            {"sort_order": 100 + i, "code": code},
        )

    for i, row in enumerate(CATEGORIES):
        _insert_category(conn, row, True, i)
    for i, row in enumerate(BUILDINGS):
        _insert_building(conn, row, True, i)

    # These two codes already existed under older names. Keep the rows so old
    # tickets still resolve, but move them to their new place in the list.
    conn.execute(sa.text(
        "UPDATE building SET name_en = :name_en, name_hi = :name_hi, floors = :floors, "
        "active = true, sort_order = 2 WHERE code = 'MBA'"
    ).bindparams(bindparam("floors", type_=postgresql.ARRAY(sa.String()))), {
        "name_en": "PG Block (MBA & Research)",
        "name_hi": "पीजी ब्लॉक (एमबीए और रिसर्च)",
        "floors": ["Ground", "1", "2"],
    })
    conn.execute(sa.text(
        "UPDATE building SET name_en = :name_en, name_hi = :name_hi, floors = :floors, "
        "active = true, sort_order = 4 WHERE code = 'HOSTEL'"
    ).bindparams(bindparam("floors", type_=postgresql.ARRAY(sa.String()))), {
        "name_en": "Hostel",
        "name_hi": "हॉस्टल",
        "floors": ["Ground", "1", "2", "3"],
    })


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("UPDATE ticket SET subtype = left(subtype, 80) WHERE length(subtype) > 80"))
    op.alter_column("ticket", "subtype", existing_type=sa.String(length=160), type_=sa.String(length=80))
    op.drop_column("ticket", "custom_location")

    conn.execute(
        sa.text("UPDATE category SET active = true WHERE code IN :codes").bindparams(
            bindparam("codes", expanding=True),
        ),
        {"codes": list(LEGACY_CATEGORIES)},
    )
    conn.execute(
        sa.text("UPDATE building SET active = true WHERE code IN :codes").bindparams(
            bindparam("codes", expanding=True),
        ),
        {"codes": list(LEGACY_BUILDINGS)},
    )
    conn.execute(
        sa.text("UPDATE category SET active = false WHERE code IN :codes").bindparams(
            bindparam("codes", expanding=True),
        ),
        {"codes": [row[0] for row in CATEGORIES]},
    )
    conn.execute(
        sa.text("UPDATE building SET active = false WHERE code IN :codes").bindparams(
            bindparam("codes", expanding=True),
        ),
        {"codes": [row[0] for row in BUILDINGS]},
    )
    conn.execute(sa.text(
        "UPDATE building SET name_en = :name_en, name_hi = :name_hi, floors = :floors, "
        "sort_order = 9 WHERE code = 'MBA'"
    ).bindparams(bindparam("floors", type_=postgresql.ARRAY(sa.String()))), {
        "name_en": "MBA Department",
        "name_hi": "एमबीए विभाग",
        "floors": ["Ground", "1", "2"],
    })
    conn.execute(sa.text(
        "UPDATE building SET name_en = :name_en, name_hi = :name_hi, floors = :floors, "
        "sort_order = 13 WHERE code = 'HOSTEL'"
    ).bindparams(bindparam("floors", type_=postgresql.ARRAY(sa.String()))), {
        "name_en": "Hostel",
        "name_hi": "छात्रावास",
        "floors": ["Ground", "1", "2", "3"],
    })
