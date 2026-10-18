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

async function signIn(page: Page, emp: string) {
  await page.goto('/login')
  await page.getByLabel('Employee ID').fill(emp)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

async function signOut(page: Page) {
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByLabel('Employee ID')).toBeVisible()
}

test('faculty reports a problem with Other and a photo; manager sees it with the image', async ({ page }, info) => {
  const shot = (name: string) => page.screenshot({ path: `out/${info.project.name}-${name}.png`, fullPage: true })

  await signIn(page, 'SMOKE-FAC')
  await expect(page.getByRole('heading', { name: /Hello/ })).toBeVisible()
  await shot('1-home')

  await page.goto('/report')
  await page.getByRole('radio', { name: 'Carpentry' }).click()
  await page.getByRole('radiogroup', { name: 'Which part?' }).getByRole('radio', { name: 'Other' }).click()
  await expect(page.getByLabel('What is it?')).toBeVisible()
  await page.getByLabel('What is it?').fill('Bench')
  await page.getByLabel('Building').selectOption('CSE')
  await page.getByLabel('Floor').selectOption('2')
  await page.getByLabel('Room or area').fill('203')
  await page.getByLabel('Short title').fill('Broken bench near the window')
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'bench.png', mimeType: 'image/png', buffer: await pngFromCanvas(page) })
  await expect(page.getByText('Ready')).toBeVisible()
  await shot('2-report')
  await page.getByRole('button', { name: 'Send report' }).click()

  const token = page.getByTestId('receipt-token')
  await expect(token).toHaveText(/^C\d{2}-\d{4,}$/)
  const tokenText = (await token.textContent())!.trim()
  await shot('3-receipt')

  await page.getByRole('link', { name: 'View ticket' }).click()
  await expect(page.getByText('Other: Bench')).toBeVisible()
  const ownImg = page.locator('img[alt="bench.jpg"]').first()
  await expect(ownImg).toBeVisible()
  expect(await ownImg.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
  await shot('4-ticket-faculty')
  await signOut(page)

  // Facility manager: password only (no authenticator), sees the ticket and the photo.
  await signIn(page, 'SMOKE-FM')
  await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible()
  await page.getByRole('link', { name: new RegExp(tokenText) }).first().click()
  await expect(page.getByText('Step 1: Accept or reject this report')).toBeVisible()
  const img = page.locator('img[alt="bench.jpg"]').first()
  await expect(img).toBeVisible()
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
  await img.click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(page.getByText('Step 2: Assign a worker')).toBeVisible()
  await page.getByRole('checkbox', { name: /Smoke Carpenter/ }).check()
  await page.getByRole('button', { name: 'Assign and send SMS' }).click()
  await expect(page.getByText('Step 3: What did the worker find?')).toBeVisible()
  await page.getByRole('radio', { name: /Critical/ }).click()
  await page.getByLabel('Why is it critical?').fill('Frame cracked, needs replacement')
  await page.getByRole('button', { name: 'Send to management' }).click()
  await expect(page.getByText('Waiting for institute management')).toBeVisible()
  await shot('5-staff-ticket')

  await page.goto('/staff/workers')
  await expect(page.getByRole('button', { name: 'Add worker' })).toBeVisible()
  await shot('6-workers')
  await signOut(page)
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
