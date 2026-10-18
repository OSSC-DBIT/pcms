import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type Lang = 'en' | 'hi' | 'kn'
export const LANGS: { code: Lang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'kn', label: 'ಕನ್ನಡ' },
]

const en = {
  'app.name': 'PCMS',
  'app.tagline': 'Campus maintenance',
  'nav.home': 'Home',
  'nav.track': 'Track',
  'nav.raise': 'Report',
  'nav.history': 'History',
  'nav.settings': 'Settings',
  'action.back': 'Back',
  'action.next': 'Continue',
  'action.done': 'Done',
  'action.retry': 'Retry',
  'action.cancel': 'Cancel',
  'action.remove': 'Remove',
  'action.search': 'Search',
  'login.title': 'Sign in',
  'login.employeeId': 'Employee ID',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.help': 'Accounts are provisioned from the college roster by Team OSSC.',
  'home.greeting': 'Report a fault',
  'home.subtitle': 'Facilities will be notified. You will get a token to track it.',
  'home.open': 'In progress',
  'home.awaiting': 'Awaiting your verification',
  'home.recent': 'Recent',
  'home.seeAll': 'See all',
  'form.type': 'What needs fixing?',
  'form.subtype': 'Which part?',
  'form.location': 'Where is it?',
  'form.building': 'Building',
  'form.floor': 'Floor',
  'form.room': 'Room or area',
  'form.outdoors': 'Outdoors',
  'form.landmark': 'Nearby landmark',
  'form.title': 'Short title',
  'form.description': 'What failed, when, and the impact',
  'form.impact': 'How is it affecting things?',
  'form.impact.safety': 'Safety concern',
  'form.impact.class': 'Class interrupted',
  'form.impact.multiple': 'Multiple areas affected',
  'form.impact.routine': 'Routine',
  'form.access': 'Best access time',
  'form.evidence': 'Photo or video',
  'form.evidenceHint': 'Optional. Up to 3 photos, 1 short video.',
  'form.camera': 'Take photo or video',
  'form.upload': 'Choose file',
  'form.review': 'Review',
  'form.step': 'Step {n} of {total}',
  'receipt.title': 'Report received',
  'receipt.body': 'Keep this token. Facilities and the worker see the same number.',
  'receipt.track': 'Track this ticket',
  'receipt.print': 'Print receipt',
  'detail.timeline': 'Progress',
  'detail.nextUpdate': 'Next update due',
  'detail.verify': 'Verify and close',
  'detail.dispute': 'This is not fixed',
  'detail.reportedAsFixed': 'Reported as fixed',
  'detail.notYet': 'Nothing has happened yet — we are waiting on triage.',
  'detail.verified': 'You verified this issue.',
  'error.offline': 'You are offline. Drafts are kept on this device.',
  'empty.tickets': 'Nothing to track',
  'empty.ticketsBody': 'When you report a fault it will appear here with its token.',
  'empty.history': 'No closed tickets yet',
  'empty.raise': 'Report an issue',
  'settings.theme': 'Appearance',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',
  'settings.theme.system': 'System',
  'settings.language': 'Language',
  'settings.account': 'Account',
  'settings.admin': 'Open admin portal',
  'settings.signout': 'Sign out',
  'settings.draftNote': 'Private drafts are cleared on sign out.',
  'draft.label': 'Not yet submitted',
  'draft.restore': 'Continue your draft',
  'status.Submitted': 'Submitted',
  'status.Triaged': 'Triaged',
  'status.Assigned': 'Assigned',
  'status.InProgress': 'In progress',
  'status.OnHold': 'On hold',
  'status.AwaitingApproval': 'Awaiting approval',
  'status.Resolved': 'Resolved',
  'status.Closed': 'Closed',
  'status.Cancelled': 'Cancelled',
  'status.Rejected': 'Rejected',
  'status.Duplicate': 'Duplicate',
} as const

export type TKey = keyof typeof en

const hi: Partial<Record<TKey, string>> = {
  'app.tagline': 'कैंपस रखरखाव',
  'nav.home': 'होम', 'nav.track': 'स्थिति', 'nav.raise': 'दर्ज करें', 'nav.history': 'पुराना', 'nav.settings': 'सेटिंग्स',
  'action.back': 'वापस', 'action.next': 'आगे', 'action.done': 'पूर्ण', 'action.retry': 'फिर कोशिश करें', 'action.cancel': 'रद्द करें', 'action.remove': 'हटाएँ', 'action.search': 'खोजें',
  'login.title': 'साइन इन', 'login.employeeId': 'कर्मचारी आईडी', 'login.password': 'पासवर्ड', 'login.submit': 'साइन इन करें',
  'login.help': 'खाते कॉलेज रोस्टर से टीम OSSC द्वारा बनाए जाते हैं।',
  'home.greeting': 'शिकायत दर्ज करें', 'home.subtitle': 'सुविधा प्रबंधन को सूचित किया जाएगा। ट्रैक करने के लिए टोकन मिलेगा।',
  'home.open': 'प्रगति पर', 'home.awaiting': 'आपके सत्यापन की प्रतीक्षा', 'home.recent': 'हाल के', 'home.seeAll': 'सभी देखें',
  'form.type': 'क्या ठीक करना है?', 'form.subtype': 'कौन सा हिस्सा?', 'form.location': 'कहाँ है?',
  'form.building': 'ब्लॉक', 'form.floor': 'मंज़िल', 'form.room': 'कमरा या क्षेत्र', 'form.outdoors': 'बाहर', 'form.landmark': 'नज़दीकी जगह',
  'form.title': 'छोटा शीर्षक', 'form.description': 'क्या खराब हुआ, कब, और असर', 'form.impact': 'इसका क्या असर है?',
  'form.impact.safety': 'सुरक्षा की समस्या', 'form.impact.class': 'क्लास रुकी है', 'form.impact.multiple': 'कई जगहों पर असर', 'form.impact.routine': 'सामान्य',
  'form.access': 'पहुँच का समय', 'form.evidence': 'फोटो या वीडियो', 'form.evidenceHint': 'वैकल्पिक। upto 3 फोटो, एक छोटा वीडियो।',
  'form.camera': 'फोटो या वीडियो लें', 'form.upload': 'फ़ाइल चुनें', 'form.review': 'समीक्षा', 'form.step': 'चरण {n} / {total}',
  'receipt.title': 'रिपोर्ट मिल गई', 'receipt.body': 'यह टोकन संभालें। सुविधा और श्रमिक को यही नंबर दिखता है।', 'receipt.track': 'टिकट ट्रैक करें', 'receipt.print': 'रसीद प्रिंट करें',
  'detail.timeline': 'प्रगति', 'detail.nextUpdate': 'अगली अपडेट', 'detail.verify': 'सत्यापित कर बंद करें', 'detail.dispute': 'यह ठीक नहीं हुआ', 'detail.reportedAsFixed': 'ठीक होने की सूचना',
  'detail.notYet': 'अभी कोई कार्रवाई नहीं — triage की प्रतीक्षा है।',
  'error.offline': 'आप ऑफ़लाइन हैं। ड्राफ़्ट इस डिवाइस पर रहेंगे।',
  'empty.tickets': 'ट्रैक करने के लिए कुछ नहीं', 'empty.ticketsBody': 'शिकायत दर्ज करने पर वह टोकन के साथ यहाँ दिखेगी।', 'empty.history': 'अभी कोई बंद टिकट नहीं', 'empty.raise': 'शिकायत दर्ज करें',
  'settings.theme': 'रूप', 'settings.theme.light': 'लाइट', 'settings.theme.dark': 'डार्क', 'settings.theme.system': 'सिस्टम', 'settings.language': 'भाषा',
  'settings.account': 'खाता', 'settings.admin': 'एडमिन पोर्टल खोलें', 'settings.signout': 'साइन आउट', 'settings.draftNote': 'साइन आउट पर निजी ड्राफ़्ट हट जाते हैं।',
  'draft.label': 'अभी प्रस्तुत नहीं', 'draft.restore': 'ड्राफ़्ट जारी रखें',
  'status.Submitted': 'दर्ज', 'status.Triaged': 'समीक्षित', 'status.Assigned': 'सौंपा', 'status.InProgress': 'प्रगति पर', 'status.OnHold': 'रुका',
  'status.AwaitingApproval': 'मंज़ूरी की प्रतीक्षा', 'status.Resolved': 'हल हुआ', 'status.Closed': 'बंद', 'status.Cancelled': 'रद्द', 'status.Rejected': 'अस्वीकृत', 'status.Duplicate': 'डुप्लिकेट',
}

const kn: Partial<Record<TKey, string>> = {
  'app.tagline': 'ಕ್ಯಾಂಪಸ್ ನಿರ್ವಹಣೆ',
  'nav.home': 'ಮುಖಪುಟ', 'nav.track': 'ಸ್ಥಿತಿ', 'nav.raise': 'ದಾಖಲೆ', 'nav.history': 'ಇತಿಹಾಸ', 'nav.settings': 'ಸೆಟ್ಟಿಂಗ್',
  'action.back': 'ಹಿಂದೆ', 'action.next': 'ಮುಂದುವರಿಸಿ', 'action.done': 'ಪೂರ್ಣ', 'action.retry': 'ಮತ್ತೆ ಪ್ರಯತ್ನ', 'action.cancel': 'ರದ್ದು', 'action.remove': 'ತೆಗೆದುಹಾಕಿ', 'action.search': 'ಹುಡುಕಿ',
  'login.title': 'ಸೈನ್ ಇನ್', 'login.employeeId': 'ಸಿಬ್ಬಂದಿ ಐಡಿ', 'login.password': 'ಪ್ರವೇಶ ಪದ', 'login.submit': 'ಸೈನ್ ಇನ್ ಮಾಡಿ',
  'login.help': 'ಖಾತೆಗಳನ್ನು ಕಾಲೇಜು ರೋಸ್ಟರ್‌ನಿಂದ ತಂಡ OSSC ರಚಿಸುತ್ತದೆ.',
  'home.greeting': 'ದೋಷ ವರದಿ ಮಾಡಿ', 'home.subtitle': 'ಸೌಲಭ್ಯ ತಂಡಕ್ಕೆ ತಿಳಿಸಲಾಗುತ್ತದೆ. ಟ್ರ್ಯಾಕ್ ಟೋಕನ್ ಸಿಗುತ್ತದೆ.',
  'home.open': 'ಪ್ರಗತಿಯಲ್ಲಿ', 'home.awaiting': 'ನಿಮ್ಮ ದೃಢೀಕರಣದ ಕಾಯುವಿಕೆ', 'home.recent': 'ಇತ್ತೀಚಿನ', 'home.seeAll': 'ಎಲ್ಲಾ ನೋಡಿ',
  'form.type': 'ಏನು ದುರಸ್ತಿ ಬೇಕು?', 'form.subtype': 'ಯಾವ ಭಾಗ?', 'form.location': 'ಎಲ್ಲಿದೆ?',
  'form.building': 'ಬ್ಲಾಕ್', 'form.floor': 'ಮಹಡಿ', 'form.room': 'ಕೊಠಡಿ ಅಥವಾ ಪ್ರದೇಶ', 'form.outdoors': 'ಹೊರಗೆ', 'form.landmark': 'ಸಮೀಪದ ಗುರುತು',
  'form.title': 'ಸಣ್ಣ ಶೀರ್ಷಿಕೆ', 'form.description': 'ಏನು ಕೆಟ್ಟಿತು, ಯಾವಾಗ, ಪರಿಣಾಮ', 'form.impact': 'ಪರಿಣಾಮ ಏನು?',
  'form.impact.safety': 'ಭದ್ರತಾ ಸಮಸ್ಯೆ', 'form.impact.class': 'ತರಗತಿ ಅಡಚಣೆ', 'form.impact.multiple': 'ಹಲವು ಪ್ರದೇಶಗಳ ಪರಿಣಾಮ', 'form.impact.routine': 'ಸಾಮಾನ್ಯ',
  'form.access': 'ಪ್ರವೇಶದ ಸಮಯ', 'form.evidence': 'ಫೋಟೋ ಅಥವಾ ವೀಡಿಯೊ', 'form.evidenceHint': 'ಐಚ್ಛಿಕ. 3 ಫೋಟೋ, 1 ವೀಡಿಯೊ.',
  'form.camera': 'ಫೋಟೋ/ವೀಡಿಯೊ ತೆಗೆಯಿರಿ', 'form.upload': 'ಫೈಲ್ ಆಯ್ಕೆ', 'form.review': 'ಪರಿಶೀಲನೆ', 'form.step': 'ಹಂತ {n} / {total}',
  'receipt.title': 'ವರದಿ ಸ್ವೀಕರಿಸಲಾಗಿದೆ', 'receipt.body': 'ಈ ಟೋಕನ್ ಇಡಿ. ಸೌಲಭ್ಯ ಮತ್ತು ಕಾರ್ಯಕಾರರಿಗೆ ಇದೇ ಸಂಖ್ಯೆ ಕಾಣುತ್ತದೆ.', 'receipt.track': 'ಟಿಕೆಟ್ ಟ್ರ್ಯಾಕ್ ಮಾಡಿ', 'receipt.print': 'ರಸೀದಿ ಮುದ್ರಿಸಿ',
  'detail.timeline': 'ಪ್ರಗತಿ', 'detail.nextUpdate': 'ಮುಂದಿನ ನವೀಕರಣ', 'detail.verify': 'ದೃಢೀಕರಿಸಿ ಮುಚ್ಚಿ', 'detail.dispute': 'ಇದು ಸರಿಹೊಂದಿಲ್ಲ', 'detail.reportedAsFixed': 'ದुरुಸ್ತು ಆದಂತೆ ವರದಿ',
  'detail.notYet': 'ಇನ್ನೂ ಯಾವುದೇ ಕ್ರಮ ಇಲ್ಲ — ಪರಿಶೀಲನೆ ಕಾಯುತ್ತಿದೆ.',
  'error.offline': 'ನೀವು ಆಫ್‌ಲೈನ್‌ನಲ್ಲಿರುವಿರಿ. ಕರಡು ಸಾಧನದಲ್ಲಿ ಉಳಿಯುತ್ತದೆ.',
  'empty.tickets': 'ಟ್ರ್ಯಾಕ್ ಮಾಡಲು ಏನೂ ಇಲ್ಲ', 'empty.ticketsBody': 'ದೋಷ ವರದಿ ಮಾಡಿದಾಗ ಅದು ಟೋಕನ್‌ನೊಂದಿಗೆ ಇಲ್ಲಿ ಕಾಣಿಸುತ್ತದೆ.', 'empty.history': 'ಇನ್ನೂ ಮುಚ್ಚಿದ ಟಿಕೆಟ್ ಇಲ್ಲ', 'empty.raise': 'ದೋಷ ವರದಿ ಮಾಡಿ',
  'settings.theme': 'ಗೋಚರತೆ', 'settings.theme.light': 'ಬೆಳಕು', 'settings.theme.dark': 'ಗಾಢ', 'settings.theme.system': 'ಸಿಸ್ಟಮ್', 'settings.language': 'ಭಾಷೆ',
  'settings.account': 'ಖಾತೆ', 'settings.admin': 'ಆಡಳಿತ ಪೋರ್ಟಲ್ ತೆರೆಯಿರಿ', 'settings.signout': 'ಸೈನ್ ಔಟ್', 'settings.draftNote': 'ಸೈನ್ ಔಟ್‌ನಲ್ಲಿ ಖಾಸಗಿ ಕರಡುಗಳು ತೆಗೆದರಿಸಲ್ಪಡುತ್ತವೆ.',
  'draft.label': 'ಇನ್ನೂ ಸಲ್ಲಿಸಿಲ್ಲ', 'draft.restore': 'ಕರಡು ಮುಂದುವರಿಸಿ',
  'status.Submitted': 'ಸಲ್ಲಿಸಲಾಗಿದೆ', 'status.Triaged': 'ಪರಿಶೀಲಿಸಲಾಗಿದೆ', 'status.Assigned': 'ನಿಯೋಜಿತ', 'status.InProgress': 'ಪ್ರಗತಿಯಲ್ಲಿದೆ', 'status.OnHold': 'ತಾಳಿಗಿಟ್ಟಿದೆ',
  'status.AwaitingApproval': 'ಒಪ್ಪಿಗೆಗಾಗಿ ಕಾಯುತ್ತಿದೆ', 'status.Resolved': 'ಪರಿಹರಿಸಲಾಗಿದೆ', 'status.Closed': 'ಮುಚ್ಚಲಾಗಿದೆ', 'status.Cancelled': 'ರದ್ದುಗೊಳಿಸಿದೆ', 'status.Rejected': 'ತಿರಸ್ಕರಿಸಿದೆ', 'status.Duplicate': 'ನಕಲು',
}

const dicts: Record<Lang, Record<string, string>> = { en: { ...en }, hi: { ...en, ...hi }, kn: { ...en, ...kn } }

const I18nCtx = createContext<{ lang: Lang; t: (k: TKey, vars?: Record<string, string | number>) => string; setLang: (l: Lang) => void }>({
  lang: 'en', t: (k) => en[k], setLang: () => {},
})

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => (localStorage.getItem('pcms.lang') as Lang) || 'en')
  useEffect(() => {
    localStorage.setItem('pcms.lang', lang)
    document.documentElement.lang = lang
  }, [lang])
  const t = (k: TKey, vars?: Record<string, string | number>) => {
    let s = dicts[lang]?.[k] ?? en[k]
    if (vars) for (const [key, v] of Object.entries(vars)) s = s.replaceAll(`{${key}}`, String(v))
    return s
  }
  return <I18nCtx.Provider value={{ lang, t, setLang: setLangState }}>{children}</I18nCtx.Provider>
}
export const useT = () => useContext(I18nCtx)
