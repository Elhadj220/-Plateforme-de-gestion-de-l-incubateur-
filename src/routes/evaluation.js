/**
 * Sélection : grille d'évaluation, pré-analyse IA, décision motivée du comité, affectation du mentor.
 */
const express = require('express');
const db = require('../db');
const s = require('../middleware/securite');
const P = require('../services/projets');
const ia = require('../services/ia');
const { chargerProjet } = require('./projets');
const { DECISIONS } = require('../referentiel');
const { aujourdhui } = require('../lib/dates');

const router = express.Router();

/* ---------- Grille d'évaluation ---------- */

router.get('/projets/:id(\\d+)/evaluation', s.exigerRole('evaluateur'), chargerProjet, (req, res) => {
  const p = req.projet;
  if (!['soumis', 'en_evaluation'].includes(p.statut)) {
    s.flash(req, 'erreur', "Ce dossier n'est plus ouvert à l'évaluation.");
    return res.redirect(`/projets/${p.id}`);
  }
  const criteres = db.all('SELECT * FROM criteres ORDER BY ordre');
  const existante = db.get('SELECT * FROM evaluations WHERE projet_id = ? AND evaluateur_id = ?', p.id, req.user.id);
  const notes = {};
  if (existante) db.all('SELECT critere_id, note FROM evaluation_notes WHERE evaluation_id = ?', existante.id).forEach((n) => { notes[n.critere_id] = n.note; });
  const documents = db.all('SELECT id, type_doc, nom_original FROM documents WHERE projet_id = ?', p.id);
  return res.render('projets/evaluation', { titre: `Évaluer : ${p.titre}`, p, criteres, existante, notes, documents, erreurs: {} });
});

router.post('/projets/:id(\\d+)/evaluation', s.exigerRole('evaluateur'), chargerProjet, (req, res) => {
  const p = req.projet;
  if (!['soumis', 'en_evaluation'].includes(p.statut)) return s.refuser(res);
  const criteres = db.all('SELECT * FROM criteres ORDER BY ordre');
  const notes = {};
  const erreurs = {};
  for (const c of criteres) {
    const v = req.body[`note_${c.id}`];
    if (!/^[0-5]$/.test(String(v ?? ''))) erreurs[`note_${c.id}`] = 'Note de 0 à 5 obligatoire.';
    else notes[c.id] = Number(v);
  }
  const commentaire = String(req.body.commentaire || '').trim();
  const recommandation = req.body.recommandation;
  if (commentaire.length < 30) erreurs.commentaire = 'Un commentaire argumenté de 30 caractères minimum est obligatoire.';
  if (commentaire.length > 3000) erreurs.commentaire = '3000 caractères maximum.';
  if (!['favorable', 'reserve', 'defavorable'].includes(recommandation)) erreurs.recommandation = 'Choisissez une recommandation.';
  if (Object.keys(erreurs).length) {
    const documents = db.all('SELECT id, type_doc, nom_original FROM documents WHERE projet_id = ?', p.id);
    return res.status(422).render('projets/evaluation', {
      titre: `Évaluer : ${p.titre}`, p, criteres, notes, documents, erreurs,
      existante: { commentaire, recommandation, id: req.body.evaluation_id },
    });
  }
  const score = P.calculerScore(criteres, notes);
  db.transaction(() => {
    const existante = db.get('SELECT id FROM evaluations WHERE projet_id = ? AND evaluateur_id = ?', p.id, req.user.id);
    let evalId;
    if (existante) {
      evalId = existante.id;
      db.run("UPDATE evaluations SET score = ?, recommandation = ?, commentaire = ?, evalue_le = datetime('now') WHERE id = ?", score, recommandation, commentaire, evalId);
      db.run('DELETE FROM evaluation_notes WHERE evaluation_id = ?', evalId);
    } else {
      evalId = db.run('INSERT INTO evaluations (projet_id, evaluateur_id, score, recommandation, commentaire) VALUES (?, ?, ?, ?, ?)',
        p.id, req.user.id, score, recommandation, commentaire).id;
    }
    criteres.forEach((c) => db.run('INSERT INTO evaluation_notes (evaluation_id, critere_id, note) VALUES (?, ?, ?)', evalId, c.id, notes[c.id]));
    if (p.statut === 'soumis') db.run("UPDATE projets SET statut = 'en_evaluation', modifie_le = datetime('now') WHERE id = ?", p.id);
  });
  P.journaliser(req.user.id, 'evaluation', p.id, `score ${score}`);
  s.flash(req, 'succes', `Évaluation enregistrée : score ${score}/100.`);
  return res.redirect(`/projets/${p.id}?onglet=evaluation`);
});

/* ---------- Pré-analyse IA ---------- */

router.post('/projets/:id(\\d+)/analyse-ia', s.exigerRole('evaluateur', 'coordonnateur'), chargerProjet, async (req, res, next) => {
  try {
    const p = req.projet;
    const r = await ia.analyserDossier(p, req.user.id);
    db.run("UPDATE projets SET analyse_ia = ?, analyse_ia_le = datetime('now') WHERE id = ?", r.texte, p.id);
    s.flash(req, r.source === 'gemini' ? 'succes' : 'info', r.source === 'gemini'
      ? "Pré-analyse générée par l'IA. Elle constitue une aide : vérifiez-la au regard du dossier."
      : `IA indisponible (${r.erreur}). Une pré-analyse de secours a été produite.`);
    return res.redirect(`/projets/${p.id}?onglet=evaluation`);
  } catch (err) { return next(err); }
});

/* ---------- Décision motivée ---------- */

router.post('/projets/:id(\\d+)/decision', s.exigerRole('coordonnateur'), chargerProjet, (req, res) => {
  const p = req.projet;
  const retour = `/projets/${p.id}?onglet=evaluation`;
  if (!['soumis', 'en_evaluation'].includes(p.statut)) {
    s.flash(req, 'erreur', 'Une décision ne peut être prise que sur un dossier en cours d\'évaluation.');
    return res.redirect(retour);
  }
  const decision = req.body.decision;
  const motivation = String(req.body.motivation || '').trim();
  const synthese = P.syntheseEvaluations(p.id);
  let erreur = null;
  if (!DECISIONS[decision]) erreur = 'Choisissez une décision.';
  else if (synthese.evaluations.length < 1) erreur = 'Au moins une évaluation du comité est nécessaire avant de décider.';
  else if (motivation.length < 30) erreur = 'La décision doit être motivée (30 caractères minimum).';
  let cohorteId = null;
  if (!erreur && decision === 'retenu') {
    cohorteId = /^\d+$/.test(req.body.cohorte_id || '') ? Number(req.body.cohorte_id) : null;
    if (!cohorteId || !db.get('SELECT id FROM cohortes WHERE id = ?', cohorteId)) erreur = 'Choisissez la cohorte d\'affectation du projet retenu.';
  }
  if (erreur) {
    s.flash(req, 'erreur', erreur);
    return res.redirect(retour);
  }
  db.transaction(() => {
    db.run('INSERT INTO decisions (projet_id, decision, motivation, score_moyen, nb_evaluations, decide_par) VALUES (?, ?, ?, ?, ?, ?)',
      p.id, decision, motivation, synthese.moyenne, synthese.evaluations.length, req.user.id);
    db.run("UPDATE projets SET statut = ?, cohorte_id = COALESCE(?, cohorte_id), date_decision = datetime('now'), modifie_le = datetime('now') WHERE id = ?",
      decision, cohorteId, p.id);
  });
  P.journaliser(req.user.id, `decision_${decision}`, p.id);
  s.flash(req, 'succes', `Décision enregistrée : ${DECISIONS[decision]}.${decision === 'retenu' ? ' Affectez maintenant un mentor pour démarrer l\'incubation.' : ''}`);
  return res.redirect(retour);
});

/* ---------- Affectation du mentor : démarre l'incubation ---------- */

router.post('/projets/:id(\\d+)/mentor', s.exigerRole('coordonnateur'), chargerProjet, (req, res) => {
  const p = req.projet;
  const mentorId = Number(req.body.mentor_id);
  const mentor = db.get("SELECT id, prenom || ' ' || nom AS nom FROM utilisateurs WHERE id = ? AND role = 'mentor' AND actif = 1", mentorId);
  if (!['retenu', 'en_incubation'].includes(p.statut) || !mentor) {
    s.flash(req, 'erreur', 'Affectation impossible : le projet doit être retenu et le mentor actif.');
    return res.redirect(`/projets/${p.id}?onglet=evaluation`);
  }
  db.run(
    `UPDATE projets SET mentor_id = ?, statut = 'en_incubation',
            date_debut_incubation = COALESCE(date_debut_incubation, ?), modifie_le = datetime('now') WHERE id = ?`,
    mentor.id, aujourdhui(), p.id,
  );
  P.journaliser(req.user.id, 'affectation_mentor', p.id, mentor.nom);
  s.flash(req, 'succes', `${mentor.nom} est désormais mentor du projet. L'incubation a démarré : définissez les objectifs et les jalons.`);
  return res.redirect(`/projets/${p.id}?onglet=suivi`);
});

module.exports = router;
