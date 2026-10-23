"""email login and encrypted temporary passwords

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-22
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    conn = op.get_bind()

    # Existing dev/test rows had no email. There is no production data; the
    # placeholder is deterministic and can be edited by Team OSSC. Do not
    # invent addresses in a live system.
    conn.execute(sa.text("UPDATE app_user SET email = lower(btrim(email)) WHERE email IS NOT NULL"))
    conn.execute(sa.text(
        "UPDATE app_user SET email = lower(employee_id) || '@pcms.invalid' WHERE email IS NULL"
    ))
    duplicate = conn.execute(sa.text(
        "SELECT email FROM app_user GROUP BY email HAVING count(*) > 1 LIMIT 1"
    )).first()
    if duplicate is not None:
        raise RuntimeError(
            f"Cannot enforce unique emails: {duplicate[0]!r} appears more than once. "
            "Clean up app_user.email and run the migration again."
        )

    op.add_column("app_user", sa.Column("temp_password_enc", sa.Text(), nullable=True))
    op.alter_column("app_user", "email", existing_type=sa.String(length=254), nullable=False)
    op.create_unique_constraint("app_user_email_key", "app_user", ["email"])
    op.create_check_constraint("app_user_email_normalised", "app_user", "email = lower(btrim(email))")

    op.drop_constraint("app_user_employee_id_normalised", "app_user", type_="check")
    op.drop_constraint("app_user_employee_id_key", "app_user", type_="unique")
    op.drop_column("app_user", "employee_id")


def downgrade() -> None:
    op.add_column("app_user", sa.Column("employee_id", sa.String(length=32), nullable=True))
    op.execute(
        "UPDATE app_user SET employee_id = upper(left(split_part(email, '@', 1), 32))"
    )
    op.create_unique_constraint("app_user_employee_id_key", "app_user", ["employee_id"])
    op.create_check_constraint(
        "app_user_employee_id_normalised", "app_user", "employee_id = upper(btrim(employee_id))"
    )

    op.drop_column("app_user", "temp_password_enc")
    op.drop_constraint("app_user_email_normalised", "app_user", type_="check")
    op.drop_constraint("app_user_email_key", "app_user", type_="unique")
    op.alter_column("app_user", "email", existing_type=sa.String(length=254), nullable=True)
