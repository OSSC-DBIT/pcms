import { Link } from 'react-router-dom'
import { BellRing, Camera, ClipboardCheck, Hammer, ShieldCheck, Smartphone } from 'lucide-react'
import { CLUB, Footer, INSTITUTE, InstituteMark } from '../components/Brand'
import InstallCard from '../components/InstallCard'
import { Button } from '../components/ui'

const STEPS = [
  { icon: Camera, title: 'Report', body: 'Faculty describe the problem and add a photo. They get a token such as C26-0001.' },
  { icon: ClipboardCheck, title: 'Review', body: 'The facility manager accepts it, or rejects it with a reason.' },
  { icon: Hammer, title: 'Fix', body: 'A worker is assigned and gets an SMS. Critical jobs go to institute management.' },
  { icon: BellRing, title: 'Confirm', body: 'The reporter is notified and confirms the fix. Every step is recorded.' },
]

export default function Landing() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="safe-top border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 md:px-8">
          <InstituteMark />
          <Link to="/login"><Button size="sm">Sign in</Button></Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 md:px-8 md:py-16">
        <p className="text-[13px] font-medium uppercase tracking-wide text-accent">{INSTITUTE}</p>
        <h1 className="mt-2 max-w-2xl text-[30px] font-semibold leading-tight md:text-[42px]">Campus maintenance, reported and fixed in one place.</h1>
        <p className="mt-4 max-w-2xl text-[16px] leading-7 text-muted">
          PCMS is DBIT's maintenance desk. If something on campus is broken, a chair, a fan, a tap, the Wi-Fi or a projector,
          report it here from your phone or computer and follow it until it is fixed.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link to="/login"><Button>Sign in to report a problem</Button></Link>
        </div>

        <section className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="How it works">
          {STEPS.map((s, i) => (
            <div key={s.title} className="rounded-lg border border-line bg-surface p-5">
              <s.icon size={22} className="text-accent" aria-hidden />
              <p className="mt-3 text-[15px] font-semibold">{i + 1}. {s.title}</p>
              <p className="mt-1 text-[14px] leading-6 text-muted">{s.body}</p>
            </div>
          ))}
        </section>

        <section className="mt-12 grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-line bg-surface p-5">
            <p className="flex items-center gap-2 text-[15px] font-semibold"><Smartphone size={18} className="text-accent" /> Works on phone and desktop</p>
            <p className="mt-1 text-[14px] leading-6 text-muted">Install it like an app and get notifications about your reports. Accounts are created by Team OSSC from the college roster.</p>
            <div className="mt-4"><InstallCard /></div>
          </div>
          <div className="rounded-lg border border-line bg-surface p-5">
            <p className="flex items-center gap-2 text-[15px] font-semibold"><ShieldCheck size={18} className="text-accent" /> About</p>
            <p className="mt-1 text-[14px] leading-6 text-muted">
              PCMS runs on DBIT's own server. It is built, maintained and regulated by the {CLUB}, a student club
              that builds software for the campus. Questions or problems with your account: contact Team OSSC.
            </p>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  )
}
