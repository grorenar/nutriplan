/**
 * Lecture de codes-barres par caméra — module indépendant de l'UI.
 * ------------------------------------------------------------------
 * Bibliothèque retenue : **@zxing/browser** (+ sa dépendance @zxing/library),
 * chargée en différé depuis esm.sh — même convention que
 * `@supabase/supabase-js` dans `js/core/sync.js` (aucune dépendance au build,
 * Nutriplan reste un site statique pur ; import caché derrière une promesse
 * mémoïsée, jamais rechargée deux fois).
 *
 * Pourquoi @zxing/browser plutôt que les alternatives :
 *  - **API native `BarcodeDetector`** (Shape Detection API) : écartée comme
 *    moteur principal — non disponible sur Safari iOS/iPadOS à ce jour
 *    (désactivée par défaut sur toutes les versions actuelles, y compris la
 *    Technology Preview — vérifié via les tableaux de compatibilité à jour),
 *    hors de question pour une application qui doit fonctionner sur iPhone/
 *    iPad. L'utiliser en double-moteur (natif si dispo, repli JS sinon)
 *    doublerait la surface de test pour un gain marginal sur les seuls
 *    Chrome/Edge desktop et Android — complexité non justifiée ici.
 *  - **html5-qrcode** : wrapper au-dessus du même moteur ZXing-js, mais son
 *    développement est à l'arrêt (dernière publication: avril 2023).
 *  - **Quagga2** (fork maintenu de QuaggaJS) : alternative sérieuse,
 *    activement maintenue (version récente, licence MIT), mais plusieurs
 *    retours font état de faux positifs sur des EAN et de soucis sur des
 *    codes abîmés/mal imprimés — risque direct pour des codes-barres
 *    alimentaires réels (emballages froissés, reflets).
 *  - **@zxing/browser** : port direct du décodeur ZXing (référence du
 *    secteur, implémentation Google d'origine), licence MIT (le cœur
 *    @zxing/library est Apache-2.0) — aucune dépendance payante. Publications
 *    récentes vérifiées sur le registre npm (browser@0.2.1 : juillet 2026 ;
 *    library@0.23.0 : avril 2026) : toujours activement publié, malgré un
 *    rythme de nouvelles fonctionnalités ralenti (le projet est en mode
 *    maintenance, pas à l'abandon). Fournit nativement tout ce dont ce
 *    module a besoin : `listVideoInputDevices()` (énumération des caméras),
 *    `decodeFromVideoDevice(deviceId, videoEl, callback)` avec repli
 *    automatique sur `facingMode: 'environment'` quand aucun deviceId n'est
 *    fourni (caméra arrière privilégiée par défaut, sans avoir à deviner
 *    quel device est "la caméra arrière"), et des `IScannerControls.stop()`
 *    qui arrêtent explicitement toutes les pistes vidéo ET détachent le
 *    flux de l'élément `<video>`.
 *  - `BrowserMultiFormatOneDReader` restreint le décodage aux formats 1D
 *    (EAN-13/EAN-8/UPC-A/UPC-E/Code128/Code39/Code93/ITF/Codabar/RSS…),
 *    jamais aux formats 2D (QR/Data Matrix/PDF417/Aztec) hors sujet pour un
 *    code-barres alimentaire — réduit le travail par frame et le risque de
 *    décoder par erreur un QR code imprimé ailleurs sur l'emballage.
 *
 * Un code-barres décodé est TOUJOURS une chaîne de caractères
 * (`Result.getText()` renvoie déjà une chaîne ZXing, jamais repassé par
 * Number()) — même convention que `normalizeBarcode()` dans `off.js`.
 *
 * Aucune image ni flux vidéo n'est jamais envoyé à un serveur : le décodage
 * est entièrement local (canvas + calcul dans le navigateur). Seul le texte
 * décodé quitte ce module, transmis à l'appelant (js/views/foods.js), qui le
 * fait suivre tel quel à la recherche Open Food Facts déjà existante — ce
 * module ignore tout du modèle Nutriplan et de l'intégration OFF.
 */

// Formats réellement utilisés sur un emballage alimentaire courant — une
// restriction volontaire (plutôt que tous les formats 1D disponibles) pour
// limiter le travail par frame et le risque de faux positifs sur un format
// hors sujet (ex. Code 39 industriel). Facile à élargir si besoin réel.
const RELEVANT_FORMAT_NAMES = ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128'];

let libPromise = null;
let injectedLib = null; // point d'injection réservé aux tests (jamais de vrai réseau/caméra en test)
let injectedDevices = null; // idem, pour navigator.mediaDevices.enumerateDevices()

/** Remplace la bibliothèque ZXing chargée (tests uniquement). Passer null pour revenir au chargement réel. */
export function __setTestLib(lib) {
  injectedLib = lib;
}

/** Force la liste de caméras renvoyée par listCameras() (tests uniquement). Passer null pour revenir au comportement réel. */
export function __setTestDevices(devices) {
  injectedDevices = devices;
}

async function getLib() {
  if (injectedLib) return injectedLib;
  if (!libPromise) {
    libPromise = Promise.all([
      import('https://esm.sh/@zxing/library@0.23.0'),
      import('https://esm.sh/@zxing/browser@0.2.1'),
    ]).then(([library, browser]) => ({
      BrowserMultiFormatOneDReader: browser.BrowserMultiFormatOneDReader,
      DecodeHintType: library.DecodeHintType,
      BarcodeFormat: library.BarcodeFormat,
    }));
  }
  return libPromise;
}

/**
 * La lecture par caméra est-elle seulement envisageable sur ce navigateur ?
 * Vérifié AVANT même de proposer le bouton « Scanner » — ne demande jamais
 * la permission caméra pour le savoir (pas d'API = pas la peine d'essayer).
 * Un contexte non sécurisé (ni HTTPS ni localhost) bloque aussi getUserMedia :
 * `isSecureContext` le reflète déjà nativement, pas besoin de le revérifier.
 */
export function isCameraSupported() {
  return Boolean(globalThis.navigator?.mediaDevices?.getUserMedia) && globalThis.isSecureContext !== false;
}

/**
 * Liste les caméras disponibles ({deviceId, label}[]) — ne lève jamais
 * d'exception : un navigateur qui ne sait pas énumérer les périphériques
 * (ou qui n'en expose aucun) renvoie simplement une liste vide, auquel cas
 * l'appelant se contente d'une seule caméra sans proposer de bascule (cf.
 * règle « ne jamais afficher un choix qui ne peut pas être appliqué »).
 * Les libellés ne sont généralement renseignés par le navigateur qu'après
 * qu'une permission caméra a déjà été accordée au moins une fois — attendu,
 * géré côté appelant (la liste est réinterrogée après le premier flux).
 */
export async function listCameras() {
  if (injectedDevices) return injectedDevices;
  try {
    const { BrowserMultiFormatOneDReader } = await getLib();
    const devices = await BrowserMultiFormatOneDReader.listVideoInputDevices();
    return devices.map((d) => ({ deviceId: d.deviceId, label: d.label || '' }));
  } catch {
    return [];
  }
}

/**
 * "Rien dans le cadre à cet instant" (ZXing jette une exception à CHAQUE
 * frame sans code lisible — NotFoundException très largement la plus
 * fréquente, ChecksumException/FormatException pour un code partiellement
 * lu) — jamais une erreur à afficher, juste le fonctionnement normal d'une
 * lecture continue. Identifié par le nom "kind" de l'exception plutôt que
 * par `instanceof` : ce module importe `@zxing/browser` et `@zxing/library`
 * comme deux modules ESM CHARGÉS SÉPARÉMENT (deux `import()` distincts) — en
 * usage réel via esm.sh, les classes qu'ils exposent sont bien les mêmes
 * (dépendance partagée résolue une seule fois), mais s'appuyer sur une chaîne
 * de caractères stable (`Exception.getKind()`, présente sur chaque exception
 * ZXing — vérifié dans le code source de @zxing/library) est plus robuste et
 * ne dépend d'aucune hypothèse sur la façon dont les modules sont résolus.
 */
const BENIGN_SCAN_EXCEPTION_KINDS = new Set(['NotFoundException', 'ChecksumException', 'FormatException']);
function isBenignScanException(error) {
  const kind = typeof error?.getKind === 'function' ? error.getKind() : error?.name;
  return BENIGN_SCAN_EXCEPTION_KINDS.has(kind);
}

/** Table de traduction des erreurs navigateur/caméra vers un message compréhensible, sans jargon. */
function friendlyError(error) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return "Accès à la caméra refusé. Autorise la caméra dans les réglages de ton navigateur, ou saisis le code-barres à la main.";
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return "Aucune caméra détectée sur cet appareil. Saisis le code-barres à la main.";
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return "Impossible d'accéder à la caméra — elle est peut-être déjà utilisée par une autre application. Réessaie, ou saisis le code-barres à la main.";
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return "Cette caméra n'est plus disponible. Réessaie avec une autre caméra, ou saisis le code-barres à la main.";
  }
  return "Impossible de démarrer la lecture par caméra. Saisis le code-barres à la main.";
}

/**
 * Demande une mise au point AUTOMATIQUE CONTINUE quand la caméra l'annonce
 * dans ses capacités (`MediaTrackCapabilities.focusMode` incluant
 * `'continuous'`) — jamais garanti : certaines caméras, en particulier des
 * caméras avant (webcam d'ordinateur, caméra selfie de téléphone calibrée
 * pour un usage visio à bout de bras), n'ont tout simplement pas de mise au
 * point motorisée, auquel cas cet appel est un no-op silencieux (rien à
 * activer matériellement). Utile dans le cas intermédiaire : une caméra qui
 * SAIT faire du continu mais que le navigateur démarre par défaut en focus
 * fixe/single-shot tant que rien ne le demande explicitement.
 * Jamais bloquant pour la lecture : capacité absente, méthode non exposée,
 * ou `applyConstraints()` en échec ne doivent jamais empêcher le scan de
 * démarrer (repli silencieux, comme pour `listCameras()`).
 */
async function tryEnableContinuousFocus(controls) {
  try {
    if (typeof controls?.streamVideoCapabilitiesGet !== 'function') return;
    const caps = controls.streamVideoCapabilitiesGet(() => true);
    if (!caps?.focusMode?.includes?.('continuous')) return;
    await controls.streamVideoConstraintsApply({ advanced: [{ focusMode: 'continuous' }] }, () => true);
  } catch {
    // best effort — une mise au point manquante ne doit jamais bloquer la lecture
  }
}

/**
 * Démarre une lecture continue sur l'élément vidéo fourni.
 *
 * @param {object} opts
 * @param {HTMLVideoElement} opts.videoElement - élément réutilisé tel quel
 *   entre deux appels (changement de caméra) : jamais recréé par ce module.
 * @param {string} [opts.deviceId] - identifiant de caméra précis ; omis =
 *   repli automatique sur la caméra arrière (`facingMode: 'environment'`).
 * @param {(code: string) => void} opts.onDetected - appelé UNE SEULE FOIS,
 *   après arrêt complet du flux, avec le code décodé (toujours une chaîne).
 * @param {(message: string) => void} opts.onError - erreur fatale (caméra
 *   inaccessible, refusée, etc.) — jamais appelé pour un simple "rien dans
 *   le cadre à cet instant", qui fait partie du fonctionnement normal d'une
 *   lecture continue.
 * @returns {Promise<{stop: () => void, getActiveDeviceId: () => (string|null)}>}
 */
export async function startScan({ videoElement, deviceId, onDetected, onError }) {
  const { BrowserMultiFormatOneDReader, DecodeHintType, BarcodeFormat } = await getLib();

  const hints = new Map();
  const formats = RELEVANT_FORMAT_NAMES.map((name) => BarcodeFormat[name]).filter((f) => f !== undefined);
  if (formats.length) hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
  const reader = new BrowserMultiFormatOneDReader(hints);

  // Garde anti-double-traitement : une lecture continue rappelle le callback
  // à chaque frame (y compris pour "rien détecté" à cette frame) ; une
  // détection réussie ne doit être traitée qu'UNE SEULE fois, et plus aucun
  // callback ultérieur (frame en vol pendant l'arrêt) ne doit rien déclencher.
  let settled = false;
  let controls = null;

  const stop = () => {
    settled = true;
    controls?.stop();
  };

  try {
    controls = await reader.decodeFromVideoDevice(
      deviceId || undefined,
      videoElement,
      (result, error) => {
        if (settled) return;
        if (result) {
          settled = true;
          controls?.stop(); // coupe la caméra AVANT de transmettre le code — jamais de recherche OFF caméra encore active
          onDetected(result.getText());
          return;
        }
        if (error && !isBenignScanException(error)) {
          // Erreur de lecture inattendue (pas un simple "rien dans le cadre
          // à cet instant", normal à presque chaque frame) : la boucle de
          // ZXing s'arrête alors d'elle-même côté bibliothèque.
          settled = true;
          onError(friendlyError(error));
        }
      }
    );
  } catch (error) {
    onError(friendlyError(error));
    return { stop: () => {}, getActiveDeviceId: () => null };
  }

  await tryEnableContinuousFocus(controls);

  return {
    stop,
    /** Id du device réellement actif (utile quand on a démarré sans deviceId explicite — repli "environment"). */
    getActiveDeviceId: () => {
      try {
        return controls?.streamVideoSettingsGet(() => true)?.deviceId || null;
      } catch {
        return null;
      }
    },
  };
}
