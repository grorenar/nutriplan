/**
 * Tests du module de lecture de codes-barres par caméra
 * (js/core/barcode-scanner.js) — AUCUNE caméra ni bibliothèque ZXing réelle :
 * tout est simulé via les points d'injection __setTestLib()/__setTestDevices()
 * prévus à cet effet (même principe que __setTestClient() pour Supabase).
 *
 *   node tests/barcode-scanner.test.mjs
 */

import {
  isCameraSupported, listCameras, startScan, __setTestLib, __setTestDevices,
} from '../js/core/barcode-scanner.js';

let passed = 0;
const failures = [];
let currentTest = '';

function test(name, fn) {
  currentTest = name;
  try {
    fn();
    console.log(`\n✔ ${name}`);
  } catch (e) {
    console.log(`\n✘ ${name}\n   ${e.message}`);
    failures.push(`${name} — ${e.message}`);
  }
}
async function testAsync(name, fn) {
  currentTest = name;
  try {
    await fn();
    console.log(`\n✔ ${name}`);
  } catch (e) {
    console.log(`\n✘ ${name}\n   ${e.message}`);
    failures.push(`${name} — ${e.message}`);
  }
}
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`   ok   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failures.push(`${currentTest} / ${label}${detail ? ` (${detail})` : ''}`); console.log(`   FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

/* ---------------------------------------------------------------- bibliothèque ZXing simulée */

// getKind() : reproduit fidèlement l'API réelle d'Exception (@zxing/library,
// cf. barcode-scanner.js) — c'est CE signal, pas instanceof, que le module
// utilise pour reconnaître une exception "normale" de lecture.
class FakeException extends Error {
  getKind() { return this.constructor.kind; }
}
class NotFoundException extends FakeException { static kind = 'NotFoundException'; }
class ChecksumException extends FakeException { static kind = 'ChecksumException'; }
class FormatException extends FakeException { static kind = 'FormatException'; }

const BarcodeFormat = { EAN_13: 'EAN_13', EAN_8: 'EAN_8', UPC_A: 'UPC_A', UPC_E: 'UPC_E', CODE_128: 'CODE_128' };
const DecodeHintType = { POSSIBLE_FORMATS: 'POSSIBLE_FORMATS' };

/**
 * Construit un faux reader + lib, capturant tout ce qu'on a besoin
 * d'observer (hints reçus, deviceId demandé, méthode stop() appelée…).
 * `behavior(callback)` est appelé immédiatement avec le callback continu de
 * décodage — le test l'invoque lui-même pour simuler une ou plusieurs frames.
 */
function makeFakeLib({ decodeImpl, capabilities } = {}) {
  const calls = {
    constructedHints: null, decodeFromVideoDeviceArgs: null, stopCount: 0,
    capabilitiesRequested: false, appliedConstraints: null,
  };
  class FakeReader {
    constructor(hints) { calls.constructedHints = hints; }
    async decodeFromVideoDevice(deviceId, videoElement, callback) {
      calls.decodeFromVideoDeviceArgs = { deviceId, videoElement };
      if (decodeImpl) return decodeImpl(callback, calls);
      const controls = {
        stop: () => { calls.stopCount++; },
        streamVideoSettingsGet: () => ({ deviceId: 'device-active' }),
        // undefined par défaut (comme un faux objet "controls" minimal ne les
        // exposant pas) ; fourni seulement quand le test passe `capabilities`.
        ...(capabilities !== undefined ? {
          streamVideoCapabilitiesGet: () => { calls.capabilitiesRequested = true; return capabilities; },
          streamVideoConstraintsApply: async (constraints) => { calls.appliedConstraints = constraints; },
        } : {}),
      };
      calls.emit = (result, error) => callback(result, error, controls);
      return controls;
    }
  }
  const lib = {
    BrowserMultiFormatOneDReader: FakeReader,
    DecodeHintType, BarcodeFormat, NotFoundException, ChecksumException, FormatException,
  };
  return { lib, calls };
}

/* ---------------------------------------------------------------- isCameraSupported() */

test('isCameraSupported() : API absente -> false, sans jamais demander de permission', () => {
  // `navigator` est un getter non réassignable directement sur globalThis
  // (Node 22+) : on le redéfinit temporairement via defineProperty.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const setNav = (v) => Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true });
  setNav({});
  check('API absente -> false', isCameraSupported() === false);
  setNav({ mediaDevices: { getUserMedia: () => {} } });
  check('API présente, contexte sécurisé par défaut -> true', isCameraSupported() === true);
  globalThis.isSecureContext = false;
  check('contexte non sécurisé explicite -> false', isCameraSupported() === false);
  delete globalThis.isSecureContext;
  Object.defineProperty(globalThis, 'navigator', original);
});

/* ---------------------------------------------------------------- listCameras() */

await testAsync('listCameras() : renvoie la liste injectée (id + libellé), jamais d’exception', async () => {
  __setTestDevices([{ deviceId: 'a', label: 'Caméra arrière' }, { deviceId: 'b', label: '' }]);
  const list = await listCameras();
  check('deux caméras renvoyées', list.length === 2);
  check('libellé vide préservé (jamais undefined/null)', list[1].label === '');
  __setTestDevices(null);
});

await testAsync('listCameras() : une erreur de la bibliothèque -> liste vide, jamais une exception qui remonte', async () => {
  __setTestLib({
    BrowserMultiFormatOneDReader: { listVideoInputDevices: async () => { throw new Error('enumerateDevices non supporté'); } },
  });
  const list = await listCameras();
  check('liste vide en repli, aucune exception propagée', Array.isArray(list) && list.length === 0);
  __setTestLib(null);
});

/* ---------------------------------------------------------------- startScan() : détection réussie */

await testAsync('startScan() : une détection réussie arrête la caméra AVANT de transmettre le code', async () => {
  const { lib, calls } = makeFakeLib();
  __setTestLib(lib);
  const events = [];
  const onDetected = (code) => events.push(['detected', code]);
  const onError = (msg) => events.push(['error', msg]);
  const controls = await startScan({ videoElement: {}, onDetected, onError });
  // code-barres AVEC un zéro initial — jamais perdu (toujours une chaîne)
  calls.emit({ getText: () => '03017620422003' }, undefined);
  check('onDetected appelé avec le code en chaîne, zéro initial préservé', events[0]?.[0] === 'detected' && events[0]?.[1] === '03017620422003');
  check('la caméra a bien été arrêtée', calls.stopCount >= 1);
  check('ordre respecté : arrêt AVANT la transmission du code (jamais de recherche OFF caméra encore active)', calls.stopCount >= 1 && events.length === 1);
  check('aucune erreur rapportée', !events.some((e) => e[0] === 'error'));
  controls.stop();
  __setTestLib(null);
});

await testAsync('startScan() : prévention des détections répétées — un second résultat après coup est ignoré', async () => {
  const { lib, calls } = makeFakeLib();
  __setTestLib(lib);
  let detectedCount = 0;
  await startScan({ videoElement: {}, onDetected: () => { detectedCount++; }, onError: () => {} });
  calls.emit({ getText: () => '1111111111111' }, undefined);
  calls.emit({ getText: () => '2222222222222' }, undefined); // frame en vol pendant l’arrêt, même décodeur
  check('une seule détection traitée malgré deux résultats émis', detectedCount === 1);
  __setTestLib(null);
});

/* ---------------------------------------------------------------- startScan() : absence de code dans l’image */

await testAsync('startScan() : "rien dans le cadre à cet instant" (NotFoundException/ChecksumException/FormatException) n’est JAMAIS une erreur affichée', async () => {
  const { lib, calls } = makeFakeLib();
  __setTestLib(lib);
  let errorCount = 0;
  await startScan({ videoElement: {}, onDetected: () => {}, onError: () => { errorCount++; } });
  calls.emit(undefined, new NotFoundException());
  calls.emit(undefined, new ChecksumException());
  calls.emit(undefined, new FormatException());
  check('aucune des trois exceptions "normales" ne déclenche onError', errorCount === 0);
  __setTestLib(null);
});

await testAsync('startScan() : une erreur de lecture réellement inattendue déclenche onError (message sans jargon)', async () => {
  const { lib, calls } = makeFakeLib();
  __setTestLib(lib);
  const events = [];
  await startScan({ videoElement: {}, onDetected: () => events.push('detected'), onError: (msg) => events.push(msg) });
  calls.emit(undefined, new Error('erreur de décodage totalement inattendue'));
  check('onError appelé pour une erreur non reconnue (pas NotFound/Checksum/Format)', events.length === 1 && typeof events[0] === 'string');
  check('message compréhensible, pas de jargon technique brut', !events[0].includes('Error') && !events[0].includes('undefined'));
  __setTestLib(null);
});

/* ---------------------------------------------------------------- startScan() : erreurs caméra (avant toute frame) */

const cameraErrorCases = [
  ['NotAllowedError', /refusé/i],
  ['NotFoundError', /aucune caméra/i],
  ['NotReadableError', /déjà utilisée/i],
  ['OverconstrainedError', /plus disponible/i],
  ['SecurityError', /refusé/i],
];
for (const [name, expectedPattern] of cameraErrorCases) {
  await testAsync(`startScan() : erreur caméra "${name}" -> message compréhensible, repli saisie manuelle suggéré`, async () => {
    const { lib } = makeFakeLib({
      decodeImpl: async () => { const e = new Error(name); e.name = name; throw e; },
    });
    __setTestLib(lib);
    let message = null;
    const controls = await startScan({ videoElement: {}, onDetected: () => {}, onError: (msg) => { message = msg; } });
    check('message affiché', typeof message === 'string' && message.length > 0);
    check('message pertinent pour ce type d’erreur', expectedPattern.test(message));
    check('mention de la saisie manuelle comme repli', /saisis le code-barres à la main/i.test(message));
    check('aucune exception ne remonte à l’appelant (controls renvoyés malgré l’échec)', typeof controls.stop === 'function');
    __setTestLib(null);
  });
}

/* ---------------------------------------------------------------- startScan() : formats et deviceId transmis */

await testAsync('startScan() : restreint aux formats alimentaires courants (EAN-13/EAN-8/UPC-A/UPC-E/Code128)', async () => {
  const { lib, calls } = makeFakeLib();
  __setTestLib(lib);
  await startScan({ videoElement: {}, onDetected: () => {}, onError: () => {} });
  const formats = calls.constructedHints?.get(DecodeHintType.POSSIBLE_FORMATS);
  check('hints de formats transmis au lecteur', Array.isArray(formats));
  check('EAN-13 inclus', formats.includes(BarcodeFormat.EAN_13));
  check('EAN-8 inclus', formats.includes(BarcodeFormat.EAN_8));
  check('UPC-A inclus', formats.includes(BarcodeFormat.UPC_A));
  check('UPC-E inclus', formats.includes(BarcodeFormat.UPC_E));
  __setTestLib(null);
});

await testAsync('startScan() : sans deviceId -> repli automatique (caméra arrière par défaut, géré par la bibliothèque)', async () => {
  const { lib, calls } = makeFakeLib();
  __setTestLib(lib);
  await startScan({ videoElement: {}, onDetected: () => {}, onError: () => {} });
  check('aucun deviceId explicite transmis (undefined = repli environment de la bibliothèque)', calls.decodeFromVideoDeviceArgs.deviceId === undefined);
  __setTestLib(null);
});

await testAsync('startScan() : avec deviceId -> transmis tel quel (changement de caméra explicite)', async () => {
  const { lib, calls } = makeFakeLib();
  __setTestLib(lib);
  await startScan({ videoElement: {}, deviceId: 'cam-2', onDetected: () => {}, onError: () => {} });
  check('deviceId transmis sans modification', calls.decodeFromVideoDeviceArgs.deviceId === 'cam-2');
  __setTestLib(null);
});

await testAsync('startScan() : même élément vidéo réutilisé tel quel (jamais recréé par ce module)', async () => {
  const { lib, calls } = makeFakeLib();
  __setTestLib(lib);
  const videoElement = { __marker: 'original' };
  await startScan({ videoElement, onDetected: () => {}, onError: () => {} });
  check('élément vidéo transmis identique (même référence)', calls.decodeFromVideoDeviceArgs.videoElement === videoElement);
  __setTestLib(null);
});

/* ---------------------------------------------------------------- stop() / getActiveDeviceId() */

await testAsync('stop() : idempotent, ne lève jamais même appelé plusieurs fois', async () => {
  const { lib, calls } = makeFakeLib();
  __setTestLib(lib);
  const controls = await startScan({ videoElement: {}, onDetected: () => {}, onError: () => {} });
  controls.stop();
  controls.stop();
  controls.stop();
  check('plusieurs appels à stop() ne lèvent aucune exception', calls.stopCount >= 1);
  __setTestLib(null);
});

await testAsync('getActiveDeviceId() : renvoie le device réellement actif (utile avec le repli "environment")', async () => {
  const { lib } = makeFakeLib();
  __setTestLib(lib);
  const controls = await startScan({ videoElement: {}, onDetected: () => {}, onError: () => {} });
  check('deviceId actif renvoyé par la bibliothèque', controls.getActiveDeviceId() === 'device-active');
  controls.stop();
  __setTestLib(null);
});

await testAsync('getActiveDeviceId() : ne lève jamais, même si la bibliothèque ne peut pas répondre', async () => {
  const { lib } = makeFakeLib({
    decodeImpl: async (callback) => ({
      stop: () => {},
      streamVideoSettingsGet: () => { throw new Error('pas de piste active'); },
    }),
  });
  __setTestLib(lib);
  const controls = await startScan({ videoElement: {}, onDetected: () => {}, onError: () => {} });
  check('null renvoyé plutôt qu’une exception', controls.getActiveDeviceId() === null);
  __setTestLib(null);
});

/* ---------------------------------------------------------------- mise au point continue */

await testAsync('startScan() : demande la mise au point continue quand la caméra l’annonce dans ses capacités', async () => {
  const { lib, calls } = makeFakeLib({ capabilities: { focusMode: ['manual', 'continuous', 'single-shot'] } });
  __setTestLib(lib);
  const controls = await startScan({ videoElement: {}, onDetected: () => {}, onError: () => {} });
  check('les capacités de la caméra ont bien été consultées', calls.capabilitiesRequested === true);
  check('la contrainte focusMode "continuous" est appliquée', calls.appliedConstraints?.advanced?.[0]?.focusMode === 'continuous');
  controls.stop();
  __setTestLib(null);
});

await testAsync('startScan() : aucune demande de mise au point si la caméra ne l’annonce pas (ex. caméra avant sans autofocus)', async () => {
  const { lib, calls } = makeFakeLib({ capabilities: { focusMode: ['fixed'] } });
  __setTestLib(lib);
  const controls = await startScan({ videoElement: {}, onDetected: () => {}, onError: () => {} });
  check('capacités consultées mais "continuous" absent -> aucune contrainte appliquée (rien à activer matériellement)', calls.capabilitiesRequested === true && calls.appliedConstraints === null);
  controls.stop();
  __setTestLib(null);
});

await testAsync('startScan() : aucune capacité exposée (focusMode absent) -> ignoré proprement, jamais une exception', async () => {
  const { lib, calls } = makeFakeLib({ capabilities: {} });
  __setTestLib(lib);
  const controls = await startScan({ videoElement: {}, onDetected: () => {}, onError: () => {} });
  check('aucune contrainte appliquée, aucune exception', calls.appliedConstraints === null);
  controls.stop();
  __setTestLib(null);
});

await testAsync('startScan() : controls sans streamVideoCapabilitiesGet (navigateur ne l’exposant pas) -> la lecture démarre quand même normalement', async () => {
  const { lib } = makeFakeLib(); // capabilities non fourni -> les deux méthodes sont absentes du faux controls
  __setTestLib(lib);
  let detected = null;
  const controls = await startScan({ videoElement: {}, onDetected: (c) => { detected = c; }, onError: () => {} });
  check('démarrage réussi malgré l’absence de l’API capacités', typeof controls.stop === 'function');
  controls.stop();
  __setTestLib(null);
});

await testAsync('startScan() : un applyConstraints() qui échoue ne bloque jamais le démarrage de la lecture', async () => {
  const { lib, calls } = makeFakeLib({ capabilities: { focusMode: ['continuous'] } });
  // force l'échec de la demande de mise au point, sans toucher au reste du faux controls
  const realDecode = lib.BrowserMultiFormatOneDReader.prototype.decodeFromVideoDevice;
  lib.BrowserMultiFormatOneDReader.prototype.decodeFromVideoDevice = async function (...args) {
    const controls = await realDecode.apply(this, args);
    controls.streamVideoConstraintsApply = async () => { throw new Error('applyConstraints refusé par le pilote caméra'); };
    return controls;
  };
  __setTestLib(lib);
  const controls = await startScan({ videoElement: {}, onDetected: () => {}, onError: () => {} });
  check('la lecture démarre normalement malgré l’échec de la demande de mise au point', typeof controls.stop === 'function' && typeof controls.getActiveDeviceId === 'function');
  controls.stop();
  __setTestLib(null);
});

/* ---------------------------------------------------------------- bilan */

console.log(`\n${'='.repeat(60)}`);
if (failures.length) {
  console.log(`   ${passed} vérifications réussies, ${failures.length} échec(s) :`);
  failures.forEach((f) => console.log(`   ✘ ${f}`));
  process.exit(1);
} else {
  console.log(`   ${passed} vérifications réussies, 0 échec(s).`);
}
