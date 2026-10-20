"""Roles and capabilities. Names match frontend/src/lib/types.ts exactly.

DBIT decisions (2026-10-18), which differ from plan v1.2 section 3 and are
recorded in docs/SECURITY.md:
  - Team OSSC (super admin) has full access to every function.
  - Facility managers contact workers directly and record the state on the ticket.
  - Only Team OSSC uses a second factor (TOTP).
Separation of duty for spending still holds for everyone, OSSC included:
nobody can approve a proposal they requested or a ticket they reported.
"""

from typing import Final

ROLES: Final = ("faculty", "ossc", "facility_manager", "management")
ADMIN_PORTAL_ROLES: Final = frozenset({"ossc", "facility_manager", "management"})
SECOND_FACTOR_ROLES: Final = frozenset({"ossc"})

CAPABILITIES: Final = frozenset({
    "ticket.create", "ticket.track", "ticket.verify",
    "queue.view", "ticket.triage", "ticket.assign", "ticket.assess", "ticket.escalate", "ticket.close",
    "cost.approve",
    "admin.users", "admin.catalogs", "admin.locations", "admin.settings", "admin.audit",
})

ROLE_CAPABILITIES: Final[dict[str, tuple[str, ...]]] = {
    "faculty": ("ticket.create", "ticket.track", "ticket.verify"),
    "facility_manager": (
        "queue.view", "ticket.triage", "ticket.assign", "ticket.assess", "ticket.escalate", "ticket.close",
    ),
    "management": ("queue.view", "cost.approve"),
    "ossc": tuple(sorted(CAPABILITIES)),
}

assert set(ROLE_CAPABILITIES) == set(ROLES)
assert all(set(caps) <= CAPABILITIES for caps in ROLE_CAPABILITIES.values())


def capabilities_for(role: str) -> list[str]:
    return list(ROLE_CAPABILITIES.get(role, ()))


def requires_second_factor(role: str) -> bool:
    return role in SECOND_FACTOR_ROLES
