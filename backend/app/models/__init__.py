"""SQLAlchemy models. Importing this package registers every table on Base.metadata."""

from app.models.attachment import Attachment
from app.models.audit import AuditEvent
from app.models.catalog import Building, Category
from app.models.outbox import DeliveryAttempt, Outbox, ProviderEvent
from app.models.proposal import Decision, Proposal, ProposalLine
from app.models.push import PushSubscription
from app.models.session import ThrottleEvent, UserSession
from app.models.ticket import Ticket, TicketComment, TicketEvent, TokenCounter
from app.models.user import User
from app.models.worker import Assignment, Worker, WorkerSkill

__all__ = [
    "Assignment", "Attachment", "AuditEvent", "Building", "Category", "Decision", "DeliveryAttempt",
    "Outbox", "Proposal", "ProposalLine", "ProviderEvent", "PushSubscription", "ThrottleEvent", "Ticket",
    "TicketComment", "TicketEvent", "TokenCounter", "User", "UserSession", "Worker", "WorkerSkill",
]
