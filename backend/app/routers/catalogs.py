"""Catalog lookups: the types and places people choose from on the report form."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models.catalog import Building, Category
from app.schemas.catalog import CatalogsOut

router = APIRouter(tags=["catalogs"])


@router.get("/catalogs", response_model=CatalogsOut)
async def get_catalogs(session: AsyncSession = Depends(get_session),
                       include_inactive: bool = Query(False, alias="includeInactive")) -> CatalogsOut:
    """Active types and places.

    includeInactive is for the administration screens, which need to show a retired
    row so it can be restored. Everyone else always gets the active list, so a retired
    type cannot be picked on a new report. Old tickets keep rendering either way,
    because the frontend falls back to a placeholder for an unknown code.
    """
    cats = (await session.scalars(
        select(Category).where(Category.active if not include_inactive else True).order_by(Category.sort_order, Category.code)
    )).all()
    blds = (await session.scalars(
        select(Building).where(Building.active if not include_inactive else True).order_by(Building.sort_order, Building.code)
    )).all()
    return CatalogsOut.model_validate({"categories": cats, "buildings": blds})
