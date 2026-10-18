# PCMS frontend — UI test cases

Twenty failure-oriented cases the frontend must pass before any release. IDs map to the
implementation plan's acceptance tests (A01–A12). Run on a real low-cost Android (Chrome)
and an iPhone (Safari, added to home screen), plus desktop.

| # | Area | Case | Expected |
|---|------|------|----------|
| T01 | Identity | Sign in with unknown employee ID or short password | Inline error, no stack trace, form values kept, never reveals whether the ID exists beyond "incorrect" |
| T02 | Identity | Suspended/expired session mid-form | Redirect to sign-in; after re-login the draft is still there and submission requires a deliberate resume |
| T03 | Permissions | Faculty opens `/admin` directly by URL | Redirected to faculty home; API-level role check is the real gate (UI is only signposting) |
| T04 | Permissions | Facility manager views an `AwaitingApproval` ticket | No decision controls rendered; management sees decision controls and no dispatch controls |
| T05 | Core journey | Raise carpentry ticket with photo on a phone | Server token shown only after commit; token stable across refresh; receipt printable |
| T06 | Core journey | Submit twice rapidly / refresh after submit | Exactly one ticket — client request key replays the original receipt, never a second token |
| T07 | Offline | Airplane mode at review step, press Send | Clear "network needed" message; draft kept and visibly labelled "not submitted"; Retry works after reconnect |
| T08 | Offline | Kill app mid-form, reopen | Draft restored from device storage; empty state invites action, never implies the ticket exists |
| T09 | Media | Deny camera permission | File picker and text-only submission still work; nothing blocked; camera stream stops after capture |
| T10 | Media | Attach 6 MB photo / unsupported format | Rejected at selection with size/format guidance; ticket text survives; failed evidence never blocks the ticket |
| T11 | Media | Interrupted upload after ticket commit | Ticket keeps its token; evidence shows failed state with Retry; no duplicate ticket created |
| T12 | Concurrency | Two managers triage the same ticket | Second write surfaces a stale-version conflict and refreshes state; nothing silently overwritten |
| T13 | Duplicates | Same room + category already open | Suggestion card with canonical token before submit; continuing is allowed; duplicate marking keeps reporter's receipt live |
| T14 | Lifecycle | Invalid transition (e.g. close from Submitted) | Action simply not offered; direct attempt fails with a plain-language reason |
| T15 | Lifecycle | Verify / dispute a Resolved ticket | Verify closes with audit; dispute reopens to triage with mandatory reason, history preserved |
| T16 | Spending | Approve with ceiling, then larger cost | UI demands a new proposal version; requester never sees their own request as approvable |
| T17 | Spending | Amounts | All money rendered from integer paise; ₹1,23,456.78 Indian grouping; no float artifacts like .30000000004 |
| T18 | Privacy | Faculty views ticket detail and worker screens | No worker phone numbers, no internal notes, no costs anywhere in faculty payloads or UI |
| T19 | Compatibility | Keyboard-only pass; focus rings; 200 % zoom; screen-reader labels on icon buttons | All interactive elements reachable and named; touch targets ≥ 44 px; contrast AA in both themes |
| T20 | Feel | Swipe from left edge on any detail page; back button; theme + language toggle | Swipe-back navigates; no white flash between themes (inline boot script); state persists after reload; no jank on mid-range Android (transform/opacity animations only, `prefers-reduced-motion` respected) |

## Definition of "done" per screen (from the plan)

Permission-aware, validates at the field level without clearing input, useful failure
messages that say what to do next, audit-visible actions, and passes T01–T20 above.
