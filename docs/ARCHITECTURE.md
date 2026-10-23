# Architecture

## Components

```mermaid
flowchart TB
    subgraph Campus["Campus network / VPN"]
        U["Phones and desktops<br/>(PWA in the browser)"]
    end
    subgraph Host["College server (Docker Compose)"]
        N["nginx<br/>:443 app + API<br/>:8081 tunnel-only"]
        A["api<br/>FastAPI, 4 workers"]
        W["worker<br/>sends outbox"]
        S["scheduler<br/>reminders, scans"]
        DB[("PostgreSQL 17")]
        MV[("media volume<br/>private")]
        C["ClamAV"]
        B["backup<br/>nightly, encrypted"]
        T["cloudflared tunnel"]
    end
    subgraph Internet
        TW["Twilio<br/>WhatsApp + SMS"]
        PS["Browser push services"]
        SM["College SMTP relay"]
    end
    U -- HTTPS --> N
    N --> A
    A --> DB
    A --> MV
    W --> DB
    S --> DB
    S --> C
    C --- MV
    W --> TW
    W --> PS
    W --> SM
    TW -- "signed webhooks,<br/>photo fetch" --> T --> N
    B --> DB
    B --- MV
```

- The API, database, ClamAV and jobs sit on an internal Docker network with no internet route.
  Only `worker`, `clamav` (signature updates) and `tunnel` have egress.
- The tunnel reaches nginx's port 8081 only. That listener serves exactly
  `POST /webhooks/twilio`, `POST /webhooks/twilio/status` and `GET /media/public/<signed token>`.
  Everything else there is 404.
- Provider calls never happen inside a database transaction. A ticket change and its
  notification intent (outbox row) commit together; the worker sends afterwards.

## Data model (main tables)

```mermaid
erDiagram
    APP_USER ||--o{ TICKET : reports
    CATEGORY ||--o{ TICKET : classifies
    BUILDING ||--o{ TICKET : locates
    TICKET ||--o{ TICKET_EVENT : "history (append-only)"
    TICKET ||--o{ TICKET_COMMENT : "messages (append-only)"
    TICKET ||--o{ ATTACHMENT : evidence
    TICKET ||--o| TICKET_RATING : "reporter rating"
    TICKET ||--o{ ASSIGNMENT : "legacy dispatch"
    WORKER ||--o{ ASSIGNMENT : "legacy dispatch"
    WORKER ||--o{ WORKER_SKILL : "legacy skills"
    TICKET ||--o{ PROPOSAL : "cost versions"
    PROPOSAL ||--o| DECISION : "one decision"
    TICKET ||--o{ OUTBOX : notifications
    OUTBOX ||--o{ DELIVERY_ATTEMPT : tries
    APP_USER ||--o{ PUSH_SUBSCRIPTION : devices
    APP_USER ||--o{ USER_SESSION : sessions
    CATEGORY ||--o{ TOKEN_COUNTER : "serial per year"
```

Rules the database enforces: valid statuses and roles, one active lead per ticket, one pending
proposal per ticket, one decision per proposal version, one rating per ticket, non-negative money
in integer paise, unique tokens and phone numbers. Timeline, comments, decisions, delivery
attempts and the audit log cannot be updated or deleted (trigger). The `worker`, `worker_skill`
and `assignment` tables remain for history; the normal flow writes no new rows to them.

## Tokens

`<type letter><2-digit year>-<serial>`, for example `C26-0001` is the first Carpentry ticket of 2026.
The serial comes from a counter row locked inside the create transaction, per type and per
Asia/Kolkata year, so 100 parallel submissions still get 100 unique, consecutive tokens. A ticket
keeps its token if its type changes later. Letters are never reused.

| Letter | Type | Letter | Type |
|---|---|---|---|
| C | Carpentry | F | Flooring |
| P | Plumbing | W | Toilets (washrooms) |
| I | Internet | E | Electrical |
| T | Phone | O | Other |
| R | Projector | | |

## Ticket lifecycle

This is the flow DBIT confirmed on 18 October 2026.

```mermaid
flowchart TD
    A[Faculty submits problem<br/>type, part, place, photos] --> B{Facility manager<br/>reviews}
    B -->|Reject with reason| R[Rejected<br/>reporter told why]
    B -->|Accept + priority| C[Contact worker directly<br/>record optional name, mark Assigned]
    C --> D[Worker looks at it]
    D --> E{Flag}
    E -->|I Immediate| F[Fix, then mark as fixed]
    E -->|C Critical| G[Sent to institute management<br/>reason + optional cost]
    E -->|P Postpone| H[On hold<br/>reason + review date]
    G -->|Approve| F
    G -->|Question / defer / reject| H
    H -->|Resume| C
    F --> I{Reporter checks}
    I -->|Yes, fixed| J[Closed<br/>reporter may rate once]
    I -->|Still broken, within 7 days| B
```

Status names used by the API:

```mermaid
stateDiagram-v2
    [*] --> Submitted : faculty reports
    Submitted --> Triaged : accept (priority)
    Submitted --> Rejected : reject (reason)
    Submitted --> Duplicate
    Triaged --> Assigned : manager records the worker (optional name)
    Assigned --> InProgress : manager marks work started
    Assigned --> Resolved : I, fixed
    InProgress --> Resolved : I, fixed
    Assigned --> AwaitingApproval : C, sent to management
    InProgress --> AwaitingApproval : C, sent to management
    AwaitingApproval --> InProgress : approved
    AwaitingApproval --> OnHold : question / defer / reject
    Assigned --> OnHold : P, postponed
    InProgress --> OnHold : P, postponed
    OnHold --> Assigned : resume
    Resolved --> Closed : reporter confirms
    Resolved --> Triaged : reporter disputes (7 days)
    Resolved --> Closed : manager closes after 5 days without answer
    Closed --> Triaged : manager reopens
    Triaged --> Cancelled
    Closed --> [*]
    note right of Closed : one immutable rating (1-5 stars)
```

**Future scope.** Letting workers record progress themselves, for example by SMS reply or a very
simple form. For now the facility manager records it, because many workers do not use apps.

Every action carries the ticket version the person saw; a stale version gets `409` and the screen reloads.

An **assessment** can be recorded while work is assigned or in progress. It says what the job
needs (one person, more people, parts, money up front) and how it was reported, and lands in
the timeline as an internal entry, so it never reaches the reporter.

## Ratings

After the reporter confirms the fix, the ticket is `Closed` and the reporter may submit one
rating: 1-5 stars and an optional comment of up to 1000 characters. There is no edit or delete
endpoint. The unique ticket id is the concurrency guard, so a second rating returns `409
already_rated`. Staff see the rating on the ticket; the public timeline records only the star
count. A 1 or 2 star rating queues a facility-manager notification through the outbox. Reports
show the count, average, 5-to-1 distribution and the ten newest low ratings.

## Listing, search and paging

`GET /tickets` is the one list endpoint. It takes `scope` (`mine` or `queue`), `status`, `open`,
`search`, `category`, `flag`, `priority`, `building`, `worker`, `sort`, `page` and `pageSize`,
and returns `{items, total, page, pageSize}`. The `worker` filter matches the optional free-text
worker or vendor name and is available only on the staff queue.

Every filter is applied in SQL, never in the browser. The client used to fetch a fixed 100 rows
and filter them locally, which silently hid older tickets; it now sends the filters and renders
the server's `total`. `sort` is one of `newest`, `oldest`, `priority` or `updated`, and each
order has an `id` tiebreaker so paging stays stable when timestamps collide.

Search matches title, token and room with `ILIKE`. Wildcards `%` and `_` in the query are
escaped, so a search for `100%` looks for that text instead of matching everything.
Out-of-range values for `priority`, `flag` and `sort` are rejected rather than ignored.

`GET /catalogs` returns active types and places only, so a retired one cannot be picked on a new
report. `GET /catalogs?includeInactive=true` is for the administration screens, which need to
show a retired row so it can be restored. Old tickets render either way, because the frontend
falls back to a placeholder for an unknown code.

## Sign-in

```mermaid
sequenceDiagram
    participant B as Browser
    participant A as API
    B->>A: POST /session (college email, password)
    A-->>B: HttpOnly session cookie + CSRF token, next step
    alt temporary password (first sign-in or reset)
        B->>A: POST /session/password
    end
    alt super admin
        B->>A: POST /session/totp (enrol once, then a code each time)
    end
    A-->>B: next = done
    B->>A: every change sends X-CSRF-Token
```

## Worker contact and legacy dispatch

Facility managers contact workers directly and then record the state on the ticket. The name of
the worker, vendor or team is optional free text, is stored on the ticket, and is shown only to
staff. PCMS has no worker directory, worker login, phone number field or automatic job message.
The manager marks the ticket `Assigned`, may mark work started, and records the I/C/P flag.

Twilio webhooks and the worker-delivery branches in the outbox remain for messages that were
already sent before this change. Their status updates and Accept taps still work, and their
templates still exist. No new worker message is queued. A later cleanup release can remove the
provider settings and the legacy tables once those messages are drained.

Retries happen at 1, 5, 15 and 60 minutes, then the message goes to "messages need you" in the queue.
Notifications for reassigned or finished jobs expire instead of being sent.

## Notifications to people

- Web push (VAPID) to every device a person enabled. The subscription is saved again on every app
  open, and dead subscriptions are removed when the push service reports them gone. Payloads hold
  only a title, a short line and an in-app link.
- Email through the college relay, for people with an email address.
