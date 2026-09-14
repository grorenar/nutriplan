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
globalThis.CustomEvent = window.CustomEvent;
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

console.log('\n— État pesé dans le repas');
const pastaRow = $$('#drawer .item').find((el) => /Pâtes complètes/.test(el.textContent));
const stateSel = pastaRow.querySelector('[data-state]');
check('les quatre états sont proposés', stateSel.options.length === 4);
check('état par défaut = état des valeurs nutritionnelles', stateSel.value === 'cru');
const kcalBefore = Number((pastaRow.textContent.match(/(\d+) kcal/) || [])[1]);
change(stateSel, 'cuit');
await wait();
const pastaCooked = $$('#drawer .item').find((el) => /Pâtes complètes/.test(el.textContent));
check('état enregistré et relu', pastaCooked.querySelector('[data-state]').value === 'cuit');
check('conversion signalée via le rendement', /rendement/.test(pastaCooked.textContent));
check('macros recalculées sur le poids cuit',
  Number((pastaCooked.textContent.match(/(\d+) kcal/) || [])[1]) < kcalBefore);
change(pastaCooked.querySelector('[data-state]'), 'egoutte');
await wait();
const pastaDrained = $$('#drawer .item').find((el) => /Pâtes complètes/.test(el.textContent));
check('conversion impossible signalée à l’utilisateur',
  /Conversion impossible/.test(pastaDrained.textContent));
check('aucune macro calculée pour cet ingrédient',
  /— kcal · — P · — G · — L/.test(pastaDrained.textContent),
  (pastaDrained.textContent.match(/[—\d]+ kcal/) || [''])[0]);
check('ingrédient exclu du total du repas',
  /exclu\(s\) du total/.test($('#drawer .drawer__body').textContent));
const totalDrained = Number(($('#drawer .macro')?.textContent.match(/(\d+)/) || [])[1]);
change(pastaDrained.querySelector('[data-state]'), 'cru');
await wait();
const totalBack = Number(($('#drawer .macro')?.textContent.match(/(\d+)/) || [])[1]);
check('le total remonte une fois un état convertible choisi', totalBack > totalDrained,
  `${totalDrained} → ${totalBack}`);
check('plus aucun avertissement de conversion',
  !/Conversion impossible/.test($('#drawer .drawer__body').textContent));

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
check('état pesé affiché à côté de la quantité',
  /État pesé/.test(wasaRow.textContent) && !!wasaRow.querySelector('[data-state]'));
click(wasaRow.querySelector('[data-unit-toggle]')); // passage en grammes
const wasaGram = $$('#drawer .item').find((el) => /croustillant/i.test(el.textContent)).querySelector('[data-qty]');
check('pas du curseur = poids d’une unité', wasaGram.getAttribute('step') === '11', wasaGram.getAttribute('step'));
click($$('#drawer .item').find((el) => /croustillant/i.test(el.textContent)).querySelector('[data-unit-toggle]'));
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

console.log('\n— Détection de doublons : popup bloquante');
click($('[data-view="foods"]'));
await wait();
const foodCount = () => JSON.parse(localStorage.getItem('nutriplan.state.v1')).foods.length;
const before = foodCount();

// 1. aucun similaire → création directe, aucune popup
click($('[data-new]'));
const setField = (name, v) => { const el = $(`[data-f="${name}"]`); el.value = v; };
setField('name', 'Cuisse de dinosaure');
setField('kcal', '150');
click($('[data-save]'));
await wait();
check('aucun similaire : aucune popup', !$('.modal'));
check('aucun similaire : création directe', foodCount() === before + 1);
check('aucun toast de doublon', !/similaire/i.test(document.getElementById('toasts')?.textContent || ''));

// 2. similaire détecté → popup affichée
click($('[data-new]'));
setField('name', 'Blanc de poulet');
setField('kcal', '110');
click($('[data-save]'));
await wait();
check('similaire détecté : popup affichée', !!$('.modal'));
check('popup centrée et bloquante', !!$('.modal__panel') && !!$('[data-similar-confirm]'));
check('l’élément existant est présenté avec ses macros',
  /Blanc de poulet/.test($('.modal').textContent) && /kcal/.test($('.modal').textContent));
check('l’élément en cours de création est rappelé', /en train de créer/.test($('.modal').textContent));
check('aucun message de doublon en bas de fenêtre',
  !/similaire/i.test(document.getElementById('toasts')?.textContent || ''));
check('rien n’est créé tant que l’utilisateur n’a pas répondu', foodCount() === before + 1);

// 3. Annuler → élément non créé
click($('[data-similar-cancel]'));
await wait();
check('Annuler : popup fermée', !$('.modal'));
check('Annuler : aucun aliment créé', foodCount() === before + 1);
check('Annuler : la saisie reste disponible', $('[data-f="name"]')?.value === 'Blanc de poulet');

// 4. Créer quand même → élément créé
click($('[data-save]'));
await wait();
check('la popup réapparaît à la nouvelle tentative', !!$('.modal'));
click($('[data-similar-confirm]'));
await wait();
check('Créer quand même : aliment créé', foodCount() === before + 2, `${foodCount()}`);
check('Créer quand même : popup fermée et formulaire refermé', !$('.modal') && !$('[data-f="name"]'));
const foodsNow = JSON.parse(localStorage.getItem('nutriplan.state.v1')).foods;
check('aucun aliment fusionné ni supprimé',
  foodsNow.filter((f) => f.name === 'Blanc de poulet').length === 2, `${foodsNow.length} aliments`);

// 5. plusieurs similaires → tous listés
click($('[data-new]'));
setField('name', 'Blanc de poulet');
setField('kcal', '110');
click($('[data-save]'));
await wait();
const listed = ($('.modal').textContent.match(/Blanc de poulet/g) || []).length;
check('plusieurs similaires listés dans la popup', listed >= 3, `${listed} mentions`);
click($('[data-similar-cancel]'));
click($('[data-form-cancel]'));
await wait();

console.log('\n— Fiche aliment : rendement et conservation');
click($('[data-view="foods"]'));
await wait();
click($$('[data-edit]')[0]);
await wait();
check('champ nommé « Rendement après cuisson »', /Rendement après cuisson/.test($('#view').textContent));
check('aide à la formule affichée', /poids cuit ÷ poids cru/.test($('#view').textContent));
check('champ de conservation présent', !!$('[data-f="shelfLifeDays"]'));
check('champ « État des valeurs nutritionnelles »', /État des valeurs nutritionnelles/.test($('#view').textContent));
check('option « Cru / brut » proposée',
  [...$('[data-f="referenceState"]').options].some((o) => o.textContent === 'Cru / brut'));
check('case « Nécessite une cuisson » présente', !!$('[data-f="requiresCooking"]'));
check('indépendance vis-à-vis de l’état de référence expliquée',
  /Indépendant de l.état de référence/.test($('#view').textContent));
$('[data-f="shelfLifeDays"]').value = '3';
click($('[data-yield-open]'));
await wait();
check('modale de calcul ouverte', !!$('[data-yield-run]'));
$('[data-yield-raw]').value = '500';
$('[data-yield-cooked]').value = '375';
click($('[data-yield-run]'));
await wait();
check('rendement calculé affiché', /Rendement calculé : 0,75/.test($('#view').textContent));
check('équivalence affichée', /100 g cru → 75 g cuit/.test($('#view').textContent));
click($('[data-yield-apply]'));
await wait();
check('rendement reporté dans la fiche', $('[data-f="cookedFactor"]').value === '0.75', $('[data-f="cookedFactor"]').value);
check('la saisie en cours est conservée', $('[data-f="shelfLifeDays"]').value === '3');
const editedName = $('[data-f="name"]').value;
click($('[data-save]'));
await wait();
const savedFood = JSON.parse(localStorage.getItem('nutriplan.state.v1')).foods.find((f) => f.name === editedName);
check('rendement enregistré', savedFood.cookedFactor === 0.75, `${savedFood.cookedFactor}`);
check('« nécessite une cuisson » enregistré', typeof savedFood.requiresCooking === 'boolean');
check('conservation enregistrée', savedFood.shelfLifeDays === 3, `${savedFood.shelfLifeDays}`);

// erreurs de saisie dans la modale
click($$('[data-edit]')[0]);
await wait();
click($('[data-yield-open]'));
await wait();
$('[data-yield-raw]').value = '0';
$('[data-yield-cooked]').value = '375';
click($('[data-yield-run]'));
await wait();
check('poids cru nul : erreur affichée, aucun résultat',
  /nul/i.test($('#view').textContent) && !/Rendement calculé/.test($('#view').textContent));
click($('[data-yield-cancel]'));
click($('[data-form-cancel]'));
await wait();

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

// aliments sans prix : nommés et cliquables (on vide le prix via la fiche)
click($('[data-view="foods"]'));
await wait();
type($('[data-q]'), 'haricots verts');
click($$('[data-edit]')[0]);
await wait();
const sansPrixNom = $('[data-f="name"]').value;
$('[data-f="price"]').value = '';
$('[data-f="packageWeight"]').value = '';
click($('[data-save]'));
await wait();
click($('[data-view="shopping"]'));
await wait();
check('aliment sans prix nommé dans l’avertissement',
  /Prix non renseigné/.test($('#view').textContent) && $('#view').textContent.includes(sansPrixNom), sansPrixNom);
const openBtn = $$('[data-open-food]').find((b) => b.textContent.includes(sansPrixNom));
check('lien vers la fiche disponible', !!openBtn);
click(openBtn);
await wait();
check('la fiche de l’aliment s’ouvre dans Aliments',
  $('#title').textContent === 'Banque alimentaire' && $('[data-f="name"]')?.value === sansPrixNom);
click($('[data-form-cancel]'));
await wait();

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
check('état pesé indiqué à côté des quantités imprimées',
  /\d+ g (cru \/ brut|cuit|égoutté|prêt à consommer)/i.test($('#print').textContent),
  ($('#print').textContent.match(/\d+ g [a-zé\s\/]+/i) || [''])[0].trim());
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
