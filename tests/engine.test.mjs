/**
 * Tests automatisés du moteur nutritionnel et des calculs dérivés.
 *
 *   node tests/engine.test.mjs
 *
 * Aucune dépendance : ces modules sont purs (ni DOM, ni réseau, ni stockage).
 */

import {
  autoAdjust, adjustQuantities, mealMacros, macrosFor, evaluate, diagnose,
  initialQuantity, roundQuantity, convertGrams, toReferenceGrams, profileOf,
  snapQuantity, toUnits, fromUnits, isWholeUnitFood, MACRO_KEYS,
} from '../js/core/nutrition.js';
import {
  buildBatchPlan, buildShoppingList, batchCategory, cycleSources, cookingSummary, preparationNote,
} from '../js/core/derive.js';
import { seedFoods } from '../js/core/seed-foods.js';
import { findSimilarFoods, findDuplicateGroups } from '../js/core/similarity.js';

/* ---------------------------------------------------------------- harnais */

let passed = 0;
const failures = [];
let currentTest = '';

function test(name, fn) {
  currentTest = name;
  try {
    fn();
    console.log(`\n✔ ${name}`);
  } catch (e) {
    console.log(`\n✘ ${name}\n   ${e.message}`);
    failures.push(`${name} — ${e.message}`);
  }
}
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`   ok   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failures.push(`${currentTest} / ${label}${detail ? ` (${detail})` : ''}`); console.log(`   FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const info = (s) => console.log(`        ${s}`);

/* ---------------------------------------------------------------- fixtures */

const foods = seedFoods();
const byId = Object.fromEntries(foods.map((f) => [f.id, f]));
const F = (name) => {
  const f = foods.find((x) => x.name.toLowerCase().includes(name.toLowerCase()));
  if (!f) throw new Error(`aliment introuvable : ${name}`);
  return f;
};

const LUNCH = {
  thomas: { kcal: 1050, protein: 55, carbs: 120, fat: 35 },
  julie: { kcal: 750, protein: 40, carbs: 85, fat: 25 },
};
const SNACK = {
  thomas: { kcal: 350, protein: 25, carbs: 40, fat: 10 },
  julie: { kcal: 300, protein: 20, carbs: 35, fat: 8 },
};

let seq = 0;
function item(food, qty = null, opts = {}) {
  const q = qty === null ? initialQuantity(food) : qty;
  return {
    id: `it${++seq}`,
    foodId: food.id,
    free: null,
    state: opts.state || food.referenceState,
    qty: { thomas: opts.thomas ?? q, julie: opts.julie ?? q },
    locked: { thomas: !!opts.lock, julie: !!opts.lock },
  };
}
const freeItem = (name, quantity) => ({
  id: `it${++seq}`, foodId: null, free: { name, quantity }, state: null,
  qty: { thomas: 0, julie: 0 }, locked: { thomas: false, julie: false },
});

const dev = (v, t) => (t ? (v - t) / t : 0);
const within = (items, targets, person, tol = 0.05) => {
  const m = mealMacros(items, byId, person);
  return evaluate(m, targets[person], tol).rows.every((r) => r.status === 'ok');
};
function show(items, targets, person = 'thomas') {
  const m = mealMacros(items, byId, person);
  const t = targets[person];
  info(
    items.map((it) => `${it.foodId ? byId[it.foodId].name : it.free.name} ${Math.round(it.qty[person])}g${it.locked[person] ? '🔒' : ''}`).join(' | ')
  );
  info(
    `${person} : ${m.kcal.toFixed(0)}/${t.kcal} kcal (${(dev(m.kcal, t.kcal) * 100).toFixed(1)}%) · ` +
    `${m.protein.toFixed(0)}/${t.protein} P (${(dev(m.protein, t.protein) * 100).toFixed(1)}%) · ` +
    `${m.carbs.toFixed(0)}/${t.carbs} C (${(dev(m.carbs, t.carbs) * 100).toFixed(1)}%) · ` +
    `${m.fat.toFixed(0)}/${t.fat} L (${(dev(m.fat, t.fat) * 100).toFixed(1)}%)`
  );
}

/* ================================================================ TEST A */

test('A — protéine seule : pas de quantité absurde, manque signalé', () => {
  const items = [item(F('Blanc de poulet'))];
  autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  const q = items[0].qty.thomas;
  check('quantité de poulet raisonnable (≤ 300 g)', q <= 300, `${q} g`);
  const m = mealMacros(items, byId, 'thomas');
  const d = diagnose(m, LUNCH.thomas, foods);
  check('le repas est signalé hors cible', d !== null);
  check('glucides signalés manquants', d.rows.some((r) => r.key === 'carbs' && r.delta < 0));
  check('lipides signalés manquants', d.rows.some((r) => r.key === 'fat' && r.delta < 0));
  check('une piste est proposée', d.suggestions.length > 0, d.suggestions.join(', '));
});

/* ================================================================ TEST B */

test('B — protéine + féculent : protéines et glucides rapprochés de la cible', () => {
  const items = [item(F('Blanc de poulet')), item(F('Pâtes complètes'))];
  autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  show(items, LUNCH, 'julie');
  for (const p of ['thomas', 'julie']) {
    const m = mealMacros(items, byId, p);
    check(`${p} : protéines dans ±5 %`, Math.abs(dev(m.protein, LUNCH[p].protein)) <= 0.05, `${m.protein.toFixed(1)} g`);
    check(`${p} : glucides dans ±5 %`, Math.abs(dev(m.carbs, LUNCH[p].carbs)) <= 0.05, `${m.carbs.toFixed(1)} g`);
  }
  check('les lipides restent signalés hors cible (aucune source)', !within(items, LUNCH, 'thomas'));
});

/* ================================================================ TEST C */

test('C — ajout d’un légume : il reste autour de la quantité posée', () => {
  const items = [item(F('Blanc de poulet')), item(F('Pâtes complètes'))];
  autoAdjust(items, byId, LUNCH);
  items.push(item(F('Haricots verts'), 200));
  autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  const veg = items[2].qty.thomas;
  check('légume compris entre 170 et 230 g', veg >= 170 && veg <= 230, `${veg} g`);
  // second passage : pas de dérive cumulative
  autoAdjust(items, byId, LUNCH);
  autoAdjust(items, byId, LUNCH);
  const veg2 = items[2].qty.thomas;
  check('pas de dérive après 3 recalculs', Math.abs(veg2 - veg) <= 10, `${veg} g → ${veg2} g`);
});

/* ================================================================ TEST D */

test('D — ajout d’huile : les lipides sont corrigés sans casser le reste', () => {
  const items = [item(F('Blanc de poulet')), item(F('Pâtes complètes')), item(F('Haricots verts'), 200)];
  autoAdjust(items, byId, LUNCH);
  items.push(item(F('Huile d’olive')));
  autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  show(items, LUNCH, 'julie');
  for (const p of ['thomas', 'julie']) {
    const m = mealMacros(items, byId, p);
    for (const [key, label] of [['kcal', 'kcal'], ['protein', 'P'], ['carbs', 'C'], ['fat', 'L']]) {
      check(`${p} : ${label} dans ±5 %`, Math.abs(dev(m[key], LUNCH[p][key])) <= 0.05,
        `${m[key].toFixed(1)} / ${LUNCH[p][key]}`);
    }
  }
  const oil = items[3].qty.thomas;
  check('quantité d’huile plausible (≤ 45 g)', oil <= 45, `${oil} g`);
});

/* ================================================================ TEST E */

test('E — aliment verrouillé : quantité strictement inchangée', () => {
  const items = [item(F('Blanc de poulet')), item(F('Pâtes complètes')), item(F('Haricots verts'), 200), item(F('Huile d’olive'))];
  autoAdjust(items, byId, LUNCH);
  items[0].qty.thomas = 180; items[0].qty.julie = 130;
  items[0].locked.thomas = true; items[0].locked.julie = true;
  for (let i = 0; i < 5; i++) autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  check('poulet Thomas exactement 180 g', items[0].qty.thomas === 180, `${items[0].qty.thomas}`);
  check('poulet Julie exactement 130 g', items[0].qty.julie === 130, `${items[0].qty.julie}`);
  // ajout d'un aliment supplémentaire : toujours intouchable
  items.push(item(F('Skyr')));
  autoAdjust(items, byId, LUNCH);
  check('poulet inchangé après ajout d’un aliment', items[0].qty.thomas === 180 && items[0].qty.julie === 130);
  check('les autres aliments ont bougé', items.slice(1).some((it) => it.qty.thomas !== 0));
});

/* ================================================================ TEST F */

test('F — plusieurs aliments verrouillés', () => {
  const items = [
    item(F('Blanc de poulet'), 200, { lock: true }),
    item(F('Riz basmati'), 100, { lock: true }),
    item(F('Courgettes'), 150),
    item(F('Huile d’olive'), 5),
  ];
  const before = items.map((it) => ({ ...it.qty }));
  for (let i = 0; i < 3; i++) autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  check('poulet verrouillé inchangé', items[0].qty.thomas === before[0].thomas && items[0].qty.julie === before[0].julie);
  check('riz verrouillé inchangé', items[1].qty.thomas === before[1].thomas && items[1].qty.julie === before[1].julie);
  check('huile déverrouillée ajustée', items[3].qty.thomas !== before[3].thomas, `${before[3].thomas} → ${items[3].qty.thomas} g`);
  check('courgettes toujours présentes et raisonnables', items[2].qty.thomas >= 60 && items[2].qty.thomas <= 320, `${items[2].qty.thomas} g`);
});

/* ================================================================ TEST G */

test('G — aucun aliment ajouté ni supprimé automatiquement', () => {
  const items = [
    item(F('Blanc de poulet')),
    item(F('Pâtes complètes')),
    item(F('Chocolat noir'), 30), // aliment volontairement "gênant" pour la cible
    item(F('Huile d’olive')),
  ];
  const ids = items.map((i) => i.id);
  for (let i = 0; i < 4; i++) autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  check('même nombre d’ingrédients', items.length === 4, `${items.length}`);
  check('mêmes identifiants', items.every((it, i) => it.id === ids[i]));
  check('aucune quantité nulle', items.every((it) => it.qty.thomas > 0 && it.qty.julie > 0));
  check('le chocolat reste présent', items[2].qty.thomas > 0, `${items[2].qty.thomas} g`);
});

/* ================================================================ TEST H */

test('H — cible impossible : écart affiché plutôt que composition absurde', () => {
  // uniquement des légumes pour un déjeuner à 1050 kcal
  const items = [item(F('Haricots verts'), 200), item(F('Courgettes'), 150), item(F('Brocolis'), 150)];
  for (let i = 0; i < 3; i++) autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  const total = items.reduce((s, it) => s + it.qty.thomas, 0);
  check('poids total de légumes raisonnable (< 1 kg)', total < 1000, `${total} g`);
  check('chaque légume reste sous 320 g', items.every((it) => it.qty.thomas <= 320));
  const m = mealMacros(items, byId, 'thomas');
  const d = diagnose(m, LUNCH.thomas, foods);
  check('écart signalé', d !== null && d.rows.length >= 3);
  check('kcal très en dessous, signalé "off"', evaluate(m, LUNCH.thomas).rows[0].status === 'off', `${m.kcal.toFixed(0)} kcal`);

  // seconde combinaison impossible : whey seule sur un déjeuner
  const only = [item(F('Protéine en poudre'))];
  autoAdjust(only, byId, LUNCH);
  show(only, LUNCH);
  check('whey plafonnée à une quantité plausible (≤ 250 g)', only[0].qty.thomas <= 250, `${only[0].qty.thomas} g`);
});

/* ================================================================ TEST I */

test('I — Thomas et Julie optimisés indépendamment, même composition', () => {
  const items = [item(F('Blanc de poulet')), item(F('Riz basmati')), item(F('Haricots verts'), 200), item(F('Huile d’olive'))];
  autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  show(items, LUNCH, 'julie');
  check('même liste d’aliments pour les deux', items.every((it) => it.qty.thomas > 0 && it.qty.julie > 0));
  check('quantités différentes', items.some((it) => it.qty.thomas !== it.qty.julie));
  for (const p of ['thomas', 'julie']) {
    check(`${p} : les 4 macros dans ±5 %`, within(items, LUNCH, p));
  }
});

/* ================================================================ TEST J */

test('J — composition différente : un aliment absent (0 g) est ignoré', () => {
  const items = [
    item(F('Blanc de poulet')),
    item(F('Riz basmati')),
    item(F('Huile d’olive')),
    item(F('Cabillaud'), 0, { thomas: 0, julie: 150 }), // uniquement pour Julie
    item(F('Wrap'), 0, { thomas: 124, julie: 0 }), // uniquement pour Thomas
  ];
  for (let i = 0; i < 3; i++) autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  show(items, LUNCH, 'julie');
  check('cabillaud reste à 0 g pour Thomas', items[3].qty.thomas === 0);
  check('cabillaud présent pour Julie', items[4].qty.julie === 0 && items[3].qty.julie > 0);
  check('wrap reste à 0 g pour Julie', items[4].qty.julie === 0);
  check('wrap présent pour Thomas', items[4].qty.thomas > 0, `${items[4].qty.thomas} g`);
  for (const p of ['thomas', 'julie']) {
    const m = mealMacros(items, byId, p);
    check(`${p} : kcal dans ±5 %`, Math.abs(dev(m.kcal, LUNCH[p].kcal)) <= 0.05, `${m.kcal.toFixed(0)}`);
  }
});

/* ================================================================ UNITÉS */

test('Unités — aliments non fractionnables et unités pratiques', () => {
  const eggs = [item(F('Œuf entier')), item(F('Pain complet'))];
  for (let i = 0; i < 3; i++) autoAdjust(eggs, byId, SNACK);
  const gEgg = F('Œuf entier').gramsPerUnit;
  info(`œufs : ${eggs[0].qty.thomas} g = ${eggs[0].qty.thomas / gEgg} unités`);
  check('œufs = multiple entier de 60 g', eggs[0].qty.thomas % gEgg === 0, `${eggs[0].qty.thomas} g`);
  check('au moins un œuf', eggs[0].qty.thomas >= gEgg);

  const wasa = F('Pain croustillant');
  const w = [item(wasa), item(F('Fromage frais tartinable'))];
  for (let i = 0; i < 3; i++) autoAdjust(w, byId, SNACK);
  check('Wasa = multiple entier de 11 g', w[0].qty.thomas % wasa.gramsPerUnit === 0, `${w[0].qty.thomas} g = ${w[0].qty.thomas / 11} tranches`);

  const wrap = F('Wrap');
  const wr = [item(wrap), item(F('Blanc de poulet'))];
  for (let i = 0; i < 3; i++) autoAdjust(wr, byId, LUNCH);
  check('wrap = multiple entier de 62 g', wr[0].qty.thomas % wrap.gramsPerUnit === 0, `${wr[0].qty.thomas} g = ${wr[0].qty.thomas / 62} wraps`);

  const compote = F('Compote');
  const c = [item(compote), item(F('Skyr'))];
  for (let i = 0; i < 3; i++) autoAdjust(c, byId, SNACK);
  check('compote = multiple entier de 100 g (pot)', c[0].qty.thomas % compote.gramsPerUnit === 0, `${c[0].qty.thomas} g`);

  const skyr = F('Skyr');
  check('skyr fractionnable : arrondi au pas de 5 g, unité indicative', roundQuantity(skyr, 192) % 5 === 0, `${roundQuantity(skyr, 192)} g`);

  // bornes + unités entières : la quantité reste un multiple même au plafond
  const big = roundQuantity(F('Œuf entier'), 1000);
  check('arrondi borné reste un multiple', big % gEgg === 0, `${big} g`);
});

test('Unités — multiple entier de gramsPerUnit, quelle que soit la saisie', () => {
  const wasa = { ...F('Pain croustillant'), gramsPerUnit: 13 }; // 1 tranche = 13 g, non fractionnable
  info(`${wasa.name} : ${wasa.gramsPerUnit} g/unité, fractionnable = ${wasa.fractionable}`);

  // saisie en grammes : toute valeur est ramenée au multiple le plus proche
  for (const [entry, expected] of [[13, 13], [20, 26], [25, 26], [31, 26], [39, 39], [52, 52], [0, 0]]) {
    check(`saisie ${entry} g → ${expected} g`, snapQuantity(wasa, entry) === expected, `${snapQuantity(wasa, entry)}`);
  }
  check('une saisie positive donne au moins une unité', snapQuantity(wasa, 3) === 13);
  check('0 g reste 0 g (ingrédient absent pour la personne)', snapQuantity(wasa, 0) === 0);

  // saisie en unités
  for (const u of [1, 2, 3, 4]) {
    check(`${u} unité(s) → ${u * 13} g`, snapQuantity(wasa, fromUnits(wasa, u)) === u * 13);
  }
  check('2,4 unités saisies → 2 unités', snapQuantity(wasa, fromUnits(wasa, 2.4)) === 26);
  check('conversion grammes → unités', toUnits(wasa, 39) === 3);

  // règle générique : n'importe quel aliment non fractionnable
  const generic = { name: 'Aliment X', category: 'autre', gramsPerUnit: 37, fractionable: false,
    kcal: 100, protein: 5, carbs: 10, fat: 3, referenceState: 'pret' };
  check('règle générique (37 g/unité)', snapQuantity(generic, 100) === 111, `${snapQuantity(generic, 100)}`);
  check('aliment fractionnable non contraint', snapQuantity({ ...generic, fractionable: true }, 100) === 100);
  check('aliment sans unité non contraint', snapQuantity({ ...generic, gramsPerUnit: 0 }, 100) === 100);
  check('isWholeUnitFood générique', isWholeUnitFood(generic) && !isWholeUnitFood({ ...generic, fractionable: true }));

  // l'ajustement automatique respecte la contrainte, sur tous les types de repas
  const localById = { ...byId, [generic.name]: generic };
  for (const [label, targets] of [['déjeuner', LUNCH], ['collation', SNACK]]) {
    const items = [item(F('Œuf entier')), item(wasa, 26), item(F('Skyr'))];
    const map = { ...byId, [wasa.id]: wasa };
    for (let i = 0; i < 3; i++) autoAdjust(items, map, targets);
    const ok = items.every((it) => {
      const f = map[it.foodId];
      return PERSONS_EVERY(it, f);
    });
    check(`ajustement (${label}) : toutes les quantités restent des multiples`, ok,
      items.map((it) => `${map[it.foodId].name} ${it.qty.thomas}/${it.qty.julie}`).join(' | '));
  }
  check('quantité initiale proposée déjà en multiples', initialQuantity(wasa) % 13 === 0, `${initialQuantity(wasa)}`);
  check('borne haute respectée en multiples', roundQuantity(wasa, 5000, 0, 400) % 13 === 0);
});

function PERSONS_EVERY(it, food) {
  if (!isWholeUnitFood(food)) return true;
  return ['thomas', 'julie'].every((p) => (it.qty[p] || 0) % food.gramsPerUnit === 0);
}

test('Macros — les glucides s’affichent "G"', () => {
  const labels = MACRO_KEYS.map((m) => m.label);
  check('libellés P / G / L', labels.join('') === 'kcalPGL', labels.join(' '));
  const ev = evaluate({ kcal: 100, protein: 10, carbs: 10, fat: 5 }, LUNCH.thomas);
  check('aucun libellé "C" résiduel', !ev.rows.some((r) => r.label === 'C'));
});

/* ================================================================ CRU / CUIT */

test('Cru / cuit — conversions et macros', () => {
  const pates = F('Pâtes complètes');
  const cuit = convertGrams(pates, 100, 'cru', 'cuit');
  info(`100 g crus → ${cuit} g cuits (coefficient ${pates.cookedFactor})`);
  check('conversion cru → cuit', Math.abs(cuit - 100 * pates.cookedFactor) < 0.001);
  check('conversion inverse', Math.abs(convertGrams(pates, cuit, 'cuit', 'cru') - 100) < 0.001);

  const mCru = macrosFor(pates, 100, 'cru');
  const mCuit = macrosFor(pates, cuit, 'cuit');
  check('macros identiques quel que soit l’état saisi',
    Math.abs(mCru.kcal - mCuit.kcal) < 0.001 && Math.abs(mCru.protein - mCuit.protein) < 0.001,
    `${mCru.kcal.toFixed(0)} kcal`);

  // coefficient 2,5 demandé par le cahier des charges : 100 g cru → 250 g cuit
  const test25 = { ...pates, cookedFactor: 2.5 };
  check('coefficient configurable (2,5)', convertGrams(test25, 100, 'cru', 'cuit') === 250);

  // viande : perte de poids à la cuisson
  const poulet = F('Blanc de poulet');
  check('poulet 100 g crus → moins de 100 g cuits', convertGrams(poulet, 100, 'cru', 'cuit') < 100,
    `${convertGrams(poulet, 100, 'cru', 'cuit')} g`);
  check('saisie en cuit ramenée en cru pour les macros',
    Math.abs(toReferenceGrams(poulet, 70, 'cuit') - 100) < 0.001);
});

/* ================================================================ BATCH */

const mkMeal = (day, type, items) => ({ id: `m${day}${type}`, dayIndex: day, mealType: type, name: '', sameComposition: true, items });

function batchState(overrides = {}) {
  return {
    foods,
    settings: {
      cycle: { startWeekday: 1, duration: 4 },
      batch: { enabled: true, maxDays: 3 },
      budget: 100,
      tolerance: 0.05,
      targets: { thomas: { lunch: LUNCH.thomas, dinner: LUNCH.thomas }, julie: { lunch: LUNCH.julie, dinner: LUNCH.julie } },
    },
    batch: { overrides },
    shopping: { purchased: {} },
    meals: [
      mkMeal(0, 'lunch', [item(F('Blanc de poulet'), 0, { thomas: 180, julie: 130 }), item(F('Riz basmati'), 0, { thomas: 90, julie: 70 })]),
      mkMeal(0, 'dinner', [item(F('Blanc de poulet'), 0, { thomas: 180, julie: 130 }), item(F('Haricots verts'), 200)]),
      mkMeal(1, 'lunch', [item(F('Blanc de poulet'), 0, { thomas: 180, julie: 130 }), item(F('Riz basmati'), 0, { thomas: 90, julie: 70 })]),
      mkMeal(1, 'dinner', [item(F('Cabillaud'), 0, { thomas: 200, julie: 150 })]),
      mkMeal(2, 'lunch', [item(F('Œuf entier'), 0, { thomas: 120, julie: 60 })]),
      mkMeal(2, 'dinner', [item(F('Wrap'), 0, { thomas: 124, julie: 62 }), item(F('Blanc de poulet'), 0, { thomas: 130, julie: 100 })]),
      mkMeal(3, 'lunch', [item(F('Riz basmati'), 0, { thomas: 90, julie: 70 })]),
      mkMeal(3, 'dinner', [item(F('Blanc de poulet'), 0, { thomas: 180, julie: 130 })]),
    ],
  };
}

test('Batch — agrégation par session et trois catégories', () => {
  const s = batchState();
  const plan = buildBatchPlan(s, byId);
  check('deux sessions pour 4 jours et 3 jours de conservation', plan.length === 2,
    plan.map((p) => `J${p.startDay + 1}-${p.endDay + 1}`).join(' / '));

  const s1 = plan[0];
  const poulet = s1.components.find((c) => c.food.name.includes('Blanc de poulet'));
  // jours 1-3 : 180+130 + 180+130 + 180+130 + 130+100 = 1160 g crus
  info(`poulet session 1 : ${poulet.requiredRaw} g crus → ${poulet.requiredCooked.toFixed(0)} g cuits`);
  check('poulet agrégé sur les deux personnes', poulet.requiredRaw === 1160, `${poulet.requiredRaw} g`);
  check('conversion cru → cuit correcte', Math.abs(poulet.requiredCooked - 1160 * 0.7) < 0.01);

  const riz = s1.components.find((c) => c.food.name.includes('Riz'));
  check('riz agrégé (jours 1 et 2)', riz.requiredRaw === 320, `${riz.requiredRaw} g`);

  const names = s1.components.map((c) => c.food.name);
  check('cabillaud exclu du batch', !names.some((n) => n.toLowerCase().includes('cabillaud')));
  check('œufs exclus du batch', !names.some((n) => n.includes('Œuf')));
  check('wrap exclu du batch', !names.some((n) => n.includes('Wrap')));

  // --- trois catégories, déduites des propriétés des aliments
  check('catégorie "batch" pour un aliment batchable', batchCategory(F('Blanc de poulet')) === 'batch');
  check('catégorie "cuisson du jour" pour le poisson', batchCategory(F('Cabillaud')) === 'cook');
  check('catégorie "cuisson du jour" pour les œufs', batchCategory(F('Œuf entier')) === 'cook');
  check('catégorie "assemblage" pour le wrap', batchCategory(F('Wrap')) === 'assemble');
  check('catégorie "assemblage" pour le skyr', batchCategory(F('Skyr')) === 'assemble');
  check('catégorie "assemblage" pour le pain croustillant', batchCategory(F('Pain croustillant')) === 'assemble');

  const cookNames = s1.cookSameDay.map((x) => x.food.name.toLowerCase());
  const assembleNames = s1.assembleSameDay.map((x) => x.food.name.toLowerCase());
  check('cabillaud dans "à cuire le jour même"', cookNames.some((n) => n.includes('cabillaud')));
  check('œufs dans "à cuire le jour même"', cookNames.some((n) => n.includes('œuf')));
  check('wrap dans "à assembler le jour même"', assembleNames.some((n) => n.includes('wrap')));
  check('aucun aliment batchable dans les deux autres catégories',
    ![...cookNames, ...assembleNames].some((n) => n.includes('poulet') || n.includes('riz')));
  check('cabillaud rattaché au bon jour',
    s1.cookSameDay.find((x) => x.food.name.toLowerCase().includes('cabillaud')).dayIndex === 1);

  const s2 = plan[1];
  check('session 2 = jour 4 uniquement', s2.startDay === 3 && s2.endDay === 3);
  const poulet2 = s2.components.find((c) => c.food.name.includes('Blanc de poulet'));
  check('poulet session 2 séparé de la session 1', poulet2.requiredRaw === 310, `${poulet2.requiredRaw} g`);

  // modification manuelle de la quantité préparée
  const key = `0:${F('Blanc de poulet').id}`;
  const s3 = batchState({ [key]: 1500 });
  const mealsBefore = JSON.stringify(s3.meals);
  const plan3 = buildBatchPlan(s3, byId);
  const p3 = plan3[0].components.find((c) => c.food.name.includes('Blanc de poulet'));
  check('quantité préparée manuelle prise en compte', p3.preparedRaw === 1500);
  check('besoin inchangé par la modification', p3.requiredRaw === 1160);
  check('surplus correct', p3.preparedRaw - p3.requiredRaw === 340);
  check('quantité cuite attendue recalculée', Math.abs(p3.preparedCooked - 1500 * 0.7) < 0.01);
  check('planning intact après calcul du batch', JSON.stringify(s3.meals) === mealsBefore);
});

test('Batch — plan opératoire : méthode, rendement, gamelles', () => {
  const s = batchState();
  const sess = buildBatchPlan(s, byId)[0];
  const poulet = sess.components.find((c) => c.food.name.includes('Blanc de poulet'));
  info(`poulet : ${poulet.method} ${poulet.temperature} °C ${poulet.duration} min, rendement ${poulet.yieldPct} %`);
  check('méthode de cuisson reprise de la fiche aliment', poulet.method === 'Four');
  check('température reprise', poulet.temperature === 180);
  check('durée reprise', poulet.duration === 25);
  check('temps de préparation repris', poulet.prepTime === 10);
  check('matériel repris', /Four/.test(poulet.equipment));
  check('rendement cru → cuit affiché en %', poulet.yieldPct === 70);
  check('consignes libres reprises (donnée, pas règle codée)', /filets entiers/.test(poulet.note || ''));
  check('résumé de cuisson lisible', cookingSummary(F('Blanc de poulet')) === 'Four · 180 °C · 25 min');

  // gamelles : quoi répartir, personne par personne
  check('une gamelle par repas de la session', sess.gamelles.length === 6,
    sess.gamelles.map((g) => `J${g.dayIndex + 1}${g.mealType === 'lunch' ? 'M' : 'S'}`).join(' '));
  const g1 = sess.gamelles[0];
  const tPoulet = g1.persons.thomas.find((e) => !e.free && e.name.includes('poulet'));
  const jPoulet = g1.persons.julie.find((e) => !e.free && e.name.includes('poulet'));
  info(`gamelle J1 midi — Thomas ${tPoulet.grams.toFixed(0)} g de poulet cuit, Julie ${jPoulet.grams.toFixed(0)} g`);
  check('quantités de gamelle exprimées cuites', tPoulet.cooked === true);
  check('Thomas : 180 g crus → 126 g cuits', Math.abs(tPoulet.grams - 126) < 0.01, `${tPoulet.grams}`);
  check('Julie : 130 g crus → 91 g cuits', Math.abs(jPoulet.grams - 91) < 0.01, `${jPoulet.grams}`);
  check('Thomas et Julie restent indépendants dans les gamelles', tPoulet.grams !== jPoulet.grams);
  check('chaque ligne de gamelle porte sa catégorie',
    g1.persons.thomas.every((e) => ['batch', 'cook', 'assemble', 'free'].includes(e.category)));
  const isWrap = (e) => !e.free && /wrap|tortilla/i.test(e.name);
  const gWrap = sess.gamelles.find((g) => g.persons.thomas.some(isWrap));
  check('le wrap apparaît dans la gamelle en catégorie assemblage',
    gWrap.persons.thomas.find(isWrap).category === 'assemble');
  check('une gamelle vide reste vide côté Julie si la quantité est nulle',
    sess.gamelles.every((g) => g.persons.julie.every((e) => e.free || e.grams > 0)));
});

test('Fiche aliment — paramètres de cuisson personnalisés repris dans le plan', () => {
  const dino = {
    id: 'f_dino', name: 'Cuisse de dinosaure', category: 'proteine', brand: '',
    kcal: 150, protein: 25, carbs: 0, fat: 6, fiber: 0,
    referenceState: 'cru', cookedFactor: 0.75, unitName: '', gramsPerUnit: 0, fractionable: true,
    price: null, packageWeight: null, batchAllowed: true, favorite: false, lastUsed: null, unitEntry: false,
    cookingMethod: 'Four', cookingTemp: 200, cookingTime: 35, prepTime: 10, equipment: 'Four',
    instructions: 'Sortir 20 min avant, cuire entier, trancher après repos.',
  };
  const local = { ...byId, f_dino: dino };
  const s = batchState();
  s.foods = [...s.foods, dino];
  s.meals[0].items = [item(dino, 0, { thomas: 200, julie: 150 })];
  const sess = buildBatchPlan(s, local)[0];
  const c = sess.components.find((x) => x.food.id === 'f_dino');
  check('aliment personnalisé présent dans le batch', !!c);
  check('méthode personnalisée', c.method === 'Four' && c.temperature === 200 && c.duration === 35);
  check('rendement personnalisé', c.yieldPct === 75);
  check('quantité cuite attendue', Math.abs(c.requiredCooked - 350 * 0.75) < 0.01, `${c.requiredCooked}`);
  check('consignes personnalisées reprises', /Sortir 20 min/.test(c.note));
  check('aucune méthode imposée si la fiche est vide',
    preparationNote({ instructions: '' }) === null && cookingSummary({ name: 'X' }) === null);
});

/* ================================================================ COURSES */

test('Courses — besoin, conditionnements, surplus, budget', () => {
  const poulet = { ...F('Blanc de poulet'), id: 'f_test_poulet', packageWeight: 500, price: 6.9 };
  const local = { ...byId, f_test_poulet: poulet };
  const s = {
    foods: [poulet],
    settings: { cycle: { startWeekday: 0, duration: 2 }, batch: { enabled: true, maxDays: 3 }, budget: 100, tolerance: 0.05, targets: { thomas: {}, julie: {} } },
    batch: { overrides: {} },
    shopping: { purchased: {} },
    meals: [mkMeal(0, 'lunch', [item(poulet, 0, { thomas: 640, julie: 600 })])],
  };
  const list = buildShoppingList(s, local);
  const line = list.lines[0];
  info(`besoin ${line.required} g → ${line.packages} × ${line.packageWeight} g, surplus ${line.surplus} g, ${line.cost.toFixed(2)} €`);
  check('besoin = 1240 g', line.required === 1240);
  check('achat = 3 × 500 g', line.packages === 3 && line.packageWeight === 500);
  check('surplus = 260 g', line.surplus === 260);
  check('coût = 3 × prix du conditionnement', Math.abs(line.cost - 20.7) < 0.001);
  check('aucune notion de stock dans la ligne',
    !('stock' in line) && !('remaining' in line) && Object.keys(line).every((k) => !/stock|inventaire|remaining/i.test(k)),
    Object.keys(line).join(','));
  check('case "acheté" = simple booléen', line.purchased === false);

  // la case cochée ne modifie ni le besoin ni la quantité à acheter
  const s2 = { ...s, shopping: { purchased: { f_test_poulet: true } } };
  const line2 = buildShoppingList(s2, local).lines[0];
  check('cocher n’affecte pas le besoin', line2.required === line.required && line2.packages === line.packages);
  check('cocher n’est qu’un suivi', line2.purchased === true);

  // budget
  check('total du cycle calculé', Math.abs(buildShoppingList(s, local).total - 20.7) < 0.001);
  check('dépassement calculé mais non bloquant', buildShoppingList({ ...s, settings: { ...s.settings, budget: 10 } }, local).overBudget > 0);
});

test('Courses — petits-déjeuners et collations utilisés dans le cycle', () => {
  const base = batchState();
  base.meals = [mkMeal(0, 'lunch', [item(F('Riz basmati'), 0, { thomas: 100, julie: 80 })])];
  base.breakfasts = [
    { id: 'b1', name: 'Skyr + avoine', sameComposition: true, cycleUses: 0,
      items: [item(F('Skyr'), 0, { thomas: 150, julie: 150 }), item(F('Flocons'), 0, { thomas: 80, julie: 60 })] },
    { id: 'b2', name: 'Option non utilisée', sameComposition: true, cycleUses: 0,
      items: [item(F('Pain de mie'), 0, { thomas: 66, julie: 33 })] },
  ];
  base.snacksAfternoon = [
    { id: 's1', name: 'Skyr fruits rouges', sameComposition: true, cycleUses: 0,
      items: [item(F('Skyr'), 0, { thomas: 150, julie: 150 }), item(F('Fruits rouges'), 0, { thomas: 100, julie: 100 })] },
  ];
  base.snacksEvening = [
    { id: 'e1', name: 'Amandes', sameComposition: true, cycleUses: 0, items: [item(F('Amandes'), 0, { thomas: 20, julie: 15 })] },
  ];

  const names = (st) => buildShoppingList(st, byId).lines.map((l) => l.food.name);
  check('option non utilisée : absente des courses', !names(base).some((n) => n.includes('Skyr')));
  check('seul le repas du planning est compté', names(base).length === 1, names(base).join(', '));

  // on déclare les utilisations dans le cycle
  base.breakfasts[0].cycleUses = 4;
  base.snacksAfternoon[0].cycleUses = 2;
  base.snacksEvening[0].cycleUses = 1;
  const list = buildShoppingList(base, byId);
  const line = (frag) => list.lines.find((l) => l.food.name.toLowerCase().includes(frag));
  info(list.lines.map((l) => `${l.food.name} ${Math.round(l.required)} g`).join(' | '));

  check('petit-déjeuner utilisé 4 fois : flocons = 4 × 140 g', Math.abs(line('flocons').required - 560) < 0.01,
    `${line('flocons').required}`);
  check('skyr agrégé sur le petit-déjeuner ET la collation',
    Math.abs(line('skyr').required - (4 * 300 + 2 * 300)) < 0.01, `${line('skyr').required}`);
  check('collation du soir comptée une fois', Math.abs(line('amandes').required - 35) < 0.01);
  check('option toujours non utilisée : absente', !list.lines.some((l) => l.food.name.includes('Pain de mie')));
  check('repas du planning toujours compté', Math.abs(line('riz').required - 180) < 0.01);
  check('conditionnements appliqués comme pour les repas',
    line('skyr').packages === Math.ceil(1800 / line('skyr').packageWeight), `${line('skyr').packages} paquets`);
  check('surplus et prix calculés', line('skyr').surplus >= 0 && line('skyr').cost > 0);
  check('cases "acheté" disponibles pour ces aliments', line('flocons').purchased === false);

  // cycleSources : le catalogue n'entre dans le cycle que par son compteur
  check('cycleSources reflète les utilisations',
    cycleSources(base).filter((x) => x.option).map((x) => x.factor).join(',') === '4,2,1');
  base.breakfasts[0].cycleUses = 0;
  check('compteur remis à zéro : aliments retirés des courses',
    !buildShoppingList(base, byId).lines.some((l) => l.food.name.includes('Flocons')));
});

test('Doublons — avertissement à la création, jamais de fusion', () => {
  const bank = seedFoods();
  const candidate = { id: 'f_new', name: 'Pain croustillant fibres', brand: 'Wasa', category: 'feculent',
    kcal: 335, protein: 10, carbs: 60, fat: 1.5, gramsPerUnit: 13, fractionable: false };
  const existing = { ...bank.find((f) => f.name.includes('Pain croustillant')), brand: 'Wasa', gramsPerUnit: 13 };
  const withBrand = bank.map((f) => (f.id === existing.id ? existing : f));

  const hits = findSimilarFoods(candidate, withBrand);
  info(hits.map((h) => `${h.food.name} (${h.score.toFixed(2)}) ${h.reasons.join(', ')}`).join(' | '));
  check('produit très proche détecté', hits.length > 0);
  check('raisons explicites', hits[0].reasons.length >= 2, hits[0].reasons.join(', '));
  check('la banque n’est pas modifiée', withBrand.length === bank.length);

  check('aliment sans rapport : aucun avertissement',
    findSimilarFoods({ name: 'Cuisse de dinosaure', category: 'proteine', kcal: 150 }, bank).length === 0);
  check('deux aliments proches mais de catégories différentes ne sont pas rapprochés',
    findSimilarFoods({ name: 'Huile de coco', category: 'fruit', kcal: 900 }, bank).length === 0);
  check('un aliment ne se détecte pas lui-même',
    !findSimilarFoods(bank[0], bank).some((h) => h.food.id === bank[0].id));

  const groups = findDuplicateGroups(bank);
  info(`banque initiale : ${groups.length} groupe(s) signalé(s) — ${groups.map((g) => g.food.name).join(', ')}`);
  check('contrôle d’import : peu de faux positifs sur la banque livrée', groups.length <= 3);
});

/* ================================================================ LIBRES */

test('Ingrédients libres — visibles mais hors calculs', () => {
  const items = [item(F('Pâtes complètes'), 100), item(F('Skyr'), 150), freeItem('Curry', 'au goût')];
  const s = {
    foods,
    settings: { cycle: { startWeekday: 0, duration: 1 }, batch: { enabled: true, maxDays: 3 }, budget: 100, tolerance: 0.05, targets: { thomas: {}, julie: {} } },
    batch: { overrides: {} },
    shopping: { purchased: {} },
    meals: [mkMeal(0, 'lunch', items)],
  };
  const m = mealMacros(items, byId, 'thomas');
  const expected = macrosFor(F('Pâtes complètes'), 100, 'cru').kcal + macrosFor(F('Skyr'), 150, 'pret').kcal;
  check('curry présent dans le repas', items.some((it) => it.free?.name === 'Curry'));
  check('quantité libre conservée', items[2].free.quantity === 'au goût');
  check('curry hors macros', Math.abs(m.kcal - expected) < 0.001, `${m.kcal.toFixed(0)} kcal`);
  check('curry hors batch', !buildBatchPlan(s, byId)[0].components.some((c) => /curry/i.test(c.food.name)));
  check('curry hors courses / budget', !buildShoppingList(s, byId).lines.some((l) => /curry/i.test(l.food.name)));
  const adjusted = JSON.parse(JSON.stringify(items));
  autoAdjust(adjusted, byId, LUNCH);
  check('curry jamais ajusté', adjusted[2].qty.thomas === 0 && adjusted[2].qty.julie === 0);
  check('curry jamais supprimé', adjusted.length === 3);
});

/* ================================================================ STABILITÉ */

test('Stabilité — idempotence et absence de dérive', () => {
  const items = [item(F('Blanc de poulet')), item(F('Riz basmati')), item(F('Haricots verts'), 200), item(F('Huile d’olive'))];
  autoAdjust(items, byId, LUNCH);
  const snap1 = items.map((i) => ({ ...i.qty }));
  autoAdjust(items, byId, LUNCH);
  const snap2 = items.map((i) => ({ ...i.qty }));
  for (let i = 0; i < 8; i++) autoAdjust(items, byId, LUNCH);
  const snap3 = items.map((i) => ({ ...i.qty }));
  info(snap1.map((q, i) => `${byId[items[i].foodId].name} ${q.thomas}→${snap3[i].thomas}`).join(' | '));
  check('2e passage proche du 1er', snap1.every((q, i) => Math.abs(q.thomas - snap2[i].thomas) <= 10));
  check('stable après 10 passages', snap2.every((q, i) => Math.abs(q.thomas - snap3[i].thomas) <= 10));
  check('toujours dans la cible après 10 passages', within(items, LUNCH, 'thomas'));
});

/* ================================================================ VERROU TOTAL */

test('Tout verrouillé — l’algorithme ne touche à rien', () => {
  const items = [item(F('Blanc de poulet'), 200, { lock: true }), item(F('Riz basmati'), 100, { lock: true })];
  const before = JSON.stringify(items);
  autoAdjust(items, byId, LUNCH);
  check('aucune modification', JSON.stringify(items) === before);
  const m = mealMacros(items, byId, 'thomas');
  check('écart bien signalé', diagnose(m, LUNCH.thomas, foods) !== null);
});

/* ---------------------------------------------------------------- bilan */

console.log('\n' + '='.repeat(60));
console.log(`${passed} vérifications réussies, ${failures.length} échec(s).`);
if (failures.length) {
  console.log('\nÉchecs :');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
