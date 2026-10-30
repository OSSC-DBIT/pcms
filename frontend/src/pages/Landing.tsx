import { Link } from 'react-router-dom'
import { BellRing, Camera, ClipboardCheck, Hammer, ShieldCheck, Smartphone } from 'lucide-react'
import { CLUB, Footer, INSTITUTE, InstituteMark } from '../components/Brand'
import InstallCard from '../components/InstallCard'
import { Button } from '../components/ui'
import { useT } from '../lib/i18n'

export default function Landing() {
  const { t } = useT()
  const steps = [
    { icon: Camera, title: t('landing.stepReport'), body: t('landing.stepReportBody') },
    { icon: ClipboardCheck, title: t('landing.stepReview'), body: t('landing.stepReviewBody') },
    { icon: Hammer, title: t('landing.stepFix'), body: t('landing.stepFixBody') },
    { icon: BellRing, title: t('landing.stepConfirm'), body: t('landing.stepConfirmBody') },
  ]
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="safe-top border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 md:px-8">
          <InstituteMark />
          <Link to="/login"><Button size="sm">{t('landing.signIn')}</Button></Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 md:px-8 md:py-16">
        <p className="text-[13px] font-medium uppercase tracking-wide text-accent">{INSTITUTE}</p>
        <h1 className="mt-2 max-w-2xl text-[30px] font-semibold leading-tight md:text-[42px]">{t('landing.heroTitle')}</h1>
        <p className="mt-4 max-w-2xl text-[16px] leading-7 text-muted">{t('landing.heroBody')}</p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link to="/login"><Button>{t('landing.signInReport')}</Button></Link>
        </div>

        <section className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label={t('landing.howItWorks')}>
          {steps.map((s, i) => (
            <div key={s.title} className="rounded-lg border border-line bg-surface p-5">
              <s.icon size={22} className="text-accent" aria-hidden />
              <p className="mt-3 text-[15px] font-semibold">{i + 1}. {s.title}</p>
              <p className="mt-1 text-[14px] leading-6 text-muted">{s.body}</p>
            </div>
          ))}
        </section>

        <section className="mt-12 grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-line bg-surface p-5">
            <p className="flex items-center gap-2 text-[15px] font-semibold"><Smartphone size={18} className="text-accent" /> {t('landing.phoneTitle')}</p>
            <p className="mt-1 text-[14px] leading-6 text-muted">{t('landing.phoneBody')}</p>
            <div className="mt-4"><InstallCard /></div>
          </div>
          <div className="rounded-lg border border-line bg-surface p-5">
            <p className="flex items-center gap-2 text-[15px] font-semibold"><ShieldCheck size={18} className="text-accent" /> {t('landing.aboutTitle')}</p>
            <p className="mt-1 text-[14px] leading-6 text-muted">{t('landing.aboutBody', { club: CLUB })}</p>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  )
}
