import './lib/install' // must run first: captures the browser's install prompt event
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource-variable/noto-sans-kannada'
import '@fontsource-variable/noto-sans-devanagari'
import './styles/globals.css'
import App from './App'
import { I18nProvider } from './lib/i18n'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <I18nProvider>
        <App />
      </I18nProvider>
    </BrowserRouter>
  </StrictMode>,
)
