"""Spending decisions and the worker directory."""

import uuid

from fastapi import APIRouter, Body, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.errors import ApiError, not_found
from app.models.catalog import Category
from app.models.worker import Worker, WorkerSkill
from app.schemas import CamelModel
from app.schemas.ticket import DecisionIn, TicketOut, WorkerIn, WorkerOut, WorkerPatch
from app.security.deps import Principal, require
from app.services import tickets as svc, workflow

proposals = APIRouter(prefix="/proposals", tags=["proposals"])
workers = APIRouter(prefix="/workers", tags=["workers"])


@proposals.post("/{proposal_id}/decisions", response_model=TicketOut)
async def decide(proposal_id: uuid.UUID, body: DecisionIn, p: Principal = Depends(require("cost.approve")),
                 db: AsyncSession = Depends(get_session)) -> TicketOut:
    t = await workflow.decide(db, p, proposal_id, body)
    await db.commit()
    return await svc.ticket_out(db, p, t)


@workers.get("", response_model=list[WorkerOut])
async def list_workers(trade: str | None = None, active: bool | None = None, p: Principal = Depends(require("worker.directory")),
                       db: AsyncSession = Depends(get_session)) -> list[WorkerOut]:
    stmt = select(Worker)
    if active is not None:
        stmt = stmt.where(Worker.active == active)
    if trade:
        stmt = stmt.join(WorkerSkill, WorkerSkill.worker_id == Worker.id).join(Category, Category.id == WorkerSkill.category_id).where(Category.code == trade)
    rows = (await db.scalars(stmt.order_by(Worker.name))).unique().all()
    return await workflow.workers_out(db, list(rows))


@workers.post("", response_model=WorkerOut, status_code=201)
async def create_worker(body: WorkerIn, p: Principal = Depends(require("worker.manage")),
                        db: AsyncSession = Depends(get_session)) -> WorkerOut:
    w = await workflow.create_worker(db, p, body)
    await db.commit()
    return (await workflow.workers_out(db, [w]))[0]


class ImportResultRow(CamelModel):
    name: str
    phone: str
    status: str  # created | exists | invalid
    message: str | None = None


@workers.post("/import", response_model=list[ImportResultRow])
async def import_workers(body: list[WorkerIn] = Body(..., max_length=200), p: Principal = Depends(require("worker.manage")),
                         db: AsyncSession = Depends(get_session)) -> list[ImportResultRow]:
    """Add many contacts at once (picked from the phone or a contacts file). Each row stands alone."""
    out: list[ImportResultRow] = []
    for row in body:
        try:
            async with db.begin_nested():
                await workflow.create_worker(db, p, row)
            out.append(ImportResultRow(name=row.name, phone=row.phone, status="created"))
        except ApiError as exc:
            out.append(ImportResultRow(name=row.name, phone=row.phone,
                                       status="exists" if exc.code == "phone_exists" else "invalid",
                                       message=exc.message if not exc.field_errors else " ".join(exc.field_errors.values())))
    await db.commit()
    return out


@workers.patch("/{worker_id}", response_model=WorkerOut)
async def update_worker(worker_id: uuid.UUID, body: WorkerPatch, p: Principal = Depends(require("worker.manage")),
                        db: AsyncSession = Depends(get_session)) -> WorkerOut:
    w = await db.get(Worker, worker_id, with_for_update=True)
    if w is None:
        raise not_found("Worker not found.")
    await workflow.update_worker(db, p, w, body)
    await db.commit()
    return (await workflow.workers_out(db, [w]))[0]
