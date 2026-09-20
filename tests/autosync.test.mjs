/**
 * Tests de la synchronisation automatique (sans réseau ni base réelle).
 *
 *   node tests/autosync.test.mjs
 *
 * Un client Supabase factice est injecté dans js/core/sync.js : il applique
 * exactement le même contrat que le vrai (rpc « nutriplan_replace_all »,
 * select des tables, select de settings.updated_at, auth.getUser), ce qui
 * permet de vérifier les décisions de synchronisation de bout en bout —
 * démarrage, retour d'onglet, retour en ligne, modification locale en attente.
 */

import {
  __setTestClient, syncNow, pull, push, planSync, shouldCheckRemote, fetchRemoteStamp, sameStamp,
  stateToTables, tablesToState, isConfigured,
} from '../js/core/sync.js';
import {
  getState, replaceState, update, defaultState, subscribe, ensureCycleMeals,
  newRecipe, newRecipeItem, newPreparation, newRecipeMealItem, newPreparationItem,
} from '../js/core/store.js';

// stockage local minimal : node n'en fournit pas, et l'application en dépend
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}

let passed = 0;
const failures = [];
let currentTest = '';
function test(name, fn) {
  currentTest = name;
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`\n✔ ${name}`))
    .catch((e) => {
      console.log(`\n✘ ${name}\n   ${e.stack || e.message}`);
      failures.push(`${name} — ${e.message}`);
    });
}
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`   ok   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failures.push(`${currentTest} / ${label}`); console.log(`   FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const info = (s) => console.log(`        ${s}`);

/* ---------------------------------------------------------------- client factice */

let lastRemote = null;
const remoteCallsSnapshot = () => ({ ...lastRemote.calls });

/** Installe une base distante simulée comme client courant. */
function useRemote(remote) {
  lastRemote = remote;
  __setTestClient(makeClient(remote));
  return remote;
}

/** Base distante simulée : les tables telles qu'elles seraient dans Supabase. */
function remoteFrom(state) {
  return JSON.parse(JSON.stringify(stateToTables(state)));
}

/**
 * PostgREST renvoie les timestamptz au format PostgreSQL
 * (« 2026-09-14T16:08:09.698+00:00 »), pas au format JavaScript (« …Z »).
 * Le client factice reproduit cette différence, qui a déjà causé un bug.
 */
const asPostgresStamp = (iso) => (iso ? String(iso).replace(/Z$/, '+00:00') : iso);

function makeClient(remote) {
  remote.calls = { rpc: 0, select: 0, stamp: 0 };
  return {
    auth: {
      // `remote.authError` simule une réponse de Supabase où `auth.getUser()`
      // NE LÈVE PAS d'exception mais renvoie {data:{user:null}, error} — le
      // cas réel d'une base injoignable (P0.4). `remote.signedIn === false`
      // reste le cas distinct d'un utilisateur vraiment non authentifié.
      getUser: async () => {
        if (remote.authError) return { data: { user: null }, error: remote.authError };
        return { data: { user: remote.signedIn === false ? null : { id: 'u1', email: 'foyer@example.org' } } };
      },
    },
    from(table) {
      return {
        select(columns) {
          const rows = remote.tables[table] || [];
          if (columns === 'updated_at') {
            remote.calls.stamp += 1;
            const result = { data: rows.map((r) => ({ updated_at: asPostgresStamp(r.updated_at) })), error: null };
            const p = Promise.resolve(result);
            p.limit = () => Promise.resolve({ data: result.data.slice(0, 1), error: null });
            return p;
          }
          remote.calls.select += 1;
          // PostgREST normalise aussi les timestamptz dans un select complet
          const normalized =
            table === 'settings' ? rows.map((r) => ({ ...r, updated_at: asPostgresStamp(r.updated_at) })) : rows;
          const p = Promise.resolve({ data: normalized, error: null });
          p.limit = () => Promise.resolve({ data: normalized.slice(0, 1), error: null });
          return p;
        },
      };
    },
    async rpc(name, { payload }) {
      if (name !== 'nutriplan_replace_all') return { data: null, error: { message: `fonction inconnue : ${name}` } };
      remote.calls.rpc += 1;
      remote.tables = JSON.parse(JSON.stringify(payload));
      return {
        data: Object.fromEntries(Object.keys(payload).map((t) => [t, payload[t].length])),
        error: null,
      };
    },
  };
}

/** État local propre, déjà synchronisé avec l'horodatage distant donné. */
function setLocal(state, { dirty = false, remoteStamp = null } = {}) {
  replaceState(state, { dirty });
  update((s) => {
    s.meta.dirty = dirty;
    s.meta.remoteStamp = remoteStamp;
    s.meta.syncError = null;
  }, { sync: false });
}

const foodNamed = (state, name) => state.foods.find((f) => f.name === name);
const stampOf = (remote) => asPostgresStamp(remote.tables.settings[0].updated_at);

/* ---------------------------------------------------------------- scénarios */

await test('Décisions de synchronisation (fonction pure)', () => {
  const base = { configured: true, online: true, authenticated: true };
  check('modification locale en attente → envoi prioritaire',
    planSync({ ...base, dirty: true, knownStamp: 'A', remoteStamp: 'B' }).action === 'push');
  check('rien en local + base distante modifiée → récupération',
    planSync({ ...base, dirty: false, knownStamp: 'A', remoteStamp: 'B' }).action === 'pull');
  check('appareil qui n’a encore jamais vu la base → récupération',
    planSync({ ...base, dirty: false, knownStamp: null, remoteStamp: 'B' }).action === 'pull');
  check('même horodatage → rien à faire',
    planSync({ ...base, dirty: false, knownStamp: 'B', remoteStamp: 'B' }).action === 'up-to-date');
  check('base distante vide → rien à faire',
    planSync({ ...base, dirty: false, knownStamp: null, remoteStamp: null }).action === 'up-to-date');
  check('hors ligne → aucune action', planSync({ ...base, online: false }).action === 'skip');
  check('non connecté → aucune action', planSync({ ...base, authenticated: false }).action === 'skip');
  check('non configuré → aucune action', planSync({ configured: false }).action === 'skip');

  check('vérification distante autorisée au premier appel', shouldCheckRemote(null) === true);
  check('vérification distante répétée trop tôt → ignorée', shouldCheckRemote(Date.now()) === false);
  check('vérification distante à nouveau autorisée après le délai',
    shouldCheckRemote(Date.now() - 20000) === true);
});

await test('Démarrage : une session déjà connectée récupère la base distante', async () => {
  // l'appareil B n'a rien modifié ; l'appareil A a créé un aliment entre-temps
  const distant = defaultState();
  distant.foods.push({ ...distant.foods[0], id: 'f_ajout_pc', name: 'Aliment créé sur l’ordinateur' });
  const remote = useRemote({ tables: remoteFrom(distant) });
  check('client de test pris en compte', isConfigured() === true);

  setLocal(defaultState(), { dirty: false, remoteStamp: null });
  check('avant : l’aliment distant est absent en local', !foodNamed(getState(), 'Aliment créé sur l’ordinateur'));

  const result = await syncNow();
  info(`action : ${result.action} — ${result.reason}`);
  check('récupération automatique sans modification locale', result.action === 'pull');
  check('la nouvelle donnée est arrivée', !!foodNamed(getState(), 'Aliment créé sur l’ordinateur'));
  check('aucun clic sur « Récupérer du cloud » nécessaire', remote.calls.rpc === 0);
  check('horodatage distant mémorisé', getState().meta.remoteStamp === stampOf(remote));
  check('état marqué synchronisé', getState().meta.dirty === false && !getState().meta.syncError);
});

await test('Retour sur l’application : rien ne se télécharge si rien n’a changé', async () => {
  const before = { ...remoteCallsSnapshot() };
  const result = await syncNow();
  info(`action : ${result.action} — ${result.reason}`);
  check('aucune récupération inutile', result.action === 'up-to-date');
  check('une seule requête légère (settings.updated_at)',
    lastRemote.calls.stamp === before.stamp + 1 && lastRemote.calls.select === before.select,
    `stamp ${lastRemote.calls.stamp}, select ${lastRemote.calls.select}`);
  check('données locales intactes', !!foodNamed(getState(), 'Aliment créé sur l’ordinateur'));

  // puis l'ordinateur modifie à nouveau la base : le retour sur l'onglet la récupère
  const distant = getState();
  const modifie = JSON.parse(JSON.stringify(distant));
  modifie.foods.push({ ...modifie.foods[0], id: 'f_second_ajout', name: 'Deuxième ajout' });
  modifie.meta = { ...modifie.meta, updatedAt: new Date(Date.now() + 1000).toISOString() };
  lastRemote.tables = remoteFrom(modifie);
  const second = await syncNow();
  check('changement distant détecté au retour sur l’application', second.action === 'pull');
  check('deuxième aliment récupéré', !!foodNamed(getState(), 'Deuxième ajout'));
});

await test('Une modification locale en attente n’est jamais écrasée', async () => {
  const distant = defaultState();
  distant.foods.push({ ...distant.foods[0], id: 'f_distant', name: 'Version distante' });
  const remote = useRemote({ tables: remoteFrom(distant) });

  // local : une modification faite hors ligne, pas encore envoyée
  const local = defaultState();
  local.foods.push({ ...local.foods[0], id: 'f_local', name: 'Modification locale non envoyée' });
  setLocal(local, { dirty: true, remoteStamp: 'ancien-horodatage' });

  const result = await syncNow();
  info(`action : ${result.action} — ${result.reason}`);
  check('l’envoi est prioritaire sur la récupération', result.action === 'push');
  check('la modification locale est toujours là', !!foodNamed(getState(), 'Modification locale non envoyée'));
  check('elle n’a pas été remplacée par la version distante',
    !foodNamed(getState(), 'Version distante'));
  check('elle a bien été envoyée au cloud',
    remote.tables.foods.some((f) => f.name === 'Modification locale non envoyée'));
  check('état marqué synchronisé après envoi', getState().meta.dirty === false);
  check('horodatage distant mis à jour', getState().meta.remoteStamp === stampOf(remote));

  // l'appel suivant ne doit plus rien récupérer : local et distant sont alignés
  const after = await syncNow();
  check('plus rien à faire ensuite', after.action === 'up-to-date');
  check('modification locale toujours présente', !!foodNamed(getState(), 'Modification locale non envoyée'));
});

await test('Retour en ligne : envoi puis alignement', async () => {
  const remote = useRemote({ tables: remoteFrom(defaultState()) });

  const local = defaultState();
  local.foods.push({ ...local.foods[0], id: 'f_hors_ligne', name: 'Créé hors ligne' });
  setLocal(local, { dirty: true, remoteStamp: null });

  // hors ligne : aucune tentative réseau
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
  const offline = await syncNow();
  check('hors ligne : aucune synchronisation', offline.action === 'skip', offline.reason);
  check('hors ligne : aucune requête envoyée', remote.calls.rpc === 0 && remote.calls.stamp === 0);
  check('modification locale conservée', getState().meta.dirty === true);

  // retour de connexion
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  const back = await syncNow();
  check('retour en ligne : la modification part', back.action === 'push');
  check('le cloud contient la modification',
    remote.tables.foods.some((f) => f.name === 'Créé hors ligne'));
  check('plus aucune modification en attente', getState().meta.dirty === false);
});

await test('Session non connectée : aucune synchronisation, aucune perte', async () => {
  const remote = useRemote({ tables: remoteFrom(defaultState()), signedIn: false });
  const local = defaultState();
  local.foods.push({ ...local.foods[0], id: 'f_attente', name: 'En attente de connexion' });
  setLocal(local, { dirty: true, remoteStamp: null });

  const result = await syncNow();
  check('aucune action sans session', result.action === 'skip', result.reason);
  check('rien n’a été envoyé', remote.calls.rpc === 0);
  check('les données locales restent intactes', !!foodNamed(getState(), 'En attente de connexion'));
  check('elles restent marquées à synchroniser', getState().meta.dirty === true);
});

await test('« Récupérer du cloud » reste un forçage manuel opérationnel', async () => {
  const distant = defaultState();
  distant.foods.push({ ...distant.foods[0], id: 'f_force', name: 'Récupéré manuellement' });
  const remote = useRemote({ tables: remoteFrom(distant) });

  // local déjà « à jour » du point de vue de l'horodatage : la synchro auto ne ferait rien
  setLocal(defaultState(), { dirty: false, remoteStamp: stampOf(remote) });
  check('la synchronisation automatique ne ferait rien', (await syncNow()).action === 'up-to-date');
  check('l’aliment distant n’est pas encore là', !foodNamed(getState(), 'Récupéré manuellement'));

  const res = await pull();
  check('le bouton manuel récupère bien la base', res.seeded === false);
  check('donnée distante récupérée', !!foodNamed(getState(), 'Récupéré manuellement'));

  // et l'envoi manuel fonctionne toujours
  update((s) => { s.foods.push({ ...s.foods[0], id: 'f_manuel', name: 'Envoyé manuellement' }); });
  const counts = await push();
  check('l’envoi manuel fonctionne toujours', counts.foods === getState().foods.length);
  check('le cloud a reçu la donnée', remote.tables.foods.some((f) => f.name === 'Envoyé manuellement'));
  check('aucune erreur de synchronisation', !getState().meta.syncError);
});

await test('Saisie en cours : aucune récupération ne détruit le formulaire', async () => {
  const base = { configured: true, online: true, authenticated: true };
  check('saisie en cours + base distante modifiée → récupération reportée',
    planSync({ ...base, dirty: false, editing: true, knownStamp: 'A', remoteStamp: 'B' }).action === 'deferred');
  check('saisie en cours + modification locale → envoi quand même',
    planSync({ ...base, dirty: true, editing: true, knownStamp: 'A', remoteStamp: 'B' }).action === 'push');
  check('hors saisie → récupération normale',
    planSync({ ...base, dirty: false, editing: false, knownStamp: 'A', remoteStamp: 'B' }).action === 'pull');

  // la base distante a changé, mais l'utilisateur remplit un formulaire
  const distant = defaultState();
  distant.foods.push({ ...distant.foods[0], id: 'f_pendant_saisie', name: 'Arrivé pendant la saisie' });
  const remote = useRemote({ tables: remoteFrom(distant) });
  setLocal(defaultState(), { dirty: false, remoteStamp: null });

  let renders = 0;
  const stop = subscribe(() => { renders += 1; });

  const deferred = await syncNow({ editing: true });
  info(`action : ${deferred.action} — ${deferred.reason}`);
  check('récupération reportée', deferred.action === 'deferred');
  check('aucune requête distante pendant la saisie',
    remote.calls.stamp === 0 && remote.calls.select === 0 && remote.calls.rpc === 0,
    `stamp ${remote.calls.stamp}, select ${remote.calls.select}, rpc ${remote.calls.rpc}`);
  check('état local inchangé : la saisie n’est pas remplacée',
    !foodNamed(getState(), 'Arrivé pendant la saisie'));
  check('aucun rendu global déclenché pendant la saisie', renders === 0, `${renders} rendu(s)`);

  // fin de la saisie : la récupération a bien lieu
  const done = await syncNow({ editing: false });
  check('récupération exécutée après la saisie', done.action === 'pull');
  check('donnée distante enfin reçue', !!foodNamed(getState(), 'Arrivé pendant la saisie'));
  check('un rendu a lieu à ce moment-là, pas avant', renders >= 1, `${renders} rendu(s)`);
  stop();
});

await test('Les écritures d’état de synchronisation ne redessinent pas l’interface', async () => {
  const remote = useRemote({ tables: remoteFrom(defaultState()) });
  setLocal(defaultState(), { dirty: false, remoteStamp: null });
  await syncNow();                     // premier appel : aligne l'horodatage
  let renders = 0;
  const stop = subscribe(() => { renders += 1; });

  const result = await syncNow();
  check('vérification sans changement', result.action === 'up-to-date', result.reason);
  check('aucun rendu déclenché par la vérification', renders === 0, `${renders} rendu(s)`);
  check('horodatage de vérification tout de même mémorisé', Number.isFinite(getState().meta.lastRemoteCheck));

  // un envoi non plus ne doit pas redessiner l'interface
  update((s) => { s.foods.push({ ...s.foods[0], id: 'f_silence', name: 'Envoi silencieux' }); });
  const rendersAfterEdit = renders; // la modification elle-même notifie, c'est normal
  const pushed = await syncNow({ editing: true });
  check('envoi possible même pendant une saisie', pushed.action === 'push');
  check('aucun rendu supplémentaire provoqué par l’envoi', renders === rendersAfterEdit,
    `${renders} vs ${rendersAfterEdit}`);
  check('modification bien envoyée', remote.tables.foods.some((f) => f.name === 'Envoi silencieux'));
  stop();
});

await test('Horodatage : formats PostgreSQL et JavaScript comparés par instant', async () => {
  const iso = '2026-09-14T16:08:09.698Z';
  const pg = '2026-09-14T16:08:09.698+00:00';
  check('même instant, formats différents → identiques', sameStamp(iso, pg) === true);
  check('même chaîne → identiques', sameStamp(pg, pg) === true);
  check('décalage horaire équivalent → identiques',
    sameStamp('2026-09-14T18:08:09.698+02:00', iso) === true);
  check('instants différents → distincts', sameStamp(iso, '2026-09-14T16:08:10.698Z') === false);
  check('horodatage absent → distinct', sameStamp(null, pg) === false && sameStamp(iso, null) === false);
  check('deux absences → identiques', sameStamp(null, null) === true);
  check('valeur illisible → comparaison textuelle', sameStamp('abc', 'abc') === true && sameStamp('abc', 'abd') === false);

  // bout en bout : après un envoi, la base renvoie le format PostgreSQL.
  // Sans normalisation, l'appareil récupérait la base entière juste après avoir
  // envoyé la sienne.
  const remote = useRemote({ tables: remoteFrom(defaultState()) });
  const local = defaultState();
  local.foods.push({ ...local.foods[0], id: 'f_format', name: 'Test de format' });
  setLocal(local, { dirty: true, remoteStamp: null });

  const pushed = await syncNow();
  check('envoi effectué', pushed.action === 'push');
  check('horodatage mémorisé au format renvoyé par la base',
    getState().meta.remoteStamp === stampOf(remote), String(getState().meta.remoteStamp));
  check('horodatage relu identique à celui mémorisé',
    sameStamp(await fetchRemoteStamp(), getState().meta.remoteStamp) === true);

  const selectsBefore = remote.calls.select;
  const after = await syncNow();
  check('aucune récupération inutile après un envoi', after.action === 'up-to-date', after.reason);
  check('aucune table retéléchargée', remote.calls.select === selectsBefore);
});

await test('Recettes/préparations : envoyées et récupérées correctement (bug réel corrigé — TABLES ne les listait pas)', async () => {
  const local = defaultState();
  ensureCycleMeals(local);
  const wasa = local.foods.find((f) => /Pain croustillant/i.test(f.name));
  const stmoret = local.foods.find((f) => /Fromage frais tartinable/i.test(f.name));
  const riz = local.foods.find((f) => /Riz basmati/i.test(f.name)) || local.foods[0];

  const weightRecipe = newRecipe('Riz simple', 'weight');
  weightRecipe.items = [newRecipeItem(riz.id, 300, 'cru')];
  weightRecipe.baseGrams = 300;

  const portionRecipe = newRecipe('Wasa fromage frais', 'portion');
  portionRecipe.items = [newRecipeItem(wasa.id, 33, 'pret'), newRecipeItem(stmoret.id, 20, 'pret')];

  local.recipes.push(weightRecipe, portionRecipe);
  const prep = newPreparation(weightRecipe, 900, 'Riz simple #1');
  local.preparations.push(prep);

  // un item de repas référence directement la recette (mode "molle", pas
  // encore préparée) : vérifie que recipeId/section/zeroWaste survivent eux
  // aussi (itemRows()/itemsFromRows() les ignoraient totalement avant ce correctif).
  const meal = local.meals[0];
  const recipeItem = newRecipeMealItem(portionRecipe.id, 53);
  recipeItem.section = 'dessert';
  meal.items.push(recipeItem);
  const prepItem = newPreparationItem(prep.id, 200);
  prepItem.zeroWaste = true;
  meal.items.push(prepItem);

  setLocal(local, { dirty: true, remoteStamp: null });
  const remote = useRemote({ tables: { settings: [] } }); // base distante vide au départ

  const pushed = await syncNow();
  check('envoi effectué', pushed.action === 'push', pushed.reason);

  check('le payload envoyé contient la recette au poids', remote.tables.recipes.some((r) => r.name === 'Riz simple'));
  check('le payload envoyé contient la recette portion', remote.tables.recipes.some((r) => r.name === 'Wasa fromage frais'));
  check('recipe_items envoyés pour les deux recettes (1 + 2 = 3 lignes)',
    remote.tables.recipe_items.length === 3, remote.tables.recipe_items.length);
  check('preparations envoyée avec son recipe_snapshot figé',
    remote.tables.preparations.length === 1 && remote.tables.preparations[0].recipe_snapshot?.kind === 'weight');
  check('recipe_id de l’item de repas envoyé (pas perdu)',
    remote.tables.meal_items.some((r) => r.recipe_id === portionRecipe.id));
  check('section de l’item de repas envoyée (pas perdue)',
    remote.tables.meal_items.some((r) => r.recipe_id === portionRecipe.id && r.section === 'dessert'));
  check('preparation_id + zero_waste de l’item de repas envoyés (pas perdus)',
    remote.tables.meal_items.some((r) => r.preparation_id === prep.id && r.zero_waste === true));

  // un AUTRE appareil, vierge, récupère cette même base : round-trip complet
  setLocal(defaultState(), { dirty: false, remoteStamp: null });
  const pulled = await syncNow();
  check('récupération effectuée sur le second appareil', pulled.action === 'pull', pulled.reason);

  const gotWeight = getState().recipes.find((r) => r.name === 'Riz simple');
  const gotPortion = getState().recipes.find((r) => r.name === 'Wasa fromage frais');
  check('recette au poids récupérée avec sa composition et son baseGrams',
    !!gotWeight && gotWeight.kind === 'weight' && gotWeight.baseGrams === 300 && gotWeight.items.length === 1);
  check('recette portion récupérée avec ses 2 ingrédients',
    !!gotPortion && gotPortion.kind === 'portion' && gotPortion.items.length === 2);
  const gotPrep = getState().preparations.find((p) => p.label === 'Riz simple #1');
  check('préparation récupérée avec sa quantité et son snapshot figé',
    !!gotPrep && gotPrep.preparedQuantity === 900 && gotPrep.recipeSnapshot?.items?.length === 1);

  const gotMeal = getState().meals.find((m) => m.dayIndex === meal.dayIndex && m.mealType === meal.mealType);
  const gotRecipeItem = gotMeal?.items.find((it) => it.recipeId === gotPortion.id);
  check('item de repas référençant la recette récupéré (recipeId préservé)', !!gotRecipeItem);
  check('sa section est préservée ("dessert", pas retombée sur "plat")', gotRecipeItem?.section === 'dessert');
  const gotPrepItem = gotMeal?.items.find((it) => it.preparationId === gotPrep.id);
  check('item de repas référençant la préparation récupéré (preparationId préservé)', !!gotPrepItem);
  check('son mode zéro reste est préservé', gotPrepItem?.zeroWaste === true);
});

await test('pull() en cours : une recette créée PENDANT la récupération n’est plus jamais écrasée (bug réel corrigé)', async () => {
  // pull() enchaîne une requête par table (14 tables) : un aller-retour réseau
  // RÉEL n'est jamais instantané. Le client factice habituel résout tout de
  // suite ; celui-ci introduit un délai réaliste pour pouvoir agir PENDANT
  // que pull() est en cours — exactement la fenêtre où le bug se produisait.
  function makeSlowClient(remote) {
    remote.calls = { rpc: 0, select: 0, stamp: 0 };
    return {
      auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'foyer@example.org' } } }) },
      from(table) {
        return {
          async select() {
            remote.calls.select += 1;
            await new Promise((r) => setTimeout(r, 5));
            return { data: remote.tables[table] || [], error: null };
          },
        };
      },
      async rpc(name, { payload }) {
        if (name !== 'nutriplan_replace_all') return { data: null, error: { message: `fonction inconnue : ${name}` } };
        remote.calls.rpc += 1;
        remote.tables = JSON.parse(JSON.stringify(payload));
        return { data: Object.fromEntries(Object.keys(payload).map((t) => [t, payload[t].length])), error: null };
      },
    };
  }

  const remoteState = defaultState();
  ensureCycleMeals(remoteState);
  const remote = { tables: remoteFrom(remoteState) };
  __setTestClient(makeSlowClient(remote));

  const local = defaultState();
  ensureCycleMeals(local);
  setLocal(local, { dirty: false, remoteStamp: null }); // état propre, pull() va démarrer

  const pullPromise = pull(); // ne pas attendre : simule un pull déjà en cours

  // PENDANT que pull() récupère ses 14 tables, l'utilisateur crée une
  // recette — exactement le geste de js/views/recipes.js.
  await new Promise((r) => setTimeout(r, 2));
  const riz = getState().foods.find((f) => /Riz basmati/i.test(f.name)) || getState().foods[0];
  const recipe = newRecipe('Recette créée pendant un pull en cours', 'weight');
  recipe.items = [newRecipeItem(riz.id, 300, 'cru')];
  recipe.baseGrams = 300;
  update((s) => { s.recipes.push(recipe); });
  check('la recette existe bien en local juste après création', getState().recipes.length === 1);

  await pullPromise;

  check('la recette créée pendant le pull n’a PAS été écrasée (survit à la fin du pull)',
    getState().recipes.some((r) => r.name === 'Recette créée pendant un pull en cours'),
    `${getState().recipes.length} recette(s) en local`);
  check('elle a bien été envoyée au serveur (push déclenché au lieu d’un remplacement)',
    remote.tables.recipes?.some((r) => r.name === 'Recette créée pendant un pull en cours') === true);
  check('l’état est marqué synchronisé APRÈS un envoi réel, pas après une perte silencieuse',
    getState().meta.dirty === false && remote.calls.rpc === 1);
});

await test('P0.3 — clé de sous-préparation batch avec ":" imbriqués : round-trip Supabase sans perte (bug réel corrigé)', async () => {
  // avant correction : `key.split(':')` détruisait tout ce qui suit le 2e ':'.
  const s = defaultState();
  s.batch.overrides = {
    '0:f_riz': 200, // ancien format (session:foodId), doit continuer de fonctionner
    '0:0-1:f_boeuf': 400, // sous-préparation aliment (session:jourDébut-jourFin:foodId)
    '1:recipe:recipe_abc123': 600, // recette (session:recipe:recipeId)
    '2:2-3:recipe:recipe_xyz789': 350, // sous-préparation recette (session:jourDébut-jourFin:recipe:recipeId)
  };
  const tables = stateToTables(s);
  check('4 lignes batch_items produites (aucune fusion/collision de clé)', tables.batch_items.length === 4);
  const restored = tablesToState(tables);
  check('les 4 clés sont restaurées EXACTEMENT à l’identique après un aller-retour',
    JSON.stringify(Object.entries(restored.batch.overrides).sort()) === JSON.stringify(Object.entries(s.batch.overrides).sort()),
    JSON.stringify(restored.batch.overrides));
});

/* ================================================================ P0.4 — STATUT RÉEL DE SYNCHRONISATION */
/*
 * Cause exacte du bug : `currentUser()` lisait `{ data }` sans jamais
 * regarder `error` — or `auth.getUser()` de Supabase NE LÈVE PAS d'exception
 * quand la base est injoignable, elle renvoie `{data:{user:null}, error}`.
 * `syncNow()` traitait donc une coupure réseau exactement comme "non
 * authentifié" (`if (!ctx.authenticated) return planSync(ctx)`), une branche
 * qui ne touchait JAMAIS `meta.syncError` — l'interface retombait alors sur
 * "Synchronisé" par défaut, alors que la base n'avait jamais été jointe.
 * Corrigé : `currentUser()` propage l'erreur ; `syncNow()` la classe
 * (`classifySyncError`) en 'network' (déconnecté) ou 'server' (vraie erreur
 * de synchronisation) et pose `meta.syncing` pendant l'exécution.
 */

await test('P0.4.1 — connecté et synchronisé : syncing/syncError/syncErrorKind retombent tous à un état propre', async () => {
  const remote = useRemote({ tables: remoteFrom(defaultState()) });
  setLocal(defaultState(), { dirty: false, remoteStamp: stampOf(remote) });
  const result = await syncNow();
  check('action up-to-date', result.action === 'up-to-date');
  check('syncing = false après la synchronisation', getState().meta.syncing === false);
  check('aucune erreur', getState().meta.syncError === null && getState().meta.syncErrorKind === null);
});

await test('P0.4.2 — synchronisation en cours : meta.syncing passe à true PENDANT l’appel réseau', async () => {
  function makeDelayedClient(remote) {
    remote.calls = { rpc: 0, select: 0, stamp: 0 };
    return {
      auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'foyer@example.org' } } }) },
      from(table) {
        return {
          select(columns) {
            const rows = remote.tables[table] || [];
            const data = columns === 'updated_at' ? rows.map((r) => ({ updated_at: asPostgresStamp(r.updated_at) })) : rows;
            const p = (async () => { await new Promise((r) => setTimeout(r, 15)); remote.calls.stamp += 1; return { data, error: null }; })();
            p.limit = async () => { await new Promise((r) => setTimeout(r, 15)); return { data: data.slice(0, 1), error: null }; };
            return p;
          },
        };
      },
      async rpc() { return { data: {}, error: null }; },
    };
  }
  const remote = { tables: remoteFrom(defaultState()) };
  __setTestClient(makeDelayedClient(remote));
  setLocal(defaultState(), { dirty: false, remoteStamp: stampOf({ tables: remote.tables }) });

  check('syncing = false avant l’appel', getState().meta.syncing === false);
  const p = syncNow();
  await new Promise((r) => setTimeout(r, 5)); // laisse syncNow() atteindre son appel réseau différé
  check('syncing = true PENDANT la synchronisation', getState().meta.syncing === true);
  await p;
  check('syncing = false une fois terminée', getState().meta.syncing === false);
});

await test('P0.4.3 — déconnecté de la BDD : une base injoignable (erreur SANS code serveur) est classée "network", jamais confondue avec "Synchronisé"', async () => {
  const remote = useRemote({ tables: remoteFrom(defaultState()) });
  remote.authError = new TypeError('Failed to fetch'); // signature réelle d’un échec réseau navigateur
  setLocal(defaultState(), { dirty: false, remoteStamp: null });

  const result = await syncNow();
  check('action = error (jamais confondue avec "à jour")', result.action === 'error');
  check('meta.syncError renseignée (avant le correctif : restait null)', typeof getState().meta.syncError === 'string' && getState().meta.syncError.length > 0);
  check('classée "network", pas "server"', getState().meta.syncErrorKind === 'network');
  check('syncing retombe à false même en cas d’échec', getState().meta.syncing === false);

  delete remote.authError;
});

await test('P0.4.4 — erreur de synchronisation réelle (base jointe, erreur SERVEUR) : classée distinctement de "déconnecté"', async () => {
  const remote = useRemote({ tables: remoteFrom(defaultState()) });
  remote.authError = { message: 'invalid JWT', code: '401', status: 401 }; // réponse RÉELLE du serveur, pas une coupure réseau
  setLocal(defaultState(), { dirty: false, remoteStamp: null });

  const result = await syncNow();
  check('action = error', result.action === 'error');
  check('classée "server", pas "network"', getState().meta.syncErrorKind === 'server');

  delete remote.authError;
});

await test('P0.4.5 — dernière synchronisation réussie mais connexion actuellement indisponible : syncedAt reste renseigné pendant que syncErrorKind passe à "network"', async () => {
  const remote = useRemote({ tables: remoteFrom(defaultState()) });
  const local = defaultState();
  local.foods.push({ ...local.foods[0], id: 'f_avant_coupure', name: 'Envoyé avant la coupure' });
  setLocal(local, { dirty: true, remoteStamp: stampOf(remote) });
  await syncNow(); // envoi réussi : syncedAt posé
  const syncedAtBefore = getState().meta.syncedAt;
  check('syncedAt bien posé après un succès', !!syncedAtBefore);

  // puis la base devient injoignable (ex. coupure réseau après un succès)
  remote.authError = new TypeError('Failed to fetch');
  await syncNow();
  check('syncErrorKind = network après la coupure', getState().meta.syncErrorKind === 'network');
  check('syncedAt (dernière réussite) n’est PAS effacé par un échec ultérieur — permet à l’interface de dire "dernière synchronisation réussie"',
    getState().meta.syncedAt === syncedAtBefore);

  delete remote.authError;
});

await test('P0.4.6 — modification locale en attente : dirty reste vrai tant que rien n’a été envoyé', async () => {
  const remote = useRemote({ tables: remoteFrom(defaultState()) });
  const local = defaultState();
  local.foods.push({ ...local.foods[0], id: 'f_attente', name: 'Modification en attente' });
  setLocal(local, { dirty: true, remoteStamp: stampOf(remote) });
  check('dirty = true avant toute tentative de synchronisation', getState().meta.dirty === true);
  const result = await syncNow();
  check('l’envoi part en priorité (jamais une récupération qui l’écraserait)', result.action === 'push');
  check('dirty retombe à false une fois envoyé avec succès', getState().meta.dirty === false);
});

await test('Horodatage distant : requête minimale', async () => {
  const remote = useRemote({ tables: remoteFrom(defaultState()) });
  const stamp = await fetchRemoteStamp();
  check('horodatage lu depuis settings.updated_at', stamp === stampOf(remote), String(stamp));
  check('aucune table complète téléchargée pour cette vérification', remote.calls.select === 0);
});

__setTestClient(null);

console.log('\n' + '='.repeat(60));
console.log(`${passed} vérifications réussies, ${failures.length} échec(s).`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exitCode = 1;
}
