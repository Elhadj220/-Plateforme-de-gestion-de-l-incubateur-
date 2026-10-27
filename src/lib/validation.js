/**
 * Validation des formulaires côté serveur.
 * Chaque règle retourne un message d'erreur ou null. valider() renvoie { valeurs, erreurs }.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const regles = {
  requis: (v) => (v === '' || v === null || v === undefined ? 'Ce champ est obligatoire.' : null),
  email: (v) => (v && !EMAIL_RE.test(v) ? 'Adresse e-mail invalide.' : null),
  min: (n) => (v) => (v && v.length < n ? `${n} caractères minimum.` : null),
  max: (n) => (v) => (v && v.length > n ? `${n} caractères maximum.` : null),
  entier: (min, max) => (v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    if (!Number.isInteger(n)) return 'Nombre entier attendu.';
    if (n < min || n > max) return `Valeur attendue entre ${min} et ${max}.`;
    return null;
  },
  parmi: (liste) => (v) => (v && !liste.includes(v) ? 'Valeur non autorisée.' : null),
  date: (v) => {
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'Date invalide (AAAA-MM-JJ).';
    const d = new Date(`${v}T12:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? 'Date invalide.' : null;
  },
  telephone: (v) => (v && !/^\+?[0-9 ]{7,20}$/.test(v) ? 'Numéro de téléphone invalide.' : null),
  motDePasse: (v) => {
    if (!v) return null;
    if (v.length < 8) return '8 caractères minimum.';
    if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) return 'Le mot de passe doit contenir au moins une lettre et un chiffre.';
    return null;
  },
};

/**
 * schema : { champ: [regle, ...] }
 * Les chaînes sont nettoyées (trim) ; les champs vides deviennent null.
 */
function valider(body, schema) {
  const valeurs = {};
  const erreurs = {};
  for (const [champ, liste] of Object.entries(schema)) {
    const brut = body?.[champ];
    const v = typeof brut === 'string' ? brut.trim() : brut;
    for (const regle of liste) {
      const msg = regle(v === undefined ? '' : v);
      if (msg) { erreurs[champ] = msg; break; }
    }
    valeurs[champ] = v === '' || v === undefined ? null : v;
  }
  return { valeurs, erreurs, ok: Object.keys(erreurs).length === 0 };
}

const entierOuNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

module.exports = { regles, valider, entierOuNull };
