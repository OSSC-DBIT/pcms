import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

export type Theme = 'light' | 'dark' | 'system'

function apply(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.setAttribute('content', dark ? 'black-translucent' : 'default')
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => (localStorage.getItem('pcms.theme.pref') as Theme) || 'system')
  useEffect(() => {
    apply(theme)
    localStorage.setItem('pcms.theme', theme)
    if (theme !== 'system') return
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const fn = () => apply('system')
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [theme])
  return { theme, setTheme: setThemeState }
}

// Edge swipe-back: starts within 32px of the left edge, travels >60px horizontally.
export function useSwipeBack(enabled = true) {
  const navigate = useNavigate()
  const x0 = useRef<number | null>(null)
  const y0 = useRef(0)
  const fired = useRef(false)

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (!enabled) return
    const t = e.touches[0]
    fired.current = false
    x0.current = t.clientX <= 32 ? t.clientX : null
    y0.current = t.clientY
  }, [enabled])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (x0.current == null || fired.current) return
    const t = e.touches[0]
    if (t.clientX - x0.current > 60 && Math.abs(t.clientY - y0.current) < 40) {
      fired.current = true
      navigate(-1)
    }
  }, [navigate])

  const onTouchEnd = useCallback(() => { x0.current = null }, [])

  return { onTouchStart, onTouchMove, onTouchEnd }
}

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    addEventListener('online', on); addEventListener('offline', off)
    return () => { removeEventListener('online', on); removeEventListener('offline', off) }
  }, [])
  return online
}
