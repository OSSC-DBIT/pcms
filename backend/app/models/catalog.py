"""Reference catalogs: maintenance categories and campus buildings.

Rows are deactivated, never deleted, so history and tokens stay valid.
"""

from sqlalchemy import Boolean, CheckConstraint, Integer, String, Text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Category(Base):
    __tablename__ = "category"
    __table_args__ = (
        CheckConstraint("letter ~ '^[A-Z]$'", name="category_letter_single_upper"),
        CheckConstraint("code ~ '^[a-z][a-z0-9_]*$'", name="category_code_slug"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(40), unique=True, nullable=False)
    # Token type letter. Unique and never recycled (plan section 7).
    letter: Mapped[str] = mapped_column(String(1), unique=True, nullable=False)
    name_en: Mapped[str] = mapped_column(String(80), nullable=False)
    name_hi: Mapped[str] = mapped_column(String(80), nullable=False)
    subtypes_en: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False, default=list)
    subtypes_hi: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False, default=list)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class Building(Base):
    __tablename__ = "building"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    name_en: Mapped[str] = mapped_column(String(80), nullable=False)
    name_hi: Mapped[str] = mapped_column(String(80), nullable=False)
    floors: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False, default=list)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
