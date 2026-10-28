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
  await expect(page.getByRole('heading', { name: /Hello/ })).toBeVisible()
  await shot('1-home')

  await page.goto('/report')
  await page.getByRole('radio', { name: 'Civil' }).click()
  await page.getByLabel('Which part?').selectOption('Other Civil Issue')
  await expect(page.getByLabel('What is it?')).toBeVisible()
  await page.getByLabel('What is it?').fill('Bench')
  await page.getByLabel('Building').selectOption('BLOCK_A')
  await page.getByLabel('Floor').selectOption('2')
  await page.getByLabel('Room or area').fill('203')
  await page.getByLabel('Short title').fill('Broken bench near the window')
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'bench.png', mimeType: 'image/png', buffer: await pngFromCanvas(page) })
  await expect(page.getByText('Ready')).toBeVisible()
  await shot('2-report')
  await page.getByRole('button', { name: 'Send report' }).click()

  const token = page.getByTestId('receipt-token')
  await expect(token).toHaveText(/^V\d{2}-\d{4,}$/)
  const tokenText = (await token.textContent())!.trim()
  await shot('3-receipt')

  await page.getByRole('link', { name: 'View ticket' }).click()
  await expect(page.getByText('Other Civil Issue: Bench')).toBeVisible()
  await expectPhotoLoaded(page, 'bench.jpg')
  await shot('4-ticket-faculty')
  await signOut(page)

  // Facility manager: password only (no authenticator), sees the ticket and the photo.
  await signIn(page, 'smoke-manager@dbit.edu')
  await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible()
  await page.getByRole('link', { name: new RegExp(tokenText) }).first().click()
  await expect(page.getByText('Step 1: Accept or reject this report')).toBeVisible()
  const img = await expectPhotoLoaded(page, 'bench.jpg')
  await img.click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(page.getByText('Step 2: Who is doing the work?')).toBeVisible()
  await page.getByLabel('Worker or vendor').fill('Smoke Carpenter')
  await page.getByRole('button', { name: 'Mark as assigned' }).click()
  await expect(page.getByText('Worker: Smoke Carpenter')).toBeVisible()
  await page.getByRole('button', { name: 'Mark work started' }).click()
  await expect(page.getByText('Step 3: What did the worker find?')).toBeVisible()
  await page.getByRole('radio', { name: /Immediate/ }).click()
  await page.getByRole('button', { name: 'Save as Immediate' }).click()
  await expect(page.getByRole('button', { name: 'Save as Immediate' })).toHaveCount(0)
  await page.getByLabel('When the work is done: what was done').fill('Replaced the cracked frame')
  await page.getByRole('button', { name: 'Mark as fixed' }).click()
  await expect(page.getByText('Waiting for the reporter to check the work')).toBeVisible()
  await shot('5-staff-ticket')
  await signOut(page)

  // Back as the reporter: verify the fix and rate the repair.
  await signIn(page, 'smoke-faculty@dbit.edu')
  await expect(page.getByRole('heading', { name: /Hello/ })).toBeVisible()
  await page.goto('/tickets')
  await page.getByRole('link', { name: new RegExp(tokenText) }).first().click()
  await expect(page.getByText('Smoke Carpenter')).toHaveCount(0)
  await page.getByRole('button', { name: 'Yes, it is fixed' }).click()
  await expect(page.getByText('How was the repair?')).toBeVisible()
  await page.getByRole('radio', { name: '5 stars' }).click()
  await page.getByLabel('Anything else? (optional)').fill('Quick work, thank you')
  await page.getByRole('button', { name: 'Send rating' }).click()
  await expect(page.getByText('Your rating')).toBeVisible()
  await expect(page.getByText('Quick work, thank you')).toBeVisible()
  await shot('6-faculty-rating')
  await signOut(page)
})

test('approved critical cost can be finished after the facility manager reloads', async ({ page }) => {
  const title = `Approved cost check ${Date.now()}`

  // Faculty reports the problem.
  await signIn(page, 'smoke-faculty@dbit.edu')
  await expect(page.getByRole('heading', { name: /Hello/ })).toBeVisible()
  await page.goto('/report')
  await page.getByRole('radio', { name: 'Civil' }).click()
  await page.getByLabel('Which part?').selectOption('Other Civil Issue')
  await page.getByLabel('What is it?').fill('Desk')
  await page.getByLabel('Building').selectOption('BLOCK_A')
  await page.getByLabel('Floor').selectOption('2')
  await page.getByLabel('Room or area').fill('204')
  await page.getByLabel('Short title').fill(title)
  await page.getByRole('button', { name: 'Send report' }).click()
  const token = page.getByTestId('receipt-token')
  await expect(token).toHaveText(/^V\d{2}-\d{4,}$/)
  const tokenText = (await token.textContent())!.trim()
  await signOut(page)

  // Facility manager assigns a worker and asks management to approve the cost.
  await signIn(page, 'smoke-manager@dbit.edu')
  await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible()
  await page.getByRole('link', { name: new RegExp(tokenText) }).first().click()
  await page.getByRole('button', { name: 'Accept', exact: true }).click()
  await page.getByLabel('Worker or vendor').fill('Smoke Vendor')
  await page.getByRole('button', { name: 'Mark as assigned' }).click()
  await page.getByRole('button', { name: 'Mark work started' }).click()
  await expect(page.getByText('Step 3: What did the worker find?')).toBeVisible()
  await page.getByRole('radio', { name: /Critical/ }).click()
  await page.getByLabel('Why is it critical?').fill('The desk frame is broken and needs a new part.')
  await page.getByLabel('Estimated cost (Rs)').fill('1250')
  await page.getByRole('button', { name: 'Send to management' }).click()
  await expect(page.getByText('Waiting for institute management')).toBeVisible()
  await signOut(page)

  // Institute management approves the estimate.
  await signIn(page, 'smoke-management@dbit.edu')
  await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible()
  await page.goto('/staff/approvals')
  await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible()
  await page.getByRole('link', { name: new RegExp(tokenText) }).first().click()
  await expect(page.getByText('Critical: sent to management')).toBeVisible()
  await page.getByRole('button', { name: 'Record decision' }).click()
  await expect(page.getByText('Approved by Smoke Management')).toBeVisible()
  await signOut(page)

  // Back as the facility manager: the approved ticket is in Needs action and
  // can be marked fixed immediately, without choosing the flag again.
  await signIn(page, 'smoke-manager@dbit.edu')
  await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible()
  await page.getByRole('link', { name: new RegExp(tokenText) }).first().click()
  await expect(page.getByText('Step 4: Finish the approved work')).toBeVisible()
  await expect(page.getByText('Approved by institute management')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save as Immediate' })).toHaveCount(0)
  await page.getByLabel('When the work is done: what was done').fill('Replaced the broken desk frame')
  await page.getByRole('button', { name: 'Mark as fixed' }).click()
  await expect(page.getByText('Waiting for the reporter to check the work')).toBeVisible()
  await signOut(page)
})

test('faculty edits a submitted report before work starts', async ({ page }) => {
  const title = `Noisy fan ${Date.now()}`
  const updated = `${title} updated`

  await signIn(page, 'smoke-faculty@dbit.edu')
  await expect(page.getByRole('heading', { name: /Hello/ })).toBeVisible()
  await page.goto('/report')
  await page.getByRole('radio', { name: 'Mechanical' }).click()
  await page.getByLabel('Which part?').selectOption('Fan / Light / Electrical')
  await page.getByLabel('Building').selectOption('BLOCK_B')
  await page.getByLabel('Floor').selectOption('1')
  await page.getByLabel('Room or area').fill('101')
  await page.getByLabel('Short title').fill(title)
  await page.getByRole('button', { name: 'Send report' }).click()

  const token = page.getByTestId('receipt-token')
  await expect(token).toHaveText(/^M\d{2}-\d{4,}$/)
  await page.getByRole('link', { name: 'View ticket' }).click()
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
