/**
 * Utilitaires de dates. Les dates sont stockées au format ISO (AAAA-MM-JJ ou AAAA-MM-JJ HH:MM:SS, UTC).
 */

const pad = (n) => String(n).padStart(2, '0');

/** Date du jour au format AAAA-MM-JJ (heure locale du serveur). */
function aujourdhui() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Ajoute n jours (n peut être négatif) à une date ISO. */
function ajouterJours(iso, n) {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Ajoute n mois à une date ISO (le jour est ramené au dernier jour du mois si nécessaire). */
function ajouterMois(iso, n) {
  const [y, m, j] = iso.slice(0, 10).split('-').map(Number);
  const cible = new Date(Date.UTC(y, m - 1 + n, 1, 12));
  const dernierJour = new Date(Date.UTC(cible.getUTCFullYear(), cible.getUTCMonth() + 1, 0)).getUTCDate();
  cible.setUTCDate(Math.min(j, dernierJour));
  return cible.toISOString().slice(0, 10);
}

/** Vérifie qu'une chaîne est une date AAAA-MM-JJ valide. */
function estDateValide(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** 2026-03-05 -> 5 mars 2026 */
function formatDate(iso) {
  if (!iso) return '—';
  const [y, m, j] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !j) return '—';
  return `${j} ${MOIS[m - 1]} ${y}`;
}

/** 2026-03-05 14:30:00 (UTC) -> 05/03/2026 à 14:30 (heure de Dakar = UTC) */
function formatDateHeure(iso) {
  if (!iso) return '—';
  const [date, heure = ''] = iso.split(/[ T]/);
  const [y, m, j] = date.split('-');
  return `${j}/${m}/${y}${heure ? ` à ${heure.slice(0, 5)}` : ''}`;
}

module.exports = { aujourdhui, ajouterJours, ajouterMois, estDateValide, formatDate, formatDateHeure };
