import { expect, test, type Page } from '@playwright/test'

/**
 * Every main screen must fit every common screen size: no sideways scrolling of the
 * page, and no element sticking out past the right edge. Wide tables may scroll
 * inside their own box (overflow-x-auto); that is allowed and is not counted.
 *
 * Runs once (desktop project); it sets each viewport itself.
 */

const PASSWORD = process.env.SMOKE_PASSWORD ?? 'Smoke-Test-Pass-91'

const SIZES = [
  { name: 'small-phone', width: 320, height: 640 },
  { name: 'phone', width: 375, height: 740 },
  { name: 'large-phone', width: 430, height: 932 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'tablet-landscape', width: 1024, height: 768 },
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'wide', width: 2560, height: 1440 },
]

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('College email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/login/)
}

/** Elements that stick out past the viewport, ignoring content inside a horizontal scroller. */
async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const out: string[] = []
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${vw}`)
    const inScroller = (el: Element): boolean => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p)
        if ((s.overflowX === 'auto' || s.overflowX === 'scroll' || s.overflowX === 'hidden') && p !== document.body && p !== document.documentElement) return true
      }
      return false
    }
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const s = getComputedStyle(el)
      if (s.position === 'fixed' && s.visibility === 'hidden') continue
      if (r.right > vw + 1 && !inScroller(el)) {
        const id = el.id ? `#${el.id}` : ''
        const cls = typeof el.className === 'string' ? '.' + el.className.split(/\s+/).slice(0, 3).join('.') : ''
        out.push(`${el.tagName.toLowerCase()}${id}${cls} right=${Math.round(r.right)} > ${vw} "${(el.textContent ?? '').trim().slice(0, 40)}"`)
        if (out.length > 8) break
      }
    }
    return out
  })
}

async function check(page: Page, path: string, label: string) {
  const problems: string[] = []
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height })
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    const found = await overflow(page)
    if (found.length) problems.push(`${label} at ${size.name} (${size.width}px):\n  ${found.join('\n  ')}`)
  }
  expect(problems, problems.join('\n')).toEqual([])
}

test.describe('every screen fits every size', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'desktop', 'sets its own viewports; run once')
  })

  test('public pages', async ({ page }) => {
    await check(page, '/', 'landing')
    await check(page, '/login', 'login')
  })

  test('faculty pages', async ({ page }) => {
    await signIn(page, 'smoke-faculty@dbit.edu')
    await check(page, '/home', 'home')
    await check(page, '/report', 'report')
    await check(page, '/tickets', 'my requests')
    await page.goto('/tickets')
    const first = page.locator('a[href^="/t/"]').first()
    if (await first.count()) await check(page, (await first.getAttribute('href'))!, 'ticket (faculty)')
    await check(page, '/settings', 'settings')
  })

  test('facility manager pages', async ({ page }) => {
    await signIn(page, 'smoke-manager@dbit.edu')
    await check(page, '/staff', 'queue')
    await check(page, '/staff?view=all', 'queue, all open')
    await page.goto('/staff?view=all')
    const first = page.locator('a[href^="/staff/t/"]').first()
    if (await first.count()) await check(page, (await first.getAttribute('href'))!, 'ticket (staff)')
    await check(page, '/staff/reports', 'reports (manager)')
  })

  test('approver pages', async ({ page }) => {
    await signIn(page, 'smoke-management@dbit.edu')
    await check(page, '/staff/approvals', 'approvals')
    await check(page, '/staff/reports', 'reports with expenditure')
  })
})
