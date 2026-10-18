// Applies the saved theme and language before first paint (kept external for a strict CSP).
;(function () {
  try {
    var saved = localStorage.getItem('pcms.theme')
    var dark = saved === 'dark' || ((!saved || saved === 'system') && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    document.documentElement.lang = localStorage.getItem('pcms.lang') === 'hi' ? 'hi' : 'en'
  } catch (e) {
    document.documentElement.dataset.theme = 'light'
  }
})()
