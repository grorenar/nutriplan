/** Coquille applicative : navigation, rendu de la vue active, cycle de synchronisation. */

import { load, subscribe, getState } from './core/store.js';
import * as sync from './core/sync.js';
import { toast, relativeTime } from './core/util.js';
import * as planning from './views/planning.js';
import * as foods from './views/foods.js';
import * as recipes from './views/recipes.js';
import * as catalogs from './views/catalogs.js';
import * as preparations from './views/preparations.js';
import * as batch from './views/batch.js';
import * as shopping from './views/shopping.js';
import * as settings from './views/settings.js';
import { renderEditor, isOpen, closeEditor } from './views/editor.js';
import { openPrintDialog } from './views/print.js';
import { stopActiveScanner } from './views/barcode-panel.js';

const VIEWS = [
  { id: 'planning', label: 'Planning', icon: '📅', render: planning.render, title: 'Planning du cycle' },
  { id: 'foods', label: 'Aliments', icon: '🥑', render: foods.render, title: 'Banque alimentaire' },
  { id: 'recipes', label: 'Recettes', icon: '📖', render: recipes.render, title: 'Recettes' },
  { id: 'breakfasts', label: 'Petits-déj.', icon: '🥞', render: catalogs.renderBreakfasts, title: 'Petits-déjeuners' },
  { id: 'snacks', label: 'Collations', icon: '🍎', render: catalogs.renderSnacks, title: 'Collations' },
  { id: 'preparations', label: 'Préparations', icon: '🍳', render: preparations.render, title: 'Préparations' },
  { id: 'batch', label: 'Batch', icon: '🥘', render: batch.render, title: 'Batch cooking' },
  { id: 'shopping', label: 'Courses', icon: '🛒', render: shopping.render, title: 'Liste de courses' },
  { id: 'settings', label: 'Paramètres', icon: '⚙️', render: settings.render, title: 'Paramètres' },
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
  // Changer d'écran ne doit jamais laisser un éditeur de repas ouvert
  // derrière soi (retour utilisateur) : #drawer vit hors de #view, donc
  // renderView() ci-dessous ne le nettoie jamais tout seul.
  if (isOpen()) closeEditor();
  current = id;
  location.hash = id;
  renderNav();
  renderView();
}

function renderView() {
  // Un changement de vue (clic nav, hashchange) ne passe jamais par le
  // nettoyage propre de foods.js (resetForm()/closeOffSearch()) — il vide
  // #view directement. Une MediaStream de caméra ne s'arrête JAMAIS toute
  // seule parce que son élément <video> disparaît du DOM : sans cet appel,
  // le scanner de codes-barres (barcode-panel.js, partagé par tous les
  // écrans qui le proposent) resterait actif en arrière-plan après avoir
  // quitté la vue. Sans effet si aucun scanner n'est ouvert.
  stopActiveScanner();
  const def = viewDef(current);
  document.getElementById('title').textContent = def.title;
  const root = document.getElementById('view');
  root.innerHTML = '';
  def.render(root);
}

/**
 * Source de vérité du statut affiché (P0.4 — décision verrouillée) : reflète
 * l'état RÉEL du client, jamais un optimisme par défaut. En particulier,
 * "Synchronisé" n'est plus le repli silencieux d'un état non vérifié —
 * chaque branche correspond à un fait constaté (`meta.syncing`/`syncError`/
 * `syncErrorKind`/`dirty`/`syncedAt`), jamais à une absence d'information.
 */
function renderStatus() {
  const s = getState();
  const box = document.getElementById('status');
  if (!box) return;
  const configured = sync.isConfigured();
  let cls = '';
  let label = 'Mode local';
  if (configured) {
    if (!navigator.onLine) {
      cls = 'is-dirty'; label = 'Hors ligne — modifications conservées';
    } else if (s.meta.syncing) {
      cls = 'is-dirty'; label = 'Synchronisation en cours…';
    } else if (s.meta.syncError) {
      cls = 'is-error';
      if (s.meta.syncErrorKind === 'network') {
        // Supabase injoignable maintenant : distinct d'une vraie erreur de
        // synchronisation (RPC/vérification) — cf. classifySyncError() dans sync.js.
        label = s.meta.syncedAt
          ? 'Déconnecté de la BDD — dernière synchronisation réussie'
          : 'Déconnecté de la BDD';
      } else if (s.meta.syncErrorKind === 'conflict') {
        // push() a détecté qu'un autre appareil a modifié le cloud depuis la
        // dernière synchronisation de celui-ci (assertNotStale(), sync.js) :
        // rien n'a été écrasé, mais un envoi manuel/« forcer » est nécessaire.
        label = 'Un autre appareil a modifié les données — à vérifier dans Paramètres';
      } else {
        label = 'Échec de synchronisation — données locales intactes';
      }
    } else if (s.meta.dirty) {
      cls = 'is-dirty'; label = 'Modifications à synchroniser';
    } else {
      cls = 'is-sync'; label = 'Synchronisé';
    }
  }
  const syncIcon = `<svg class="sync-spin${s.meta.syncing ? ' is-spinning' : ''}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M20 11A8 8 0 1 0 18.5 15.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M20 5v6h-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  const lastSync = configured
    ? (s.meta.syncedAt ? `${syncIcon}<span>Dernière synchro : ${relativeTime(s.meta.syncedAt)}</span>` : `${syncIcon}<span>Jamais synchronisé</span>`)
    : '';
  box.innerHTML = `<span class="dot ${cls}"></span><span class="rail__foot-text"><span class="rail__foot-label">${label}</span>${lastSync ? `<span class="rail__foot-sync">${lastSync}</span>` : ''}</span>`;
  box.title = s.meta.syncError || label;
  // Pastille repliée pour mobile/iPad (.rail__foot est masqué sous 860px,
  // cf. app.css) : même état, sans le libellé (pas de place dans la barre du
  // haut) — un tap ouvre Paramètres, où le détail technique est déjà affiché
  // en toutes lettres (jamais seulement au survol, inaccessible au tactile).
  const mobile = document.getElementById('status-mobile');
  if (mobile) { mobile.className = `topbar__status ${cls}`; mobile.title = s.meta.syncError || label; }
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

  // Tap/clic sur le statut de synchro (rail ou pastille mobile) : ouvre
  // Paramètres, où le détail technique d'une éventuelle erreur est déjà
  // affiché en clair (cf. renderAccount() dans settings.js) — remplace le
  // seul `title` (survol, jamais accessible au tactile) comme moyen d'accès.
  document.getElementById('status')?.addEventListener('click', () => navigate('settings'));
  document.getElementById('status-mobile')?.addEventListener('click', () => navigate('settings'));

  // depuis l'écran Courses : ouvrir la fiche d'un aliment sans prix
  document.addEventListener('nutriplan:open-food', (e) => {
    foods.openFoodForm(e.detail.id);
    navigate('foods');
  });

  // point d'entrée pour un futur lecteur de code-barres (caméra/douchette,
  // non implémenté ici) : il n'a qu'à émettre cet événement avec le code lu.
  document.addEventListener('nutriplan:off-barcode', (e) => {
    navigate('foods');
    foods.openFoodFormWithBarcode(document.getElementById('view'), e.detail?.barcode);
  });

  // Lien Batch cooking -> Préparations (bouton « Créer une préparation » sur
  // une ligne de recettes à préparer) : ouvre le formulaire de création
  // prérempli, jamais une création automatique (cf. batch.js/preparations.js).
  document.addEventListener('nutriplan:create-preparation', (e) => {
    navigate('preparations');
    preparations.openCreateFromRecipe(document.getElementById('view'), e.detail?.recipeId, e.detail?.grams);
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
  const formOpen = Boolean(document.querySelector('#drawer .composer__dialog, #modal .modal, #modal .drawer__panel, #view .drawer__panel'));
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
