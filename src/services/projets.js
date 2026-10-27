/**
 * Règles métier liées aux projets : droits d'accès, complétude, notation, retards.
 */
const db = require('../db');
const { DOCUMENTS_OBLIGATOIRES, CHAMPS_OBLIGATOIRES, TYPES_DOCUMENT } = require('../referentiel');
const { aujourdhui } = require('../lib/dates');

/** Charge un projet avec le nom du porteur, du mentor et de la cohorte. */
function trouverProjet(id) {
  return db.get(
    `SELECT p.*,
            u.prenom || ' ' || u.nom AS porteur_nom, u.email AS porteur_email, u.genre AS porteur_genre,
            u.telephone AS porteur_telephone, u.structure AS porteur_structure,
            m.prenom || ' ' || m.nom AS mentor_nom, m.email AS mentor_email,
            c.nom AS cohorte_nom
       FROM projets p
       JOIN utilisateurs u ON u.id = p.porteur_id
  LEFT JOIN utilisateurs m ON m.id = p.mentor_id
  LEFT JOIN cohortes c ON c.id = p.cohorte_id
      WHERE p.id = ?`,
    Number(id),
  );
}

/**
 * Droit de consultation d'un projet :
 *  - le coordonnateur voit tout ;
 *  - le porteur voit ses projets ;
 *  - le mentor voit les projets qui lui sont affectés ;
 *  - le membre du comité voit les dossiers soumis à évaluation et ceux qu'il a évalués.
 */
function peutVoir(user, projet) {
  if (!user || !projet) return false;
  switch (user.role) {
    case 'coordonnateur': return true;
    case 'porteur': return projet.porteur_id === user.id;
    case 'mentor': return projet.mentor_id === user.id;
    case 'evaluateur':
      return ['soumis', 'en_evaluation'].includes(projet.statut)
        || !!db.get('SELECT 1 AS ok FROM evaluations WHERE projet_id = ? AND evaluateur_id = ?', projet.id, user.id);
    default: return false;
  }
}

/** Le porteur ne peut modifier son dossier que tant qu'il n'est pas en cours d'examen. */
function dossierModifiable(projet) {
  return ['brouillon', 'ajourne'].includes(projet.statut);
}

/** Le suivi (objectifs, jalons) n'est possible qu'une fois le projet en incubation. */
function enIncubation(projet) {
  return projet.statut === 'en_incubation';
}

function peutPiloterSuivi(user, projet) {
  return user.role === 'coordonnateur' || (user.role === 'mentor' && projet.mentor_id === user.id);
}

/** Contrôle de complétude : champs obligatoires renseignés et pièces obligatoires déposées. */
function completude(projet) {
  const manquants = [];
  for (const [champ, libelle] of Object.entries(CHAMPS_OBLIGATOIRES)) {
    const v = projet[champ];
    if (v === null || v === undefined || String(v).trim() === '') manquants.push(libelle);
  }
  if (projet.resume && projet.resume.trim().length < 80) manquants.push('Résumé trop court (80 caractères minimum)');

  const types = new Set(db.all('SELECT DISTINCT type_doc FROM documents WHERE projet_id = ?', projet.id).map((d) => d.type_doc));
  for (const t of DOCUMENTS_OBLIGATOIRES) {
    if (!types.has(t)) manquants.push(`Pièce manquante : ${TYPES_DOCUMENT[t]}`);
  }
  const total = Object.keys(CHAMPS_OBLIGATOIRES).length + DOCUMENTS_OBLIGATOIRES.length + 1;
  const pourcentage = Math.round(((total - Math.min(manquants.length, total)) / total) * 100);
  return { complet: manquants.length === 0, manquants, pourcentage };
}

/**
 * Score d'une évaluation sur 100 : somme pondérée des notes (0 à 5) de chaque critère.
 * notes : { critere_id: note }
 */
function calculerScore(criteres, notes) {
  const poidsTotal = criteres.reduce((s, c) => s + c.poids, 0);
  if (poidsTotal === 0) return 0;
  const brut = criteres.reduce((s, c) => s + (Number(notes[c.id]) / 5) * c.poids, 0);
  return Math.round((brut / poidsTotal) * 1000) / 10;
}

/** Synthèse des évaluations d'un projet : moyenne, répartition des recommandations, détail par critère. */
function syntheseEvaluations(projetId) {
  const evaluations = db.all(
    `SELECT e.*, u.prenom || ' ' || u.nom AS evaluateur_nom
       FROM evaluations e JOIN utilisateurs u ON u.id = e.evaluateur_id
      WHERE e.projet_id = ? ORDER BY e.evalue_le`,
    projetId,
  );
  const parCritere = db.all(
    `SELECT c.id, c.libelle, c.poids, ROUND(AVG(n.note), 2) AS moyenne
       FROM criteres c
  LEFT JOIN evaluation_notes n ON n.critere_id = c.id
  LEFT JOIN evaluations e ON e.id = n.evaluation_id
      WHERE e.projet_id = ?
   GROUP BY c.id ORDER BY c.ordre`,
    projetId,
  );
  const moyenne = evaluations.length
    ? Math.round((evaluations.reduce((s, e) => s + e.score, 0) / evaluations.length) * 10) / 10
    : null;
  const recommandations = { favorable: 0, reserve: 0, defavorable: 0 };
  evaluations.forEach((e) => { recommandations[e.recommandation] += 1; });
  return { evaluations, parCritere, moyenne, recommandations };
}

/** Jalons non validés dont l'échéance est dépassée. Filtrable par projet, mentor ou porteur. */
function jalonsEnRetard({ projetId, mentorId, porteurId } = {}) {
  const where = ["j.statut <> 'valide'", 'j.date_echeance < ?', "p.statut = 'en_incubation'"];
  const params = [aujourdhui()];
  if (projetId) { where.push('p.id = ?'); params.push(projetId); }
  if (mentorId) { where.push('p.mentor_id = ?'); params.push(mentorId); }
  if (porteurId) { where.push('p.porteur_id = ?'); params.push(porteurId); }
  return db.all(
    `SELECT j.*, p.titre AS projet_titre, p.id AS projet_id,
            CAST(julianday(?) - julianday(j.date_echeance) AS INTEGER) AS jours_retard
       FROM jalons j JOIN projets p ON p.id = j.projet_id
      WHERE ${where.join(' AND ')}
   ORDER BY j.date_echeance`,
    aujourdhui(), ...params,
  );
}

/** Avancement d'un projet : part des jalons validés. */
function avancement(projetId) {
  const r = db.get(
    `SELECT COUNT(*) AS total, SUM(statut = 'valide') AS valides FROM jalons WHERE projet_id = ?`,
    projetId,
  );
  return { total: r.total, valides: r.valides || 0, pourcentage: r.total ? Math.round(((r.valides || 0) / r.total) * 100) : 0 };
}

/** Enregistre une action dans le journal d'audit. */
function journaliser(userId, action, projetId = null, details = null) {
  db.run('INSERT INTO journal_activite (utilisateur_id, action, projet_id, details) VALUES (?, ?, ?, ?)', userId, action, projetId, details);
}

module.exports = {
  trouverProjet, peutVoir, dossierModifiable, enIncubation, peutPiloterSuivi, completude,
  calculerScore, syntheseEvaluations, jalonsEnRetard, avancement, journaliser,
};
