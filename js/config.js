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
export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';

/** Clé de stockage local. */
export const STORAGE_KEY = 'nutriplan.state.v1';

/**
 * Un compte Supabase = un espace de données. Thomas et Julie partagent les
 * mêmes identifiants, donc les mêmes données : rien d'autre à configurer.
 */
