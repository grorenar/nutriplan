/** Coquille applicative : navigation, rendu de la vue active, cycle de synchronisation. */

import { load, subscribe, getState } from './core/store.js';
import * as sync from './core/sync.js';
import { toast } from './core/util.js';
import * as planning from './views/planning.js';
import * as foods from './views/foods.js';
import * as catalogs from './views/catalogs.js';
import * as batch from './views/batch.js';
import * as shopping from './views/shopping.js';
import * as settings from './views/settings.js';
import { renderEditor, isOpen } from './views/editor.js';
import { openPrintDialog } from './views/print.js';

const VIEWS = [
  { id: 'planning', label: 'Planning', icon: '▤', render: planning.render, title: 'Planning du cycle' },
  { id: 'foods', label: 'Aliments', icon: '◎', render: foods.render, title: 'Banque alimentaire' },
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

  // synchronisation initiale et reprise de connexion
  if (sync.isConfigured()) {
    sync.syncIfNeeded().catch(() => {});
    window.addEventListener('online', () => {
      renderStatus();
      sync
        .syncIfNeeded()
        .then((done) => { if (done) toast('Synchronisation effectuée'); renderStatus(); })
        .catch(() => {});
    });
    window.addEventListener('offline', renderStatus);
  }
}

let syncTimer = null;
function scheduleSync() {
  if (!sync.isConfigured()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    sync.syncIfNeeded().then((done) => { if (done) renderStatus(); }).catch(() => {});
  }, 4000);
}

document.addEventListener('DOMContentLoaded', boot);
