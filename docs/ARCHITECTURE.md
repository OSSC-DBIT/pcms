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
        S["scheduler<br/>fallbacks, reminders, scans"]
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
    TICKET ||--o{ ASSIGNMENT : dispatch
    WORKER ||--o{ ASSIGNMENT : receives
    WORKER ||--o{ WORKER_SKILL : has
    TICKET ||--o{ PROPOSAL : "cost versions"
    PROPOSAL ||--o| DECISION : "one decision"
    TICKET ||--o{ OUTBOX : notifications
    OUTBOX ||--o{ DELIVERY_ATTEMPT : tries
    APP_USER ||--o{ PUSH_SUBSCRIPTION : devices
    APP_USER ||--o{ USER_SESSION : sessions
    CATEGORY ||--o{ TOKEN_COUNTER : "serial per year"
```

Rules the database enforces: valid statuses and roles, one active lead per ticket, one pending
proposal per ticket, one decision per proposal version, non-negative money in integer paise,
unique tokens and phone numbers. Timeline, comments, decisions, delivery attempts and the
audit log cannot be updated or deleted (trigger).

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
    B -->|Accept + priority| C[Assign worker]
    C -->|automatic SMS / WhatsApp| D[Worker looks at it]
    D --> E{Flag}
    E -->|I Immediate| F[Fix, then mark as fixed]
    E -->|C Critical| G[Sent to institute management<br/>reason + optional cost]
    E -->|P Postpone| H[On hold<br/>reason + review date]
    G -->|Approve| F
    G -->|Question / defer / reject| H
    H -->|Resume| C
    F --> I{Reporter checks}
    I -->|Yes, fixed| J[Closed]
    I -->|Still broken, within 7 days| B
```

Status names used by the API:

```mermaid
stateDiagram-v2
    [*] --> Submitted : faculty reports
    Submitted --> Triaged : accept (priority)
    Submitted --> Rejected : reject (reason)
    Submitted --> Duplicate
    Triaged --> Assigned : worker assigned, SMS sent
    Assigned --> InProgress : worker confirmed (button or call)
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
```

**Future scope.** The worker giving the reason for Critical or Postpone directly (SMS reply,
voice or a very simple form). For now the facility manager records it, because many workers do
not use apps.

Every action carries the ticket version the person saw; a stale version gets `409` and the screen reloads.

## Sign-in

```mermaid
sequenceDiagram
    participant B as Browser
    participant A as API
    B->>A: POST /session (employee ID, password)
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

## Dispatch and fallback

```mermaid
sequenceDiagram
    participant M as Manager
    participant A as API + DB
    participant W as Worker process
    participant T as Twilio
    participant K as Worker phone
    M->>A: assign (WhatsApp)
    A->>A: assignment + outbox row (one transaction)
    W->>A: claim job (SKIP LOCKED)
    W->>T: template with photo link (signed, 10 min)
    T->>K: WhatsApp job [Accept] [Done] [Need help]
    T-->>A: status: delivered / read (never counts as acceptance)
    K->>T: taps Accept
    T->>A: signed webhook, matched to the message and the worker's number
    A->>A: ticket InProgress
    Note over A: No Accept in 30 min: SMS fallback, and managers are alerted to call
```

Retries happen at 1, 5, 15 and 60 minutes, then the message goes to "messages need you" in the queue.
Notifications for reassigned or finished jobs expire instead of being sent.

## Notifications to people

- Web push (VAPID) to every device a person enabled. The subscription is saved again on every app
  open, and dead subscriptions are removed when the push service reports them gone. Payloads hold
  only a title, a short line and an in-app link.
- Email through the college relay, for people with an email address.
