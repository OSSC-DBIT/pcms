"""Pydantic schemas form the OpenAPI contract.

Bodies use camelCase to match frontend/src/lib/types.ts. The error envelope
stays snake_case because the frontend toErr() already reads it that way.
"""

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)
