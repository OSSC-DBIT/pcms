from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models.catalog import Building, Category
from app.schemas.catalog import CatalogsOut

router = APIRouter(tags=["catalogs"])


@router.get("/catalogs", response_model=CatalogsOut)
async def get_catalogs(session: AsyncSession = Depends(get_session)) -> CatalogsOut:
    cats = (await session.scalars(
        select(Category).where(Category.active).order_by(Category.sort_order, Category.code)
    )).all()
    blds = (await session.scalars(
        select(Building).where(Building.active).order_by(Building.sort_order, Building.code)
    )).all()
    return CatalogsOut.model_validate({"categories": cats, "buildings": blds})
