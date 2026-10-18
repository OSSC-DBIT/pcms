# PCMS frontend — handover

## Status
UI complete and live at https://pcms-rust.vercel.app (private repo, Vercel project `pcms`).
Verified end-to-end in a real browser against production: faculty report → token receipt,
admin login → queue → triage (Submitted → Triaged), demo-data controls, three languages,
both themes, permission guards. Zero console errors during the full QA pass.

## What the backend team needs to do (one file)

`frontend/src/lib/api.ts` — replace each mock method body with a `fetch` to the Django API
listed in the plan (§17). Set `VITE_API_BASE_URL` and delete the mock branch. Every call
site already handles async, loading, offline and error states. The OpenAPI contract from
plan §17 maps 1:1 to the exported `api` object and `types.ts`.

## Accounts (mock mode; real ones come from the college roster)

| ID | Role | Portal |
|----|------|--------|
| DB2101 | Faculty | / |
| DB0001 | Facility manager | /admin |
| DB0002 | Management | /admin (costs only) |
| DB0000 | Team OSSC | /admin (full) |
| — | Workers | no login; WhatsApp/SMS/call |

## Commands

```bash
cd frontend && npm install && npm run dev     # develop
npm run build && npm run preview              # check prod build
vercel deploy --prod                          # ship (from frontend/, CLI logged in)
```

## Design system
Grayscale only (white/black/grey), light + dark (system default, no boot flash),
Geist Sans + Geist Mono bundled locally, status by fill weight never colour,
direction-aware page transitions, edge-swipe back, 44px+ targets, focus rings,
`prefers-reduced-motion`, PWA installable with offline app shell.
Tokens: `src/styles/globals.css`. QA bar: `docs/UI-TEST-CASES.md` (T01–T20).

## Languages
English / हिन्दी / ಕನ್ನಡ in `src/lib/i18n.tsx` + localized catalogs in `api.ts`.
Adding a language = one dictionary + `nameXx` fields.

## Known limits (by design, per plan)
- Mock tokens are device-local counters; the server owns real serial allocation (§7.1)
- TOTP, CSRF, rate-limiting are backend responsibilities (§18)
- Worker phone numbers are masked in the UI; the API must never send them to faculty roles
