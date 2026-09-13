/**
 * Calculs dérivés du cycle : batch cooking, liste de courses, budget, suggestions.
 * Aucune de ces fonctions ne modifie le planning.
 */

import { convertGrams, toReferenceGrams, PERSONS, mealMacros } from './nutrition.js';

/** Besoins agrégés par aliment, sur un sous-ensemble de repas. */
export function aggregateNeeds(meals, foodsById) {
  const out = {}; // foodId -> { food, refGrams, servedGrams, uses, days:Set }
  for (const meal of meals) {
    for (const it of meal.items) {
      if (!it.foodId) continue;
      const food = foodsById[it.foodId];
      if (!food) continue;
      const served = PERSONS.reduce((sum, p) => sum + (it.qty?.[p] || 0), 0);
      if (!served) continue;
      const state = it.state || food.referenceState;
      const ref = toReferenceGrams(food, served, state);
      if (!out[food.id]) out[food.id] = { food, refGrams: 0, servedGrams: 0, uses: 0, days: new Set() };
      out[food.id].refGrams += ref;
      out[food.id].servedGrams += served;
      out[food.id].uses += 1;
      out[food.id].days.add(meal.dayIndex);
    }
  }
  return out;
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

const isCooked = (food) => food.referenceState === 'cru';

/** Note de préparation spécifique (viande entière). */
export function preparationNote(food) {
  if (/poulet|dinde|volaille|filet mignon/i.test(food.name) && food.referenceState === 'cru') {
    return 'Cuire les filets entiers, laisser tiédir, puis couper en dés.';
  }
  return null;
}

/**
 * Plan de batch cooking : composants agrégés par session (pas de recettes).
 * Retourne aussi les aliments non batchables à cuisiner le jour même.
 */
export function buildBatchPlan(state, foodsById) {
  const sessions = batchSessions(state.settings);
  const plan = sessions.map((s) => {
    const meals = state.meals.filter((m) => m.dayIndex >= s.startDay && m.dayIndex <= s.endDay);
    const needs = aggregateNeeds(meals, foodsById);
    const components = [];
    for (const entry of Object.values(needs)) {
      const { food, refGrams, servedGrams } = entry;
      if (!food.batchAllowed) continue;
      const cookedGrams = isCooked(food) ? convertGrams(food, refGrams, 'cru', 'cuit') : refGrams;
      const key = `${s.index}:${food.id}`;
      const prepared = state.batch.overrides[key];
      components.push({
        key,
        food,
        requiredRaw: refGrams,
        requiredCooked: cookedGrams,
        servedGrams,
        preparedRaw: prepared ?? refGrams,
        note: preparationNote(food),
        needsCooking: isCooked(food),
      });
    }
    components.sort((a, b) => b.requiredRaw - a.requiredRaw);

    // aliments non batchables nécessitant une cuisson : jour même
    const sameDay = [];
    for (const meal of meals) {
      for (const it of meal.items) {
        const food = it.foodId && foodsById[it.foodId];
        if (!food || food.batchAllowed || !isCooked(food)) continue;
        const served = PERSONS.reduce((sum, p) => sum + (it.qty?.[p] || 0), 0);
        if (!served) continue;
        sameDay.push({
          food,
          dayIndex: meal.dayIndex,
          mealType: meal.mealType,
          grams: toReferenceGrams(food, served, it.state || food.referenceState),
        });
      }
    }
    return { ...s, components, sameDay, mealCount: meals.length };
  });
  return plan;
}

/* ------------------------------------------------------------------ */
/* Liste de courses                                                    */
/* ------------------------------------------------------------------ */

export function buildShoppingList(state, foodsById) {
  const needs = aggregateNeeds(state.meals, foodsById);
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
  const needs = aggregateNeeds(state.meals, foodsById);
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
