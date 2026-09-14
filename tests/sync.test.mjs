/**
 * Test d'intégration de la couche Supabase, exécuté sur un PostgreSQL local.
 *
 *   node tests/sync.test.mjs
 *
 * Le script émule `auth.uid()` / `auth.users` (fournis par Supabase), applique
 * supabase/schema.sql, puis vérifie :
 *   - l'écriture atomique via nutriplan_replace_all (rollback complet en cas d'erreur) ;
 *   - les compteurs renvoyés, sur lesquels s'appuie la vérification côté client ;
 *   - l'aller-retour état -> tables -> état (aucune perte de donnée) ;
 *   - l'isolation entre deux comptes (RLS).
 *
 * Prérequis : un serveur PostgreSQL local et la commande psql accessibles.
 * Ce test ne touche JAMAIS à la base Supabase de production.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultState } from '../js/core/store.js';
import { stateToTables, tablesToState, verifyCounts, TABLES } from '../js/core/sync.js';
import { seedFoods } from '../js/core/seed-foods.js';

const DB = process.env.NUTRIPLAN_TEST_DB || 'nutritest';
const PSQL_USER = process.env.NUTRIPLAN_TEST_PSQL_USER || 'postgres';
const UID1 = '11111111-1111-1111-1111-111111111111';
const UID2 = '22222222-2222-2222-2222-222222222222';

const tmp = mkdtempSync(join(tmpdir(), 'nutriplan-'));
chmodSync(tmp, 0o777); // psql tourne sous l'utilisateur postgres
let passed = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`   ok   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failures.push(label); console.log(`   FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** Exécute du SQL en tant qu'utilisateur authentifié donné, renvoie la sortie texte. */
function sql(text, uid = null, { tuples = true } = {}) {
  const file = join(tmp, `q${Date.now()}${Math.random().toString(36).slice(2)}.sql`);
  const prelude = uid
    ? `set local role authenticated;\nselect set_config('request.jwt.claim.sub', '${uid}', true);\n`
    : '';
  writeFileSync(file, uid ? `begin;\n${prelude}${text}\ncommit;\n` : text);
  chmodSync(file, 0o644);
  const out = execFileSync('su', [PSQL_USER, '-c', `psql -q -v ON_ERROR_STOP=1 ${tuples ? '-At' : ''} -d ${DB} -f ${file}`], {
    encoding: 'utf8',
  }).trim();
  // la première ligne est la sortie de set_config (identité simulée)
  return uid ? out.split('\n').slice(1).join('\n').trim() : out;
}

/** Appelle la fonction de remplacement atomique avec un payload JSON. */
function replaceAll(payload, uid) {
  return sql(`select nutriplan_replace_all($nutriplan$${JSON.stringify(payload)}$nutriplan$::jsonb);`, uid);
}

/* ------------------------------------------------------------------ */
/* Base de test jetable : émulation de ce que Supabase fournit          */
/* ------------------------------------------------------------------ */

/** Rejoue supabase/schema.sql tel qu'il sera collé dans l'éditeur SQL de Supabase. */
function applySchema() {
  const schemaPath = new URL('../supabase/schema.sql', import.meta.url).pathname;
  execFileSync('su', [PSQL_USER, '-c', `psql -q -d ${DB} -f ${schemaPath}`], { encoding: 'utf8' });
}

function bootstrap() {
  const admin = (text) => {
    const file = join(tmp, `admin${Math.random().toString(36).slice(2)}.sql`);
    writeFileSync(file, text);
    chmodSync(file, 0o644);
    return execFileSync('su', [PSQL_USER, '-c', `psql -q -d ${arguments[1] || 'postgres'} -f ${file}`], { encoding: 'utf8' });
  };
  // base jetable
  const f1 = join(tmp, 'create.sql');
  writeFileSync(f1, `drop database if exists ${DB};\ncreate database ${DB};\n`);
  chmodSync(f1, 0o644);
  execFileSync('su', [PSQL_USER, '-c', `psql -q -d postgres -f ${f1}`], { encoding: 'utf8' });

  // auth.users / auth.uid() / rôle authenticated : fournis par Supabase en production
  const f2 = join(tmp, 'auth.sql');
  writeFileSync(f2, `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
insert into auth.users values ('${UID1}'), ('${UID2}') on conflict do nothing;
create or replace function auth.uid() returns uuid language sql stable as
  $fn$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
do $do$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $do$;
grant usage on schema public, auth to authenticated;
grant execute on function auth.uid() to authenticated;
alter default privileges in schema public grant all on tables to authenticated;
`);
  chmodSync(f2, 0o644);
  execFileSync('su', [PSQL_USER, '-c', `psql -q -d ${DB} -f ${f2}`], { encoding: 'utf8' });

  // le schéma réel du projet, tel qu'il sera collé dans Supabase
  applySchema();

  // droits sur les tables créées par le schéma (Supabase les accorde par défaut)
  const f3 = join(tmp, 'grants.sql');
  writeFileSync(f3, 'grant all on all tables in schema public to authenticated;\n');
  chmodSync(f3, 0o644);
  execFileSync('su', [PSQL_USER, '-c', `psql -q -d ${DB} -f ${f3}`], { encoding: 'utf8' });
}

console.log('— Création de la base de test et application de supabase/schema.sql');
bootstrap();

console.log('\n— Préparation d’un état de test');
const state = defaultState();
state.settings.cycle = { startWeekday: 2, duration: 4 };
state.settings.budget = 115;
state.foods[0].lastUsed = '2026-09-01T10:00:00.000Z';
state.foods[0].favorite = true;
// paramètres de préparation personnalisés + saisie par unités
const dinoIndex = state.foods.length;
state.foods.push({
  id: 'f_dino', name: 'Cuisse de dinosaure', category: 'proteine', brand: 'Jurassic',
  kcal: 150, protein: 25, carbs: 0, fat: 6, fiber: 0,
  referenceState: 'cru', cookedFactor: 0.75, unitName: 'cuisse', gramsPerUnit: 250, fractionable: false,
  unitEntry: true, price: 19.9, packageWeight: 500, batchAllowed: true, favorite: false, lastUsed: null,
  cookingMethod: 'Four', cookingTemp: 200, cookingTime: 35, prepTime: 10, equipment: 'Four', shelfLifeDays: 3,
  requiresCooking: true,
  instructions: 'Cuire entière, laisser reposer, trancher.',
});
const f = (n) => seedFoods().find((x) => x.name.toLowerCase().includes(n)).id;
const item = (foodId, t, j, opts = {}) => ({
  id: `it_${Math.random().toString(36).slice(2, 8)}`,
  foodId,
  free: opts.free || null,
  state: opts.state || 'cru',
  qty: { thomas: t, julie: j },
  locked: { thomas: !!opts.lockT, julie: false },
});
state.meals = [
  { id: 'm1', dayIndex: 0, mealType: 'lunch', name: 'Poulet riz', sameComposition: true,
    items: [item(f('blanc de poulet'), 180, 130, { lockT: true }), item(f('riz basmati'), 240, 180, { state: 'cuit' }),
            { ...item(null, 0, 0), foodId: null, free: { name: 'Curry', quantity: 'au goût' } }] },
  { id: 'm2', dayIndex: 0, mealType: 'dinner', name: '', sameComposition: false, items: [] },
  { id: 'm3', dayIndex: 1, mealType: 'lunch', name: '', sameComposition: true, items: [] },
  { id: 'm4', dayIndex: 1, mealType: 'dinner', name: '', sameComposition: true, items: [] },
];
state.breakfasts = [{ id: 'b1', name: 'Skyr avoine', sameComposition: true, uses: { thomas: 4, julie: 3 },
  items: [item(f('skyr'), 150, 150, { state: 'pret' })] }];
state.snacks = [{
  id: 's1', name: 'Wasa poulet', sameComposition: true, targetSlot: 'evening',
  uses: { thomas: { afternoon: 3, evening: 2 }, julie: { afternoon: 2, evening: 1 } },
  items: [item(f('pain croustillant'), 33, 22, { state: 'pret' })],
}];
state.shopping.purchased = { [f('riz basmati')]: true };
state.batch.overrides = { [`0:${f('blanc de poulet')}`]: 1500 };

const payload = stateToTables(state);
console.log(`   ${TABLES.map((t) => `${t}:${payload[t].length}`).join(' ')}`);

console.log('\n— Écriture atomique et compteurs');
const counts = JSON.parse(replaceAll(payload, UID1));
check('la fonction renvoie un compteur par table', TABLES.every((t) => t in counts));
check('compteurs égaux aux lignes envoyées',
  TABLES.every((t) => counts[t] === payload[t].length),
  TABLES.map((t) => `${t}:${counts[t]}`).join(' '));

console.log('\n— Idempotence : rejouer le même envoi ne duplique rien');
const counts2 = JSON.parse(replaceAll(payload, UID1));
check('mêmes compteurs au second envoi', TABLES.every((t) => counts2[t] === payload[t].length));
const totalFoods = Number(sql(`select count(*) from foods where user_id = '${UID1}';`));
check('aucune duplication en base', totalFoods === payload.foods.length, `${totalFoods} aliments`);

console.log('\n— Vérification des compteurs côté client (logique pure)');
check('un envoi conforme est validé', verifyCounts(payload, counts).length === 0);
check('une table absente de la réponse est détectée',
  verifyCounts(payload, { ...counts, foods: undefined }).includes('foods'));
check('un compteur trop faible est détecté',
  verifyCounts(payload, { ...counts, meal_items: counts.meal_items - 1 }).includes('meal_items'));
check('une réponse vide invalide la synchronisation', verifyCounts(payload, {}).length === TABLES.length);

console.log('\n— Échec d’insertion : rollback complet, base inchangée');
console.log('   (l’erreur PostgreSQL affichée ci-dessous est volontaire)');
const broken = JSON.parse(JSON.stringify(payload));
broken.meal_items.push({ ...broken.meal_items[0], id: 'orphelin:thomas', meal_id: 'repas_inexistant' });
let failed = false;
try { replaceAll(broken, UID1); } catch (e) { failed = true; }
check('l’envoi corrompu est rejeté', failed);
const afterFail = {
  foods: Number(sql(`select count(*) from foods where user_id = '${UID1}';`)),
  meals: Number(sql(`select count(*) from meals where user_id = '${UID1}';`)),
  items: Number(sql(`select count(*) from meal_items where user_id = '${UID1}';`)),
};
check('les aliments sont toujours là', afterFail.foods === payload.foods.length, `${afterFail.foods}`);
check('les repas sont toujours là', afterFail.meals === payload.meals.length, `${afterFail.meals}`);
check('aucune ligne orpheline insérée', afterFail.items === payload.meal_items.length, `${afterFail.items}`);

console.log('\n— Aller-retour état → base → état');
const dump = {};
for (const t of TABLES) {
  dump[t] = JSON.parse(
    sql(`select coalesce(json_agg(x), '[]'::json) from (select * from ${t} where user_id = '${UID1}') x;`)
  );
}
const back = tablesToState(dump);
check('nombre d’aliments conservé', back.foods.length === state.foods.length);
check('valeurs nutritionnelles conservées',
  back.foods.find((x) => x.id === f('blanc de poulet')).protein ===
  state.foods.find((x) => x.id === f('blanc de poulet')).protein);
check('lastUsed synchronisé', back.foods.find((x) => x.lastUsed)?.lastUsed === state.foods[0].lastUsed,
  String(back.foods.find((x) => x.lastUsed)?.lastUsed));
check('favoris conservés', back.foods.filter((x) => x.favorite).length === state.foods.filter((x) => x.favorite).length);
check('objectifs conservés', back.settings.targets.thomas.lunch.kcal === state.settings.targets.thomas.lunch.kcal);
check('paramètres du cycle conservés',
  back.settings.cycle.startWeekday === 2 && back.settings.cycle.duration === 4 && back.settings.budget === 115);
const m1 = back.meals.find((m) => m.id === 'm1');
check('repas conservés', back.meals.length === 4 && m1.name === 'Poulet riz');
check('quantités par personne conservées',
  m1.items[0].qty.thomas === 180 && m1.items[0].qty.julie === 130,
  JSON.stringify(m1.items[0].qty));
check('verrou conservé', m1.items[0].locked.thomas === true && m1.items[0].locked.julie === false);
check('état cru/cuit conservé', m1.items[0].state === 'cru');
check('état « cuit » choisi dans le repas sauvegardé et relu',
  m1.items[1].state === 'cuit' && m1.items[1].qty.thomas === 240, JSON.stringify(m1.items[1].state));
check('ingrédient libre conservé',
  m1.items.some((i) => i.free?.name === 'Curry' && i.free.quantity === 'au goût'));
check('sameComposition conservé', back.meals.find((m) => m.id === 'm2').sameComposition === false);
check('catalogue petits-déjeuners conservé', back.breakfasts.length === 1 && back.breakfasts[0].items.length === 1);
check('utilisations des petits-déjeuners par personne conservées',
  back.breakfasts[0].uses.thomas === 4 && back.breakfasts[0].uses.julie === 3,
  JSON.stringify(back.breakfasts[0].uses));
check('affectations 16 h / soir des collations conservées',
  JSON.stringify(back.snacks[0].uses) ===
    JSON.stringify({ thomas: { afternoon: 3, evening: 2 }, julie: { afternoon: 2, evening: 1 } }),
  JSON.stringify(back.snacks[0].uses));
const dino = back.foods.find((x) => x.id === 'f_dino');
check('paramètres de cuisson personnalisés conservés',
  dino.cookingMethod === 'Four' && dino.cookingTemp === 200 && dino.cookingTime === 35 && dino.prepTime === 10,
  `${dino.cookingMethod} ${dino.cookingTemp} ${dino.cookingTime}`);
check('consignes libres conservées', /Cuire entière/.test(dino.instructions));
check('matériel conservé', dino.equipment === 'Four');
check('rendement cru → cuit conservé', Number(dino.cookedFactor) === 0.75);
check('mode de saisie par unités conservé', dino.unitEntry === true && dino.gramsPerUnit === 250);
check('durée de conservation après préparation conservée', dino.shelfLifeDays === 3, `${dino.shelfLifeDays}`);
check('durée non renseignée reste nulle', back.foods.find((x) => x.id === f('riz basmati')).shelfLifeDays === null);
check('catalogue de collations unique conservé', back.snacks.length === 1 && back.snacks[0].items.length === 1);
check('objectif de référence de la collation conservé', back.snacks[0].targetSlot === 'evening');
check('cases "acheté" conservées', back.shopping.purchased[f('riz basmati')] === true);
check('quantités de batch manuelles conservées', back.batch.overrides[`0:${f('blanc de poulet')}`] === 1500);

console.log('\n— Migration d’une base V1.2 : colonne requires_cooking');
// On simule des lignes antérieures à l'introduction du champ : la colonne existe
// mais n'a jamais été renseignée (NULL), comme après un simple "add column".
sql(`
  alter table foods alter column requires_cooking drop default;
  insert into foods (user_id, id, name, category, reference_state, cooking_method, requires_cooking)
  values
    ('${UID1}', 'legacy_cru_sans_methode', 'Légume cru', 'legume', 'cru', null, null),
    ('${UID1}', 'legacy_cuit_avec_methode', 'Plat cuit', 'proteine', 'cuit', 'Four', null),
    ('${UID1}', 'legacy_cuit_sans_methode', 'Conserve', 'autre', 'cuit', null, null),
    ('${UID1}', 'legacy_choix_utilisateur', 'Cru mangé tel quel', 'legume', 'cru', null, false)
  on conflict (user_id, id) do nothing;
`);
const legacyNulls = Number(sql(`select count(*) from foods where requires_cooking is null and user_id = '${UID1}';`));
check('lignes V1.2 non renseignées avant migration', legacyNulls === 3, `${legacyNulls}`);

applySchema(); // première migration

const rc = (id) => sql(`select requires_cooking from foods where user_id = '${UID1}' and id = '${id}';`);
check('cru sans méthode de cuisson → true', rc('legacy_cru_sans_methode') === 't', rc('legacy_cru_sans_methode'));
check('cuit avec méthode de cuisson → true', rc('legacy_cuit_avec_methode') === 't', rc('legacy_cuit_avec_methode'));
check('cuit sans méthode de cuisson → false', rc('legacy_cuit_sans_methode') === 'f', rc('legacy_cuit_sans_methode'));
check('valeur déjà renseignée par l’utilisateur : intacte', rc('legacy_choix_utilisateur') === 'f');
check('plus aucune ligne non renseignée',
  Number(sql(`select count(*) from foods where requires_cooking is null;`)) === 0);

// l'utilisateur modifie ensuite explicitement la valeur : elle ne doit plus bouger
sql(`update foods set requires_cooking = false where user_id = '${UID1}' and id = 'legacy_cru_sans_methode';`);
applySchema(); // migration rejouée
check('migration rejouable sans effet de bord', rc('legacy_cru_sans_methode') === 'f', rc('legacy_cru_sans_methode'));
check('les autres valeurs restent stables',
  rc('legacy_cuit_avec_methode') === 't' && rc('legacy_cuit_sans_methode') === 'f');

// côté client : une base pas encore migrée (NULL) reprend le même classement
const clientSide = tablesToState({
  foods: [
    { id: 'x1', name: 'Cru', category: 'legume', reference_state: 'cru', cooking_method: null, requires_cooking: null,
      kcal_per_100g: 20, protein_per_100g: 1, carbs_per_100g: 2, fat_per_100g: 0 },
    { id: 'x2', name: 'Cuit méthode', category: 'proteine', reference_state: 'cuit', cooking_method: 'Four', requires_cooking: null,
      kcal_per_100g: 150, protein_per_100g: 20, carbs_per_100g: 0, fat_per_100g: 7 },
    { id: 'x3', name: 'Cuit sans méthode', category: 'autre', reference_state: 'cuit', cooking_method: null, requires_cooking: null,
      kcal_per_100g: 100, protein_per_100g: 5, carbs_per_100g: 10, fat_per_100g: 2 },
    { id: 'x4', name: 'Choix utilisateur', category: 'legume', reference_state: 'cru', cooking_method: null, requires_cooking: false,
      kcal_per_100g: 20, protein_per_100g: 1, carbs_per_100g: 2, fat_per_100g: 0 },
  ],
});
const cs = (id) => clientSide.foods.find((f) => f.id === id).requiresCooking;
check('client : cru sans méthode → true', cs('x1') === true);
check('client : cuit avec méthode → true', cs('x2') === true);
check('client : cuit sans méthode → false', cs('x3') === false);
check('client : false explicite jamais recalculé', cs('x4') === false);
check('client : une valeur true persistée est relue telle quelle',
  tablesToState({ foods: [{ id: 'y', name: 'Y', category: 'autre', reference_state: 'pret', cooking_method: null,
    requires_cooking: true, kcal_per_100g: 1, protein_per_100g: 0, carbs_per_100g: 0, fat_per_100g: 0 }] })
    .foods[0].requiresCooking === true);

// nettoyage : on repart de l'état envoyé par le client pour la suite des tests
replaceAll(payload, UID1);

console.log('\n— Isolation entre comptes (RLS)');
const small = stateToTables({ ...state, foods: state.foods.slice(0, 3), meals: [], breakfasts: [], snacks: [], shopping: { purchased: {} }, batch: { overrides: {} } });
replaceAll(small, UID2);
const seenBy1 = Number(sql(`select count(*) from foods;`, UID1));
const seenBy2 = Number(sql(`select count(*) from foods;`, UID2));
check('le compte A ne voit que ses aliments', seenBy1 === payload.foods.length, `${seenBy1}`);
check('le compte B ne voit que les siens', seenBy2 === 3, `${seenBy2}`);
check('les identifiants d’aliments identiques ne se télescopent pas',
  Number(sql(`select count(*) from foods where id = '${f('blanc de poulet')}';`)) === 2);
const writeBlocked = sql(
  `with u as (update foods set name = 'piraté' where user_id = '${UID1}' returning 1) select count(*) from u;`, UID2);
check('le compte B ne peut pas modifier les données de A', Number(writeBlocked) === 0);
check('les données de A sont intactes',
  sql(`select name from foods where user_id = '${UID1}' and id = '${f('blanc de poulet')}';`) === 'Blanc de poulet');

console.log('\n' + '='.repeat(60));
console.log(`${passed} vérifications réussies, ${failures.length} échec(s).`);
if (failures.length) { console.log(failures.map((x) => `  - ${x}`).join('\n')); process.exitCode = 1; }
