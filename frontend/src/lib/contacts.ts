/**
 * Importing worker contacts.
 *  - Phone: the Contact Picker API (Android Chrome over HTTPS). The person picks
 *    contacts; nothing is read without their choice.
 *  - Elsewhere: a contacts file exported from the phone (.vcf) or a CSV with name,phone.
 */
export interface PickedContact { name: string; phone: string }

interface ContactsManager { select: (props: string[], opts: { multiple: boolean }) => Promise<{ name?: string[]; tel?: string[] }[]> }

export function canPickContacts(): boolean {
  return 'contacts' in navigator && 'ContactsManager' in window && window.isSecureContext
}

export async function pickContacts(): Promise<PickedContact[]> {
  const mgr = (navigator as unknown as { contacts: ContactsManager }).contacts
  const picked = await mgr.select(['name', 'tel'], { multiple: true })
  return dedupe(picked.flatMap((c) => {
    const name = (c.name?.[0] ?? '').trim()
    const tel = (c.tel ?? []).find((n) => digits(n).length >= 10) ?? c.tel?.[0]
    return name && tel ? [{ name, phone: tel.trim() }] : []
  }))
}

const digits = (s: string) => s.replace(/\D/g, '')

function dedupe(list: PickedContact[]): PickedContact[] {
  const seen = new Set<string>()
  return list.filter((c) => {
    const key = digits(c.phone).slice(-10)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Parses vCard (.vcf) or a CSV with a header containing name and phone/mobile. */
export function parseContactsFile(text: string): PickedContact[] {
  const clean = text.replace(/^\uFEFF/, '')
  if (/BEGIN:VCARD/i.test(clean)) {
    const out: PickedContact[] = []
    // Unfold continuation lines (RFC 6350 section 3.2).
    const unfolded = clean.replace(/\r?\n[ \t]/g, '')
    for (const card of unfolded.split(/BEGIN:VCARD/i).slice(1)) {
      const fn = card.match(/^FN[^:\r\n]*:(.+)$/im)?.[1]
      const n = card.match(/^N[^:\r\n]*:(.+)$/im)?.[1]
      const tel = card.match(/^TEL[^:\r\n]*:(.+)$/im)?.[1]
      const name = (fn ?? n?.split(';').filter(Boolean).reverse().join(' ') ?? '').replace(/\\,/g, ',').trim()
      if (name && tel) out.push({ name, phone: tel.trim() })
    }
    return dedupe(out)
  }
  const lines = clean.split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []
  const header = lines[0].toLowerCase().split(',').map((h) => h.trim().replace(/"/g, ''))
  const ni = header.findIndex((h) => h.includes('name'))
  const pi = header.findIndex((h) => /phone|mobile|tel|number/.test(h))
  if (ni < 0 || pi < 0) return []
  return dedupe(lines.slice(1).map((l) => {
    const cells = l.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
    return { name: cells[ni] ?? '', phone: cells[pi] ?? '' }
  }).filter((c) => c.name && c.phone))
}
