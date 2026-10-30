"""Kannada catalog names and Sports Department

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-30
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import bindparam
from sqlalchemy.dialects import postgresql

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CATEGORY_KN = {
    "carpentry": (
        "ಬಡಗಿ ಕೆಲಸ",
        ["ಕುರ್ಚಿ", "ಮೇಜು", "ಬಾಗಿಲು", "ಕಿಟಕಿ", "ಕಪಾಟು", "ಇತರ"],
    ),
    "plumbing": (
        "ಪ್ಲಂಬಿಂಗ್",
        ["ನಲ್ಲ", "ಚರಂಡಿ", "ಸೋರಿಕೆ", "ಟ್ಯಾಂಕ್", "ಇತರ"],
    ),
    "internet": (
        "ಇಂಟರ್ನೆಟ್",
        ["ವೈ-ಫೈ", "ಲ್ಯಾನ್ ಪೋರ್ಟ್", "ರೌಟರ್", "ಇತರ"],
    ),
    "phone": (
        "ದೂರವಾಣಿ",
        ["ವಿಸ್ತರಣೆ", "ಲೈನ್", "ಇತರ"],
    ),
    "projector": (
        "ಪ್ರೊಜೆಕ್ಟರ್",
        ["ದೀಪ", "ರಿಮೋಟ್", "ಸ್ಕ್ರೀನ್", "ಎಚ್ಡಿಎಂಐ", "ಇತರ"],
    ),
    "flooring": (
        "ನೆಲಹಾಸು",
        ["ಟೈಲ್", "ಬಿರುಕು", "ಇತರ"],
    ),
    "toilets": (
        "ಶೌಚಾಲಯಗಳು",
        ["ಫ್ಲಶ್", "ನಲ್ಲ", "ಕಟ್ಟು", "ಇತರ"],
    ),
    "electrical": (
        "ವಿದ್ಯುತ್",
        ["ಫ್ಯಾನ್", "ದೀಪ", "ಸಾಕೆಟ್", "ಸ್ವಿಚ್ಬೋರ್ಡ್", "ಇತರ"],
    ),
    "other": ("ಇತರ", ["ಇತರ"]),
    "it_services": (
        "ಐಟಿ ಸೇವೆಗಳು",
        [
            "ಕಂಪ್ಯೂಟರ್ / ಲ್ಯಾಪ್ಟಾಪ್",
            "ವೈ-ಫೈ / ಇಂಟರ್ನೆಟ್",
            "ಪ್ರೊಜೆಕ್ಟರ್",
            "ಪ್ರಿಂಟರ್ / ಸ್ಕ್ಯಾನರ್",
            "ಸ್ಮಾರ್ಟ್ ಬೋರ್ಡ್ / ಡಿಸ್ಪ್ಲೇ",
            "ಸಾಫ್ಟ್ವೇರ್ / ಲಾಗಿನ್ ಸಮಸ್ಯೆ",
            "ನೆಟ್ವರ್ಕ್ / ಲ್ಯಾನ್",
            "ಇತರ ಐಟಿ ಸಮಸ್ಯೆ",
        ],
    ),
    "civil": (
        "ಸಿವಿಲ್",
        [
            "ಡೆಸ್ಕ್ / ಕುರ್ಚಿ / ಪೀಠೋಪಕರಣ",
            "ಬಾಗಿಲು / ಕಿಟಕಿ / ಬೀಗ",
            "ಗೋಡೆ / ಚಾವಣಿ / ನೆಲ",
            "ಪ್ಲಂಬಿಂಗ್ / ನೀರಿನ ಸೋರಿಕೆ",
            "ಶೌಚಾಲಯ / ವಾಶ್ರೂಮ್",
            "ಛಾವಣಿ / ಜಲನಿರೋಧಕ",
            "ಇತರ ಸಿವಿಲ್ ಸಮಸ್ಯೆ",
        ],
    ),
    "mechanical": (
        "ಯಾಂತ್ರಿಕ",
        [
            "ಫ್ಯಾನ್ / ದೀಪ / ವಿದ್ಯುತ್",
            "ಎಸಿ / ತಂಪಾಗಿಸುವಿಕೆ",
            "ಪ್ರಯೋಗಾಲಯ ಸಾಧನ",
            "ಯಂತ್ರ / ಉಪಕರಣ",
            "ಇತರ ಯಾಂತ್ರಿಕ ಸಮಸ್ಯೆ",
        ],
    ),
}

BUILDING_KN = {
    "ADMIN": "ಮುಖ್ಯ ಕಟ್ಟಡ (ಆಡಳಿತ)",
    "CSE": "ಕಂಪ್ಯೂಟರ್ ಸೈನ್ಸ್ ಮತ್ತು ಎಂಜಿನಿಯರಿಂಗ್",
    "ISE": "ಇನ್ಫರ್ಮೇಶನ್ ಸೈನ್ಸ್ ಮತ್ತು ಎಂಜಿನಿಯರಿಂಗ್",
    "ECE": "ಎಲೆಕ್ಟ್ರಾನಿಕ್ಸ್ ಮತ್ತು ಕಮ್ಯುನಿಕೇಶನ್",
    "EEE": "ಎಲೆಕ್ಟ್ರಿಕಲ್ ಮತ್ತು ಎಲೆಕ್ಟ್ರಾನಿಕ್ಸ್",
    "AI": "ಎಐ ಮತ್ತು ಎಂಎಲ್ / ಎಐ ಮತ್ತು ಡೇಟಾ ಸೈನ್ಸ್",
    "MECH": "ಮೆಕ್ಯಾನಿಕಲ್ ಎಂಜಿನಿಯರಿಂಗ್ ಮತ್ತು ವರ್ಕ್ಶಾಪ್ಗಳು",
    "CIVIL": "ಸಿವಿಲ್ ಎಂಜಿನಿಯರಿಂಗ್",
    "BSH": "ಮೂಲ ವಿಜ್ಞಾನ (ಭೌತಶಾಸ್ತ್ರ, ರಸಾಯನಶಾಸ್ತ್ರ, ಗಣಿತ)",
    "MBA": "ಎಂಬಿಎ ವಿಭಾಗ",
    "LIB": "ಗ್ರಂಥಾಲಯ ಮತ್ತು ಮಾಹಿತಿ ಕೇಂದ್ರ",
    "AUD": "ಸಭಾಂಗಣ ಮತ್ತು ಸೆಮಿನಾರ್ ಹಾಲ್ಗಳು",
    "FOOD": "ಫುಡ್ ಕೋರ್ಟ್",
    "HOSTEL": "ಹಾಸ್ಟೆಲ್",
    "SPORTS": "ಕ್ರೀಡಾ ವಿಭಾಗ",
    "TRANS": "ಸಾರಿಗೆ ಮತ್ತು ಪಾರ್ಕಿಂಗ್",
    "BLOCK_A": "ಬ್ಲಾಕ್ ಎ",
    "BLOCK_B": "ಬ್ಲಾಕ್ ಬಿ",
    "PU": "ಪಿಯು ಬ್ಲಾಕ್",
    "ADMIN_BLOCK": "ಆಡಳಿತಾಧಿಕಾರಿ ಬ್ಲಾಕ್",
}

DEPARTMENTS_KN = {
    "BLOCK_A": [
        "ಕಂಪ್ಯೂಟರ್ ಸೈನ್ಸ್ ಮತ್ತು ಎಂಜಿನಿಯರಿಂಗ್ (ಸಿಎಸ್ಇ)",
        "ಇನ್ಫರ್ಮೇಶನ್ ಸೈನ್ಸ್ ಮತ್ತು ಎಂಜಿನಿಯರಿಂಗ್ (ಐಎಸ್ಇ)",
        "ಎಲೆಕ್ಟ್ರಾನಿಕ್ಸ್ ಮತ್ತು ಕಮ್ಯುನಿಕೇಶನ್ ಎಂಜಿನಿಯರಿಂಗ್ (ಇಸಿಇ)",
        "ಭೌತಶಾಸ್ತ್ರ",
        "ರಸಾಯನಶಾಸ್ತ್ರ",
    ],
    "BLOCK_B": [
        "ಕೃತಕ ಬುದ್ಧಿಮತ್ತೆ ಮತ್ತು ಯಂತ್ರ ಕಲಿಕೆ (ಎಐ/ಎಂಎಲ್)",
        "ಕೃತಕ ಬುದ್ಧಿಮತ್ತೆ ಮತ್ತು ಡೇಟಾ ಸೈನ್ಸ್ (ಎಐ ಮತ್ತು ಡಿಎಸ್)",
        "ಎಲೆಕ್ಟ್ರಿಕಲ್ ಮತ್ತು ಎಲೆಕ್ಟ್ರಾನಿಕ್ಸ್ ಎಂಜಿನಿಯರಿಂಗ್ (ಇಇಇ)",
        "ಸೈಬರ್ ಭದ್ರತೆ ಮತ್ತು ಐಒಟಿ",
    ],
    "MBA": ["ಎಂಬಿಎ ವಿಭಾಗ", "ಸಂಶೋಧನಾ ವಿಭಾಗ", "ಇತರ ಪ್ರದೇಶ"],
    "PU": ["ಪಿಯು ತರಗತಿ ಕೊಠಡಿಗಳು", "ಪ್ರಯೋಗಾಲಯಗಳು", "ಸಿಬ್ಬಂದಿ ಕೊಠಡಿ", "ಕಚೇರಿ", "ಇತರ ಪ್ರದೇಶ"],
    "HOSTEL": ["ಬಾಲಕರ ಹಾಸ್ಟೆಲ್", "ಬಾಲಕಿಯರ ಹಾಸ್ಟೆಲ್"],
    "ADMIN_BLOCK": ["ಪ್ರಾಂಶುಪಾಲರ ಕಚೇರಿ", "ಆಡಳಿತ ಕಚೇರಿ", "ಅಧ್ಯಾಪಕರ ಕೊಠಡಿಗಳು", "ಸಮ್ಮೇಳನ ಕೊಠಡಿ", "ಇತರ ಪ್ರದೇಶ"],
}


def _set_array(conn, table: str, column: str, key: str, values: list[str]) -> None:
    stmt = sa.text(
        f"UPDATE {table} SET {column} = :values WHERE code = :code"
    ).bindparams(bindparam("values", type_=postgresql.ARRAY(sa.Text())))
    conn.execute(stmt, {"code": key, "values": values})


def upgrade() -> None:
    op.add_column("category", sa.Column("name_kn", sa.String(length=80), nullable=False, server_default=""))
    op.add_column(
        "category",
        sa.Column("subtypes_kn", postgresql.ARRAY(sa.Text()), nullable=False,
                  server_default=sa.text("'{}'::text[]")),
    )
    op.add_column("building", sa.Column("name_kn", sa.String(length=80), nullable=False, server_default=""))
    op.add_column(
        "building",
        sa.Column("departments_kn", postgresql.ARRAY(sa.Text()), nullable=False,
                  server_default=sa.text("'{}'::text[]")),
    )

    conn = op.get_bind()
    for code, (name, subtypes) in CATEGORY_KN.items():
        conn.execute(sa.text("UPDATE category SET name_kn = :name WHERE code = :code"),
                     {"code": code, "name": name})
        _set_array(conn, "category", "subtypes_kn", code, subtypes)
    for code, name in BUILDING_KN.items():
        conn.execute(sa.text("UPDATE building SET name_kn = :name WHERE code = :code"),
                     {"code": code, "name": name})
    for code, departments in DEPARTMENTS_KN.items():
        _set_array(conn, "building", "departments_kn", code, departments)

    # Custom rows added by administrators keep their English text until edited.
    conn.execute(sa.text("UPDATE category SET name_kn = name_en WHERE name_kn = ''"))
    conn.execute(sa.text(
        "UPDATE category SET subtypes_kn = subtypes_en "
        "WHERE cardinality(subtypes_kn) <> cardinality(subtypes_en)"
    ))
    conn.execute(sa.text("UPDATE building SET name_kn = name_en WHERE name_kn = ''"))
    conn.execute(sa.text(
        "UPDATE building SET departments_kn = departments "
        "WHERE cardinality(departments_kn) <> cardinality(departments)"
    ))

    conn.execute(sa.text("""
        UPDATE building
        SET name_en = 'Sports Department', name_hi = 'खेल विभाग', name_kn = 'ಕ್ರೀಡಾ ವಿಭಾಗ',
            floors = ARRAY['Ground']::text[], departments = ARRAY[]::text[],
            departments_kn = ARRAY[]::text[], active = true, sort_order = 6
        WHERE code = 'SPORTS'
    """))


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("""
        UPDATE building
        SET name_en = 'Physical Education and Sports', name_hi = 'शारीरिक शिक्षा एवं खेल',
            floors = ARRAY['Ground']::text[], departments = ARRAY[]::text[],
            active = false, sort_order = 114
        WHERE code = 'SPORTS'
    """))
    op.drop_column("building", "departments_kn")
    op.drop_column("building", "name_kn")
    op.drop_column("category", "subtypes_kn")
    op.drop_column("category", "name_kn")
