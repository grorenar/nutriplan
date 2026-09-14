/**
 * Moteur nutritionnel — isolé de l'UI et de l'accès aux données.
 * Toutes les fonctions sont pures : elles prennent des données, renvoient des données.
 *
 * Conventions :
 *  - les valeurs nutritionnelles d'un aliment sont TOUJOURS pour 100 g,
 *    exprimées dans son "état de référence" (cru / cuit / égoutté / prêt) ;
 *  - les quantités des ingrédients sont en grammes, dans l'état choisi pour l'ingrédient ;
 *  - la conversion cru <-> cuit utilise le coefficient de l'aliment (cookedFactor).
 */

import { clamp, round } from './util.js';

export const CATEGORIES = [
  { id: 'proteine', label: 'Protéine' },
  { id: 'feculent', label: 'Féculent' },
  { id: 'legume', label: 'Légume' },
  { id: 'fruit', label: 'Fruit' },
  { id: 'laitier', label: 'Produit laitier' },
  { id: 'matiere_grasse', label: 'Matière grasse' },
  { id: 'oleagineux', label: 'Oléagineux' },
  { id: 'autre', label: 'Autre' },
];

export const STATES = [
  { id: 'cru', label: 'Cru' },
  { id: 'cuit', label: 'Cuit' },
  { id: 'egoutte', label: 'Égoutté' },
  { id: 'pret', label: 'Prêt à consommer' },
];

export const PERSONS = ['thomas', 'julie'];
export const PERSON_LABEL = { thomas: 'Thomas', julie: 'Julie' };

export const MEAL_TYPES = {
  breakfast: 'Petit-déjeuner',
  lunch: 'Déjeuner',
  snack_afternoon: 'Collation 16 h',
  dinner: 'Dîner',
  snack_evening: 'Collation du soir',
  day: 'Journée',
};

/**
 * Profils par catégorie : bornes raisonnables (en grammes, dans l'état de l'ingrédient)
 * et force d'ancrage. Plus l'ancrage est élevé, moins l'algorithme se permet de
 * s'éloigner de la quantité actuelle.
 *   -> les légumes et les fruits sont fortement ancrés : ils ne servent jamais
 *      de variable d'ajustement pour "remplir" les calories.
 */
export const CATEGORY_PROFILE = {
  proteine: { min: 50, max: 250, def: 150, anchor: 0.05, step: 5 },
  feculent: { min: 20, max: 400, def: 90, anchor: 0.03, step: 5 },
  legume: { min: 60, max: 320, def: 200, anchor: 40, step: 10 },
  fruit: { min: 30, max: 260, def: 120, anchor: 15, step: 10 },
  laitier: { min: 40, max: 500, def: 150, anchor: 0.08, step: 5 },
  matiere_grasse: { min: 2, max: 45, def: 10, anchor: 0.03, step: 1 },
  oleagineux: { min: 5, max: 80, def: 20, anchor: 0.8, step: 5 },
  autre: { min: 5, max: 300, def: 60, anchor: 2.0, step: 5 },
};

export const profileOf = (food) => CATEGORY_PROFILE[food?.category] || CATEGORY_PROFILE.autre;

/* ------------------------------------------------------------------ */
/* Conversion d'état                                                   */
/* ------------------------------------------------------------------ */

/**
 * Convertit une quantité exprimée dans `fromState` vers `toState`.
 * Seul le couple cru <-> cuit modifie le poids (coefficient de l'aliment).
 */
export function convertGrams(food, qty, fromState, toState) {
  if (!food || !qty || fromState === toState) return qty;
  const f = Number(food.cookedFactor) > 0 ? Number(food.cookedFactor) : 1;
  if (fromState === 'cru' && toState === 'cuit') return qty * f;
  if (fromState === 'cuit' && toState === 'cru') return qty / f;
  return qty; // égoutté / prêt : pas de conversion automatique
}

/** Quantité ramenée à l'état de référence de l'aliment (base de tous les calculs). */
export function toReferenceGrams(food, qty, itemState) {
  return convertGrams(food, qty, itemState || food.referenceState, food.referenceState);
}

/* ------------------------------------------------------------------ */
/* Calcul des macros                                                   */
/* ------------------------------------------------------------------ */

export const emptyMacros = () => ({ kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });

/** Macros d'un ingrédient pour une quantité donnée. */
export function macrosFor(food, qty, itemState) {
  const m = emptyMacros();
  if (!food || !qty) return m;
  const g = toReferenceGrams(food, qty, itemState) / 100;
  m.kcal = (food.kcal || 0) * g;
  m.protein = (food.protein || 0) * g;
  m.carbs = (food.carbs || 0) * g;
  m.fat = (food.fat || 0) * g;
  m.fiber = (food.fiber || 0) * g;
  return m;
}

/** Macros totales d'une liste d'ingrédients pour une personne. */
export function mealMacros(items, foodsById, person) {
  const total = emptyMacros();
  for (const it of items) {
    if (!it.foodId) continue; // ingrédient libre : ne participe pas aux macros
    const food = foodsById[it.foodId];
    if (!food) continue;
    const m = macrosFor(food, it.qty?.[person] || 0, it.state);
    total.kcal += m.kcal;
    total.protein += m.protein;
    total.carbs += m.carbs;
    total.fat += m.fat;
    total.fiber += m.fiber;
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* Écarts / tolérance                                                  */
/* ------------------------------------------------------------------ */

export const MACRO_KEYS = [
  { key: 'kcal', target: 'kcal', label: 'kcal', unit: '' },
  { key: 'protein', target: 'protein', label: 'P', unit: 'g' },
  { key: 'carbs', target: 'carbs', label: 'G', unit: 'g' },
  { key: 'fat', target: 'fat', label: 'L', unit: 'g' },
];

/**
 * Statut d'une valeur par rapport à sa cible.
 *  ok   : dans ±tolérance (5 % par défaut)
 *  warn : hors cible mais proche (jusqu'à 3× la tolérance)
 *  off  : très éloigné
 */
export function statusFor(value, target, tolerance = 0.05) {
  if (!target) return 'none';
  const dev = Math.abs(value - target) / target;
  if (dev <= tolerance) return 'ok';
  if (dev <= tolerance * 3) return 'warn';
  return 'off';
}

/** Évaluation complète d'un repas pour une personne. */
export function evaluate(macros, target, tolerance = 0.05) {
  const rows = MACRO_KEYS.map(({ key, label }) => {
    const value = macros[key] || 0;
    const goal = target?.[key] || 0;
    return {
      key,
      label,
      value,
      target: goal,
      delta: value - goal,
      status: statusFor(value, goal, tolerance),
    };
  });
  const worst = rows.reduce(
    (acc, r) => (r.status === 'off' ? 'off' : r.status === 'warn' && acc !== 'off' ? 'warn' : acc),
    'ok'
  );
  return { rows, status: worst };
}

/* ------------------------------------------------------------------ */
/* Ajustement automatique                                              */
/* ------------------------------------------------------------------ */

/** Poids relatifs des macros dans la fonction de coût. */
/**
 * Les kcal sont une grandeur LARGEMENT REDONDANTE avec P/C/L (≈ 4P + 4C + 9L).
 * Leur donner le même poids que les macros pousse l'algorithme à gonfler les protéines
 * et les glucides pour compenser des calories manquantes (typiquement quand aucune
 * matière grasse n'est présente). On les pondère donc faiblement : les macros pilotent,
 * les calories suivent, et l'écart calorique restant est signalé à l'utilisateur.
 */
const WEIGHTS = { kcal: 0.35, protein: 1.4, carbs: 1.0, fat: 1.0 };

/** Arrondi final tenant compte des unités non fractionnables. */
/** Un aliment est-il saisi par unités entières ? (générique : tout aliment non fractionnable) */
export const isUnitFood = (food) => Boolean(food && Number(food.gramsPerUnit) > 0);
export const isWholeUnitFood = (food) => isUnitFood(food) && food.fractionable === false;

/** Grammes -> unités (nombre décimal). */
export const toUnits = (food, grams) => (isUnitFood(food) ? grams / Number(food.gramsPerUnit) : null);

/** Unités -> grammes. */
export const fromUnits = (food, units) => (isUnitFood(food) ? units * Number(food.gramsPerUnit) : units);

/**
 * Rendement après cuisson : coefficient = poids cuit ÷ poids cru.
 * Fonction pure, utilisée par l'aide au calcul de la fiche aliment.
 *   500 g crus → 375 g cuits  ⇒  0,75
 *   500 g crus → 1000 g cuits ⇒  2
 * @returns {{ ok: true, factor: number } | { ok: false, error: string }}
 */
export function computeYield(rawInput, cookedInput) {
  const parse = (v) => {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  };
  const raw = parse(rawInput);
  const cooked = parse(cookedInput);

  if (raw === null || cooked === null) return { ok: false, error: 'Renseigne le poids cru et le poids cuit.' };
  if (Number.isNaN(raw) || Number.isNaN(cooked)) return { ok: false, error: 'Les poids doivent être des nombres.' };
  if (raw < 0 || cooked < 0) return { ok: false, error: 'Les poids ne peuvent pas être négatifs.' };
  if (raw === 0) return { ok: false, error: 'Le poids cru ne peut pas être nul.' };
  if (cooked === 0) return { ok: false, error: 'Le poids cuit ne peut pas être nul.' };

  return { ok: true, factor: Math.round((cooked / raw) * 10000) / 10000 };
}

/** Pas de saisie d'une quantité : le poids d'une unité pour un aliment non fractionnable. */
export function quantityStep(food, { inUnits = false } = {}) {
  if (inUnits) return isWholeUnitFood(food) ? 1 : 0.5;
  if (isWholeUnitFood(food)) return Number(food.gramsPerUnit);
  return 1;
}

/**
 * Contrainte ABSOLUE sur les quantités : un aliment non fractionnable ne peut
 * exister qu'en multiples entiers de gramsPerUnit, quelle que soit la manière
 * dont la quantité a été obtenue (saisie en grammes, saisie en unités,
 * ajustement automatique, duplication, import…).
 * 0 g reste possible : l'ingrédient est alors simplement absent pour la personne.
 */
export function snapQuantity(food, qty) {
  const value = Math.max(0, Number(qty) || 0);
  if (!isWholeUnitFood(food)) return value;
  if (value <= 0) return 0;
  const g = Number(food.gramsPerUnit);
  return Math.max(1, Math.round(value / g)) * g;
}

export function roundQuantity(food, qty, min = 0, max = Infinity) {
  const p = profileOf(food);
  // Aliment non fractionnable : uniquement des unités entières (jamais 1,37 œuf).
  if (isWholeUnitFood(food)) {
    const g = Number(food.gramsPerUnit);
    let units = Math.max(1, Math.round(qty / g));
    if (units * g > max) units = Math.max(1, Math.floor(max / g));
    if (units * g < min) units = Math.ceil(min / g);
    return units * g;
  }
  // Aliment fractionnable : l'unité n'est qu'un confort d'affichage,
  // l'arrondi suit le pas de la catégorie (sinon une c. à soupe d'huile
  // imposerait des paliers de 5 g et empêcherait d'atteindre la cible).
  return Math.max(p.step, round(qty, p.step));
}

/**
 * Quantité initiale proposée lors de l'ajout d'un aliment.
 * On part du défaut de catégorie ; l'ajustement continu fera le reste.
 */
export function initialQuantity(food) {
  const p = profileOf(food);
  return roundQuantity(food, p.def);
}

/**
 * Cœur de l'application : ajuste les quantités des ingrédients DÉVERROUILLÉS
 * pour rapprocher simultanément kcal / P / G / L des objectifs.
 *
 * Méthode : descente par coordonnées sur un coût quadratique convexe
 *   coût = Σ_macro  w · ((valeur - cible) / cible)²  +  Σ_ingrédient  λ · ((q - q₀) / échelle)²
 * avec bornes par catégorie. Le terme d'ancrage (λ) empêche les compositions absurdes :
 * les légumes et les fruits, fortement ancrés, ne bougent quasiment pas.
 *
 * Garanties :
 *  - aucun ingrédient n'est ajouté ni supprimé ;
 *  - un ingrédient verrouillé n'est jamais modifié ;
 *  - les ingrédients libres (sans foodId) sont ignorés.
 *
 * @returns {{quantities: Object<string, number>, changed: boolean}}
 *          quantités par identifiant d'ingrédient (seuls les déverrouillés changent).
 */
export function adjustQuantities(items, foodsById, target, person, options = {}) {
  const iterations = options.iterations ?? 260;
  const result = {};
  if (!target) return { quantities: result, changed: false };

  const vars = [];
  const fixed = { kcal: 0, protein: 0, carbs: 0, fat: 0 };

  const pinned = new Set(options.pinned || []);

  for (const it of items) {
    const qty = it.qty?.[person] || 0;
    if (!it.foodId) continue;
    // quantité nulle = ingrédient absent pour cette personne : on l'ignore
    if (qty <= 0) continue;
    const food = foodsById[it.foodId];
    if (!food) continue;
    // "épinglé" = quantité saisie à l'instant par l'utilisateur : traitée comme fixe
    const locked = !!it.locked?.[person] || pinned.has(it.id);
    const m = macrosFor(food, qty, it.state);
    const hasEnergy = (food.kcal || 0) > 0 || (food.protein || 0) > 0 || (food.carbs || 0) > 0 || (food.fat || 0) > 0;

    if (locked || !hasEnergy) {
      fixed.kcal += m.kcal;
      fixed.protein += m.protein;
      fixed.carbs += m.carbs;
      fixed.fat += m.fat;
      continue;
    }

    // contribution par gramme (dans l'état de l'ingrédient)
    const per1 = macrosFor(food, 1, it.state);
    const p = profileOf(food);
    vars.push({
      id: it.id,
      food,
      per1,
      min: p.min,
      max: p.max,
      anchor: p.anchor,
      // ancrage sur la quantité actuelle
      q0: qty,
      q: qty,
    });
  }

  if (!vars.length) return { quantities: result, changed: false };

  const t = {
    kcal: Math.max(1, target.kcal || 0),
    protein: Math.max(1, target.protein || 0),
    carbs: Math.max(1, target.carbs || 0),
    fat: Math.max(1, target.fat || 0),
  };
  const keys = ['kcal', 'protein', 'carbs', 'fat'];

  // somme courante des contributions variables
  const sum = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const v of vars) for (const k of keys) sum[k] += v.per1[k] * v.q;

  /**
   * Pondération robuste (IRLS / Huber) : au-delà de DELTA d'écart relatif, l'influence
   * d'une macro cesse de croître. Sans cela, une macro structurellement inatteignable
   * (aucune matière grasse dans le repas, par exemple) tire les autres aliments vers le
   * haut et fait sortir protéines et glucides de leur cible. Avec, les macros atteignables
   * restent sur leur objectif et le manque est simplement signalé.
   */
  const DELTA = 0.15;
  const effW = { ...WEIGHTS };

  for (let iter = 0; iter < iterations; iter++) {
    let move = 0;
    for (const k of keys) {
      const rel = Math.abs((sum[k] + fixed[k] - t[k]) / t[k]);
      effW[k] = WEIGHTS[k] * (rel > DELTA ? DELTA / rel : 1);
    }
    for (const v of vars) {
      // retrait de la contribution de la variable courante
      for (const k of keys) sum[k] -= v.per1[k] * v.q;

      let numer = 0;
      let denom = 0;
      for (const k of keys) {
        const c = v.per1[k];
        if (!c) continue;
        const w = effW[k] / (t[k] * t[k]);
        const rest = sum[k] + fixed[k];
        numer += w * c * (t[k] - rest);
        denom += w * c * c;
      }
      // L'optimum est D'ABORD borné, PUIS mélangé à la quantité actuelle (ancrage relatif).
      // Borner avant le mélange est essentiel : sans cela, un optimum théorique absurde
      // (3,5 kg de haricots verts pour atteindre 1050 kcal) tire quand même la quantité
      // vers le haut malgré un ancrage fort.
      const best = clamp(denom > 0 ? numer / denom : v.q, v.min, v.max);
      const next = clamp((best + v.anchor * v.q0) / (1 + v.anchor), v.min, v.max);
      move = Math.max(move, Math.abs(next - v.q));
      v.q = next;

      for (const k of keys) sum[k] += v.per1[k] * v.q;
    }
    if (move < 0.05) break;
  }

  let changed = false;
  for (const v of vars) {
    const rounded = roundQuantity(v.food, clamp(v.q, v.min, v.max), v.min, v.max);
    result[v.id] = rounded;
    if (Math.abs(rounded - (items.find((i) => i.id === v.id)?.qty?.[person] || 0)) > 0.001) changed = true;
  }
  return { quantities: result, changed };
}

/**
 * Applique l'ajustement automatique sur une liste d'ingrédients (mutation locale
 * d'une copie) pour les deux personnes, en fonction des objectifs du repas.
 */
export function autoAdjust(items, foodsById, targets, options = {}) {
  const persons = options.persons || PERSONS;
  for (const person of persons) {
    const { quantities } = adjustQuantities(items, foodsById, targets[person], person, options);
    for (const it of items) {
      if (quantities[it.id] !== undefined) {
        it.qty[person] = quantities[it.id];
      }
    }
  }
  return items;
}

/**
 * Diagnostic : qu'est-ce qui manque / est en excès quand la cible n'est pas atteignable ?
 * Ne modifie rien, ne propose que de l'information.
 */
export function diagnose(macros, target, foods, tolerance = 0.05) {
  const ev = evaluate(macros, target, tolerance);
  const problems = ev.rows.filter((r) => r.status !== 'ok');
  if (!problems.length) return null;

  const suggestions = [];
  for (const p of problems) {
    const missing = p.delta < 0;
    if (p.key === 'protein' && missing) suggestions.push('protéine maigre (blanc de poulet, skyr, whey)');
    if (p.key === 'carbs' && missing) suggestions.push('féculent (riz, pâtes, pain)');
    if (p.key === 'fat' && missing) suggestions.push('matière grasse (huile, oléagineux)');
    if (p.key === 'kcal' && missing && !suggestions.length) suggestions.push('féculent ou matière grasse');
  }
  return {
    rows: problems,
    suggestions: [...new Set(suggestions)],
  };
}
