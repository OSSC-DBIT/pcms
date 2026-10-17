import { useState } from 'react'
import { BUILDINGS, CATEGORIES } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { Fade, NavBar, Segmented } from '../../components/ui'

const SECTIONS = ['catalogs', 'locations', 'roles', 'templates'] as const

export default function ToalAdmin() {
  const { lang } = useT()
  const [section, setSection] = useState<(typeof SECTIONS)[number]>('catalogs')

  return (
    <Fade className="mx-auto min-h-dvh max-w-lg pb-16">
      <NavBar title="Administration" />
      <div className="px-5 py-4">
        <Segmented label="admin-section" value={section} onChange={setSection} options={[
          { value: 'catalogs', label: 'Categories' }, { value: 'locations', label: 'Locations' },
          { value: 'roles', label: 'Roles' }, { value: 'templates', label: 'Messages' },
        ]} />
      </div>

      {section === 'catalogs' && (
        <div>
          <p className="px-5 pb-2 text-[12.5px] leading-5 text-muted">One letter per type, never recycled. Token = college code + year + letter + serial; serials restart at 0001 each January (Asia/Kolkata).</p>
          {CATEGORIES.map((c) => (
            <div key={c.code} className="hairline-b flex items-center justify-between px-5 py-3.5">
              <span className="flex items-center gap-3">
                <span className="token flex h-8 w-8 items-center justify-center rounded-full border border-fg/30 text-[14px] font-semibold">{c.letter}</span>
                <span>
                  <span className="block text-[14.5px] font-medium">{lang === 'hi' ? c.nameHi : c.nameEn}</span>
                  <span className="block text-[12px] text-muted">{(lang === 'hi' ? c.subtypesHi : c.subtypesEn).join(' · ')}</span>
                </span>
              </span>
              <span className={`rounded-full border border-line px-2.5 py-0.5 text-[12px] ${c.active ? '' : 'text-muted'}`}>{c.active ? 'active' : 'off'}</span>
            </div>
          ))}
        </div>
      )}

      {section === 'locations' && (
        <div>
          {BUILDINGS.map((b) => (
            <div key={b.code} className="hairline-b px-5 py-3.5">
              <p className="text-[14.5px] font-medium">{lang === 'hi' ? b.nameHi : b.nameEn}</p>
              <p className="token mt-0.5 text-[12.5px] text-muted">Floors: {b.floors.join(', ')}</p>
            </div>
          ))}
          <p className="px-5 py-4 text-[12.5px] text-muted">Outdoors and "room not listed" are covered by the free-text landmark on the form.</p>
        </div>
      )}

      {section === 'roles' && (
        <div className="px-5 pt-1">
          {[
            ['Team OSSC', 'Full portal: users, roles, categories, locations, templates, settings, audit. Only role that creates accounts.'],
            ['Facility manager', 'Queue, triage, flag, assign, dispatch, escalate, close. Cannot approve own spending or change roles.'],
            ['Management', 'Escalated cost proposals and reports only. No dispatch, no settings.'],
            ['Faculty', 'Own tickets only. No directory, no internal notes, no costs.'],
          ].map(([r, d]) => (
            <div key={r} className="hairline-b py-4">
              <p className="text-[14.5px] font-medium">{r}</p>
              <p className="mt-1 max-w-[52ch] text-[13px] leading-5 text-muted">{d}</p>
            </div>
          ))}
          <p className="py-5 text-[12.5px] leading-5 text-muted">
            Permission sets are enforced server-side — this screen lists them; accounts need named individuals, second factor for privileged roles, and audited role changes. Leavers are suspended and sessions revoked promptly.
          </p>
        </div>
      )}

      {section === 'templates' && (
        <div className="px-5 pt-1">
          <p className="py-3 text-[13px] font-medium">WhatsApp job (utility template)</p>
          <pre className="token whitespace-pre-wrap rounded-md border border-dashed border-fg/40 p-4 text-[12.5px] leading-5">
{`DBIT PCMS job DB26C0123
Plan type: Carpentry — Plan: Broken chair
Location: Block A, Floor 2, Room 203 — Flag: I
[photo] [Accept] [Done] [Need help]`}
          </pre>
          <p className="py-3 pt-5 text-[13px] font-medium">SMS fallback</p>
          <pre className="token whitespace-pre-wrap rounded-md border border-dashed border-fg/40 p-4 text-[12.5px] leading-5">
{`PCMS DB26C0123: Chair broken, Block A room 203.
Normal. Call facilities to accept.`}
          </pre>
          <p className="mt-5 text-[12.5px] leading-5 text-muted">
            Business-initiated messages use approved Meta templates; free chat only inside the 24-hour window. Media ships by media ID — no public image links. A delivered tick is never acceptance; only Accept or a recorded call is.
          </p>
        </div>
      )}
    </Fade>
  )
}
