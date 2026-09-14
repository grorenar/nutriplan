/**
 * Test d'interface de bout en bout (jsdom) : on charge index.html, on clique
 * réellement dans l'application et on vérifie ce qui s'affiche.
 *
 *   npm i jsdom && node tests/ui.test.mjs
 *
 * jsdom n'est utilisé que pour les tests : l'application elle-même n'a
 * aucune dépendance.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let JSDOM;
try { ({ JSDOM } = await import('jsdom')); }
catch { console.log('jsdom absent — test ignoré (npm i jsdom pour l’exécuter)'); process.exit(0); }

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const dom = new JSDOM(fs.readFileSync(join(root, 'index.html'), 'utf8'), {
  url: 'https://example.org/', pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.location = window.location;
globalThis.confirm = () => true;
globalThis.Blob = window.Blob;
globalThis.URL = window.URL;
window.print = () => { printed++; };
let printed = 0;

let passed = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`   ok   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failures.push(label); console.log(`   FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const jsErrors = [];
window.addEventListener('error', (e) => jsErrors.push(e.message));

await import(join(root, 'js/app.js'));
document.dispatchEvent(new window.Event('DOMContentLoaded'));
await new Promise((r) => setTimeout(r, 50));

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const change = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('change', { bubbles: true })); };
const type = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const wait = () => new Promise((r) => setTimeout(r, 20));

console.log('\n— Démarrage');
check('7 entrées de navigation', $$('#nav button').length === 7);
check('8 créneaux de repas pour un cycle de 4 jours', $$('.meal-card').length === 8);
check('état de synchronisation affiché', /Mode local/.test($('#status').textContent));

console.log('\n— Composition d’un déjeuner');
click($$('[data-edit]')[0]);
check('éditeur ouvert', !!$('#drawer .drawer__panel'));
const add = (search, label) => {
  type($('#drawer [data-search]'), search);
  const btn = $$('#drawer [data-add]').find((b) => b.textContent.includes(label));
  if (!btn) throw new Error(`aliment introuvable : ${label}`);
  click(btn);
};
add('poulet', 'Blanc de poulet');
add('pâtes com', 'Pâtes complètes');
add('haricots', 'Haricots verts');
add('huile d', 'Huile d');
check('4 ingrédients', $$('#drawer .item').length === 4);
const macros = $$('#drawer .macro').slice(0, 4).map((m) => m.textContent.replace(/\s+/g, ' ').trim());
console.log(`        ${macros.join(' | ')}`);
check('macros affichées sans clic supplémentaire', macros.length === 4);
check('glucides affichés "G" et non "C"', macros.some((m) => / G$/.test(m)) && !macros.some((m) => / C$/.test(m)), macros.join(' | '));
check('les 4 macros de Thomas sont dans la cible',
  $$('#drawer .macro').slice(0, 4).every((m) => m.classList.contains('is-ok')));

console.log('\n— Verrouillage');
const qty = () => $$('#drawer [data-qty]').map((i) => i.value);
change($$('#drawer [data-qty]')[0], '180');
click($$('#drawer [data-lock]')[0]);
const lockedValue = qty()[0];
check('poulet à 180 g après verrouillage', lockedValue === '180', lockedValue);
change($$('#drawer [data-qty]')[2], '150');
check('poulet inchangé après modification des pâtes', qty()[0] === '180');
check('aucun ingrédient supprimé', $$('#drawer .item').length === 4);

console.log('\n— Ingrédient libre');
$('#drawer [data-free-name]').value = 'Curry';
$('#drawer [data-free-qty]').value = 'au goût';
click($('#drawer [data-free-add]'));
check('curry ajouté au repas', $$('#drawer .item').length === 5 && /Curry/.test($('#drawer').textContent));
check('curry marqué hors macros', /non compté dans les macros/.test($('#drawer').textContent));

console.log('\n— Stabilité de la recherche');
const panelBefore = $('#drawer .drawer__panel');
const searchEl = $('#drawer [data-search]');
type(searchEl, '');
searchEl.focus();
for (const chunk of ['s', 'k', 'y']) type(searchEl, searchEl.value + chunk);
check('le champ de recherche garde le focus', document.activeElement === $('#drawer [data-search]'));
check('la fenêtre n’est pas reconstruite', $('#drawer .drawer__panel') === panelBefore);
check('le texte saisi est conservé', $('#drawer [data-search]').value === 'sky', $('#drawer [data-search]').value);
check('seuls les résultats changent', $$('#drawer [data-add]').every((b) => /skyr/i.test(b.textContent)));
type($('#drawer [data-search]'), '');

console.log('\n— Saisie en unités et multiples stricts');
type($('#drawer [data-search]'), 'croustillant');
click($$('#drawer [data-add]')[0]);
const wasaRow = $$('#drawer .item').find((el) => /croustillant/i.test(el.textContent));
check('aliment à l’unité ajouté', !!wasaRow);
check('mention des multiples affichée', /multiples de 11 g/.test(wasaRow.textContent));
const wasaInput = wasaRow.querySelector('[data-qty]');
check('saisie en unités par défaut', wasaInput.dataset.unitmode === '1');
change(wasaInput, '3');
let wasaQty = () => {
  const st = JSON.parse(localStorage.getItem('nutriplan.state.v1'));
  const it = st.meals[0].items.find((i) => /wasa|croustillant/.test(i.foodId));
  return it ? it.qty.thomas : null;
};
check('3 tranches = 33 g stockés', wasaQty() === 33, `${wasaQty()} g`);
click(wasaRow.querySelector('[data-unit-toggle]'));
const wasaRow2 = $$('#drawer .item').find((el) => /croustillant/i.test(el.textContent));
check('bascule en grammes', wasaRow2.querySelector('[data-qty]').dataset.unitmode === '0');
change(wasaRow2.querySelector('[data-qty]'), '25');
check('25 g saisis → 22 g (multiple de 11)', wasaQty() === 22, `${wasaQty()} g`);
click($$('#drawer .item').find((el) => /croustillant/i.test(el.textContent)).querySelector('[data-del]'));

console.log('\n— Aliments récents');
type($('#drawer [data-search]'), ''); // la recherche filtre aussi l'onglet Récents
click($('#drawer [data-cat="recent"]'));
check('les aliments utilisés apparaissent dans "Récents"',
  $$('#drawer [data-add]').some((b) => b.textContent.includes('Blanc de poulet')));

click($('#drawer [data-close]'));
check('éditeur fermé', !$('#drawer .drawer__panel'));
check('macros visibles sur la carte du planning', $$('.meal-card .macro').length >= 8);

console.log('\n— Détection de doublons');
click($('[data-view="foods"]'));
await wait();
click($('[data-new]'));
const setField = (name, v) => { const el = $(`[data-f="${name}"]`); el.value = v; };
setField('name', 'Blanc de poulet');
setField('kcal', '110');
click($('[data-save]'));
await wait();
check('avertissement de doublon affiché', /similaire/i.test($('#view').textContent));
check('création toujours possible', /Créer quand même/.test($('#view').textContent));
click($('[data-save]'));
await wait();
const foodsAfter = JSON.parse(localStorage.getItem('nutriplan.state.v1')).foods;
check('l’aliment est créé malgré l’avertissement',
  foodsAfter.filter((f) => f.name === 'Blanc de poulet').length === 2);
check('aucun aliment fusionné ni supprimé', foodsAfter.length === 89, `${foodsAfter.length}`);

console.log('\n— Catalogues, couverture et courses');
click($('[data-view="breakfasts"]'));
await wait();
check('couverture affichée pour les deux personnes', /Couverture du cycle/.test($('#view').textContent));
check('besoin théorique = durée du cycle', /0 \/ 4/.test($('#view').textContent), $('#view').textContent.slice(0, 120));
check('avertissement de manque affiché', /⚠️/.test($('#view').textContent));
check('bouton de forçage proposé', !!$('[data-force]'));

click($('[data-new]'));
await wait();
type($('#drawer [data-search]'), 'flocons');
click($$('#drawer [data-add]')[0]);
click($('#drawer [data-close]'));
await wait();
click($('[data-view="shopping"]'));
await wait();
check('option non utilisée : absente des courses', !/flocons/i.test($('#view').textContent));

click($('[data-view="breakfasts"]'));
await wait();
const plusFor = (person) =>
  $$(`[data-uses][data-person="${person}"][data-delta="1"]`)[0];
click(plusFor('thomas'));
click(plusFor('thomas'));
click(plusFor('julie'));
await wait();
const bState = () => JSON.parse(localStorage.getItem('nutriplan.state.v1')).breakfasts[0];
check('compteurs indépendants Thomas / Julie', bState().uses.thomas === 2 && bState().uses.julie === 1,
  JSON.stringify(bState().uses));
check('couverture mise à jour', /2 \/ 4/.test($('#view').textContent));
click($('[data-force]'));
await wait();
check('écart assumé mémorisé', JSON.parse(localStorage.getItem('nutriplan.state.v1')).coverage.forced.breakfast === true);
check('avertissement toujours visible après forçage', /⚠️/.test($('#view').textContent));

click($('[data-view="shopping"]'));
await wait();
check('option utilisée : présente dans les courses', /flocons/i.test($('#view').textContent));

console.log('\n— Collations : catalogue unique 16 h / soir');
click($('[data-view="snacks"]'));
await wait();
check('un seul catalogue de collations', !/Collations 16 h.*Collations du soir/s.test($('#view').textContent.slice(0, 200)) && /Couverture du cycle/.test($('#view').textContent));
check('libellés 16 h et Soir', /16 h/.test($('#view').textContent) && /Soir/.test($('#view').textContent));
click($('[data-new]'));
await wait();
type($('#drawer [data-search]'), 'cajou');
click($$('#drawer [data-add]')[0]);
click($('#drawer [data-close]'));
await wait();
const snackPlus = (person, slot) =>
  $$(`[data-uses][data-person="${person}"][data-slot="${slot}"][data-delta="1"]`)[0];
click(snackPlus('thomas', 'afternoon'));
click(snackPlus('thomas', 'afternoon'));
click(snackPlus('thomas', 'evening'));
click(snackPlus('julie', 'evening'));
await wait();
const sState = () => JSON.parse(localStorage.getItem('nutriplan.state.v1')).snacks[0];
check('affectations 16 h / soir enregistrées séparément',
  sState().uses.thomas.afternoon === 2 && sState().uses.thomas.evening === 1 && sState().uses.julie.evening === 1,
  JSON.stringify(sState().uses));
click($('[data-view="shopping"]'));
await wait();
check('collation utilisée : présente dans les courses', /cajou/i.test($('#view').textContent));

console.log('\n— Navigation complète');
for (const id of ['foods', 'breakfasts', 'snacks', 'batch', 'shopping', 'settings']) {
  click($(`[data-view="${id}"]`));
  await wait();
  check(`vue ${id} rendue`, $('#view').textContent.length > 50, `${$('#title').textContent}`);
}

console.log('\n— Courses et batch');
click($('[data-view="shopping"]'));
const line = $$('.list-row').map((l) => l.textContent.replace(/\s+/g, ' ').trim()).find((t) => /poulet/i.test(t));
console.log(`        ${line}`);
check('ligne de courses avec besoin et conditionnement', /Besoin/.test(line || ''));
const cb = $$('[data-buy]')[0];
cb.checked = true; cb.dispatchEvent(new window.Event('change', { bubbles: true }));
check('case "acheté" enregistrée', $$('[data-buy]')[0].checked === true);

click($('[data-view="batch"]'));
const prep = $$('[data-prep]')[0];
check('composants de batch listés', !!prep);
change(prep, '1500');
check('quantité préparée modifiable', $$('[data-prep]')[0].value === '1500');
check('note de préparation du poulet affichée', /filets entiers/.test($('#view').textContent));
check('trois catégories affichées',
  /À préparer en batch/.test($('#view').textContent) &&
  /À cuire le jour même/.test($('#view').textContent) &&
  /À assembler le jour même/.test($('#view').textContent));
check('plan opératoire : méthode et température', /Four/.test($('#view').textContent) && /180 °C/.test($('#view').textContent));
check('détail des gamelles présent', /Détail des gamelles/.test($('#view').textContent));

console.log('\n— Impression');
click($('#print-btn'));
click($('#modal [data-print-all]'));
click($('#modal [data-print-go]'));
check('catalogues imprimés avec leurs utilisations', /Couverture du cycle/.test($('#print').textContent) && /Utilisations/.test($('#print').textContent));
check('document d’impression généré', $('#print').innerHTML.length > 1000);
check('window.print() appelé', printed === 1);

console.log('\n— Paramètres');
click($('[data-view="settings"]'));
await wait();
change($('[data-duration]'), '6');
await wait();
click($('[data-view="planning"]'));
check('cycle passé à 6 jours', $$('.day').length === 6);
click($('[data-view="settings"]'));
await wait();
check('mode local expliqué dans le compte', /Mode local uniquement/.test($('#view').textContent));

console.log('\n— Persistance locale');
const saved = JSON.parse(localStorage.getItem('nutriplan.state.v1'));
check('état écrit dans localStorage', !!saved && saved.foods.length > 50);
check('repas conservé avec son verrou',
  saved.meals[0].items.some((i) => i.locked.thomas === true && i.qty.thomas === 180));
check('ingrédient libre conservé', saved.meals[0].items.some((i) => i.free?.name === 'Curry'));

console.log('\n' + '='.repeat(60));
check('aucune erreur JavaScript', jsErrors.length === 0, jsErrors.join(' / '));
console.log(`${passed} vérifications réussies, ${failures.length} échec(s).`);
if (failures.length) { console.log(failures.map((x) => `  - ${x}`).join('\n')); process.exitCode = 1; }
