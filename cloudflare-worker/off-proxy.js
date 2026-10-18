/**
 * Proxy CORS minimal entre Nutriplan et Open Food Facts.
 * ---------------------------------------------------------------------
 * Pourquoi ce fichier existe : `search.openfoodfacts.org` ne renvoie pas
 * d'en-tête `Access-Control-Allow-Origin` pour les requêtes venant d'un
 * site tiers (confirmé en usage réel sur grorenar.github.io — la requête
 * aboutit, 200 OK côté serveur, mais le navigateur bloque la réponse par
 * politique CORS). Nutriplan étant un site statique pur, sans serveur, rien
 * côté client ne peut contourner ça : il faut un relais qui fasse la
 * requête lui-même (serveur à serveur, jamais soumis au CORS du navigateur)
 * et ajoute l'en-tête manquant avant de renvoyer la réponse.
 *
 * Ce relais ne fait QUE ça — aucune donnée stockée, aucune clé API requise
 * (Open Food Facts est un service public en lecture), aucune logique
 * métier. Il ne proxie que deux routes connues et rejette tout le reste,
 * pour ne jamais servir de proxy CORS ouvert généraliste.
 *
 * Déploiement : voir le README du dépôt (§ Open Food Facts) pour les
 * instructions pas à pas (tableau de bord Cloudflare Workers, aucune
 * installation locale nécessaire). Une fois déployé, colle l'URL obtenue
 * dans `js/config.js` (OFF_PROXY_URL).
 */

// Origines autorisées à utiliser ce proxy — ajuste si le site est servi
// ailleurs qu'ici (ex. un domaine personnalisé configuré sur GitHub Pages).
const ALLOWED_ORIGINS = [
  'https://grorenar.github.io',
];

function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // développement local (python -m http.server, live-server…) : port variable,
  // donc comparaison sur l'hôte seul plutôt qu'une liste figée de ports.
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
}

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
  if (isAllowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

// Identification de l'application cliente demandée par Open Food Facts
// (impossible à positionner depuis un fetch() de navigateur — « forbidden
// header name » — mais possible ici, ce relais étant un serveur).
const UPSTREAM_USER_AGENT = 'Nutriplan - private meal planning app - https://github.com/grorenar/nutriplan';

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers });
    }
    if (!isAllowedOrigin(origin)) {
      return new Response('Origin not allowed', { status: 403, headers });
    }

    const url = new URL(request.url);
    let upstream;

    if (url.pathname.startsWith('/product/') && url.pathname.endsWith('.json')) {
      // /product/{code}.json -> fiche produit par code-barres (API v2).
      // Le code est revalidé ici (chiffres uniquement) : ce relais ne doit
      // jamais pouvoir servir à atteindre une URL arbitraire chez OFF.
      const code = url.pathname.slice('/product/'.length, -'.json'.length);
      if (!/^[0-9]+$/.test(code)) return new Response('Invalid barcode', { status: 400, headers });
      upstream = `https://world.openfoodfacts.org/api/v2/product/${code}.json?${url.searchParams.toString()}`;
    } else if (url.pathname === '/search') {
      // recherche texte (Search-a-licious).
      upstream = `https://search.openfoodfacts.org/search?${url.searchParams.toString()}`;
    } else {
      return new Response('Not found', { status: 404, headers });
    }

    let res;
    try {
      res = await fetch(upstream, { headers: { 'User-Agent': UPSTREAM_USER_AGENT } });
    } catch {
      return new Response(JSON.stringify({ error: 'Open Food Facts injoignable depuis le proxy.' }), {
        status: 502,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const body = await res.arrayBuffer();
    return new Response(body, {
      status: res.status,
      headers: { ...headers, 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
    });
  },
};
