/**
 * Categories and buildings come from GET /catalogs. The app loads them once
 * after sign-in, before any screen that needs them renders, so lookups here
 * are synchronous.
 *
 * Two caches, on purpose:
 *   - the active list, which is what the report form and every lookup use, so a
 *     retired type can never be picked for a new report;
 *   - the full list, loaded only by the administration screens so a retired row
 *     stays visible and can be restored instead of silently disappearing.
 *
 * Old tickets keep rendering either way: `category()` falls back to a placeholder
 * for a code that is not in the active list.
 */
import { request } from './http'
import type { Building, Category } from './types'

interface Catalogs { categories: Category[]; buildings: Building[] }

let active: Catalogs = { categories: [], buildings: [] }
let all: Catalogs | null = null
let loaded = false

async function fetchCatalogs(includeInactive: boolean): Promise<Catalogs> {
  return request<Catalogs>('GET', includeInactive ? '/catalogs?includeInactive=true' : '/catalogs')
}

/** Load the active list. Called once after sign-in and after a catalog change. */
export async function loadCatalogs(force = false): Promise<void> {
  if (loaded && !force) return
  active = await fetchCatalogs(false)
  loaded = true
  // The active list changed, so anything derived from the full list is stale too.
  all = null
}

/** Load the full list including retired rows. Administration screens only. */
export async function loadAllCatalogs(force = false): Promise<void> {
  if (all !== null && !force) return
  all = await fetchCatalogs(true)
}

export function resetCatalogs() {
  active = { categories: [], buildings: [] }
  all = null
  loaded = false
}

export const categories = (): Category[] => active.categories
export const buildings = (): Building[] => active.buildings

/** Every category including retired ones, for the Types administration tab. */
export const allCategories = (): Category[] => all?.categories ?? []
/** Every building including retired ones, for the Places administration tab. */
export const allBuildings = (): Building[] => all?.buildings ?? []

/** Unknown or retired codes still render (old tickets keep their category). */
export function category(code: string): Category {
  return active.categories.find((c) => c.code === code)
    ?? all?.categories.find((c) => c.code === code)
    ?? { code, letter: '?', nameEn: code, nameHi: code, subtypesEn: [], subtypesHi: [], active: false }
}

export function building(code: string): Building | undefined {
  return active.buildings.find((b) => b.code === code)
    ?? all?.buildings.find((b) => b.code === code)
}
