/**
 * Catches render-time errors so one broken screen does not blank the whole app.
 *
 * React unmounts the entire tree when a render throws and nothing catches it,
 * which left PCMS showing an empty page with no way back. This renders a
 * recovery panel instead, in the same shape as the "PCMS is not reachable"
 * panel in App.tsx so the two failures look like the same product.
 *
 * "Try again" clears the error and re-renders, which is enough for a transient
 * fault (a stale list, a bad response). If the error is in the screen itself
 * that will throw straight back, so the panel also offers a route out to a
 * known-good page. Callers pass a changing `key` (Gate uses the pathname) so
 * navigating away remounts the boundary and clears a stuck screen.
 *
 * Error boundaries catch render, lifecycle and constructor errors only. A
 * rejected promise in an event handler or effect is not caught here; those go
 * through the per-screen errorMessage() handling instead.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from './ui'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // No error reporting service is wired up, so the console is the only record.
    // Keep the component stack: it names the screen that threw.
    console.error('PCMS render error', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <main className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-[17px] font-semibold">This screen stopped working</p>
        <p className="max-w-sm text-[14px] text-muted">
          Nothing you reported is lost. Try again, or go back and open it once more.
        </p>
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => this.setState({ error: null })}>Try again</Button>
          <Button variant="secondary" onClick={() => { window.location.href = '/' }}>Go to the start</Button>
        </div>
        {import.meta.env.DEV && (
          <pre className="mt-3 max-w-full overflow-auto rounded-md bg-subtle p-3 text-left text-[12px] text-muted">
            {error.message}
          </pre>
        )}
      </main>
    )
  }
}
