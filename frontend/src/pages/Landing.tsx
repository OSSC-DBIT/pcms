/**
 * DBIT's PCMS landing page (browser only; the installed app opens /login).
 * Effects: drifting colour blobs, animated gradient text, pointer spotlight on cards,
 * scroll reveals and a mock ticket that steps through its statuses. framer-motion
 * honours the person's reduced-motion setting, and globals.css stops the CSS animations.
 */
import { clsx } from 'clsx'
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import {
  ArrowRight, BellRing, Camera, CheckCircle2, ClipboardCheck, DatabaseBackup, FileSearch, Hammer, Hash, Languages,
  Lock, MapPin, ScrollText, ShieldCheck, Smartphone, Star, UserRound, Users, Wallet, Wrench, type LucideIcon,
} from 'lucide-react'
import { CLUB, Footer, INSTITUTE, INSTITUTE_SHORT, LanguageSwitcher } from '../components/Brand'
import InstallCard from '../components/InstallCard'
import { useT, type Lang, type TKey } from '../lib/i18n'

const EASE = [0.22, 1, 0.36, 1] as const
// Capitals and wide letter spacing suit Latin script only; they break up Kannada and Hindi letters.
const latin = (lang: Lang) => lang === 'en'
const CTA = 'inline-flex h-12 items-center justify-center gap-2 rounded-md px-5 text-[15.5px] font-medium transition-colors'

/** Fades and lifts its content into view once, the first time it is scrolled to. */
function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div className={className} initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }} transition={{ duration: 0.6, delay, ease: EASE }}>
      {children}
    </motion.div>
  )
}

/** Moves the card's spotlight to the pointer. */
function track(e: MouseEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect()
  e.currentTarget.style.setProperty('--x', `${e.clientX - r.left}px`)
  e.currentTarget.style.setProperty('--y', `${e.clientY - r.top}px`)
}

function SectionTitle({ eyebrow, title, body }: { eyebrow: string; title: string; body?: string }) {
  const { lang } = useT()
  return (
    <Reveal className="mx-auto max-w-2xl text-center">
      <p className={clsx('text-[13px] font-semibold text-accent', latin(lang) && 'uppercase tracking-[0.14em]')}>{eyebrow}</p>
      <h2 className="mt-2 text-[26px] font-semibold leading-tight tracking-tight md:text-[34px]">{title}</h2>
      {body && <p className="mt-3 text-[15.5px] leading-7 text-muted">{body}</p>}
    </Reveal>
  )
}

// The statuses the mock ticket steps through, with the colour of each badge.
const DEMO_STEPS: { status: TKey; tone: string; icon: LucideIcon }[] = [
  { status: 'status.Submitted', tone: 'bg-subtle text-fg', icon: ClipboardCheck },
  { status: 'status.Triaged', tone: 'bg-accent-soft text-accent', icon: CheckCircle2 },
  { status: 'status.InProgress', tone: 'bg-warn-soft text-warn', icon: Wrench },
  { status: 'status.Closed', tone: 'bg-ok-soft text-ok', icon: Star },
]

function DemoTicket() {
  const { t, lang } = useT()
  const [step, setStep] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setStep((s) => (s + 1) % DEMO_STEPS.length), 2200)
    return () => clearInterval(id)
  }, [])
  const current = DEMO_STEPS[step]
  return (
    <motion.div initial={{ opacity: 0, y: 30, rotate: -1 }} animate={{ opacity: 1, y: 0, rotate: 0 }}
      transition={{ duration: 0.8, delay: 0.2, ease: EASE }}
      className="glow-border relative w-full max-w-sm rounded-2xl p-5 shadow-2xl shadow-accent/10" aria-hidden>
      <div className="flex items-center justify-between">
        <span className={clsx('text-[12px] font-medium text-muted', latin(lang) && 'uppercase tracking-wide')}>{t('landing.demoLabel')}</span>
        <span className="token rounded-md bg-subtle px-2 py-0.5 text-[13px] font-semibold">C26-0001</span>
      </div>
      <p className="mt-4 text-[18px] font-semibold">{t('landing.demoTitle')}</p>
      <p className="mt-1 flex items-center gap-1.5 text-[13.5px] text-muted"><MapPin size={14} /> {t('landing.demoPlace')}</p>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {['from-sky-400/40 to-indigo-500/40', 'from-amber-300/40 to-rose-400/40', 'from-emerald-300/40 to-cyan-500/40'].map((g, i) => (
          <div key={g} className={`relative aspect-square rounded-lg bg-gradient-to-br ${g}`}>
            {i === 2 && <span className="absolute inset-0 flex items-center justify-center"><Camera size={20} className="text-fg/70" /></span>}
          </div>
        ))}
      </div>
      <p className="mt-2 text-[12.5px] text-muted">{t('landing.demoPhotos')}</p>
      <div className="mt-4 h-10">
        <AnimatePresence mode="wait">
          <motion.span key={current.status} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3 }} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13.5px] font-medium ${current.tone}`}>
            <current.icon size={15} /> {t(current.status)}
          </motion.span>
        </AnimatePresence>
      </div>
      <div className="mt-1 flex gap-1.5">
        {DEMO_STEPS.map((s, i) => (
          <span key={s.status} className="h-1.5 flex-1 overflow-hidden rounded-full bg-subtle">
            <motion.span className="block h-full rounded-full bg-accent" initial={false}
              animate={{ width: i <= step ? '100%' : '0%' }} transition={{ duration: 0.5, ease: EASE }} />
          </span>
        ))}
      </div>
    </motion.div>
  )
}

export default function Landing() {
  const { t } = useT()
  const steps = [
    { icon: Camera, title: t('landing.stepReport'), body: t('landing.stepReportBody') },
    { icon: ClipboardCheck, title: t('landing.stepReview'), body: t('landing.stepReviewBody') },
    { icon: Hammer, title: t('landing.stepFix'), body: t('landing.stepFixBody') },
    { icon: BellRing, title: t('landing.stepConfirm'), body: t('landing.stepConfirmBody') },
  ]
  const features: { icon: LucideIcon; title: TKey; body: TKey; wide?: boolean }[] = [
    { icon: Camera, title: 'landing.fCameraTitle', body: 'landing.fCameraBody', wide: true },
    { icon: Hash, title: 'landing.fTokenTitle', body: 'landing.fTokenBody' },
    { icon: BellRing, title: 'landing.fNotifyTitle', body: 'landing.fNotifyBody' },
    { icon: Languages, title: 'landing.fLangTitle', body: 'landing.fLangBody' },
    { icon: Wallet, title: 'landing.fApproveTitle', body: 'landing.fApproveBody' },
    { icon: Star, title: 'landing.fRateTitle', body: 'landing.fRateBody', wide: true },
  ]
  const roles: { icon: LucideIcon; role: TKey; body: TKey }[] = [
    { icon: UserRound, role: 'role.faculty', body: 'landing.roleFacultyBody' },
    { icon: Wrench, role: 'role.facility_manager', body: 'landing.roleManagerBody' },
    { icon: FileSearch, role: 'role.principal', body: 'landing.rolePrincipalBody' },
    { icon: Users, role: 'role.management', body: 'landing.roleManagementBody' },
  ]
  const security: { icon: LucideIcon; text: TKey }[] = [
    { icon: Lock, text: 'landing.sec1' },
    { icon: ShieldCheck, text: 'landing.sec2' },
    { icon: ScrollText, text: 'landing.sec3' },
    { icon: DatabaseBackup, text: 'landing.sec4' },
  ]
  const nav: { href: string; label: TKey }[] = [
    { href: '#how', label: 'landing.navHow' },
    { href: '#features', label: 'landing.navFeatures' },
    { href: '#security', label: 'landing.navSecurity' },
  ]

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex min-h-dvh flex-col overflow-x-clip">
        <header className="safe-top sticky top-0 z-30 border-b border-line/70 bg-surface/75 backdrop-blur-xl">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 md:px-8">
            <Link to="/" className="flex min-w-0 items-center gap-2.5">
              <img src="/pwa-64x64.png" alt="" width={32} height={32} className="rounded-md" />
              <span className="leading-tight">
                <span className="block text-[15px] font-semibold">PCMS</span>
                <span className="hidden whitespace-nowrap text-[12px] text-muted sm:block">{INSTITUTE_SHORT}</span>
              </span>
            </Link>
            <nav aria-label={t('landing.howItWorks')} className="hidden items-center gap-6 text-[14px] text-muted lg:flex">
              {nav.map((n) => <a key={n.href} href={n.href} className="transition-colors hover:text-fg">{t(n.label)}</a>)}
            </nav>
            <div className="flex shrink-0 items-center gap-2 sm:gap-3">
              <LanguageSwitcher compact />
              <Link to="/login" className="inline-flex h-9 items-center whitespace-nowrap rounded-md bg-accent px-3 text-[14px] font-medium text-accent-fg hover:opacity-90">{t('landing.signIn')}</Link>
            </div>
          </div>
        </header>

        <main className="flex-1">
          {/* Hero */}
          <section className="relative isolate overflow-hidden">
            <div className="grid-backdrop absolute inset-0 -z-10" aria-hidden />
            <div className="blob -z-10 left-[-8rem] top-[-6rem] h-[26rem] w-[26rem] bg-blue-500" aria-hidden />
            <div className="blob -z-10 right-[-6rem] top-[4rem] h-[22rem] w-[22rem] bg-violet-500 [animation-delay:-6s]" aria-hidden />
            <div className="blob -z-10 bottom-[-8rem] left-1/3 h-[20rem] w-[20rem] bg-cyan-400 [animation-delay:-12s]" aria-hidden />

            <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-12 md:px-8 md:pb-24 md:pt-20 lg:grid-cols-[1.15fr_1fr]">
              <div>
                <motion.p initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
                  className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/80 px-3 py-1 text-[12.5px] font-medium text-muted backdrop-blur">
                  <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-ok" /></span>
                  {INSTITUTE}
                </motion.p>
                <motion.h1 initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, delay: 0.05, ease: EASE }}
                  className="mt-5 text-[38px] font-semibold leading-[1.08] tracking-tight md:text-[60px]">
                  {t('landing.heroLead')}<br /><span className="text-gradient">{t('landing.heroAccent')}</span>
                </motion.h1>
                <motion.p initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, delay: 0.15, ease: EASE }}
                  className="mt-5 max-w-xl text-[16.5px] leading-7 text-muted">{t('landing.heroBody')}</motion.p>
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, delay: 0.25, ease: EASE }}
                  className="mt-8 flex flex-wrap gap-3">
                  <Link to="/login" className={clsx(CTA, 'group bg-accent text-accent-fg shadow-lg shadow-accent/25 hover:opacity-90')}>
                    {t('landing.signInReport')} <ArrowRight size={18} className="transition-transform group-hover:translate-x-0.5" />
                  </Link>
                  <a href="#how" className={clsx(CTA, 'border border-line bg-surface text-fg hover:bg-subtle')}>{t('landing.seeHow')}</a>
                </motion.div>
                <motion.ul initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, delay: 0.4 }}
                  className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-[13.5px] text-muted">
                  {([[Languages, 'landing.chipLanguages'], [Smartphone, 'landing.chipPhone'], [Lock, 'landing.chipPrivate']] as const).map(([Icon, key]) => (
                    <li key={key} className="flex items-center gap-1.5"><Icon size={15} className="text-accent" /> {t(key)}</li>
                  ))}
                </motion.ul>
              </div>
              <div className="flex justify-center lg:justify-end"><DemoTicket /></div>
            </div>
          </section>

          {/* How it works */}
          <section id="how" className="scroll-mt-20 border-t border-line/70 bg-surface/50 py-16 md:py-24">
            <div className="mx-auto max-w-6xl px-4 md:px-8">
              <SectionTitle eyebrow={t('landing.howItWorks')} title={t('landing.heroTitle')} />
              <div className="relative mt-12 grid gap-5 md:grid-cols-4">
                <div className="absolute left-[12%] right-[12%] top-7 hidden h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent md:block" aria-hidden />
                {steps.map((s, i) => (
                  <Reveal key={s.title} delay={i * 0.1}>
                    <div className="relative flex flex-col items-center text-center">
                      <span className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-surface shadow-sm">
                        <s.icon size={24} className="text-accent" aria-hidden />
                        <span className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-[12px] font-semibold text-accent-fg">{i + 1}</span>
                      </span>
                      <p className="mt-4 text-[16px] font-semibold">{s.title}</p>
                      <p className="mt-1.5 max-w-[16rem] text-[14px] leading-6 text-muted">{s.body}</p>
                    </div>
                  </Reveal>
                ))}
              </div>
            </div>
          </section>

          {/* Features */}
          <section id="features" className="scroll-mt-20 py-16 md:py-24">
            <div className="mx-auto max-w-6xl px-4 md:px-8">
              <SectionTitle eyebrow={t('landing.navFeatures')} title={t('landing.featuresTitle')} body={t('landing.featuresBody')} />
              <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {features.map((f, i) => (
                  <Reveal key={f.title} delay={(i % 4) * 0.07} className={f.wide ? 'lg:col-span-2' : undefined}>
                    <motion.div onMouseMove={track} whileHover={{ y: -4 }} transition={{ type: 'spring', stiffness: 300, damping: 22 }}
                      className="spotlight h-full rounded-2xl border border-line bg-surface p-6">
                      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent"><f.icon size={21} aria-hidden /></span>
                      <p className="mt-4 text-[16px] font-semibold">{t(f.title)}</p>
                      <p className="mt-1.5 text-[14px] leading-6 text-muted">{t(f.body)}</p>
                    </motion.div>
                  </Reveal>
                ))}
              </div>
            </div>
          </section>

          {/* Roles */}
          <section className="border-y border-line/70 bg-surface/50 py-16 md:py-24">
            <div className="mx-auto max-w-6xl px-4 md:px-8">
              <SectionTitle eyebrow="PCMS" title={t('landing.rolesTitle')} />
              <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {roles.map((r, i) => (
                  <Reveal key={r.role} delay={i * 0.08}>
                    <div onMouseMove={track} className="spotlight h-full rounded-2xl border border-line bg-surface p-6">
                      <r.icon size={22} className="text-accent" aria-hidden />
                      <p className="mt-3 text-[16px] font-semibold">{t(r.role)}</p>
                      <p className="mt-1.5 text-[14px] leading-6 text-muted">{t(r.body)}</p>
                    </div>
                  </Reveal>
                ))}
              </div>
            </div>
          </section>

          {/* Security and install */}
          <section id="security" className="scroll-mt-20 py-16 md:py-24">
            <div className="mx-auto grid max-w-6xl gap-6 px-4 md:px-8 lg:grid-cols-2">
              <Reveal>
                <div className="relative h-full overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-slate-900 to-indigo-950 p-7 text-white">
                  <div className="blob right-[-5rem] top-[-5rem] h-60 w-60 bg-indigo-500" aria-hidden />
                  <ShieldCheck size={28} className="relative text-indigo-300" aria-hidden />
                  <p className="relative mt-4 text-[22px] font-semibold">{t('landing.securityTitle')}</p>
                  <p className="relative mt-2 text-[14.5px] leading-6 text-white/70">{t('landing.securityBody')}</p>
                  <ul className="relative mt-6 space-y-3">
                    {security.map((s) => (
                      <li key={s.text} className="flex items-start gap-3 text-[14.5px]">
                        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/10"><s.icon size={15} aria-hidden /></span>
                        {t(s.text)}
                      </li>
                    ))}
                  </ul>
                </div>
              </Reveal>
              <Reveal delay={0.1}>
                <div className="flex h-full flex-col rounded-2xl border border-line bg-surface p-7">
                  <Smartphone size={28} className="text-accent" aria-hidden />
                  <p className="mt-4 text-[22px] font-semibold">{t('landing.phoneTitle')}</p>
                  <p className="mt-2 text-[14.5px] leading-6 text-muted">{t('landing.phoneBody')}</p>
                  <div className="mt-5"><InstallCard /></div>
                  <p className="mt-auto pt-6 text-[13.5px] leading-6 text-muted">{t('landing.aboutBody', { club: CLUB })}</p>
                </div>
              </Reveal>
            </div>
          </section>

          {/* Final call to action */}
          <section className="mx-auto max-w-6xl px-4 pb-20 md:px-8">
            <Reveal>
              <div className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 px-6 py-12 text-center text-white md:py-16">
                <div className="grid-backdrop absolute inset-0 opacity-30" aria-hidden />
                <p className="relative text-[26px] font-semibold md:text-[34px]">{t('landing.ctaTitle')}</p>
                <p className="relative mt-2 text-[15.5px] text-white/80">{t('landing.ctaBody')}</p>
                <Link to="/login" className="relative mt-7 inline-flex h-12 items-center gap-2 rounded-md bg-white px-6 text-[15.5px] font-semibold text-indigo-700 shadow-lg transition-transform hover:scale-[1.03]">
                  {t('landing.signInReport')} <ArrowRight size={18} />
                </Link>
              </div>
            </Reveal>
          </section>
        </main>

        <Footer />
      </div>
    </MotionConfig>
  )
}
