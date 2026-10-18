from typing import Literal

from pydantic import Field

from app.schemas import CamelModel

StepName = Literal["totp", "change_password", "enrol_totp", "done"]


class SignInIn(CamelModel):
    employee_id: str = Field(min_length=1, max_length=32)
    password: str = Field(min_length=1, max_length=256)


class MeOut(CamelModel):
    """Matches the frontend User interface."""

    id: str
    employee_id: str
    name: str
    role: str
    capabilities: list[str]


class TotpEnrolment(CamelModel):
    secret: str
    uri: str


class StepOut(CamelModel):
    """Returned by every sign-in step. The client keeps going until next == 'done'."""

    user: MeOut
    next: StepName
    csrf_token: str
    enrolment: TotpEnrolment | None = None
    # Shown exactly once, right after TOTP enrolment.
    recovery_codes: list[str] | None = None


class TotpIn(CamelModel):
    code: str = Field(min_length=6, max_length=20)


class ChangePasswordIn(CamelModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=1, max_length=256)


class MeWithCsrf(MeOut):
    csrf_token: str
