import { useState } from 'react'
import { BUILDINGS, CATEGORIES, demoReset, demoSeed, hasDemoData } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { localName } from '../../lib/api'
import { Banner, Button, Card, Fade, NavBar, Row, SectionLabel, Segmented } from '../../components/ui'

const SECTIONS = ['catalogs', 'locations', 'roles', 'templates', 'demo'] as const

export default function AdminSettings() {
  const { lang } = useT()
  const [section, setSection] = useState<(typeof SECTIONS)[number]>('catalogs')
  const [seeded, setSeeded] = useState(hasDemoData())

  return (
    <Fade className="mx-auto min-h-dvh max-w-lg pb-16">
      <NavBar title="Administration" />
      <div className="px-4 py-4">
        <Segmented label="admin-section" value={section} onChange={setSection} options={[
          { value: 'catalogs', label: 'Types' }, { value: 'locations', label: 'Places' },
          { value: 'roles', label: 'Roles' }, { value: 'templates', label: 'Messages' }, { value: 'demo', label: 'Demo' },
        ]} />
      </div>

      {section === 'catalogs' && (
        <>
          <p className="pretty px-5 pb-1 text-[12px] leading-4 text-muted">One letter per type, never recycled. Token = college code + year + letter + serial; serials restart at 0001 each January (Asia/Kolkata).</p>
          <Card className="inset-hr mx-4 mt-3">
            {CATEGORIES.map((c) => (
              <div key={c.code} className="flex min-h-[56px] items-center justify-between px-4 py-2.5">
                <span className="flex items-center gap-3">
                  <span className="token flex h-9 w-9 items-center justify-center rounded-full border border-fg/25 text-[14px] font-bold">{c.letter}</span>
                  <span>
                    <span className="block text-[14.5px] font-medium">{localName(c, lang)}</span>
                    <span className="block max-w-[46ch] truncate text-[12px] text-muted">{(lang === 'hi' ? c.subtypesHi : lang === 'kn' ? c.subtypesKn : c.subtypesEn).join(' · ')}</span>
                  </span>
                </span>
                <span className="rounded-full border border-line px-2.5 py-0.5 text-[11.5px] font-semibold text-muted">{c.active ? 'active' : 'off'}</span>
              </div>
            ))}
          </Card>
        </>
      )}

      {section === 'locations' && (
        <Card className="inset-hr mx-4">
          {BUILDINGS.map((b) => (
            <Row key={b.code} title={localName(b, lang)} detail={`Floors: ${b.floors.join(', ')}`} chevron={false} />
          ))}
        </Card>
      )}

      {section === 'roles' && (
        <Card className="inset-hr mx-4">
          {[
            ['Team OSSC', 'Full portal: users, roles, categories, locations, templates, settings, audit. Only role that creates accounts.'],
            ['Facility manager', 'Queue, triage, flag, assign, dispatch, escalate, close. Cannot approve own spending or change roles.'],
            ['Management', 'Escalated cost proposals and reports only. No dispatch, no settings.'],
            ['Faculty', 'Own tickets only. No directory, no internal notes, no costs.'],
            ['Workers', 'No account. Receive jobs on WhatsApp with SMS and call fallback; replies update the ticket.'],
          ].map(([r, d]) => (
            <div key={r} className="px-4 py-3.5">
              <p className="text-[14.5px] font-semibold">{r}</p>
              <p className="pretty mt-1 max-w-[52ch] text-[13px] leading-5 text-muted">{d}</p>
            </div>
          ))}
          <p className="pretty px-4 py-4 text-[11.5px] leading-4 text-muted">
            Permission sets are enforced server-side. Accounts need named individuals, second factor for privileged roles, and audited role changes. Leavers are suspended and sessions revoked promptly.
          </p>
        </Card>
      )}

      {section === 'templates' && (
        <div className="px-4">
          <SectionLabel>WhatsApp job (utility template)</SectionLabel>
          <pre className="token whitespace-pre-wrap rounded-[14px] border border-dashed border-fg/40 bg-surface p-4 text-[12.5px] leading-5">
{`DBIT PCMS job DB26C0123
Plan type: Carpentry — Plan: Broken chair
Location: Block A, Floor 2, Room 203 — Flag: I
[photo] [Accept] [Done] [Need help]`}
          </pre>
          <SectionLabel>SMS fallback</SectionLabel>
          <pre className="token whitespace-pre-wrap rounded-[14px] border border-dashed border-fg/40 bg-surface p-4 text-[12.5px] leading-5">
{`PCMS DB26C0123: Chair broken, Block A room 203.
Normal. Call facilities to accept.`}
          </pre>
          <p className="pretty px-1 pt-5 text-[11.5px] leading-4 text-muted">
            Business-initiated messages use approved Meta templates; free chat only inside the 24-hour window. Media ships by media ID — no public image links. A delivered tick is never acceptance; only Accept or a recorded call is.
          </p>
        </div>
      )}

      {section === 'demo' && (
        <div className="px-4">
          <Banner>The app ships with no data. Load a small demo worker directory to try dispatch, or reset to empty.</Banner>
          <div className="mt-4 space-y-3">
            <Button onClick={() => { demoSeed(); setSeeded(true) }}>Load demo workers</Button>
            <Button variant="secondary" onClick={() => { demoReset(); setSeeded(false) }}>Reset all local data</Button>
          </div>
          <p className="mt-4 text-center text-[11.5px] text-muted">{seeded ? 'Demo data loaded on this device' : 'Empty — nothing loaded'}</p>
        </div>
      )}
    </Fade>
  )
}
