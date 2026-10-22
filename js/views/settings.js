/** Écran PARAMÈTRES. */

import { getState, update, exportJSON, importJSON, resetCycle, ensureCycleMeals, defaultState, backupInfo, restoreBackup } from '../core/store.js';
import { PERSONS, PERSON_LABEL, MEAL_TYPES, MACRO_META } from '../core/nutrition.js';
import { WEEKDAYS, esc, num, toast, downloadFile } from '../core/util.js';
import { findDuplicateGroups } from '../core/similarity.js';
import * as sync from '../core/sync.js';
import { actionConfirmModal, wireActionConfirm } from './confirm-action.js';
import { donutChart } from './charts.js';

const TYPES = ['day', 'breakfast', 'lunch', 'snack_afternoon', 'dinner', 'snack_evening'];
// Repas réellement sommés pour l'aperçu quotidien — 'day' exclu : c'est un
// objectif global optionnel, saisi séparément (souvent laissé à 0), jamais
// mêlé à la somme des repas réels pour ne pas compter deux fois le même besoin.
const DAY_MEAL_TYPES = TYPES.filter((t) => t !== 'day');
let importReport = null; // doublons probables repérés au dernier import
let pendingConfirm = null; // { title, message, confirmLabel, onConfirm } — P1, remplace confirm() natif

// Onglets plutôt qu'un long empilement de cartes (refonte graphique) : chaque
// section garde exactement son contenu/comportement d'avant, seule la
// présentation change. L'onglet actif est un état d'écran ordinaire (même
// mécanisme que `pendingConfirm`/`importReport`), pas une route — il revient
// à « Objectifs nutritionnels » à la réouverture de l'écran, comme avant.
const TABS = [
  { id: 'targets', label: 'Objectifs nutritionnels', icon: '🎯' },
  { id: 'cycle', label: 'Cycle', icon: '📅' },
  { id: 'batch', label: 'Batch cooking', icon: '🍲' },
  { id: 'data', label: 'Données', icon: '🗂️' },
  { id: 'account', label: 'Compte', icon: '☁️' },
];
let activeTab = 'targets';

export async function render(root) {
  const s = getState();

  root.innerHTML = `
    <div class="settings-tiles" role="tablist" aria-label="Sections des paramètres">
      ${TABS.map(
        (t) => `<button type="button" class="settings-tile" role="tab" data-tab="${t.id}" aria-selected="${t.id === activeTab}">
          <span class="settings-tile__icon" aria-hidden="true">${t.icon}</span>
          <span class="settings-tile__label">${t.label}</span>
        </button>`
      ).join('')}
    </div>

    <div data-panel="targets" ${activeTab === 'targets' ? '' : 'hidden'}>
      <div class="page-grid">
        <div class="page-grid__main">
          <div class="card">
            <div class="card__head"><h2>Objectifs nutritionnels</h2><p>Les besoins caloriques et macros par repas, pour Thomas et Julie.</p></div>
            ${PERSONS.map((p) => targetTable(p, s)).join('')}
            <div class="row" style="margin-top:10px">
              <label class="field" style="max-width:200px">Tolérance (%)
                <input type="number" step="1" min="1" max="25" data-tol value="${num(s.settings.tolerance * 100, 0)}"></label>
              <button class="btn btn--sm" data-reset-targets>Rétablir les objectifs par défaut</button>
            </div>
            <small>Les objectifs de la journée sont indicatifs : l'application vise les objectifs par repas, sans corriger les éventuelles incohérences.</small>
            <label class="check" style="margin-top:10px"><input type="checkbox" data-autoadjust ${s.settings.autoAdjust ? 'checked' : ''}> Ajustement automatique des quantités</label>
            <small>Recalcule automatiquement les quantités d'un repas pour viser ces objectifs, à chaque modification. Peut aussi être activé/désactivé ponctuellement depuis l'éditeur de repas.</small>
          </div>
        </div>
        <div class="page-grid__aside">
          <div class="card">
            <div class="card__head"><h3>Aperçu quotidien</h3><p>Répartition de tes objectifs sur une journée.</p></div>
            ${PERSONS.map((p) => dailyOverview(p, s)).join('')}
          </div>
        </div>
      </div>
    </div>

    <div class="card" data-panel="cycle" ${activeTab === 'cycle' ? '' : 'hidden'}>
      <div class="card__head"><h2>Cycle</h2><p>Durée du cycle de repas et budget de courses associé.</p></div>
      <div class="grid grid--3">
        <label class="field">Premier jour du cycle
          <select data-startday>${WEEKDAYS.map((d, i) => `<option value="${i}" ${s.settings.cycle.startWeekday === i ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
        <label class="field">Durée (jours)
          <input type="number" min="1" max="14" data-duration value="${s.settings.cycle.duration}"></label>
        <label class="field">Budget cible du cycle (€)
          <input type="number" step="1" min="0" data-budget value="${s.settings.budget}"></label>
      </div>
    </div>

    <div class="card" data-panel="batch" ${activeTab === 'batch' ? '' : 'hidden'}>
      <div class="card__head"><h2>Batch cooking</h2><p>Active les sessions de préparation groupée et leur durée de conservation.</p></div>
      <div class="row">
        <label class="check"><input type="checkbox" data-batch-enabled ${s.settings.batch.enabled ? 'checked' : ''}> Activer le batch cooking</label>
        <label class="field" style="max-width:220px">Conservation maximale (jours)
          <input type="number" min="1" max="7" data-batch-days value="${s.settings.batch.maxDays}"></label>
      </div>
    </div>

    <div class="card" data-panel="data" ${activeTab === 'data' ? '' : 'hidden'}>
      <div class="card__head"><h2>Données</h2><p>Sauvegarde portable et actions sensibles sur le cycle en cours.</p></div>
      <div class="row">
        <button class="btn" data-export>Exporter en JSON</button>
        <label class="btn" style="display:inline-flex;align-items:center">Importer un JSON
          <input type="file" accept="application/json" data-import style="display:none">
        </label>
      </div>
      <small style="display:block;margin-top:8px" class="muted">Export/Import JSON : un fichier portable que tu télécharges ou réimportes toi-même — distinct de l'enregistrement automatique dans ce navigateur (silencieux, à chaque modification) et du compte cloud ci-dessous (partagé entre appareils).</small>
      ${
        importReport
          ? `<div class="card" style="margin-top:12px;border-color:#ecd7ae;background:var(--warn-bg)">
              <strong>Doublons possibles dans la banque importée</strong>
              <ul style="margin:6px 0 0;padding-left:18px">
                ${importReport
                  .map((g) => `<li>${esc(g.food.name)} ~ ${g.similar.map((x) => esc(x.food.name)).join(', ')}</li>`)
                  .join('')}
              </ul>
              <small>Aucun aliment n'a été fusionné ni supprimé : vérifie-les dans l'écran Aliments.</small>
              <div class="row" style="margin-top:8px"><button class="btn btn--sm" data-dismiss-import>Masquer</button></div>
            </div>`
          : ''
      }
      <div class="row" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line)">
        <strong class="tag" style="color:var(--off)">Zone sensible</strong>
        <span class="spacer"></span>
        <button class="btn btn--danger" data-reset-cycle>Réinitialiser le cycle</button>
      </div>
      <small>La réinitialisation du cycle efface le planning, les achats cochés, les quantités de batch et les compteurs d'utilisation des catalogues. Elle ne touche ni à la banque alimentaire, ni aux objectifs, ni aux options des catalogues.</small>
    </div>

    <div class="card" data-panel="account" ${activeTab === 'account' ? '' : 'hidden'}>
      <div class="card__head"><h2>Compte et synchronisation</h2></div>
      <div data-account>Chargement…</div>
    </div>
    ${pendingConfirm ? actionConfirmModal(pendingConfirm) : ''}
  `;

  wire(root);
  renderAccount(root);
}

/**
 * Donut de répartition calorique de la journée (somme des repas réels,
 * 'day' exclu — cf. DAY_MEAL_TYPES) : protéines/glucides/lipides pondérés
 * par leur apport calorique réel (4/4/9 kcal par gramme), pas par leur
 * seul poids en grammes — c'est la proportion qui compte nutritionnellement,
 * affichage à titre indicatif, n'affecte jamais aucun calcul du moteur.
 */
function dailyOverview(person, s) {
  const total = DAY_MEAL_TYPES.reduce(
    (acc, type) => {
      const t = s.settings.targets[person][type] || { kcal: 0, protein: 0, carbs: 0, fat: 0 };
      acc.kcal += t.kcal; acc.protein += t.protein; acc.carbs += t.carbs; acc.fat += t.fat;
      return acc;
    },
    { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  );
  const segments = [
    // value = apport calorique réel (g × kcal/g) : détermine la part de l'anneau ;
    // displayValue = grammes, tel qu'affiché dans la légende.
    { label: 'Protéines', value: total.protein * 4, displayValue: total.protein, color: 'var(--protein)', icon: '💪' },
    { label: 'Glucides', value: total.carbs * 4, displayValue: total.carbs, color: 'var(--carbs)', icon: '🌾' },
    { label: 'Lipides', value: total.fat * 9, displayValue: total.fat, color: 'var(--fat)', icon: '🧈' },
  ];
  return `<div style="margin-bottom:16px">
    <h3 class="person-name person-name--${person}" style="margin-bottom:8px">${PERSON_LABEL[person]}</h3>
    ${donutChart(segments, {
      size: 112, thickness: 15,
      centerValueHtml: `<span class="donut__center-value">${num(total.kcal, 0)}</span>`,
      centerLabel: 'kcal',
      ariaLabel: `Répartition des macros de ${PERSON_LABEL[person]}`,
      formatValue: (v) => `${num(v, 0)} g`,
    })}
  </div>`;
}

/**
 * Objectifs de macros par repas (P4, retour utilisateur) — une carte par
 * repas plutôt qu'un tableau dense de 24 champs nus : mêmes data-target/
 * data-type/data-key qu'avant (même mécanisme de saisie, wire() inchangé),
 * seule la présentation change. Icône + couleur par macro réutilisent
 * MACRO_META, déjà la référence constante dans tout le reste de l'app
 * (planning, éditeur de repas).
 */
function targetTable(person, s) {
  const cards = TYPES.map((type) => {
    const t = s.settings.targets[person][type] || { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    const fields = Object.keys(MACRO_META)
      .map((k) => {
        const meta = MACRO_META[k];
        return `<label class="target-field">
          <span class="target-field__label" style="color:var(--${meta.cls})">${meta.icon} ${meta.short}</span>
          <input type="number" step="1" min="0" value="${t[k]}" data-target="${person}" data-type="${type}" data-key="${k}">
        </label>`;
      })
      .join('');
    return `<div class="target-card">
      <div class="target-card__head">${esc(MEAL_TYPES[type])}</div>
      <div class="target-card__fields">${fields}</div>
    </div>`;
  }).join('');

  return `<h3 class="person-name person-name--${person}" style="margin:12px 0 10px">${PERSON_LABEL[person]}</h3>
    <div class="target-grid">${cards}</div>`;
}

function wire(root) {
  root.querySelectorAll('[data-tab]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      activeTab = e.currentTarget.dataset.tab;
      render(root);
    })
  );

  root.querySelectorAll('[data-target]').forEach((input) =>
    input.addEventListener('change', (e) => {
      const { target: person, type, key } = e.target.dataset;
      const v = Math.max(0, Number(e.target.value) || 0);
      update((s) => { s.settings.targets[person][type][key] = v; });
    })
  );

  root.querySelector('[data-tol]')?.addEventListener('change', (e) => {
    const v = Math.min(25, Math.max(1, Number(e.target.value) || 5));
    update((s) => { s.settings.tolerance = v / 100; });
  });

  root.querySelector('[data-reset-targets]')?.addEventListener('click', () => {
    pendingConfirm = {
      title: 'Rétablir les objectifs par défaut ?',
      message: 'Les objectifs nutritionnels actuels de Thomas et Julie seront remplacés par les valeurs par défaut.',
      confirmLabel: 'Rétablir',
      onConfirm: () => {
        update((s) => { s.settings.targets = defaultState().settings.targets; });
        render(root);
      },
    };
    render(root);
  });

  root.querySelector('[data-startday]')?.addEventListener('change', (e) => {
    const v = Number(e.target.value);
    update((s) => { s.settings.cycle.startWeekday = v; });
  });

  root.querySelector('[data-duration]')?.addEventListener('change', (e) => {
    const v = Math.min(14, Math.max(1, Number(e.target.value) || 1));
    update((s) => { s.settings.cycle.duration = v; ensureCycleMeals(s); });
    render(root);
  });

  root.querySelector('[data-budget]')?.addEventListener('change', (e) => {
    const v = Math.max(0, Number(e.target.value) || 0);
    update((s) => { s.settings.budget = v; });
  });

  root.querySelector('[data-batch-enabled]')?.addEventListener('change', (e) => {
    const v = e.target.checked;
    update((s) => { s.settings.batch.enabled = v; });
  });

  root.querySelector('[data-batch-days]')?.addEventListener('change', (e) => {
    const v = Math.min(7, Math.max(1, Number(e.target.value) || 3));
    update((s) => { s.settings.batch.maxDays = v; });
  });

  root.querySelector('[data-autoadjust]')?.addEventListener('change', (e) => {
    const v = e.target.checked;
    update((s) => { s.settings.autoAdjust = v; });
  });

  root.querySelector('[data-export]')?.addEventListener('click', () => {
    const stamp = new Date().toISOString().slice(0, 10);
    downloadFile(`nutriplan-${stamp}.json`, exportJSON());
    toast('Export téléchargé');
  });

  root.querySelector('[data-import]')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    pendingConfirm = {
      title: 'Importer cette sauvegarde ?',
      message: 'Les données actuelles seront entièrement remplacées par le contenu de ce fichier.',
      confirmLabel: 'Importer',
      onConfirm: async () => {
        try {
          importJSON(await file.text());
          // contrôle non bloquant : la banque importée contient-elle des doublons probables ?
          const groups = findDuplicateGroups(getState().foods);
          importReport = groups.length ? groups : null;
          toast(groups.length ? `Sauvegarde importée — ${groups.length} doublon(s) possible(s)` : 'Sauvegarde importée');
        } catch (err) {
          toast(`Import impossible : ${err.message}`, 'error');
        }
        render(root);
      },
    };
    render(root);
  });

  root.querySelector('[data-dismiss-import]')?.addEventListener('click', () => { importReport = null; render(root); });

  root.querySelector('[data-reset-cycle]')?.addEventListener('click', () => {
    pendingConfirm = {
      title: 'Réinitialiser le cycle ?',
      message: 'Le planning, les achats cochés et les quantités de batch seront effacés. La banque alimentaire, les objectifs et les catalogues sont conservés.',
      confirmLabel: 'Réinitialiser',
      onConfirm: () => {
        resetCycle();
        toast('Cycle réinitialisé');
        render(root);
      },
    };
    render(root);
  });

  wireActionConfirm(root, { getPending: () => pendingConfirm, setPending: (v) => { pendingConfirm = v; }, render });
}

/* ------------------------------------------------------------------ */
/* Compte Supabase                                                     */
/* ------------------------------------------------------------------ */

async function renderAccount(root) {
  const box = root.querySelector('[data-account]');
  if (!box) return;

  if (!sync.isConfigured()) {
    box.innerHTML = `<p>Mode local uniquement : les données sont enregistrées dans ce navigateur.</p>`;
    return;
  }

  let user = null;
  try { user = await sync.currentUser(); } catch { /* hors ligne */ }
  const s = getState();

  const backup = backupInfo();
  const statusLine = s.meta.syncError
    ? `<small class="sync-error">Dernière synchronisation en échec : ${esc(s.meta.syncError)} — les données locales sont intactes et restent la référence.</small>`
    : s.meta.dirty
      ? '<small>Modifications locales en attente d’envoi.</small>'
      : `<small>Synchronisé${s.meta.syncedAt ? ` le ${new Date(s.meta.syncedAt).toLocaleString('fr-FR')}` : ''}.</small>`;

  box.innerHTML = user
    ? `<p>Connecté : <strong>${esc(user.email || '')}</strong></p>
       <div class="row">
         <button class="btn btn--primary" data-push>Envoyer vers le cloud</button>
         <button class="btn" data-pull>Récupérer depuis le cloud</button>
         <span class="spacer"></span>
         <button class="btn" data-signout>Déconnexion</button>
       </div>
       <small class="muted">La synchronisation se fait déjà automatiquement en arrière-plan après chaque modification ; ces deux boutons servent à forcer un envoi/une récupération immédiats (ex. après une coupure réseau) — « Récupérer » remplace les données de cet appareil par celles du cloud.</small>
       <div class="row" style="margin-top:12px">
         <input type="password" data-newpw placeholder="Nouveau mot de passe" style="max-width:240px">
         <button class="btn btn--sm" data-changepw>Modifier le mot de passe</button>
       </div>
       ${statusLine}
       ${
         backup
           ? `<div class="row" style="margin-top:10px">
                <button class="btn btn--sm" data-restore>Restaurer la sauvegarde locale</button>
                <small>État d’avant la dernière récupération, du ${esc(new Date(backup.savedAt).toLocaleString('fr-FR'))}.</small>
              </div>`
           : ''
       }`
    : `<div class="row">
         <input type="email" data-email placeholder="Adresse e-mail" style="max-width:240px">
         <input type="password" data-password placeholder="Mot de passe" style="max-width:200px">
         <button class="btn btn--primary" data-signin>Connexion</button>
         <button class="btn" data-signup>Créer le compte</button>
       </div>
       <small>Un seul compte partagé par Thomas et Julie : les données appartiennent à ce compte et ne sont accessibles qu’avec lui.</small>`;

  box.querySelector('[data-restore]')?.addEventListener('click', () => {
    pendingConfirm = {
      title: 'Restaurer la sauvegarde locale ?',
      message: 'L’état actuel de l’application sera remplacé par celui d’avant la dernière récupération depuis le cloud.',
      confirmLabel: 'Restaurer',
      onConfirm: () => {
        try { restoreBackup(); toast('Sauvegarde locale restaurée'); }
        catch (e) { toast(e.message, 'error'); }
        render(root);
      },
    };
    render(root);
  });

  box.querySelector('[data-signin]')?.addEventListener('click', async () => {
    try {
      await sync.signIn(box.querySelector('[data-email]').value.trim(), box.querySelector('[data-password]').value);
      toast('Connecté');
      await sync.pull().catch(() => {});
      render(root);
    } catch (e) { toast(e.message || 'Connexion impossible', 'error'); }
  });

  box.querySelector('[data-signup]')?.addEventListener('click', async () => {
    try {
      await sync.signUp(box.querySelector('[data-email]').value.trim(), box.querySelector('[data-password]').value);
      toast('Compte créé — vérifie éventuellement tes e-mails');
      render(root);
    } catch (e) { toast(e.message || 'Création impossible', 'error'); }
  });

  box.querySelector('[data-signout]')?.addEventListener('click', async () => {
    await sync.signOut();
    toast('Déconnecté');
    render(root);
  });

  box.querySelector('[data-push]')?.addEventListener('click', async () => {
    try {
      const counts = await sync.push();
      const total = Object.values(counts || {}).reduce((a, b) => a + Number(b), 0);
      toast(`Envoi vérifié : ${total} lignes enregistrées`);
      render(root);
    } catch (e) {
      // conflit détecté (assertNotStale(), sync.js) : un autre appareil a
      // modifié le cloud depuis la dernière synchronisation de celui-ci —
      // échappatoire explicite, jamais un écrasement silencieux par défaut.
      if (e.syncErrorKind === 'conflict') {
        pendingConfirm = {
          title: 'Envoyer quand même ?',
          message: `${e.message}\n\nEnvoyer quand même les données de cet appareil, en remplaçant celles du cloud ?`,
          confirmLabel: 'Envoyer quand même',
          onConfirm: async () => {
            try {
              const counts = await sync.push({ force: true });
              const total = Object.values(counts || {}).reduce((a, b) => a + Number(b), 0);
              toast(`Envoi forcé : ${total} lignes enregistrées (données distantes remplacées)`);
            } catch (e2) {
              toast(`Envoi impossible : ${e2.message} — rien n'a été modifié`, 'error');
            }
            render(root);
          },
        };
        render(root);
        return;
      }
      toast(`Envoi impossible : ${e.message} — rien n'a été modifié`, 'error');
      render(root);
    }
  });

  box.querySelector('[data-pull]')?.addEventListener('click', () => {
    pendingConfirm = {
      title: 'Remplacer les données locales ?',
      message: 'Remplacer les données locales par celles du cloud ? Une sauvegarde locale sera conservée, restaurable depuis cet écran.',
      confirmLabel: 'Récupérer depuis le cloud',
      onConfirm: async () => {
        try { await sync.pull(); toast('Données récupérées'); }
        catch (e) { toast(e.message || 'Récupération impossible', 'error'); }
        render(root);
      },
    };
    render(root);
  });

  box.querySelector('[data-changepw]')?.addEventListener('click', async () => {
    const pw = box.querySelector('[data-newpw]').value;
    if (pw.length < 6) { toast('Mot de passe trop court', 'error'); return; }
    try { await sync.changePassword(pw); toast('Mot de passe modifié'); }
    catch (e) { toast(e.message || 'Modification impossible', 'error'); }
  });
}
