/** Coquille applicative : navigation, rendu de la vue active, cycle de synchronisation. */

import { load, subscribe, getState } from './core/store.js';
import * as sync from './core/sync.js';
import { toast } from './core/util.js';
import * as planning from './views/planning.js';
import * as foods from './views/foods.js';
import * as recipes from './views/recipes.js';
import * as catalogs from './views/catalogs.js';
import * as batch from './views/batch.js';
import * as shopping from './views/shopping.js';
import * as settings from './views/settings.js';
import { renderEditor, isOpen } from './views/editor.js';
import { openPrintDialog } from './views/print.js';

const VIEWS = [
  { id: 'planning', label: 'Planning', icon: '▤', render: planning.render, title: 'Planning du cycle' },
  { id: 'foods', label: 'Aliments', icon: '◎', render: foods.render, title: 'Banque alimentaire' },
  { id: 'recipes', label: 'Recettes', icon: '📖', render: recipes.render, title: 'Recettes' },
  { id: 'breakfasts', label: 'Petits-déj.', icon: '☕', render: catalogs.renderBreakfasts, title: 'Petits-déjeuners' },
  { id: 'snacks', label: 'Collations', icon: '◍', render: catalogs.renderSnacks, title: 'Collations' },
  { id: 'batch', label: 'Batch', icon: '⊞', render: batch.render, title: 'Batch cooking' },
  { id: 'shopping', label: 'Courses', icon: '✓', render: shopping.render, title: 'Liste de courses' },
  { id: 'settings', label: 'Paramètres', icon: '⚙', render: settings.render, title: 'Paramètres' },
];

let current = 'planning';

function viewDef(id) {
  return VIEWS.find((v) => v.id === id) || VIEWS[0];
}

function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = VIEWS.map(
    (v) => `<button data-view="${v.id}" aria-current="${v.id === current}">
      <span aria-hidden="true">${v.icon}</span> ${v.label}</button>`
  ).join('');
  nav.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', (e) => navigate(e.currentTarget.dataset.view))
  );
}

export function navigate(id) {
  current = id;
  location.hash = id;
  renderNav();
  renderView();
}

function renderView() {
  const def = viewDef(current);
  document.getElementById('title').textContent = def.title;
  const root = document.getElementById('view');
  root.innerHTML = '';
  def.render(root);
}

function renderStatus() {
  const s = getState();
  const box = document.getElementById('status');
  if (!box) return;
  const configured = sync.isConfigured();
  let cls = '';
  let label = 'Mode local';
  if (configured) {
    if (!navigator.onLine) { cls = 'is-dirty'; label = 'Hors ligne — modifications conservées'; }
    else if (s.meta.syncError) { cls = 'is-error'; label = 'Échec de synchronisation — données locales intactes'; }
    else if (s.meta.dirty) { cls = 'is-dirty'; label = 'Modifications à synchroniser'; }
    else { cls = 'is-sync'; label = 'Synchronisé'; }
  }
  box.innerHTML = `<span class="dot ${cls}"></span>${label}`;
  box.title = s.meta.syncError || label;
}

/* ------------------------------------------------------------------ */

function boot() {
  load();

  subscribe(() => {
    renderStatus();
    // la vue Paramètres se rafraîchit elle-même (formulaires + appels réseau)
    if (current !== 'settings') renderView();
    if (isOpen()) renderEditor();
    scheduleSync();
  });

  document.getElementById('print-btn').addEventListener('click', openPrintDialog);

  // depuis l'écran Courses : ouvrir la fiche d'un aliment sans prix
  document.addEventListener('nutriplan:open-food', (e) => {
    foods.openFoodForm(e.detail.id);
    navigate('foods');
  });

  const hash = location.hash.replace('#', '');
  if (VIEWS.some((v) => v.id === hash)) current = hash;
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#', '');
    if (h && h !== current && VIEWS.some((v) => v.id === h)) navigate(h);
  });

  renderNav();
  renderView();
  renderStatus();

  // --- synchronisation automatique dans les deux sens
  if (sync.isConfigured()) {
    // au lancement : même sans modification locale, on vérifie si la base
    // distante a changé depuis la dernière fois que cet appareil l'a vue
    runSync('démarrage');

    // retour de connexion : les modifications locales partent avant tout pull
    window.addEventListener('online', () => {
      renderStatus();
      runSync('retour en ligne');
    });
    window.addEventListener('offline', renderStatus);

    // retour sur l'onglet / l'application
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') runSync('retour sur l’application', { throttled: true });
    });
    window.addEventListener('focus', () => runSync('retour sur l’application', { throttled: true }));
  }
}

let syncTimer = null;
let retryTimer = null;
let lastRemoteCheck = 0;

/**
 * L'utilisateur est-il en train de remplir un formulaire ?
 * Une récupération distante remplace l'état et reconstruit la vue : elle
 * détruirait la modale ouverte, ferait perdre le focus au champ actif (et donc
 * disparaître le clavier virtuel) et effacerait la saisie en cours.
 */
export function isEditing() {
  const el = document.activeElement;
  const typing =
    Boolean(el) &&
    (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable === true);
  const formOpen = Boolean(document.querySelector('#drawer .drawer__panel, #modal .modal, #modal .drawer__panel, #view .drawer__panel'));
  return typing || formOpen;
}

/**
 * Lance une synchronisation automatique (envoi des modifications locales en
 * attente, sinon récupération si la base distante a changé).
 * `throttled` évite de réinterroger la base à chaque bascule d'onglet.
 */
function runSync(reason, { throttled = false } = {}) {
  if (!sync.isConfigured()) return;
  const pending = getState().meta.dirty;
  if (throttled && !pending && !sync.shouldCheckRemote(lastRemoteCheck)) return;
  lastRemoteCheck = Date.now();
  sync
    .syncNow({ editing: isEditing() })
    .then((result) => {
      if (result.action === 'pull') toast('Données mises à jour depuis le cloud');
      // récupération reportée : on réessaiera dès que la saisie sera terminée
      if (result.action === 'deferred') retryAfterEditing(reason);
      renderStatus();
    })
    .catch(() => renderStatus());
}

/** Réessaie la synchronisation dès que le formulaire est refermé / le champ quitté. */
function retryAfterEditing(reason) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (isEditing()) { retryAfterEditing(reason); return; } // toujours en saisie : on repatiente
    runSync(reason);
  }, 2000);
}

function scheduleSync() {
  if (!sync.isConfigured()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync('modification locale'), 4000);
}

document.addEventListener('DOMContentLoaded', boot);
