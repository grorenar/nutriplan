/**
 * Panneau de lecture de code-barres par caméra — composant partagé (choix de
 * caméra si l'appareil en expose plusieurs, flash/torche, repli vers la
 * saisie manuelle en cas d'erreur) utilisé par tout écran proposant un scan :
 * création d'aliment (foods.js), ajout d'un ingrédient à un repas/une
 * collation (editor.js) ou à une recette (recipes.js). Un seul endroit pour
 * cette mécanique — jamais une resaisie parallèle du choix de caméra ou de la
 * gestion du flash selon l'écran.
 *
 * Un seul scanner actif à la fois (cohérent avec le matériel : une seule
 * caméra ouverte en même temps) : le panneau gère son propre état interne et
 * s'insère toujours en superposition de tout le reste de l'écran
 * (`document.body`), donc indépendamment de l'écran/tiroir qui l'a ouvert.
 */
import { isCameraSupported, listCameras, startScan } from '../core/barcode-scanner.js';
import { esc, normalize } from '../core/util.js';

export const isScannerSupported = isCameraSupported;

/**
 * `status`: 'starting' (permission/flux en cours) | 'scanning' (flux affiché,
 * lecture en cours) | 'error' (caméra inaccessible — bouton Réessayer).
 * `cameras`: [{deviceId, label}] — rafraîchi après le premier flux obtenu
 * (les libellés ne sont fiables qu'une fois la permission accordée), déjà
 * simplifié par simplifyCameraChoices() (jamais la liste brute).
 * `activeDeviceId`: device réellement actif, pour présélectionner le bon
 * choix dans le sélecteur de caméra (utile avec le repli "environment").
 * `controls`: renvoyé par startScan() — { stop(), hasTorch(), setTorch() }.
 * `torchAvailable`/`torchOn` : état du flash, réinitialisés à chaque
 * (re)démarrage (jamais activé automatiquement sans action explicite).
 */
let scanner = null;
let onDetectedCallback = null;

export function isScannerOpen() {
  return scanner !== null;
}

/**
 * Ouvre le panneau scanner en superposition de tout le reste de l'écran.
 * `onDetected(code)` est appelé UNE SEULE FOIS après une lecture réussie —
 * le panneau est déjà refermé et la caméra déjà coupée à ce moment, à charge
 * de l'appelant de poursuivre (recherche dans le catalogue, recherche OFF…).
 */
export function openScannerPanel(onDetected) {
  closeScannerPanel();
  onDetectedCallback = onDetected;
  scanner = {
    status: 'starting', error: null, cameras: [], activeDeviceId: null, controls: null,
    torchAvailable: false, torchOn: false,
  };
  document.body.insertAdjacentHTML('beforeend', scannerPanelHtml());
  wireScanner();
  runScan();
}

/**
 * Termine le scanner avec un code, qu'il vienne d'une lecture caméra
 * réussie (runScan()) ou d'une saisie manuelle (wireScannerChrome()) —
 * MÊME suite dans les deux cas : panneau refermé puis callback appelé,
 * jamais de logique dupliquée selon la source du code.
 */
function finishWithCode(code) {
  if (!scanner) return;
  const callback = onDetectedCallback;
  closeScannerPanel();
  callback?.(code);
}

/** Referme le panneau et coupe la caméra, sans rien faire d'autre (l'écran/tiroir en dessous reste intact). */
export function closeScannerPanel() {
  scanner?.controls?.stop();
  scanner = null;
  onDetectedCallback = null;
  document.querySelector('[data-scanner-backdrop]')?.remove();
}

/**
 * Point d'entrée pour app.js : coupe la caméra et retire le panneau avant
 * tout changement de vue. Jamais d'exception — sans effet si aucun scanner
 * n'est ouvert.
 */
export function stopActiveScanner() {
  closeScannerPanel();
}

/**
 * (Re)démarre la lecture sur la caméra demandée (ou, par défaut, la caméra
 * arrière — géré par startScan()/la bibliothèque, jamais deviné ici).
 * Coupe systématiquement tout flux précédent avant d'en ouvrir un nouveau
 * (changement de caméra propre : jamais deux flux actifs en même temps).
 */
async function runScan(deviceId) {
  if (!scanner) return;
  scanner.controls?.stop();
  scanner.status = 'starting';
  scanner.error = null;
  scanner.controls = null;
  scanner.torchAvailable = false;
  scanner.torchOn = false; // jamais reporté d'une caméra à l'autre : état matériel réellement réinitialisé au changement
  renderScannerChrome();

  const videoElement = document.getElementById('scanner-video');
  if (!videoElement) return; // panneau refermé entre-temps

  const controls = await startScan({
    videoElement,
    deviceId,
    onDetected: (code) => {
      if (!scanner) return; // panneau déjà refermé (rare, détection juste avant la fermeture)
      finishWithCode(code); // caméra coupée ET panneau retiré AVANT d'appeler l'appelant
    },
    onError: (message) => {
      if (!scanner) return;
      scanner.status = 'error';
      scanner.error = message;
      scanner.controls = null;
      renderScannerChrome();
    },
  });

  if (!scanner) { controls.stop(); return; } // panneau refermé pendant le await startScan()
  if (scanner.status === 'error') { controls.stop(); return; } // onError a déjà tranché (ex. permission refusée)

  scanner.status = 'scanning';
  scanner.controls = controls;
  scanner.activeDeviceId = controls.getActiveDeviceId() || deviceId || null;
  scanner.torchAvailable = controls.hasTorch();
  // Les libellés de caméras ne sont fiables qu'après qu'une permission a été
  // accordée au moins une fois : on (re)liste seulement maintenant.
  scanner.cameras = simplifyCameraChoices(await listCameras());
  renderScannerChrome();
}

// Mots-clés reconnaissant une caméra avant/arrière dans son libellé natif —
// accents retirés par normalize() avant le test, d'où "arriere"/"avant" en
// toutes lettres (jamais un fragment de mot : "arri" seul ne "boundary"
// jamais avec le "e" qui suit dans "arriere", d'où la forme complète ici).
const BACK_CAMERA_PATTERN = /\b(back|rear|environment|arriere)\b/;
const FRONT_CAMERA_PATTERN = /\b(front|user|face|avant)\b/;

/** Libellé lisible pour une caméra : avant/arrière déduit du libellé natif quand possible, repli numéroté sinon. */
function cameraLabel(cam, index) {
  const l = normalize(cam.label || '');
  if (BACK_CAMERA_PATTERN.test(l)) return 'Caméra arrière';
  if (FRONT_CAMERA_PATTERN.test(l)) return 'Caméra avant';
  return cam.label || `Caméra ${index + 1}`;
}

/**
 * iOS/Safari (et d'autres navigateurs mobiles) exposent CHAQUE objectif
 * physique arrière comme un périphérique distinct — grand angle, ultra grand
 * angle, téléobjectif, ET des périphériques "virtuels" combinant plusieurs
 * objectifs (« Triple caméra arrière », « Double caméra arrière… ») pour le
 * changement de focale automatique en zoomant, comme l'app Appareil photo.
 * Un iPhone récent peut ainsi annoncer 6 à 8 caméras pour 2 UTILISATEURS
 * réels (avant/arrière) — une liste brute n'est pas exploitable.
 *
 * Simplifie donc le choix à UNE caméra arrière + UNE caméra avant (jamais
 * plus) : côté arrière, préfère explicitement le périphérique virtuel
 * multi-objectifs quand il existe (« Triple » puis « Double »/« Dual ») —
 * c'est lui qui donne le changement d'objectif automatique en zoomant,
 * exactement le comportement de l'app Appareil photo native — à défaut la
 * première caméra arrière listée. Un appareil sans notion avant/arrière
 * (webcams d'ordinateur, aucun libellé reconnu) n'est jamais réduit : la
 * liste reste telle quelle (cf. cameraLabel(), repli numéroté).
 */
function simplifyCameraChoices(cameras) {
  const back = [];
  const front = [];
  const unclassified = [];
  for (const cam of cameras) {
    const l = normalize(cam.label || '');
    if (BACK_CAMERA_PATTERN.test(l)) back.push(cam);
    else if (FRONT_CAMERA_PATTERN.test(l)) front.push(cam);
    else unclassified.push(cam);
  }
  if (!back.length && !front.length) return cameras; // rien de reconnaissable : aucune simplification à faire (ex. webcams d'ordinateur)
  const bestBack =
    back.find((c) => /\btriple\b/.test(normalize(c.label || ''))) ||
    back.find((c) => /\b(double|dual)\b/.test(normalize(c.label || ''))) ||
    back[0];
  return [bestBack, front[0], ...unclassified].filter(Boolean);
}

function scannerPanelHtml() {
  // Modale centrale à bord arrondi (retour utilisateur : cohérence avec le
  // reste de la DA — plus un volet latéral à l'ancienne), même recette que
  // .wizard/.composer : .scanner-modal pilote seul le positionnement/fond,
  // les sous-éléments gardent leur double classe (…drawer__panel, etc.) pour
  // hériter des styles de base sans rien dupliquer côté JS (détection
  // d'ouverture, structure). Volontairement étroite (vidéo 4/3 + quelques
  // contrôles, pas une liste à faire défiler) et aussi peu chargée que
  // possible : rien ici que le cadre de visée, l'état courant et les seuls
  // contrôles qui s'appliquent (caméra/flash, uniquement s'il y a un choix).
  return `<div class="scanner-modal" data-scanner-backdrop>
    <div class="scanner-modal__dialog drawer__panel" role="dialog" aria-label="Scanner un code-barres">
      <div class="scanner-modal__head drawer__head"><div class="row">
        <h3 style="flex:1">Scanner un code-barres</h3>
        <button class="btn btn--ghost" data-scanner-close type="button">Fermer</button>
      </div></div>
      <div class="scanner-modal__body drawer__body">
        <div class="scanner-frame">
          <video id="scanner-video" class="scanner-frame__video" autoplay muted playsinline></video>
          <div class="scanner-frame__guide" aria-hidden="true"></div>
        </div>
        <div id="scanner-chrome" style="margin-top:12px">${scannerChromeHtml()}</div>
        <small class="scanner-modal__privacy">La lecture se fait entièrement sur cet appareil : aucune image n'est envoyée à un serveur. Seul le code-barres détecté est utilisé pour la recherche.</small>
      </div>
    </div>
  </div>`;
}

/** Statut + sélecteur de caméra — seule zone remplacée à chaque étape, jamais la vidéo elle-même (pas de coupure/réaffectation inutile du flux). */
function scannerChromeHtml() {
  const s = scanner;
  if (!s) return '';
  const parts = [];
  if (s.status === 'starting') {
    parts.push(`<p class="muted">Démarrage de la caméra…</p>`);
  } else if (s.status === 'error') {
    parts.push(`<div class="card" style="border-color:#eebeb9">
      <strong>${esc(s.error)}</strong>
      <div class="row" style="margin-top:8px">
        <button class="btn btn--sm" data-scanner-retry type="button">Réessayer</button>
        <button class="btn btn--sm btn--ghost" data-scanner-manual type="button">Saisie manuelle</button>
      </div>
    </div>`);
  } else if (s.status === 'manual') {
    // Même suite qu'une lecture caméra réussie (finishWithCode()) — un code
    // tapé à la main est tout aussi valable qu'un code lu par la caméra,
    // jamais un second parcours différent côté appelant.
    parts.push(`<div class="card">
      <label class="field">Code-barres
        <input type="text" inputmode="numeric" pattern="[0-9]*" data-scanner-manual-input placeholder="Ex. 3017620422003" autofocus>
      </label>
      <div class="row" style="margin-top:8px">
        <button class="btn btn--sm btn--primary" data-scanner-manual-submit type="button" disabled>Valider</button>
        <button class="btn btn--sm btn--ghost" data-scanner-manual-cancel type="button">Annuler</button>
      </div>
    </div>`);
  } else {
    parts.push(`<p class="muted">Positionne le code-barres dans le cadre — la lecture est automatique.</p>`);
  }
  if (s.cameras.length > 1) {
    parts.push(`<label class="field" style="margin-top:10px">Caméra
      <select data-scanner-camera>${s.cameras
        .map((c, i) => `<option value="${esc(c.deviceId)}" ${c.deviceId === s.activeDeviceId ? 'selected' : ''}>${esc(cameraLabel(c, i))}</option>`)
        .join('')}</select></label>`);
  }
  if (s.status === 'scanning' && s.torchAvailable) {
    parts.push(`<div class="row" style="margin-top:10px">
      <button class="btn btn--sm" data-scanner-torch type="button" aria-pressed="${s.torchOn}">${s.torchOn ? '🔦 Flash activé' : '🔦 Activer le flash'}</button>
    </div>`);
  }
  return parts.join('');
}

/** Ne touche jamais la vidéo ni le reste du panneau — seule la zone de statut est remplacée. */
function renderScannerChrome() {
  const el = document.getElementById('scanner-chrome');
  if (!el || !scanner) return;
  el.innerHTML = scannerChromeHtml();
  wireScannerChrome();
}

function wireScanner() {
  if (!scanner) return;
  document.querySelector('[data-scanner-close]')?.addEventListener('click', () => closeScannerPanel());
  document.querySelector('[data-scanner-backdrop]')?.addEventListener('mousedown', (e) => {
    if (e.target.dataset.scannerBackdrop !== undefined) closeScannerPanel();
  });
  wireScannerChrome();
}

function wireScannerChrome() {
  if (!scanner) return;
  document.querySelector('[data-scanner-retry]')?.addEventListener('click', () => runScan(scanner.activeDeviceId || undefined));
  document.querySelector('[data-scanner-manual]')?.addEventListener('click', () => {
    scanner.controls?.stop(); // la caméra reste potentiellement en erreur derrière : coupée explicitement, jamais laissée active sans flux affiché
    scanner.controls = null;
    scanner.status = 'manual';
    renderScannerChrome();
  });
  const manualInput = document.querySelector('[data-scanner-manual-input]');
  const manualSubmitBtn = document.querySelector('[data-scanner-manual-submit]');
  const submitManual = () => {
    const code = (manualInput?.value || '').replace(/[^0-9]/g, '');
    if (code) finishWithCode(code);
  };
  manualInput?.addEventListener('input', () => {
    if (manualSubmitBtn) manualSubmitBtn.disabled = !manualInput.value.replace(/[^0-9]/g, '');
  });
  manualInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitManual(); });
  document.querySelector('[data-scanner-manual-submit]')?.addEventListener('click', submitManual);
  document.querySelector('[data-scanner-manual-cancel]')?.addEventListener('click', () => runScan(scanner.activeDeviceId || undefined));
  document.querySelector('[data-scanner-camera]')?.addEventListener('change', (e) => runScan(e.target.value));
  document.querySelector('[data-scanner-torch]')?.addEventListener('click', async () => {
    if (!scanner?.controls) return;
    const next = !scanner.torchOn;
    const ok = await scanner.controls.setTorch(next);
    if (!scanner) return; // panneau refermé pendant l'appel
    if (ok) scanner.torchOn = next;
    renderScannerChrome();
  });
}
