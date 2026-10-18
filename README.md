# pcms — DBIT Campus Maintenance (Team OSSC)

Ticketing PWA per the PCMS implementation plan v1.2 (16 Oct 2026).

```
frontend/   React + TS PWA — faculty portal and /admin admin portal (UI complete, mock API)
backend/    reserved — Django + PostgreSQL + outbox worker (Team OSSC)
```

- Frontend deploys independently; API contract lives in `frontend/src/lib/api.ts`
- QA bar: `frontend/docs/UI-TEST-CASES.md`
- Interface is grayscale light/dark, Geist type pairing, installable, offline drafts
