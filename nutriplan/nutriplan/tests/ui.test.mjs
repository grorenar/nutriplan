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

console.log('\n— Aliments récents');
type($('#drawer [data-search]'), ''); // la recherche filtre aussi l'onglet Récents
click($('#drawer [data-cat="recent"]'));
check('les aliments utilisés apparaissent dans "Récents"',
  $$('#drawer [data-add]').some((b) => b.textContent.includes('Blanc de poulet')));

click($('#drawer [data-close]'));
check('éditeur fermé', !$('#drawer .drawer__panel'));
check('macros visibles sur la carte du planning', $$('.meal-card .macro').length >= 8);

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

console.log('\n— Impression');
click($('#print-btn'));
click($('#modal [data-print-go]'));
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
