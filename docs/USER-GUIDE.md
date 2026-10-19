# User guide

Open PCMS on the campus Wi-Fi at the address Team OSSC gives you, for example `https://pcms.dbit.edu.in`.
On a phone, tap **Install app** (Android) or **Share, then Add to Home Screen** (iPhone) to use it like an app.
Allow notifications when asked so you hear about updates.

**First sign-in.** Use your employee ID and the temporary password from Team OSSC, then choose your
own password (at least 10 characters). Super admins also scan a QR code with Google or Microsoft Authenticator.

## Faculty

1. **Report**: choose what needs fixing and which part. If you choose **Other**, say what it is.
   Then choose the building, floor and room, write a short title, say how serious it is, and add up to 3 photos or 1 short video.
2. Tap **Send report**. You get a token such as `C26-0001`. Keep it.
3. **My tickets** shows progress and messages from facilities. Long lists are split into pages,
   and the counter tells you how many you have.
4. When facilities say it is fixed, check it and tap **Yes, it is fixed**, or **No, still broken** and say why.

For a dangerous electrical fault, fire or flooding, call the campus emergency number first.

## Facility manager

1. **Queue** lists open tickets. "Needs action" shows new reports, jobs waiting for a worker, and fixes to confirm.
   Search by title, token or room, and narrow by priority, building, type, flag or worker.
   Every filter and all paging are done by the server, so the list is never quietly cut short.
2. Open a ticket and follow the highlighted step:
   - **Step 1, accept or reject.** Choose a priority (P1 to P4) and tap **Accept**, or **Reject** and write the reason. The reporter sees the reason.
   - **Step 2, assign a worker.** Tick the worker and choose SMS or WhatsApp. The job (token, problem, place) is sent to them automatically.
     If they confirm by phone, tap **Worker confirmed**.
   - Record an **Assessment** if useful: whether it needs one person, more people, parts or money up front.
     This helps management decide. The note is internal, so the reporter never sees it.
   - **Step 3, what did the worker find?** Choose one:
     - **I Immediate**: fix it now. When done, write what was done and tap **Mark as fixed**.
     - **C Critical**: write why it is critical (and a cost estimate if known) and tap **Send to management**.
     - **P Postpone**: write why and the date to look again.
   - The reporter is then asked to confirm the fix.
3. **More actions** has change priority, change type, duplicate, cancel and reopen.
4. **Workers**: **Add worker** (name, mobile, work). Or **From phone contacts**
   (Chrome on Android) or **Import file** (a .vcf contacts export, or a CSV with name and phone), then choose each person's work.
   **Edit** changes a worker's name, work, area, language or number; leave the number blank to keep it.
   Lists only ever show a masked number, per the privacy rule.
5. "Messages need you" in the queue lists SMS or WhatsApp jobs that failed. Call the worker, then mark it handled.
6. **Reports** shows how the last 7 to 365 days looked: new, overdue, waiting for approval, repeat faults by
   place and type, how long triage and fixing take, and approved spend. **Export CSV** downloads the ticket list
   for the same window; the download is recorded in the audit log.

## Institute management

**Approvals** lists tickets the facility manager marked **Critical**. Open one, read why it is critical (and the
estimate, if any), then choose **Approve** (optionally with an amount ceiling), **Ask a question**, **Defer** (with a
review date) or **Reject** (with the next step). You cannot approve something you sent yourself.

## Super admin (Team OSSC)

- **Admin, then People**: **Import CSV** (columns `employee_id, name, role, email`). Preview first, then
  download the file with temporary passwords, hand each password over in person, and delete the file afterwards.
  **Add person** creates one account. **Reset** issues a new temporary password (and can reset a lost authenticator).
  **Suspend** blocks access at once.
- **Types** and **Places**: add new types (each with an unused token letter) and buildings with their floors.
  **Edit** renames one or changes its parts or floors. **Retire** hides it from the report form without touching
  any existing ticket; **Restore** brings it back. Token letters are never reused, even from a retired type.
- **Audit log** lists every recorded change, newest first, filterable by action and entity.
  It is append-only in the database, so this screen can only read it.
- The super admin can also do everything the other roles can.
