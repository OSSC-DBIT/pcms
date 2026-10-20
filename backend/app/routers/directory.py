"""Spending decisions."""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.schemas.ticket import DecisionIn, TicketOut
from app.security.deps import Principal, require
from app.services import tickets as svc, workflow

proposals = APIRouter(prefix="/proposals", tags=["proposals"])


@proposals.post("/{proposal_id}/decisions", response_model=TicketOut)
async def decide(proposal_id: uuid.UUID, body: DecisionIn, p: Principal = Depends(require("cost.approve")),
                 db: AsyncSession = Depends(get_session)) -> TicketOut:
    t = await workflow.decide(db, p, proposal_id, body)
    await db.commit()
    return await svc.ticket_out(db, p, t)
