"""Roles and capabilities. Names match frontend/src/lib/types.ts exactly.

DBIT decisions (2026-10-18), which differ from plan v1.2 section 3 and are
recorded in docs/SECURITY.md:
  - Team OSSC (super admin) has full access to every function.
  - Facility managers contact workers directly and record the state on the ticket.
  - Only Team OSSC uses a second factor (TOTP).
Separation of duty for spending still holds for everyone, OSSC included:
nobody can approve a proposal they requested or a ticket they reported.

DBIT decisions (2026-10-30):
  - A ticket marked Critical goes to the principal first. The principal
    approves, rejects or escalates it to institute management, the higher
    authority, who then decides.
  - Messages and notes on a ticket are shared by staff only: the facility
    manager, management, the principal and Team OSSC. Faculty never see them.
  - All staff roles can report a problem and add photos and documents.
"""

from typing import Final

ROLES: Final = ("faculty", "ossc", "facility_manager", "management", "principal")
ADMIN_PORTAL_ROLES: Final = frozenset({"ossc", "facility_manager", "management", "principal"})
SECOND_FACTOR_ROLES: Final = frozenset({"ossc"})

CAPABILITIES: Final = frozenset({
    "ticket.create", "ticket.track", "ticket.verify",
    "queue.view", "ticket.triage", "ticket.assign", "ticket.assess", "ticket.escalate", "ticket.close",
    # ticket.attach: add photos and documents to any ticket (staff).
    "ticket.attach",
    # cost.principal: first decision on spending. cost.approve: institute management, after escalation.
    "cost.principal", "cost.approve",
    "admin.users", "admin.catalogs", "admin.locations", "admin.settings", "admin.audit",
    # admin.tickets: remove any ticket (DBIT, 2026-11-04). History stays; the ticket is hidden everywhere.
    "admin.tickets",
})

# Every staff role can report a problem and confirm the fix of one they reported.
_REPORTER = ("ticket.create", "ticket.track", "ticket.verify")

ROLE_CAPABILITIES: Final[dict[str, tuple[str, ...]]] = {
    "faculty": _REPORTER,
    "facility_manager": (
        *_REPORTER, "queue.view", "ticket.triage", "ticket.assign", "ticket.assess", "ticket.escalate", "ticket.close",
        "ticket.attach",
    ),
    "management": (*_REPORTER, "queue.view", "cost.approve", "ticket.attach"),
    "principal": (*_REPORTER, "queue.view", "cost.principal", "ticket.attach"),
    "ossc": tuple(sorted(CAPABILITIES)),
}

assert set(ROLE_CAPABILITIES) == set(ROLES)
assert all(set(caps) <= CAPABILITIES for caps in ROLE_CAPABILITIES.values())


def capabilities_for(role: str) -> list[str]:
    return list(ROLE_CAPABILITIES.get(role, ()))


def requires_second_factor(role: str) -> bool:
    return role in SECOND_FACTOR_ROLES
