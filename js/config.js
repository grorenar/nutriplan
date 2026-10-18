/**
 * Configuration Supabase.
 * ------------------------------------------------------------------
 * Renseigne ici les deux valeurs que tu trouves dans ton projet Supabase :
 *   Dashboard Supabase > Project Settings > API
 *     - "Project URL"        -> SUPABASE_URL
 *     - "anon public" key    -> SUPABASE_ANON_KEY
 *
 * Ces deux valeurs sont publiques par nature (la sécurité est assurée par
 * l'authentification + les policies RLS définies dans supabase/schema.sql).
 *
 * Tant que ces champs restent vides, l'application fonctionne à 100 %
 * en local (localStorage) : aucune connexion n'est requise.
 */
export const SUPABASE_URL = 'https://wptpchmxobcpkbhjaahi.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_Cms2VWcTSpUwMx3mefoqew_Zr5FSoDl';

/** Clé de stockage local. */
export const STORAGE_KEY = 'nutriplan.state.v1';

/**
 * Un compte Supabase = un espace de données. Thomas et Julie partagent les
 * mêmes identifiants, donc les mêmes données : rien d'autre à configurer.
 */

/**
 * Proxy CORS pour Open Food Facts (recherche d'aliments, écran Aliments).
 * ------------------------------------------------------------------
 * `search.openfoodfacts.org` ne renvoie pas d'en-tête CORS pour les requêtes
 * venant d'un site tiers (confirmé en usage réel : la requête aboutit bien
 * — 200 OK côté serveur — mais le navigateur bloque la réponse) : un site
 * statique pur (GitHub Pages, sans serveur) ne peut pas contourner ça côté
 * client, il faut un relais qui fait la requête lui-même puis ajoute
 * l'en-tête manquant. `cloudflare-worker/off-proxy.js` est ce relais —
 * minimal (aucune donnée stockée, aucune clé requise), à déployer une seule
 * fois sur le niveau gratuit de Cloudflare Workers (voir §7 du README).
 *
 * Renseigne ici l'URL obtenue après déploiement (ex.
 * "https://nutriplan-off-proxy.TON-SOUS-DOMAINE.workers.dev"). Une fois
 * renseignée, le proxy est utilisé pour les DEUX usages (fiche produit par
 * code-barres et recherche par nom/marque) — plus simple qu'un mélange
 * direct/proxié, et protège aussi contre un futur changement de politique
 * CORS côté `world.openfoodfacts.org`. Tant que ce champ reste vide,
 * l'application appelle Open Food Facts directement (fonctionne pour la
 * fiche produit par code-barres à ce jour, mais pas pour la recherche).
 */
export const OFF_PROXY_URL = 'https://nutriplan-off-proxy.thomas-boualit.workers.dev';
