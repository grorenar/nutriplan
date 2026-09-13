/**
 * Couche de données locale.
 *  - état applicatif unique (objet JSON) ;
 *  - persistance immédiate dans localStorage (fonctionne hors ligne) ;
 *  - marquage "dirty" pour la resynchronisation Supabase ;
 *  - export / import JSON.
 *
 * L'UI ne modifie JAMAIS l'état directement : elle passe par update().
 */

import { STORAGE_KEY } from '../config.js';
import { uid, deepCopy } from './util.js';
import { seedFoods } from './seed-foods.js';

export const DEFAULT_TARGETS = {
  thomas: {
    day: { kcal: 3500, protein: 195, carbs: 395, fat: 115 },
    breakfast: { kcal: 850, protein: 40, carbs: 100, fat: 30 },
    lunch: { kcal: 1050, protein: 55, carbs: 120, fat: 35 },
    snack_afternoon: { kcal: 350, protein: 25, carbs: 40, fat: 10 },
    dinner: { kcal: 1050, protein: 55, carbs: 120, fat: 35 },
    snack_evening: { kcal: 200, protein: 20, carbs: 15, fat: 5 },
  },
  julie: {
    day: { kcal: 2450, protein: 145, carbs: 265, fat: 81 },
    breakfast: { kcal: 550, protein: 30, carbs: 60, fat: 18 },
    lunch: { kcal: 750, protein: 40, carbs: 85, fat: 25 },
    snack_afternoon: { kcal: 300, protein: 20, carbs: 35, fat: 8 },
    dinner: { kcal: 700, protein: 40, carbs: 75, fat: 25 },
    snack_evening: { kcal: 150, protein: 15, carbs: 10, fat: 5 },
  },
};

export function defaultState() {
  return {
    version: 1,
    foods: seedFoods(),
    settings: {
      targets: deepCopy(DEFAULT_TARGETS),
      tolerance: 0.05,
      cycle: { startWeekday: 1, duration: 4 }, // 0 = Lundi
      budget: 100,
      batch: { enabled: true, maxDays: 3 },
      autoAdjust: true,
    },
    meals: [], // repas du cycle en cours (déjeuners / dîners uniquement)
    breakfasts: [],
    snacksAfternoon: [],
    snacksEvening: [],
    shopping: { purchased: {} }, // foodId -> bool
    batch: { overrides: {} }, // `${session}:${foodId}` -> grammes préparés
    meta: { updatedAt: new Date().toISOString(), dirty: false, syncedAt: null, syncError: null },
  };
}

let state = null;
const listeners = new Set();

/* ------------------------------------------------------------------ */
/* Chargement / sauvegarde                                             */
/* ------------------------------------------------------------------ */

export function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    state = raw ? migrate(JSON.parse(raw)) : defaultState();
  } catch (e) {
    console.warn('État local illisible, réinitialisation.', e);
    state = defaultState();
  }
  ensureCycleMeals(state);
  return state;
}

/** Complète un aliment venant d'une version antérieure (ou d'un import partiel). */
export function normalizeFood(f) {
  return {
    brand: '', fiber: 0, cookedFactor: 1, unitName: '', gramsPerUnit: 0, fractionable: true,
    price: null, packageWeight: null, batchAllowed: false, favorite: false, lastUsed: null,
    cookingMethod: '', cookingTemp: null, cookingTime: null, prepTime: null, equipment: '', instructions: '',
    ...f,
    // saisie par unités entières par défaut pour un aliment non fractionnable
    unitEntry: f.unitEntry ?? (Number(f.gramsPerUnit) > 0 && f.fractionable === false),
  };
}

const normalizeOption = (o) => ({ cycleUses: 0, sameComposition: true, items: [], ...o });

function migrate(s) {
  const base = defaultState();
  const merged = { ...base, ...s };
  merged.settings = { ...base.settings, ...(s.settings || {}) };
  merged.settings.targets = { ...base.settings.targets, ...(s.settings?.targets || {}) };
  merged.settings.cycle = { ...base.settings.cycle, ...(s.settings?.cycle || {}) };
  merged.settings.batch = { ...base.settings.batch, ...(s.settings?.batch || {}) };
  merged.shopping = { purchased: {}, ...(s.shopping || {}) };
  merged.batch = { overrides: {}, ...(s.batch || {}) };
  merged.meta = { ...base.meta, ...(s.meta || {}) };
  if (!Array.isArray(merged.foods) || !merged.foods.length) merged.foods = seedFoods();
  merged.foods = merged.foods.map(normalizeFood);
  for (const key of ['breakfasts', 'snacksAfternoon', 'snacksEvening']) {
    merged[key] = (merged[key] || []).map(normalizeOption);
  }
  return merged;
}

export function getState() {
  if (!state) load();
  return state;
}

export function persist() {
  state.meta.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Sauvegarde locale impossible', e);
  }
}

/** Applique une mutation puis notifie l'UI. */
export function update(mutator, { silent = false, sync = true } = {}) {
  const s = getState();
  mutator(s);
  if (sync) s.meta.dirty = true;
  persist();
  if (!silent) emit();
  return s;
}

/** Remplace tout l'état (import, synchronisation descendante). */
export function replaceState(next, { dirty = false } = {}) {
  state = migrate(next);
  state.meta.dirty = dirty;
  ensureCycleMeals(state);
  persist();
  emit();
}

/* ---------------------------------------------------------------- */
/* Sauvegarde locale de secours                                       */
/* ---------------------------------------------------------------- */

const BACKUP_KEY = `${STORAGE_KEY}.backup`;

/** Copie l'état local avant une opération destructive (récupération cloud). */
export function backupLocal() {
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify({ savedAt: new Date().toISOString(), state: getState() }));
    return true;
  } catch (e) {
    console.warn('Sauvegarde de secours impossible', e);
    return false;
  }
}

/** Date de la sauvegarde de secours, ou null. */
export function backupInfo() {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    return raw ? { savedAt: JSON.parse(raw).savedAt } : null;
  } catch { return null; }
}

/** Restaure la sauvegarde de secours (état d'avant la dernière récupération). */
export function restoreBackup() {
  const raw = localStorage.getItem(BACKUP_KEY);
  if (!raw) throw new Error('Aucune sauvegarde locale disponible');
  replaceState(JSON.parse(raw).state, { dirty: true });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) fn(state);
}

/* ------------------------------------------------------------------ */
/* Helpers de domaine                                                  */
/* ------------------------------------------------------------------ */

export function foodsById() {
  const map = {};
  for (const f of getState().foods) map[f.id] = f;
  return map;
}

export const newItem = (foodId, qty = 0, itemState = null) => ({
  id: uid('it'),
  foodId,
  free: null,
  state: itemState,
  qty: { thomas: qty, julie: qty },
  locked: { thomas: false, julie: false },
});

export const newFreeItem = (name, quantity) => ({
  id: uid('it'),
  foodId: null,
  free: { name, quantity },
  state: null,
  qty: { thomas: 0, julie: 0 },
  locked: { thomas: false, julie: false },
});

export const newMeal = (dayIndex, mealType) => ({
  id: uid('meal'),
  dayIndex,
  mealType,
  name: '',
  sameComposition: true,
  items: [],
});

export const newOption = (name = '') => ({
  id: uid('opt'),
  name,
  sameComposition: true,
  // nombre de fois où l'option est utilisée dans le cycle en cours (0 = non utilisée).
  // C'est ce compteur — et uniquement lui — qui fait entrer les aliments d'un
  // catalogue dans les courses, sans rattacher l'option à un jour ni à une date.
  cycleUses: 0,
  items: [],
});

/** Crée les créneaux déjeuner/dîner manquants et supprime ceux hors cycle. */
export function ensureCycleMeals(s = getState()) {
  const days = s.settings.cycle.duration;
  s.meals = s.meals.filter((m) => m.dayIndex < days);
  for (let d = 0; d < days; d++) {
    for (const type of ['lunch', 'dinner']) {
      if (!s.meals.some((m) => m.dayIndex === d && m.mealType === type)) {
        s.meals.push(newMeal(d, type));
      }
    }
  }
  s.meals.sort((a, b) => a.dayIndex - b.dayIndex || (a.mealType === 'lunch' ? -1 : 1));
  return s;
}

export function catalogKey(type) {
  return { breakfast: 'breakfasts', snack_afternoon: 'snacksAfternoon', snack_evening: 'snacksEvening' }[type];
}

/* ------------------------------------------------------------------ */
/* Export / import                                                     */
/* ------------------------------------------------------------------ */

export function exportJSON() {
  return JSON.stringify({ ...getState(), exportedAt: new Date().toISOString() }, null, 2);
}

export function importJSON(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object') throw new Error('Fichier invalide');
  if (!Array.isArray(data.foods)) throw new Error('Fichier invalide : banque alimentaire absente');
  replaceState(data, { dirty: true });
}

/** Réinitialise uniquement le cycle en cours. */
export function resetCycle() {
  update((s) => {
    s.meals = [];
    s.shopping = { purchased: {} };
    s.batch = { overrides: {} };
    // les catalogues sont conservés : seul leur compteur d'utilisation du cycle repart à zéro
    for (const key of ['breakfasts', 'snacksAfternoon', 'snacksEvening']) {
      for (const o of s[key]) o.cycleUses = 0;
    }
    ensureCycleMeals(s);
  });
}
