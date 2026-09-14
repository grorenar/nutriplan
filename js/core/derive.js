/**
 * Calculs dérivés du cycle : batch cooking, liste de courses, budget, suggestions.
 * Aucune de ces fonctions ne modifie le planning.
 */

import { convertGrams, toReferenceGrams, PERSONS, mealMacros } from './nutrition.js';

/** Utilisations totales d'une option de catalogue, par personne. */
export function optionUses(option, kind) {
  if (kind === 'breakfast') {
    return { thomas: Number(option.uses?.thomas) || 0, julie: Number(option.uses?.julie) || 0 };
  }
  const total = (p) => (Number(option.uses?.[p]?.afternoon) || 0) + (Number(option.uses?.[p]?.evening) || 0);
  return { thomas: total('thomas'), julie: total('julie') };
}

/**
 * Sources d'un cycle : les repas du planning (déjeuners/dîners) + les options
 * de catalogue effectivement utilisées. Les catalogues restent indépendants des
 * jours : seuls leurs compteurs d'utilisation les font entrer dans le cycle.
 * Chaque source porte un facteur PAR PERSONNE, car Thomas et Julie peuvent
 * utiliser une même option un nombre de fois différent.
 */
export function cycleSources(state) {
  const sources = state.meals.map((m) => ({
    items: m.items,
    factors: { thomas: 1, julie: 1 },
    meal: m,
    dayIndex: m.dayIndex,
    mealType: m.mealType,
  }));

  for (const [key, kind] of [['breakfasts', 'breakfast'], ['snacks', 'snack']]) {
    for (const option of state[key] || []) {
      const factors = optionUses(option, kind);
      if (factors.thomas > 0 || factors.julie > 0) sources.push({ items: option.items, factors, option, kind });
    }
  }
  return sources;
}

/**
 * Besoins agrégés par aliment sur une liste de sources.
 * Le facteur est appliqué PAR PERSONNE avant agrégation : les quantités de
 * Thomas et de Julie peuvent différer et leurs nombres d'utilisations aussi.
 */
export function aggregateNeeds(sources, foodsById) {
  const out = {}; // foodId -> { food, refGrams, servedGrams, uses, days:Set }
  for (const source of sources) {
    const factors = source.factors || { thomas: source.factor ?? 1, julie: source.factor ?? 1 };
    const maxFactor = Math.max(factors.thomas || 0, factors.julie || 0);
    for (const it of source.items) {
      if (!it.foodId) continue;
      const food = foodsById[it.foodId];
      if (!food) continue;
      const served = PERSONS.reduce((sum, p) => sum + (it.qty?.[p] || 0) * (factors[p] || 0), 0);
      if (!served) continue;
      const state = it.state || food.referenceState;
      const ref = toReferenceGrams(food, served, state);
      if (!out[food.id]) out[food.id] = { food, refGrams: 0, servedGrams: 0, uses: 0, days: new Set() };
      out[food.id].refGrams += ref;
      out[food.id].servedGrams += served;
      out[food.id].uses += maxFactor;
      if (source.dayIndex !== undefined) out[food.id].days.add(source.dayIndex);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Couverture du cycle (petits-déjeuners et collations)                */
/* ------------------------------------------------------------------ */

export const COVERAGE_SLOTS = [
  { key: 'breakfast', kind: 'breakfast', label: 'Petits-déjeuners' },
  { key: 'snack_afternoon', kind: 'snack', slot: 'afternoon', label: 'Collations 16 h' },
  { key: 'snack_evening', kind: 'snack', slot: 'evening', label: 'Collations du soir' },
];

/**
 * Couverture du cycle : nombre d'options déclarées face au nombre théorique
 * (un par jour de cycle et par personne). Purement informatif : rien n'est
 * ajouté, choisi ni corrigé automatiquement.
 */
export function coverageReport(state) {
  const needed = state.settings.cycle.duration;
  const forced = state.coverage?.forced || {};
  const report = {};

  for (const slot of COVERAGE_SLOTS) {
    const rows = {};
    for (const person of PERSONS) {
      let used = 0;
      if (slot.kind === 'breakfast') {
        for (const o of state.breakfasts || []) used += Number(o.uses?.[person]) || 0;
      } else {
        for (const o of state.snacks || []) used += Number(o.uses?.[person]?.[slot.slot]) || 0;
      }
      const delta = used - needed;
      rows[person] = {
        used,
        needed,
        delta,
        status: delta === 0 ? 'ok' : delta < 0 ? 'missing' : 'extra',
        forced: !!forced[slot.key],
      };
    }
    report[slot.key] = { ...slot, needed, persons: rows, forced: !!forced[slot.key] };
  }
  return report;
}

/* ------------------------------------------------------------------ */
/* Batch cooking                                                       */
/* ------------------------------------------------------------------ */

/** Découpe le cycle en sessions de batch (règle de conservation). */
export function batchSessions(settings) {
  const duration = settings.cycle.duration;
  const span = Math.max(1, settings.batch.maxDays);
  const sessions = [];
  for (let start = 0; start < duration; start += span) {
    const end = Math.min(duration, start + span) - 1;
    sessions.push({ index: sessions.length, startDay: start, endDay: end });
  }
  return sessions;
}

/**
 * L'aliment demande-t-il une cuisson ?
 * C'est une propriété EXPLICITE de la fiche aliment (requiresCooking) : elle
 * n'est jamais déduite de l'état de référence. Un aliment cru peut très bien
 * être consommé tel quel, et un aliment prêt à consommer peut demander une
 * cuisson (gnocchis à poêler, par exemple).
 */
export const needsCooking = (food) => Boolean(food?.requiresCooking);

/**
 * Trois catégories, déduites uniquement des propriétés de l'aliment :
 *   batchAllowed = true                          → batch    (à préparer en batch)
 *   batchAllowed = false et requiresCooking = true → cook     (à cuire le jour même)
 *   requiresCooking = false                      → assemble (à assembler le jour même)
 * L'état de référence n'intervient pas dans ce classement.
 */
export function batchCategory(food) {
  if (!food) return 'assemble';
  if (food.batchAllowed) return 'batch';
  return needsCooking(food) ? 'cook' : 'assemble';
}

export const BATCH_CATEGORY_LABEL = {
  batch: 'À préparer en batch',
  cook: 'À cuire le jour même',
  assemble: 'À assembler le jour même',
};

/** Consignes de préparation saisies dans la fiche aliment (jamais codées en dur). */
export function preparationNote(food) {
  return food?.instructions ? String(food.instructions) : null;
}

/** Résumé lisible de la méthode de cuisson d'un aliment. */
export function cookingSummary(food) {
  if (!food) return null;
  const parts = [];
  if (food.cookingMethod) parts.push(food.cookingMethod);
  if (food.cookingTemp) parts.push(`${food.cookingTemp} °C`);
  if (food.cookingTime) parts.push(`${food.cookingTime} min`);
  return parts.length ? parts.join(' · ') : null;
}

/** Quantité telle qu'elle sera servie dans la gamelle (cuite si l'aliment se cuit). */
function servedGrams(food, qty, itemState) {
  const state = itemState || food.referenceState;
  if (needsCooking(food) && food.referenceState === 'cru') return convertGrams(food, qty, state, 'cuit');
  return qty;
}

/**
 * Plan de batch cooking : composants agrégés par session (pas de recettes),
 * plan opératoire de préparation, et détail des gamelles à remplir.
 * Cette fonction ne modifie jamais le planning : elle le lit.
 */
export function buildBatchPlan(state, foodsById) {
  const sessions = batchSessions(state.settings);
  return sessions.map((s) => {
    // nombre de jours que la préparation de cette session doit couvrir
    const coveredDays = s.endDay - s.startDay + 1;
    const meals = state.meals.filter((m) => m.dayIndex >= s.startDay && m.dayIndex <= s.endDay);
    const needs = aggregateNeeds(meals, foodsById);

    // ---- A. à préparer en batch
    const components = [];
    for (const entry of Object.values(needs)) {
      const { food, refGrams } = entry;
      if (batchCategory(food) !== 'batch') continue;
      const cooked = needsCooking(food) && food.referenceState === 'cru'
        ? convertGrams(food, refGrams, 'cru', 'cuit')
        : refGrams;
      const key = `${s.index}:${food.id}`;
      const prepared = state.batch.overrides[key];
      const preparedRaw = prepared ?? refGrams;
      components.push({
        key,
        food,
        requiredRaw: refGrams,
        requiredCooked: cooked,
        preparedRaw,
        preparedCooked: needsCooking(food) && food.referenceState === 'cru'
          ? convertGrams(food, preparedRaw, 'cru', 'cuit')
          : preparedRaw,
        yieldPct: Math.round((Number(food.cookedFactor) || 1) * 100),
        method: food.cookingMethod || '',
        temperature: food.cookingTemp ?? null,
        duration: food.cookingTime ?? null,
        prepTime: food.prepTime ?? null,
        equipment: food.equipment || '',
        note: preparationNote(food),
        summary: cookingSummary(food),
        needsCooking: needsCooking(food),
        // durée de conservation renseignée dans la fiche aliment (null = inconnue)
        shelfLifeDays: food.shelfLifeDays ?? null,
        coveredDays,
        shelfLifeShort:
          Number.isFinite(Number(food.shelfLifeDays)) && food.shelfLifeDays !== null
            ? Number(food.shelfLifeDays) < coveredDays
            : false,
      });
    }
    components.sort((a, b) => b.requiredRaw - a.requiredRaw);

    // ---- B et C : par repas concerné
    const cookSameDay = [];
    const assembleSameDay = [];
    for (const meal of meals) {
      for (const it of meal.items) {
        const food = it.foodId && foodsById[it.foodId];
        if (!food) continue;
        const cat = batchCategory(food);
        if (cat === 'batch') continue;
        const total = PERSONS.reduce((sum, p) => sum + (it.qty?.[p] || 0), 0);
        if (!total) continue;
        const row = {
          food,
          dayIndex: meal.dayIndex,
          mealType: meal.mealType,
          grams: toReferenceGrams(food, total, it.state || food.referenceState),
          summary: cookingSummary(food),
          note: preparationNote(food),
        };
        (cat === 'cook' ? cookSameDay : assembleSameDay).push(row);
      }
    }

    // ---- gamelles : ce qu'il faut répartir, personne par personne
    const gamelles = meals.map((meal) => ({
      mealId: meal.id,
      dayIndex: meal.dayIndex,
      mealType: meal.mealType,
      name: meal.name || '',
      persons: Object.fromEntries(
        PERSONS.map((person) => [
          person,
          meal.items
            .map((it) => {
              if (!it.foodId) {
                return it.free ? { free: true, name: it.free.name, quantity: it.free.quantity, category: 'free' } : null;
              }
              const food = foodsById[it.foodId];
              const qty = it.qty?.[person] || 0;
              if (!food || !qty) return null;
              return {
                free: false,
                food,
                name: food.name,
                category: batchCategory(food),
                grams: servedGrams(food, qty, it.state),
                cooked: needsCooking(food) && food.referenceState === 'cru',
              };
            })
            .filter(Boolean),
        ])
      ),
    }));

    // alertes : préparation dont la conservation ne couvre pas la session.
    // Purement informatif : rien n'est supprimé, le planning n'est pas modifié.
    const conservationAlerts = components
      .filter((c) => c.shelfLifeShort)
      .map((c) => ({
        food: c.food,
        shelfLifeDays: Number(c.shelfLifeDays),
        coveredDays,
        message:
          `${c.food.name} se conserve ${c.shelfLifeDays} jour(s) après préparation, ` +
          `mais cette session couvre ${coveredDays} jour(s).`,
      }));

    return { ...s, coveredDays, components, cookSameDay, assembleSameDay, gamelles, conservationAlerts, mealCount: meals.length };
  });
}

/* ------------------------------------------------------------------ */
/* Liste de courses                                                    */
/* ------------------------------------------------------------------ */

export function buildShoppingList(state, foodsById) {
  const needs = aggregateNeeds(cycleSources(state), foodsById);
  const lines = Object.values(needs).map((entry) => {
    const { food, refGrams } = entry;
    const pack = Number(food.packageWeight) > 0 ? Number(food.packageWeight) : null;
    const packages = pack ? Math.ceil(refGrams / pack) : null;
    const buyGrams = pack ? packages * pack : refGrams;
    const price = Number(food.price) > 0 ? Number(food.price) : null;
    let cost = null;
    if (price !== null) cost = pack ? packages * price : (price * refGrams) / 1000;
    return {
      food,
      required: refGrams,
      packages,
      packageWeight: pack,
      buyGrams,
      surplus: buyGrams - refGrams,
      cost,
      purchased: !!state.shopping.purchased[food.id],
    };
  });
  lines.sort((a, b) => a.food.category.localeCompare(b.food.category) || a.food.name.localeCompare(b.food.name));
  const total = lines.reduce((s, l) => s + (l.cost || 0), 0);
  const unpriced = lines.filter((l) => l.cost === null).length;
  return { lines, total, unpriced, budget: state.settings.budget, overBudget: total - state.settings.budget };
}

/* ------------------------------------------------------------------ */
/* Suggestions d'optimisation du cycle (jamais appliquées automatiquement) */
/* ------------------------------------------------------------------ */

export function optimizeSuggestions(state, foodsById) {
  const needs = aggregateNeeds(cycleSources(state), foodsById);
  const entries = Object.values(needs);
  const suggestions = [];

  const repeated = entries.filter((e) => e.uses >= 3 && e.food.batchAllowed);
  for (const e of repeated) {
    suggestions.push({
      kind: 'batch',
      text: `${e.food.name} apparaît ${e.uses} fois — bon candidat au batch cooking.`,
    });
  }

  const oneOff = entries.filter((e) => e.uses === 1 && ['legume', 'feculent', 'proteine'].includes(e.food.category));
  for (const e of oneOff.slice(0, 6)) {
    suggestions.push({
      kind: 'variety',
      text: `${e.food.name} n'est utilisé qu'une fois — le remplacer par un aliment déjà présent réduirait les courses.`,
    });
  }

  suggestions.push({
    kind: 'info',
    text: `${entries.length} aliments différents dans le cycle.`,
  });

  // budget + substitutions moins chères dans la même catégorie
  const shopping = buildShoppingList(state, foodsById);
  if (shopping.overBudget > 0) {
    suggestions.push({
      kind: 'budget',
      text: `Budget estimé ${shopping.total.toFixed(2)} € — dépassement de ${shopping.overBudget.toFixed(2)} €.`,
    });
    const pricePerKg = (f) =>
      Number(f.price) > 0 && Number(f.packageWeight) > 0 ? (f.price / f.packageWeight) * 1000 : null;
    const expensive = shopping.lines
      .filter((l) => l.cost !== null)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 4);
    for (const line of expensive) {
      const mine = pricePerKg(line.food);
      if (mine === null) continue;
      const alt = Object.values(foodsById)
        .filter((f) => f.id !== line.food.id && f.category === line.food.category && pricePerKg(f) !== null)
        .filter((f) => pricePerKg(f) < mine * 0.75)
        .sort((a, b) => pricePerKg(a) - pricePerKg(b))[0];
      if (alt) {
        suggestions.push({
          kind: 'substitution',
          text: `${line.food.name} (${(mine / 1).toFixed(2)} €/kg) → ${alt.name} (${pricePerKg(alt).toFixed(2)} €/kg) : substitution possible, à valider manuellement.`,
        });
      }
    }
  } else {
    suggestions.push({
      kind: 'budget',
      text: `Budget estimé ${shopping.total.toFixed(2)} € — dans l'objectif de ${state.settings.budget} €.`,
    });
  }
  return suggestions;
}

/* ------------------------------------------------------------------ */
/* Totaux journaliers (indicatif)                                      */
/* ------------------------------------------------------------------ */

export function dayTotals(state, foodsById, dayIndex, person) {
  const meals = state.meals.filter((m) => m.dayIndex === dayIndex);
  const total = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const m of meals) {
    const macros = mealMacros(m.items, foodsById, person);
    total.kcal += macros.kcal;
    total.protein += macros.protein;
    total.carbs += macros.carbs;
    total.fat += macros.fat;
  }
  return total;
}
