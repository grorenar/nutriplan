/** Écran PARAMÈTRES. */

import { getState, update, exportJSON, importJSON, resetCycle, ensureCycleMeals, defaultState, backupInfo, restoreBackup } from '../core/store.js';
import { PERSONS, PERSON_LABEL, MEAL_TYPES } from '../core/nutrition.js';
import { WEEKDAYS, esc, num, toast, downloadFile } from '../core/util.js';
import { findDuplicateGroups } from '../core/similarity.js';
import * as sync from '../core/sync.js';
import { actionConfirmModal, wireActionConfirm } from './confirm-action.js';

const TYPES = ['day', 'breakfast', 'lunch', 'snack_afternoon', 'dinner', 'snack_evening'];
let importReport = null; // doublons probables repérés au dernier import
let pendingConfirm = null; // { title, message, confirmLabel, onConfirm } — P1, remplace confirm() natif

export async function render(root) {
  const s = getState();

  root.innerHTML = `
    <div class="card">
      <div class="card__head"><h2>Objectifs nutritionnels</h2></div>
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

    <div class="card">
      <div class="card__head"><h2>Cycle</h2></div>
      <div class="grid grid--3">
        <label class="field">Premier jour du cycle
          <select data-startday>${WEEKDAYS.map((d, i) => `<option value="${i}" ${s.settings.cycle.startWeekday === i ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
        <label class="field">Durée (jours)
          <input type="number" min="1" max="14" data-duration value="${s.settings.cycle.duration}"></label>
        <label class="field">Budget cible du cycle (€)
          <input type="number" step="1" min="0" data-budget value="${s.settings.budget}"></label>
      </div>
    </div>

    <div class="card">
      <div class="card__head"><h2>Batch cooking</h2></div>
      <div class="row">
        <label class="check"><input type="checkbox" data-batch-enabled ${s.settings.batch.enabled ? 'checked' : ''}> Activer le batch cooking</label>
        <label class="field" style="max-width:220px">Conservation maximale (jours)
          <input type="number" min="1" max="7" data-batch-days value="${s.settings.batch.maxDays}"></label>
      </div>
    </div>

    <div class="card">
      <div class="card__head"><h2>Données</h2></div>
      <div class="row">
        <button class="btn" data-export>Exporter en JSON</button>
        <label class="btn" style="display:inline-flex;align-items:center">Importer un JSON
          <input type="file" accept="application/json" data-import style="display:none">
        </label>
        <span class="spacer"></span>
        <button class="btn btn--danger" data-reset-cycle>Réinitialiser le cycle</button>
      </div>
      <small>La réinitialisation du cycle efface le planning, les achats cochés, les quantités de batch et les compteurs d'utilisation des catalogues. Elle ne touche ni à la banque alimentaire, ni aux objectifs, ni aux options des catalogues.</small>
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
    </div>

    <div class="card">
      <div class="card__head"><h2>Compte et synchronisation</h2></div>
      <div data-account>Chargement…</div>
    </div>
    ${pendingConfirm ? actionConfirmModal(pendingConfirm) : ''}
  `;

  wire(root);
  renderAccount(root);
}

function targetTable(person, s) {
  const rows = TYPES.map((type) => {
    const t = s.settings.targets[person][type] || { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    return `<tr>
      <td>${esc(MEAL_TYPES[type])}</td>
      ${['kcal', 'protein', 'carbs', 'fat']
        .map(
          (k) =>
            `<td><input type="number" step="1" min="0" style="width:92px" value="${t[k]}"
               data-target="${person}" data-type="${type}" data-key="${k}"></td>`
        )
        .join('')}
    </tr>`;
  }).join('');

  return `<h3 class="person-name person-name--${person}" style="margin:12px 0 4px">${PERSON_LABEL[person]}</h3>
    <table><thead><tr><th>Repas</th><th>kcal</th><th>Protéines</th><th>Glucides</th><th>Lipides</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function wire(root) {
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
