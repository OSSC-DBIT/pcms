from app.schemas import CamelModel


class CategoryOut(CamelModel):
    code: str
    letter: str
    name_en: str
    name_hi: str
    subtypes_en: list[str]
    subtypes_hi: list[str]
    active: bool


class BuildingOut(CamelModel):
    code: str
    name_en: str
    name_hi: str
    floors: list[str]
    active: bool


class CatalogsOut(CamelModel):
    categories: list[CategoryOut]
    buildings: list[BuildingOut]
