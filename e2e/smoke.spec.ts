import { expect, test, type Page } from '@playwright/test'

const PASSWORD = process.env.SMOKE_PASSWORD ?? 'Smoke-Test-Pass-91'

async function pngFromCanvas(page: Page): Promise<Buffer> {
  const url = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 320
    c.height = 240
    const g = c.getContext('2d')!
    g.fillStyle = '#c0392b'
    g.fillRect(0, 0, 320, 240)
    return c.toDataURL('image/png')
  })
  return Buffer.from(url.split(',')[1], 'base64')
}

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('College email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

async function signOut(page: Page) {
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByLabel('College email')).toBeVisible()
}

/** A photo uses loading="lazy", so on a phone it loads only after scrolling. */
async function expectPhotoLoaded(page: Page, name: string) {
  const img = page.locator(`img[alt="${name}"]`).first()
  await expect(img).toBeVisible()
  await img.scrollIntoViewIfNeeded()
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
  return img
}

test('faculty reports a problem with Other and a photo; manager sees it with the image', async ({ page }, info) => {
  const shot = (name: string) => page.screenshot({ path: `out/${info.project.name}-${name}.png`, fullPage: true })

  await signIn(page, 'smoke-faculty@dbit.edu')
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()
  await shot('1-home')

  await page.goto('/report')
  await page.getByRole('radio', { name: 'Civil' }).click()
  await page.getByLabel('Specific issue').selectOption('Other Civil Issue')
  await expect(page.getByLabel('Describe the item')).toBeVisible()
  await page.getByLabel('Describe the item').fill('Bench')
  await page.getByLabel('Building').selectOption('BLOCK_A')
  await page.getByLabel('Department / Area').selectOption('Computer Science and Engineering (CSE)')
  await page.getByLabel('Floor').selectOption('2')
  await page.getByLabel('Room or area').fill('203')
  await page.getByLabel('Short title').fill('Broken bench near the window')
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'bench.png', mimeType: 'image/png', buffer: await pngFromCanvas(page) })
  await expect(page.getByText('Ready')).toBeVisible()
  await shot('2-report')
  await page.getByRole('button', { name: 'Submit report' }).click()

  const token = page.getByTestId('receipt-token')
  await expect(token).toHaveText(/^V\d{2}-\d{4,}$/)
  const tokenText = (await token.textContent())!.trim()
  await shot('3-receipt')

  await page.getByRole('link', { name: 'View request' }).click()
  await expect(page.getByText('Other Civil Issue: Bench')).toBeVisible()
  await expectPhotoLoaded(page, 'bench.jpg')
  await shot('4-ticket-faculty')
  await signOut(page)

  // Facility manager: password only (no authenticator), sees the ticket and the photo.
  await signIn(page, 'smoke-manager@dbit.edu')
  await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible()
  await page.getByRole('link', { name: new RegExp(tokenText) }).first().click()
  await expect(page.getByText('Step 1: Review this request')).toBeVisible()
  const img = await expectPhotoLoaded(page, 'bench.jpg')
  await img.click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(page.getByText('Step 2: Assign the work')).toBeVisible()
  await page.getByRole('button', { name: 'Mark as assigned' }).click()
  await page.getByRole('button', { name: 'Mark work as started' }).click()
  await expect(page.getByText('Step 3: Record the work')).toBeVisible()
  // No up-front choice: with neither Critical nor Postpone ticked, the work is Immediate.
  await expect(page.getByRole('checkbox', { name: /^Critical/ })).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: /^Postpone/ })).not.toBeChecked()
  await page.getByLabel('Work carried out').fill('Replaced the cracked frame')
  await page.getByLabel('Actual cost (Rs)').fill('450')
  await page.getByRole('button', { name: 'Mark as complete' }).click()
  await expect(page.getByText('Awaiting confirmation from the reporter')).toBeVisible()
  await expect(page.getByText('Actual cost ₹450.00')).toBeVisible()
  await shot('5-staff-ticket')
  await signOut(page)

  // Back as the reporter: verify the fix and rate the repair.
  await signIn(page, 'smoke-faculty@dbit.edu')
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()
  await page.goto('/tickets')
  await page.getByRole('link', { name: new RegExp(tokenText) }).first().click()
  await expect(page.getByText('Smoke Carpenter')).toHaveCount(0)
  await page.getByRole('button', { name: 'Confirm completion' }).click()
  await expect(page.getByText('Rate the service')).toBeVisible()
  await page.getByRole('radio', { name: '5 stars' }).click()
  await page.getByLabel('Additional comments (optional)').fill('Quick work, thank you')
  await page.getByRole('button', { name: 'Submit rating' }).click()
  await expect(page.getByText('Your rating')).toBeVisible()
  await expect(page.getByText('Quick work, thank you')).toBeVisible()
  await shot('6-faculty-rating')
  await signOut(page)
})

test('approved critical cost can be finished after the facility manager reloads', async ({ page }) => {
  const title = `Approved cost check ${Date.now()}`

  // Faculty reports the problem.
  await signIn(page, 'smoke-faculty@dbit.edu')
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()
  await page.goto('/report')
  await page.getByRole('radio', { name: 'Civil' }).click()
  await page.getByLabel('Specific issue').selectOption('Other Civil Issue')
  await page.getByLabel('Describe the item').fill('Desk')
  await page.getByLabel('Building').selectOption('BLOCK_A')
  await page.getByLabel('Department / Area').selectOption('Computer Science and Engineering (CSE)')
  await page.getByLabel('Floor').selectOption('2')
  await page.getByLabel('Room or area').fill('204')
  await page.getByLabel('Short title').fill(title)
  await page.getByRole('button', { name: 'Submit report' }).click()
  const token = page.getByTestId('receipt-token')
  await expect(token).toHaveText(/^V\d{2}-\d{4,}$/)
  const tokenText = (await token.textContent())!.trim()
  await signOut(page)

  // Facility manager assigns a worker and sends the cost for approval.
  await signIn(page, 'smoke-manager@dbit.edu')
  await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible()
  await page.getByRole('link', { name: new RegExp(tokenText) }).first().click()
  await page.getByRole('button', { name: 'Accept', exact: true }).click()
  await page.getByRole('button', { name: 'Mark as assigned' }).click()
  await page.getByRole('button', { name: 'Mark work as started' }).click()
  await expect(page.getByText('Step 3: Record the work')).toBeVisible()
  await page.getByRole('checkbox', { name: /^Critical/ }).check()
  await expect(page.getByRole('checkbox', { name: /^Critical/ })).toBeChecked()
  await page.getByLabel('Reason for marking critical').fill('The desk frame is broken and needs a new part.')
  await page.getByLabel('Estimated cost (Rs)').fill('1250')
  await page.getByRole('button', { name: 'Send for approval' }).click()
  await expect(page.getByText("Awaiting the principal's decision")).toBeVisible()
  await signOut(page)

  // A critical ticket goes to the principal first, who approves the estimate.
  await signIn(page, 'smoke-principal@dbit.edu')
  await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible()
  await page.goto('/staff/approvals')
  await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible()
  await page.getByRole('link', { name: new RegExp(tokenText) }).first().click()
  await expect(page.getByRole('heading', { name: /Expenditure request/ })).toBeVisible()
  await page.getByRole('button', { name: 'Record decision' }).click()
  await expect(page.getByText('Approved by Smoke Principal')).toBeVisible()
  await signOut(page)

  // Back as the facility manager: the approved ticket is in Needs action and
  // can be marked complete immediately, without choosing the flag again.
  await signIn(page, 'smoke-manager@dbit.edu')
  await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible()
  await page.getByRole('link', { name: new RegExp(tokenText) }).first().click()
  await expect(page.getByText('Step 4: Complete the approved work')).toBeVisible()
  await expect(page.getByText('Expenditure approved').first()).toBeVisible()
  // The approval is final: no Critical or Postpone any more, only Mark as complete.
  await expect(page.getByRole('checkbox', { name: /^Critical/ })).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: /^Postpone/ })).toHaveCount(0)
  await page.getByLabel('Work carried out').fill('Replaced the broken desk frame')
  await page.getByRole('button', { name: 'Mark as complete' }).click()
  await expect(page.getByText('Awaiting confirmation from the reporter')).toBeVisible()
  await signOut(page)
})

test('a problem the principal reports goes through the facility manager, and management decides its cost', async ({ page }) => {
  const title = `Principal office fan ${Date.now()}`

  await signIn(page, 'smoke-principal@dbit.edu')
  await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible()
  await page.goto('/report')
  await page.getByRole('radio', { name: 'Mechanical / Electrical' }).click()
  await page.getByLabel('Specific issue').selectOption('Fan / Light / Electrical')
  await page.getByLabel('Building').selectOption('ADMIN_BLOCK')
  await page.getByLabel('Department / Area').selectOption("Dean's Room")
  await page.getByLabel('Floor').selectOption({ index: 1 })
  await page.getByLabel('Room or area').fill('Dean office')
  await page.getByLabel('Short title').fill(title)
  await page.getByRole('button', { name: 'Submit report' }).click()
  const token = page.getByTestId('receipt-token')
  await expect(token).toHaveText(/^M\d{2}-\d{4,}$/)
  const tokenText = (await token.textContent())!.trim()
  await signOut(page)

  // Same flow as any report: the facility manager accepts, assigns and marks it critical.
  await signIn(page, 'smoke-manager@dbit.edu')
  await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible()
  await page.getByRole('link', { name: new RegExp(tokenText) }).first().click()
  await expect(page.getByText('Step 1: Review this request')).toBeVisible()
  await page.getByRole('button', { name: 'Accept', exact: true }).click()
  await page.getByRole('button', { name: 'Mark as assigned' }).click()
  await page.getByRole('checkbox', { name: /^Critical/ }).check()
  await page.getByLabel('Reason for marking critical').fill('The fan motor has burnt out and needs replacing.')
  await page.getByLabel('Estimated cost (Rs)').fill('3200')
  await page.getByRole('button', { name: 'Send for approval' }).click()
  // The principal reported it, so institute management decides.
  await expect(page.getByText('Awaiting a decision from institute management')).toBeVisible()
  await signOut(page)

  await signIn(page, 'smoke-management@dbit.edu')
  await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible()
  await page.goto('/staff/approvals')
  await page.getByRole('link', { name: new RegExp(tokenText) }).first().click()
  await page.getByRole('button', { name: 'Record decision' }).click()
  await expect(page.getByText('Approved by Smoke Management')).toBeVisible()

  // Department-wise spending: the first test recorded Rs 450 on a CSE repair.
  await page.goto('/staff/reports')
  const spend = page.getByRole('region', { name: 'Actual spending by department' })
  await expect(spend).toBeVisible()
  await expect(spend.getByText('Computer Science and Engineering (CSE)').first()).toBeVisible()
  await spend.getByRole('button', { name: 'Requested' }).click()
  await expect(spend.getByRole('button', { name: 'Requested' })).toHaveAttribute('aria-pressed', 'true')
  await expect(spend.getByText("Dean's Room").first()).toBeVisible()
  await signOut(page)
})

test('faculty edits a submitted report before work starts', async ({ page }) => {
  const title = `Noisy fan ${Date.now()}`
  const updated = `${title} updated`

  await signIn(page, 'smoke-faculty@dbit.edu')
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()
  await page.goto('/report')
  await page.getByRole('radio', { name: 'Mechanical' }).click()
  await page.getByLabel('Specific issue').selectOption('Fan / Light / Electrical')
  await page.getByLabel('Building').selectOption('BLOCK_B')
  await page.getByLabel('Department / Area').selectOption('Artificial Intelligence and Machine Learning (AI/ML)')
  await page.getByLabel('Floor').selectOption('1')
  await page.getByLabel('Room or area').fill('101')
  await page.getByLabel('Short title').fill(title)
  await page.getByRole('button', { name: 'Submit report' }).click()

  const token = page.getByTestId('receipt-token')
  await expect(token).toHaveText(/^M\d{2}-\d{4,}$/)
  await page.getByRole('link', { name: 'View request' }).click()
  await page.getByRole('link', { name: 'Edit report' }).click()

  await expect(page.getByRole('heading', { name: 'Edit report' })).toBeVisible()
  await expect(page.getByLabel('Short title')).toHaveValue(title)
  await page.getByLabel('Short title').fill(updated)
  await page.getByRole('button', { name: 'Save changes' }).click()

  await expect(page.getByText(updated).first()).toBeVisible()
  await expect(page.getByText('Ticket details updated by the reporter').first()).toBeVisible()
})

test('landing page names DBIT and the club', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByText('Maintained and regulated by the Open Source Student Club, DBIT.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Don Bosco Institute of Technology, Bengaluru' })).toBeVisible()
})

test('PWA manifest and icons are installable', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest')
  expect(res.ok()).toBeTruthy()
  const m = await res.json()
  expect(m.display).toBe('standalone')
  expect(m.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
  expect((await request.get('/sw.js')).ok()).toBeTruthy()
})
