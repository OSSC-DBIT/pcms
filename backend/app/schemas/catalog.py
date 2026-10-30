from app.schemas import CamelModel


class CategoryOut(CamelModel):
    code: str
    letter: str
    name_en: str
    name_hi: str
    name_kn: str
    subtypes_en: list[str]
    subtypes_hi: list[str]
    subtypes_kn: list[str]
    active: bool


class BuildingOut(CamelModel):
    code: str
    name_en: str
    name_hi: str
    name_kn: str
    floors: list[str]
    departments: list[str]
    departments_kn: list[str]
    active: bool


class CatalogsOut(CamelModel):
    categories: list[CategoryOut]
    buildings: list[BuildingOut]
