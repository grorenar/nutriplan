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
  { id: 'legumineuse', label: 'Légumineuse' },
  { id: 'legume', label: 'Légume' },
  { id: 'fruit', label: 'Fruit' },
  { id: 'laitier', label: 'Produit laitier' },
  { id: 'matiere_grasse', label: 'Matière grasse' },
  { id: 'oleagineux', label: 'Noix & graines' },
  { id: 'autre', label: 'Autre' },
];

export const STATES = [
  { id: 'cru', label: 'Cru / brut' },
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
 * Profils par catégorie : bornes raisonnables (en grammes, dans l'état de l'ingrédient),
 * portion type (`def` = réf_cat) et énergie type d'une portion (`eCat` = E_cat).
 * Ces deux derniers nombres alimentent `referenceFor()` : un point de départ pour des
 * proportions réalistes, jamais une cible nutritionnelle.
 */
export const CATEGORY_PROFILE = {
  proteine: { min: 50, max: 250, def: 150, eCat: 164, step: 5 },
  feculent: { min: 20, max: 400, def: 90, eCat: 266, step: 5 },
  legumineuse: { min: 40, max: 300, def: 150, eCat: 207, step: 5 },
  legume: { min: 60, max: 320, def: 200, eCat: 65, step: 10 },
  fruit: { min: 30, max: 260, def: 120, eCat: 78, step: 10 },
  laitier: { min: 40, max: 500, def: 150, eCat: 112, step: 5 },
  matiere_grasse: { min: 2, max: 45, def: 10, eCat: 90, step: 1 },
  oleagineux: { min: 5, max: 80, def: 20, eCat: 148, step: 5 },
  autre: { min: 5, max: 300, def: 60, eCat: 100, step: 5 },
};

export const profileOf = (food) => CATEGORY_PROFILE[food?.category] || CATEGORY_PROFILE.autre;

/**
 * Référence de portion pour un aliment (architecture C) : moyenne géométrique
 * entre une référence en masse (réf_cat, la portion type de la catégorie) et
 * une référence iso-énergétique (réf_cat × E_cat / densité), bornée à
 * [réf_cat/3, réf_cat×3] pour les densités extrêmes.
 *   réf = clamp( √(réf_cat × E_cat × 100 / densité) , réf_cat/3 , réf_cat×3 )
 * C'est un point de départ pour des proportions réalistes, jamais une cible
 * nutritionnelle : l'optimiseur peut s'en écarter librement.
 */
export function referenceFor(food) {
  const p = profileOf(food);
  const density = Number(food?.kcal) || 0;
  if (density <= 0) return p.def;
  const raw = Math.sqrt((p.def * p.eCat * 100) / density);
  return clamp(raw, p.def / 3, p.def * 3);
}

/* ------------------------------------------------------------------ */
/* Conversion d'état                                                   */
/* ------------------------------------------------------------------ */

/** Le rendement après cuisson de l'aliment est-il exploitable ? */
const cookedFactorOf = (food) => {
  const f = Number(food?.cookedFactor);
  return Number.isFinite(f) && f > 0 ? f : null;
};

/**
 * Une conversion entre deux états est-elle définie pour cet aliment ?
 * Seul le couple cru <-> cuit dispose d'un coefficient (le rendement après
 * cuisson). Aucun coefficient n'est inventé pour « égoutté » ou « prêt à
 * consommer » : ces états ne se convertissent pas.
 */
export function canConvert(food, fromState, toState) {
  if (!fromState || !toState || fromState === toState) return true;
  const pair = [fromState, toState].sort().join('-'); // "cru-cuit"
  if (pair !== 'cru-cuit') return false;
  return cookedFactorOf(food) !== null;
}

/**
 * État de la conversion nécessaire entre l'état saisi dans le repas et l'état
 * des valeurs nutritionnelles de l'aliment. Sert à prévenir l'utilisateur
 * plutôt qu'à produire un calcul inventé.
 */
export function conversionInfo(food, itemState) {
  const from = itemState || food?.referenceState;
  const to = food?.referenceState;
  const needed = Boolean(from && to && from !== to);
  const possible = canConvert(food, from, to);
  return {
    from,
    to,
    needed,
    possible,
    factor: needed && possible ? cookedFactorOf(food) : null,
    message:
      needed && !possible
        ? `Conversion impossible : aucune conversion définie entre « ${stateLabel(from)} » et ` +
          `« ${stateLabel(to)} ». Les macros de cet ingrédient ne sont pas calculées et ne sont ` +
          `pas comptées dans le total. Choisis l'état correspondant aux valeurs nutritionnelles, ` +
          `ou une combinaison cru / cuit avec un rendement renseigné.`
        : null,
  };
}

export const stateLabel = (id) => STATES.find((s) => s.id === id)?.label || id || '';

/**
 * Convertit une quantité exprimée dans `fromState` vers `toState`.
 * Seul le couple cru <-> cuit modifie le poids (rendement après cuisson :
 * coefficient = poids cuit ÷ poids cru). Toute autre combinaison est renvoyée
 * telle quelle : aucun coefficient n'est inventé.
 */
export function convertGrams(food, qty, fromState, toState) {
  if (!food || !qty || fromState === toState) return qty;
  if (!canConvert(food, fromState, toState)) return qty;
  const f = cookedFactorOf(food) ?? 1;
  if (fromState === 'cru' && toState === 'cuit') return qty * f;
  if (fromState === 'cuit' && toState === 'cru') return qty / f;
  return qty; // égoutté / prêt : pas de conversion automatique
}

/** Quantité ramenée à l'état de référence de l'aliment (base de tous les calculs). */
/**
 * Quantité ramenée à l'état de référence de l'aliment (base de tous les calculs).
 * Renvoie null quand aucune conversion n'est définie entre l'état pesé et
 * l'état des valeurs nutritionnelles : deux états différents ne sont JAMAIS
 * considérés comme équivalents par défaut.
 */
export function toReferenceGrams(food, qty, itemState) {
  const from = itemState || food?.referenceState;
  if (!canConvert(food, from, food?.referenceState)) return null;
  return convertGrams(food, qty, from, food.referenceState);
}

/* ------------------------------------------------------------------ */
/* Calcul des macros                                                   */
/* ------------------------------------------------------------------ */

export const emptyMacros = () => ({ kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });

/**
 * Macros d'un ingrédient pour une quantité donnée.
 * Si la conversion entre l'état pesé et l'état des valeurs nutritionnelles
 * n'est pas définie, aucune macro n'est calculée : l'objet renvoyé porte
 * `unconvertible: true` et des valeurs nulles, plutôt qu'un calcul faux
 * qui supposerait les deux états équivalents.
 */
export function macrosFor(food, qty, itemState) {
  const m = emptyMacros();
  if (!food || !qty) return m;
  const ref = toReferenceGrams(food, qty, itemState);
  if (ref === null) {
    m.unconvertible = true;
    return m;
  }
  const g = ref / 100;
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
  total.unconvertible = 0; // ingrédients exclus faute de conversion définie
  for (const it of items) {
    if (!it.foodId) continue; // ingrédient libre : ne participe pas aux macros
    const food = foodsById[it.foodId];
    if (!food) continue;
    const m = macrosFor(food, it.qty?.[person] || 0, it.state);
    if (m.unconvertible) {
      // jamais intégré au total : la valeur serait potentiellement fausse
      total.unconvertible += 1;
      continue;
    }
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
 * Perte bornée (Welsch) : quadratique près de zéro, mais son gradient sature
 * puis décroît au-delà d'un certain écart, au lieu de croître indéfiniment
 * (perte de Huber, essayée puis abandonnée : sur une cible structurellement
 * inatteignable, elle tire les ingrédients jusqu'à leur borne maximale).
 * `C` fixe l'échelle à laquelle la perte « accepte » de manquer la cible
 * plutôt que de produire une composition absurde.
 */
const WELSCH_C = 0.08;

/** Poids de la pénalité de disproportion (dispersion + échelle globale). */
const BETA = 0.006;
/** Poids du terme d'échelle globale à l'intérieur de la pénalité. */
const GAMMA = 3;

const welschLoss = (d) => WELSCH_C * (1 - Math.exp(-(d * d) / (2 * WELSCH_C)));

const GOLDEN = (Math.sqrt(5) - 1) / 2;

/** Minimum d'une fonction 1D sur [a, b] par recherche en section dorée. */
function goldenSectionMin(f, a, b, iterations = 24) {
  let x1 = b - GOLDEN * (b - a);
  let x2 = a + GOLDEN * (b - a);
  let f1 = f(x1);
  let f2 = f(x2);
  for (let i = 0; i < iterations; i++) {
    if (f1 <= f2) {
      b = x2; x2 = x1; f2 = f1;
      x1 = b - GOLDEN * (b - a); f1 = f(x1);
    } else {
      a = x1; x1 = x2; f1 = f2;
      x2 = a + GOLDEN * (b - a); f2 = f(x2);
    }
  }
  const x = (a + b) / 2;
  return { x, f: f(x) };
}

/**
 * Minimisation 1D sur [lo, hi] par grille de 48 points puis section dorée
 * autour de CHAQUE vallée détectée (minimum local de la grille). Le coût
 * n'est pas garanti unimodal (mesuré : des minima locaux existent) — une
 * simple recherche ternaire échouerait sur ces cas. Retenu après comparaison :
 * zéro échec, pour un nombre d'évaluations très inférieur à la recherche ternaire.
 */
function minimize1D(f, lo, hi, gridPoints = 48) {
  if (!(hi > lo)) { const x = lo; return { x, f: f(x) }; }
  const xs = new Array(gridPoints);
  const fs = new Array(gridPoints);
  for (let i = 0; i < gridPoints; i++) {
    xs[i] = lo + ((hi - lo) * i) / (gridPoints - 1);
    fs[i] = f(xs[i]);
  }
  let best = { x: xs[0], f: fs[0] };
  for (let i = 1; i < gridPoints; i++) if (fs[i] < best.f) best = { x: xs[i], f: fs[i] };
  for (let i = 0; i < gridPoints; i++) {
    const isValley = (i === 0 || fs[i] <= fs[i - 1]) && (i === gridPoints - 1 || fs[i] <= fs[i + 1]);
    if (!isValley) continue;
    const a = xs[Math.max(0, i - 1)];
    const b = xs[Math.min(gridPoints - 1, i + 1)];
    const refined = goldenSectionMin(f, a, b);
    if (refined.f < best.f) best = refined;
  }
  return best;
}

const MACRO_ORDER = ['kcal', 'protein', 'carbs', 'fat'];

/**
 * Résout l'ajustement par descente par coordonnées EN ESPACE LOGARITHMIQUE
 * (x = ln q), à partir d'un jeu de quantités de départ donné par `startOf`.
 * Chaque coordonnée est minimisée par `minimize1D` sur le coût complet ; les
 * contributions des autres variables sont gelées pendant cette minimisation
 * (Gauss-Seidel), ce qui rend chaque évaluation de coût en O(1).
 */
function solveFromStart(vars, fixed, t, startOf, iterations) {
  const n = vars.length;
  const q = vars.map((v) => clamp(startOf(v), v.min, v.max));
  const refLn = vars.map((v) => Math.log(v.ref));
  const u = q.map((qi, i) => Math.log(qi) - refLn[i]);

  const sum = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (let i = 0; i < n; i++) for (const k of MACRO_ORDER) sum[k] += vars[i].per1[k] * q[i];

  for (let iter = 0; iter < iterations; iter++) {
    let move = 0;
    for (let i = 0; i < n; i++) {
      const v = vars[i];
      const sumOthers = {};
      for (const k of MACRO_ORDER) sumOthers[k] = sum[k] - v.per1[k] * q[i];
      let sumU = 0;
      let sumU2 = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        sumU += u[j];
        sumU2 += u[j] * u[j];
      }

      const costAt = (x) => {
        const qi = Math.exp(x);
        let macroCost = 0;
        for (const k of MACRO_ORDER) {
          const val = sumOthers[k] + v.per1[k] * qi;
          const d = (val + fixed[k] - t[k]) / t[k];
          macroCost += WEIGHTS[k] * welschLoss(d);
        }
        const ui = x - refLn[i];
        const s1 = sumU + ui;
        const s2 = sumU2 + ui * ui;
        const dispersion = s2 - (s1 * s1) / n;
        const scaleTerm = (GAMMA * s1 * s1) / n;
        return macroCost + BETA * (dispersion + scaleTerm);
      };

      const { x } = minimize1D(costAt, Math.log(v.min), Math.log(v.max));
      const nextQ = clamp(Math.exp(x), v.min, v.max);
      move = Math.max(move, Math.abs(nextQ - q[i]));
      for (const k of MACRO_ORDER) sum[k] = sumOthers[k] + v.per1[k] * nextQ;
      q[i] = nextQ;
      u[i] = Math.log(nextQ) - refLn[i];
    }
    if (move < 0.05) break;
  }

  let macroCost = 0;
  for (const k of MACRO_ORDER) {
    const d = (sum[k] + fixed[k] - t[k]) / t[k];
    macroCost += WEIGHTS[k] * welschLoss(d);
  }
  const meanU = n ? u.reduce((s, x) => s + x, 0) / n : 0;
  const dispersion = u.reduce((s, x) => s + (x - meanU) ** 2, 0);
  const cost = macroCost + BETA * (dispersion + GAMMA * n * meanU * meanU);

  return { q, cost };
}

/**
 * Cœur de l'application : ajuste les quantités des ingrédients DÉVERROUILLÉS
 * pour rapprocher simultanément kcal / P / G / L des objectifs — architecture C.
 *
 * Coût minimisé, par personne :
 *   Σ_macro  W · ρ_C( (valeur - cible) / cible )
 *     + β · [ Σᵢ (uᵢ - ū)²  +  γ · n · ū² ]
 *   avec  uᵢ = ln(qᵢ / réfᵢ)  (réfᵢ = referenceFor(food), architecture C)
 *         ρ_C(d) = perte bornée de Welsch (WELSCH_C)
 *
 * Le premier terme rapproche les 4 macros de leurs cibles avec une perte qui
 * « accepte » de manquer une cible structurellement inatteignable plutôt que
 * de produire une composition absurde. Le second est une pénalité de
 * disproportion (jamais une interdiction) fondée sur des VARIATIONS RELATIVES
 * par rapport aux références de catégorie : elle pénalise un ingrédient qui
 * s'écarte des autres (dispersion) et un repas globalement gonflé ou rétréci
 * (échelle). Il n'y a plus d'ancrage sur la quantité de départ : un aliment
 * mal saisi au départ n'est plus jamais figé.
 *
 * Minimisation : descente par coordonnées en espace logarithmique, chaque
 * coordonnée résolue par grille 48 points + section dorée (le coût 1D n'est
 * pas garanti unimodal). Multi-départ (quantité actuelle, référence, quantité
 * mise à l'échelle du besoin calorique) : on retient le résultat de coût le
 * plus bas, pour éviter de rester bloqué dans un minimum local médiocre.
 *
 * Garanties :
 *  - aucun ingrédient n'est ajouté ni supprimé ;
 *  - un ingrédient verrouillé n'est jamais modifié ;
 *  - les ingrédients libres (sans foodId) sont ignorés ;
 *  - aucun plafond de masse spécifique à une catégorie, aucun terme de volume
 *    dans ce coût (le volume d'un repas est une couche séparée, informative).
 *
 * @returns {{quantities: Object<string, number>, changed: boolean}}
 *          quantités par identifiant d'ingrédient (seuls les déverrouillés changent).
 */
export function adjustQuantities(items, foodsById, target, person, options = {}) {
  const iterations = options.iterations ?? 60;
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
    // conversion impossible : on laisse la quantité telle quelle et on ne
    // l'intègre à aucun calcul (ni contribution fixe, ni variable d'ajustement)
    if (m.unconvertible) continue;
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
      ref: referenceFor(food),
      q0: qty,
    });
  }

  if (!vars.length) return { quantities: result, changed: false };

  const t = {
    kcal: Math.max(1, target.kcal || 0),
    protein: Math.max(1, target.protein || 0),
    carbs: Math.max(1, target.carbs || 0),
    fat: Math.max(1, target.fat || 0),
  };

  // départ « quantité actuelle mise à l'échelle du besoin calorique »
  const currentKcal = fixed.kcal + vars.reduce((s, v) => s + v.per1.kcal * v.q0, 0);
  const scaleFactor = currentKcal > 0 ? clamp(t.kcal / currentKcal, 0.1, 10) : 1;

  const starts = [(v) => v.q0, (v) => v.ref, (v) => v.q0 * scaleFactor];

  let best = null;
  for (const startOf of starts) {
    const r = solveFromStart(vars, fixed, t, startOf, iterations);
    if (!best || r.cost < best.cost - 1e-9) best = r;
  }

  let changed = false;
  for (let i = 0; i < vars.length; i++) {
    const v = vars[i];
    const rounded = roundQuantity(v.food, clamp(best.q[i], v.min, v.max), v.min, v.max);
    result[v.id] = rounded;
    if (Math.abs(rounded - v.q0) > 0.001) changed = true;
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
