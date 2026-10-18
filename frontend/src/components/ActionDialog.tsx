import { useState, type ReactNode } from 'react'
import { Alert, Button, Dialog, Field, Input, Select, Textarea, errorMessage } from './ui'

export interface FormField {
  name: string
  label: string
  type?: 'text' | 'textarea' | 'date' | 'select'
  options?: { value: string; label: string }[]
  required?: boolean
  placeholder?: string
  hint?: string
}

/**
 * A small form in a dialog: used for every staff action that needs a reason,
 * a date or a note. Shows server errors inline and stays open on failure.
 */
export function ActionDialog({ open, onClose, title, description, fields = [], confirmLabel, danger, onSubmit }:
  { open: boolean; onClose: () => void; title: string; description?: ReactNode; fields?: FormField[]; confirmLabel: string; danger?: boolean
    onSubmit: (values: Record<string, string>) => Promise<unknown> }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const missing = fields.some((f) => f.required && !values[f.name]?.trim())

  function close() { setValues({}); setError(null); onClose() }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (missing) return
    setBusy(true); setError(null)
    try {
      await onSubmit(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])))
      close()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={close} title={title}>
      <form onSubmit={submit} className="space-y-4">
        {description && <p className="text-[14px] text-muted">{description}</p>}
        {fields.map((f) => (
          <Field key={f.name} label={f.label} hint={f.hint} optional={!f.required}>
            {(id, d) => f.type === 'select'
              ? <Select id={id} aria-describedby={d} value={values[f.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}>
                  <option value="">Choose...</option>
                  {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              : f.type === 'textarea'
              ? <Textarea id={id} aria-describedby={d} rows={3} maxLength={1000} placeholder={f.placeholder}
                  value={values[f.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} />
              : <Input id={id} aria-describedby={d} type={f.type === 'date' ? 'date' : 'text'} maxLength={500} placeholder={f.placeholder}
                  value={values[f.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} />}
          </Field>
        ))}
        {error && <Alert tone="bad">{error}</Alert>}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={busy} disabled={missing}>{confirmLabel}</Button>
        </div>
      </form>
    </Dialog>
  )
}
