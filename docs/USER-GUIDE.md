# User guide

Open PCMS on the campus Wi-Fi at the address Team OSSC gives you, for example `https://pcms.dbit.edu.in`.
On a phone, tap **Install app** (Android) or **Share, then Add to Home Screen** (iPhone) to use it like an app.
Allow notifications when asked so you hear about updates.

**First sign-in.** Use your college email and the temporary password from Team OSSC, then choose your
own password (at least 10 characters). If you forget it, ask Team OSSC to reset it; PCMS does not email
password links. Super admins also scan a QR code with Google or Microsoft Authenticator.

## Faculty

1. **Report**: choose what needs fixing and which part. If you choose **Other**, say what it is.
   Then choose the building, floor (Ground to Terrace) and room, write a short title, pick the severity
   (**Red** urgent, **Orange** soon, **Green** routine), and add up to 3 photos or 1 short video.
   Cafeteria, Canteen and Parking are in the building list too.
2. Tap **Submit report**. You get a token such as `C26-0001`. Keep it.
3. **My requests** shows the progress of each request. Long lists are split into pages,
   and the counter tells you how many you have.
4. When the facilities team completes the work, inspect it and tap **Confirm completion**, or
   **Issue not resolved** and describe what remains.
5. After you confirm completion, the request is closed. Rate the service once with 1 to 5 stars and an
   optional comment. The rating is about the service, not an individual person.

Choose **English**, **ಕನ್ನಡ** or **हिन्दी** from the **Language** menu: in the sidebar, at the top of the
screen on a phone, or on the sign-in page. The choice is remembered on your device.

For a dangerous electrical fault, fire or flooding, call the campus emergency number first.

## Facility manager

1. **Queue** lists open tickets. "Needs action" shows new reports, fixes to confirm and approved critical
   work that is ready to finish. Search by title, token or room, and narrow by severity, building, type,
   who reported it (name or email), the reporter's role, or a From and To date.
   Sort by **Severity** to see red reports first.
   Every filter and all paging are done by the server, so the list is never quietly cut short.
2. Open a ticket and follow the highlighted step:
   - **Step 1, review this request.** Check the reporter's red, orange or green severity and tap **Accept**, or **Reject** and write the reason. The reporter sees the reason.
   - **Step 2, assign the work.** Contact the worker yourself by phone, WhatsApp or in person.
     PCMS sends no messages to workers. Record an optional worker or vendor name and tap **Mark as assigned**.
     For a postponed ticket the button is **Resume work**.
   - After assignment, the worker line has **Change** or **Add worker name** so you can update or
     clear the name later. Only staff see it.
   - If the worker starts later, tap **Mark work as started**. This is optional.
   - Record the **work requirements** if useful: one person, more people, parts or money up front.
     This helps the approvers decide. It is internal, so the reporter never sees it.
   - **Step 3, choose the next action:**
     - **I Immediate**: complete it now. Describe the work carried out and tap **Mark as complete**.
     - **C Critical**: give the reason (and a cost estimate if known) and tap **Send for approval**.
       It goes to the principal.
     - **P Postpone**: give the reason and the date to review it again.
   - The reporter is then asked to confirm completion. Once closed, they can rate the service.
3. **More actions** has change type, duplicate, cancel and reopen.
   **Photos and video** and **Documents** (PDF or Word, up to 10 MB each) show who added each file.
   Documents are seen by staff only.
   **Staff messages** are shared by the facility manager, management, the principal and Team OSSC.
   The reporter never sees them.
4. "Messages need you" in the queue lists old worker messages that failed before dispatch was
   retired. Call the worker if needed, then mark it handled.
5. **Reports** shows the period you choose with **From** and **To** dates: new, overdue, awaiting approval,
   repeat faults by place and type, how long review and completion take, and service ratings.
   **Download** gives the ticket list as CSV, an Excel workbook or a PDF report for the same period.
   Every download is recorded in the audit log.

Every staff member can also **Report an issue** and follow it under **My requests**.

## Principal

**Approvals** lists tickets the facility manager marked **Critical**. They come to you first. Read the reason (and
the estimate, if any), then choose **Approve** (with the approved limit), **Reject** (with the reason), or
**Escalate to institute management** (with the reason) when a higher authority must decide.
After approval the ticket returns to the facility manager, with **Step 4: Complete the approved work** open.
You can view every ticket, write staff messages, add photos and documents, and see **Reports**, including
**Expenditure** (see below). You do not accept or assign work.

## Institute management

**Approvals** lists the requests the principal escalated, marked **With institute management**. Choose
**Approve**, **Request clarification**, **Defer** (with a review date) or **Reject**. Your decision is final.
You can also write staff messages, add photos and documents, and see **Reports** and **Expenditure**.

**Expenditure** (principal, institute management and Team OSSC only) is on the **Reports** page. For the
From and To dates it shows the amount requested, approved and awaiting a decision in INR, every request
with its status and who decided it, and a breakdown by category. **Download** adds **Expenditure CSV** and
**Expenditure Excel workbook**. The facility manager does not see spending figures.

Nobody, including Team OSSC, can approve a request they submitted or a ticket they reported.

## Super admin (Team OSSC)

- **Admin, then People**: **Import file** accepts `.xlsx` or `.csv` with columns `email, name, role, password`.
  Preview first, then download the credentials workbook, hand each password over in person, and delete the
  file afterwards. **Add person** creates one account; **Credentials file** downloads every temporary password
  that is still valid (it asks for your own password and is audited). **Reset** issues a new temporary password
  (and can reset a lost authenticator). Once a person chooses their own password, it cannot be downloaded.
  **Suspend** blocks access at once.
- **Types** and **Places**: add new types (each with an unused token letter) and buildings with their floors.
  **Edit** renames one or changes its parts or floors. **Retire** hides it from the report form without touching
  any existing ticket; **Restore** brings it back. Token letters are never reused, even from a retired type.
- **Audit log** lists every recorded change, newest first, filterable by action and entity.
  It is append-only in the database, so this screen can only read it.
- The super admin can also do everything the other roles can.
