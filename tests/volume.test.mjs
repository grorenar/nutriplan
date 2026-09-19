/**
 * Tests de la couche « volume des repas » (V1.4) — js/core/meal-volume.js.
 *
 *   node tests/volume.test.mjs
 *
 * Cette couche est strictement informative et strictement séparée du moteur
 * nutritionnel : elle ne modifie jamais une quantité, une macro, ni
 * l'optimiseur. Suite indépendante de tests/engine.test.mjs, conformément à
 * la philosophie « couche supprimable » de V1.4.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { analyzeMealVolume, plateMassOf, volumeLevelFor } from '../js/core/meal-volume.js';
import { autoAdjust, adjustQuantities, initialQuantity } from '../js/core/nutrition.js';
import { seedFoods } from '../js/core/seed-foods.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

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

let seq = 0;
function item(food, qty, opts = {}) {
  const q = qty ?? initialQuantity(food);
  return {
    id: `vt${++seq}`,
    foodId: food.id,
    free: null,
    state: opts.state || food.referenceState,
    qty: { thomas: opts.thomas ?? q, julie: opts.julie ?? q },
    locked: { thomas: !!opts.lock, julie: !!opts.lock },
  };
}

const LUNCH = { thomas: { kcal: 1050, protein: 55, carbs: 120, fat: 35 } };

/* ================================================================ SEUILS */

test('1 — repas ≤ 600 g : aucun avertissement', () => {
  // tomates concassées (pret, ×1) : masse = quantité saisie
  const items = [item(F('Tomates concassées'), 400)];
  const v = analyzeMealVolume(items, byId, 'thomas');
  check('masse = 400 g', v.grams === 400, `${v.grams} g`);
  check('niveau 0', v.level === 0);
  check('aucun libellé', v.label === null);
});

test('2 — repas entre 600 et 750 g : niveau 1 « Repas volumineux »', () => {
  const items = [item(F('Tomates concassées'), 700)];
  const v = analyzeMealVolume(items, byId, 'thomas');
  check('masse = 700 g', v.grams === 700);
  check('niveau 1', v.level === 1);
  check('libellé « Repas volumineux »', v.label === 'Repas volumineux', v.label);
});

test('3 — repas entre 750 et 900 g : niveau 2 « Repas très volumineux »', () => {
  const items = [item(F('Tomates concassées'), 850)];
  const v = analyzeMealVolume(items, byId, 'thomas');
  check('masse = 850 g', v.grams === 850);
  check('niveau 2', v.level === 2);
  check('libellé « Repas très volumineux »', v.label === 'Repas très volumineux', v.label);
});

test('4 — repas > 900 g : niveau 3 « Repas extrêmement volumineux »', () => {
  const items = [item(F('Tomates concassées'), 950)];
  const v = analyzeMealVolume(items, byId, 'thomas');
  check('masse = 950 g', v.grams === 950);
  check('niveau 3', v.level === 3);
  check('libellé « Repas extrêmement volumineux »', v.label === 'Repas extrêmement volumineux', v.label);
});

test('Frontières exactes des paliers (inclusives sur le seuil bas)', () => {
  check('600 g pile → niveau 0', volumeLevelFor(600).level === 0);
  check('600,1 g → niveau 1', volumeLevelFor(600.1).level === 1);
  check('750 g pile → niveau 1', volumeLevelFor(750).level === 1);
  check('750,1 g → niveau 2', volumeLevelFor(750.1).level === 2);
  check('900 g pile → niveau 2', volumeLevelFor(900).level === 2);
  check('900,1 g → niveau 3', volumeLevelFor(900.1).level === 3);
});

/* ================================================================ COOKEDFACTOR */

test('5 — cookedFactor ≠ 1 : la masse d’assiette suit l’état réellement présent, pas la somme saisie', () => {
  // cas du cahier des charges V1.4 : riz cru + haricots égouttés + maïs égoutté
  // + viande hachée crue + tomates prêtes.
  const items = [
    item(F('Riz basmati'), 120, { state: 'cru' }),        // cru, cookedFactor 2,6 → 312 g
    item(F('Haricots rouges'), 150, { state: 'egoutte' }), // déjà l'état consommé → 150 g
    item(F('Maïs'), 150, { state: 'egoutte' }),            // déjà l'état consommé → 150 g
    item(F('Steak haché'), 250, { state: 'cru' }),          // cru, cookedFactor 0,75 → 187,5 g
    item(F('Tomates concassées'), 200, { state: 'pret' }),  // déjà l'état consommé → 200 g
  ];
  const rawSum = items.reduce((s, it) => s + it.qty.thomas, 0);
  const { grams } = plateMassOf(items, byId, 'thomas');
  info(`somme saisie ${rawSum} g — masse d’assiette ${grams} g`);
  check('somme saisie = 870 g (grandeur non physique, pour référence)', rawSum === 870, `${rawSum} g`);
  check('masse d’assiette correcte ≈ 999,5 g (312 + 150 + 150 + 187,5 + 200)',
    Math.abs(grams - 999.5) < 0.01, `${grams} g`);
  check('la masse d’assiette n’est PAS la somme brute des quantités saisies', grams !== rawSum);
});

/* ================================================================ NON CONVERTIBLE */

test('6 — aliment pesé cru sans cookedFactor exploitable : exclu, jamais de facteur 1 inventé', () => {
  const sansRendement = { ...F('Blanc de poulet'), id: 'f_test_sans_rendement', cookedFactor: null };
  const localById = { ...byId, [sansRendement.id]: sansRendement };
  const items = [
    item(F('Riz basmati'), 100, { state: 'cru' }),         // convertible : 260 g
    item(sansRendement, 150, { state: 'cru' }),            // non convertible : exclu
  ];
  const { grams, excludedCount, partial } = plateMassOf(items, localById, 'thomas');
  check('seul le riz est compté (260 g)', Math.abs(grams - 260) < 0.01, `${grams} g`);
  check('un ingrédient exclu', excludedCount === 1);
  check('estimation signalée partielle', partial === true);
  // aucun facteur 1 inventé : la contribution du poulet non convertible n'est pas 150 g
  check('aucune masse inventée pour l’ingrédient exclu', grams !== 260 + 150);
});

test('6bis — aliment pesé cuit / égoutté / prêt : jamais besoin de cookedFactor', () => {
  const sansRendement = { ...F('Cabillaud'), id: 'f_test_sans_rendement2', cookedFactor: null };
  const localById = { ...byId, [sansRendement.id]: sansRendement };
  const items = [item(sansRendement, 150, { state: 'pret' })]; // déjà consommé : pas de conversion requise
  const { grams, excludedCount, partial } = plateMassOf(items, localById, 'thomas');
  check('masse = quantité, aucune exclusion', grams === 150 && excludedCount === 0 && partial === false, `${grams} g`);
});

/* ================================================================ VERROUILLAGE */

test('7 — aucune interaction avec le verrouillage', () => {
  const base = [item(F('Riz basmati'), 200, { state: 'cru' }), item(F('Tomates concassées'), 300)];
  const locked = base.map((it) => ({ ...it, locked: { thomas: true, julie: true } }));
  const unlocked = base.map((it) => ({ ...it, locked: { thomas: false, julie: false } }));
  const vLocked = analyzeMealVolume(locked, byId, 'thomas');
  const vUnlocked = analyzeMealVolume(unlocked, byId, 'thomas');
  check('même masse, verrouillé ou non', vLocked.grams === vUnlocked.grams, `${vLocked.grams} vs ${vUnlocked.grams}`);
  check('même niveau, verrouillé ou non', vLocked.level === vUnlocked.level);
});

/* ================================================================ AUCUNE MODIFICATION */

test('8 — aucune modification des quantités', () => {
  const items = [
    item(F('Riz basmati'), 120, { state: 'cru' }),
    item(F('Steak haché'), 250, { state: 'cru', lock: true }),
    item(F('Tomates concassées'), 200),
  ];
  const before = JSON.stringify(items);
  analyzeMealVolume(items, byId, 'thomas');
  plateMassOf(items, byId, 'thomas');
  volumeLevelFor(9999);
  check('items strictement inchangés (comparaison JSON profonde)', JSON.stringify(items) === before);
});

/* ================================================================ DÉTERMINISME */

test('9 — déterminisme : même entrée, même résultat', () => {
  const items = [
    item(F('Riz basmati'), 120, { state: 'cru' }),
    item(F('Haricots rouges'), 150, { state: 'egoutte' }),
    item(F('Steak haché'), 250, { state: 'cru' }),
  ];
  const results = Array.from({ length: 5 }, () => analyzeMealVolume(items, byId, 'thomas'));
  check('5 appels identiques', results.every((r) => JSON.stringify(r) === JSON.stringify(results[0])),
    results.map((r) => r.grams).join(','));
});

/* ================================================================ ISOLATION DU MOTEUR */

test('10 — le module de volume est strictement isolé du moteur nutritionnel', () => {
  const src = fs.readFileSync(join(root, 'js/core/nutrition.js'), 'utf8');
  check('js/core/nutrition.js ne contient aucun import du module de volume', !/meal-volume/.test(src));

  // jeu de quantités de référence figées : si meal-volume.js était supprimé
  // (avec son import dans la vue), ce résultat doit rester STRICTEMENT identique,
  // puisque nutrition.js ne l'importe jamais.
  const items = [item(F('Blanc de poulet')), item(F('Pâtes complètes'))];
  autoAdjust(items, byId, LUNCH);
  items.push(item(F('Haricots verts'), 200));
  autoAdjust(items, byId, LUNCH);
  const veg = items[2].qty.thomas;
  info(`référence figée (indépendante du module de volume) : légume = ${veg} g`);
  check('résultat de référence de l’optimiseur inchangé (170 g)', veg === 170, `${veg} g`);
});

/* ---------------------------------------------------------------- bilan */

console.log('\n' + '='.repeat(60));
console.log(`${passed} vérifications réussies, ${failures.length} échec(s).`);
if (failures.length) {
  console.log('\nÉchecs :');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
