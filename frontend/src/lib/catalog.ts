/**
 * Categories and buildings come from GET /catalogs. The app loads them once
 * after sign-in, before any screen that needs them renders, so lookups here
 * are synchronous.
 *
 * Two caches, on purpose:
 *   - the active list, which is what the report form offers, so a retired type
 *     can never be picked for a new report;
 *   - the full list, so old tickets keep their retired type or place name instead
 *     of showing a raw code. Administration screens also use it to restore rows.
 *
 * `category()` falls back to a placeholder only when even the full list is missing.
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

/** Load the active list and the full list. Called once after sign-in and after a catalog change. */
export async function loadCatalogs(force = false): Promise<void> {
  if (loaded && !force) return
  const [nextActive, nextAll] = await Promise.all([fetchCatalogs(false), fetchCatalogs(true)])
  active = nextActive
  all = nextAll
  loaded = true
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
