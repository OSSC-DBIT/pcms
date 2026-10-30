import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { en } from './locales/en'
import { hi } from './locales/hi'
import { kn } from './locales/kn'

export type Lang = 'en' | 'hi' | 'kn'
export type TKey = keyof typeof en
export type TParams = Record<string, string | number>
export type TFunc = (key: TKey, params?: TParams) => string

export const LANGS: { code: Lang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'kn', label: 'ಕನ್ನಡ' },
]

export const LOCALE: Record<Lang, string> = {
  en: 'en-IN',
  hi: 'hi-IN',
  kn: 'kn-IN',
}

const DICTS: Record<Lang, Record<TKey, string>> = { en, hi, kn }

function interpolate(template: string, params?: TParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

const I18nCtx = createContext<{ lang: Lang; t: TFunc; setLang: (l: Lang) => void }>({
  lang: 'en', t: (k) => en[k], setLang: () => {},
})

function savedLang(): Lang {
  const saved = localStorage.getItem('pcms.lang')
  return saved === 'hi' || saved === 'kn' ? saved : 'en'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(savedLang)
  useEffect(() => {
    localStorage.setItem('pcms.lang', lang)
    document.documentElement.lang = LOCALE[lang]
  }, [lang])
  const t = useCallback<TFunc>((key, params) => interpolate(DICTS[lang][key] ?? en[key], params), [lang])
  const value = useMemo(() => ({ lang, t, setLang: setLangState }), [lang, t])
  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>
}

export const useT = () => useContext(I18nCtx)
