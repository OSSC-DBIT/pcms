/**
 * Categories and buildings come from GET /catalogs. The app loads them once
 * after sign-in, before any screen that needs them renders, so lookups here
 * are synchronous.
 */
import { request } from './http'
import type { Building, Category } from './types'

let cats: Category[] = []
let blds: Building[] = []
let loaded = false

export async function loadCatalogs(force = false): Promise<void> {
  if (loaded && !force) return
  const data = await request<{ categories: Category[]; buildings: Building[] }>('GET', '/catalogs')
  cats = data.categories
  blds = data.buildings
  loaded = true
}

export function resetCatalogs() {
  cats = []
  blds = []
  loaded = false
}

export const categories = (): Category[] => cats
export const buildings = (): Building[] => blds

/** Unknown or retired codes still render (old tickets keep their category). */
export function category(code: string): Category {
  return cats.find((c) => c.code === code)
    ?? { code, letter: '?', nameEn: code, nameHi: code, subtypesEn: [], subtypesHi: [], active: false }
}

export function building(code: string): Building | undefined {
  return blds.find((b) => b.code === code)
}
