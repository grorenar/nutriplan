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
  stateToTables, isConfigured,
} from '../js/core/sync.js';
import { getState, replaceState, update, defaultState } from '../js/core/store.js';

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
      getUser: async () => ({ data: { user: remote.signedIn === false ? null : { id: 'u1', email: 'foyer@example.org' } } }),
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
