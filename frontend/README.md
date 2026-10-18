# PCMS frontend

Campus maintenance ticketing PWA — faculty portal + admin portal at `/toal`.
Design: strict grayscale (white / black / grey), light + dark, Geist Sans + Geist Mono,
Apple-minimal, mobile-first, installable offline shell.

## Stack

- Vite 8 + React 19 + TypeScript (strict)
- Tailwind CSS v4 (tokens in `src/styles/globals.css`)
- Framer Motion — transform/opacity only, springs on touch feedback, `prefers-reduced-motion` honoured
- lucide-react icons, react-router 7, vite-plugin-pwa (precache app shell, NetworkFirst for `/api/`)
- Fonts bundled locally via `@fontsource-variable/*` — zero CDN at runtime (plan §15)

## Structure

```
src/
  lib/types.ts    domain model mirroring plan §16 (ticket, token, assignment, proposal…)
  lib/api.ts      single API layer — mock today, real backend tomorrow
  lib/i18n.tsx    English + हिन्दी, extensible locale dictionaries
  lib/hooks.ts    theme, edge-swipe back, online status
  components/     design-system kit (Button, chips, fields, NavBar, TabBar…)
  pages/faculty/  home, raise (6-step wizard), track, history, detail, receipt, settings
  pages/toal/     queue, ticket ops (triage/dispatch/assess/propose/decide), workers, approvals, admin
```

## Wiring the backend (one file)

`src/lib/api.ts` exposes one `api` object whose methods map 1:1 to the plan's REST
contract (§17): `POST /api/v1/session`, `GET /tickets`, `POST /tickets` with
`client_request_id`, `POST /tickets/{id}/transitions` etc.

To go live: set `VITE_API_BASE_URL` and replace the mock bodies with `fetch` calls —
every call site already treats them as async and renders loading/error states.
The mock persists to `localStorage` so the demo behaves like the real thing
(idempotent replays, per-type token serials, audit events, optimistic version bumps).

Demo accounts (mock mode): `DB2101` faculty · `DB0001` facility manager ·
`DB0002` management · `DB0000` OSSC admin — any password ≥ 4 chars.

## Rules this UI enforces (from the plan)

- Draft ≠ ticket: tokens appear only after server commit; drafts labelled "not submitted"
- Delivered ≠ accepted: only *Record accept* / Accept button moves a job to In progress
- Flag (I/C/P) and priority are separate dimensions, always shown apart
- Approver never sees their own request; decisions bind to a proposal version
- Faculty views contain no costs, no worker numbers, no internal notes
- Status is encoded by fill weight in grayscale — never by colour alone; text always beside it

## Scripts

```bash
npm run dev      # local dev
npm run build    # tsc -b && vite build -> dist/
npm run preview  # serve the production build
```

QA: see `docs/UI-TEST-CASES.md` (T01–T20, mapped to acceptance tests A01–A12).
