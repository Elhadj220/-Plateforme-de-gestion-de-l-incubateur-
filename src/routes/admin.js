/**
 * Administration (coordonnateur) : comptes utilisateurs, cohortes, grille d'évaluation, journaux.
 */
const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const s = require('../middleware/securite');
const { regles: r, valider } = require('../lib/validation');
const { ROLES } = require('../referentiel');

const router = express.Router();
router.use('/admin', s.exigerRole('coordonnateur'));

/** Mot de passe provisoire lisible : 10 caractères avec lettres et chiffres. */
function motDePasseProvisoire() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const chiffres = '23456789';
  let mdp = '';
  for (let i = 0; i < 7; i += 1) mdp += alphabet[crypto.randomInt(alphabet.length)];
  for (let i = 0; i < 3; i += 1) mdp += chiffres[crypto.randomInt(chiffres.length)];
  return mdp;
}

/* ---------- Utilisateurs ---------- */

router.get('/admin/utilisateurs', (req, res) => {
  const role = ROLES[req.query.role] ? req.query.role : '';
  const utilisateurs = db.all(
    `SELECT u.*, (SELECT COUNT(*) FROM projets p WHERE p.porteur_id = u.id) AS nb_projets,
            (SELECT COUNT(*) FROM projets p WHERE p.mentor_id = u.id AND p.statut = 'en_incubation') AS nb_mentores
       FROM utilisateurs u ${role ? 'WHERE u.role = ?' : ''} ORDER BY u.role, u.nom`,
    ...(role ? [role] : []),
  );
  res.render('admin/utilisateurs', { titre: 'Utilisateurs', utilisateurs, role, v: {}, erreurs: {} });
});

router.post('/admin/utilisateurs', async (req, res) => {
  const { valeurs: v, erreurs } = valider(req.body, {
    prenom: [r.requis, r.max(60)], nom: [r.requis, r.max(60)], email: [r.requis, r.email, r.max(120)],
    role: [r.requis, r.parmi(Object.keys(ROLES))], genre: [r.parmi(['F', 'M'])], expertise: [r.max(200)], structure: [r.max(120)],
  });
  if (!erreurs.email && db.get('SELECT 1 AS x FROM utilisateurs WHERE email = ?', v.email)) erreurs.email = 'Adresse déjà utilisée.';
  if (Object.keys(erreurs).length) {
    const utilisateurs = db.all('SELECT u.*, 0 AS nb_projets, 0 AS nb_mentores FROM utilisateurs u ORDER BY u.role, u.nom');
    return res.status(422).render('admin/utilisateurs', { titre: 'Utilisateurs', utilisateurs, role: '', v, erreurs });
  }
  const mdp = motDePasseProvisoire();
  db.run('INSERT INTO utilisateurs (prenom, nom, email, mot_de_passe, role, genre, expertise, structure) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    v.prenom, v.nom, v.email.toLowerCase(), await bcrypt.hash(mdp, 10), v.role, v.genre, v.expertise, v.structure);
  s.flash(req, 'succes', `Compte créé pour ${v.prenom} ${v.nom}. Mot de passe provisoire à transmettre de façon sécurisée : ${mdp}`);
  return res.redirect('/admin/utilisateurs');
});

router.post('/admin/utilisateurs/:uid(\\d+)/activer', (req, res) => {
  const id = Number(req.params.uid);
  if (id === req.user.id) {
    s.flash(req, 'erreur', 'Vous ne pouvez pas désactiver votre propre compte.');
  } else {
    db.run('UPDATE utilisateurs SET actif = 1 - actif WHERE id = ?', id);
    s.flash(req, 'succes', 'Statut du compte modifié.');
  }
  res.redirect('/admin/utilisateurs');
});

router.post('/admin/utilisateurs/:uid(\\d+)/reinitialiser', async (req, res) => {
  const u = db.get('SELECT id, prenom, nom FROM utilisateurs WHERE id = ?', Number(req.params.uid));
  if (u) {
    const mdp = motDePasseProvisoire();
    db.run('UPDATE utilisateurs SET mot_de_passe = ? WHERE id = ?', await bcrypt.hash(mdp, 10), u.id);
    s.flash(req, 'succes', `Nouveau mot de passe provisoire de ${u.prenom} ${u.nom} : ${mdp}`);
  }
  res.redirect('/admin/utilisateurs');
});

/* ---------- Cohortes ---------- */

router.get('/admin/cohortes', (req, res) => {
  const cohortes = db.all(
    `SELECT c.*, COUNT(p.id) AS nb_projets FROM cohortes c LEFT JOIN projets p ON p.cohorte_id = c.id GROUP BY c.id ORDER BY c.date_debut DESC`,
  );
  res.render('admin/cohortes', { titre: 'Cohortes', cohortes });
});

router.post('/admin/cohortes', (req, res) => {
  const { valeurs: v, ok, erreurs } = valider(req.body, { nom: [r.requis, r.max(40)], date_debut: [r.requis, r.date], date_fin: [r.requis, r.date] });
  if (!ok) s.flash(req, 'erreur', `Cohorte non créée : ${Object.values(erreurs)[0]}`);
  else if (v.date_fin <= v.date_debut) s.flash(req, 'erreur', 'La date de fin doit être postérieure à la date de début.');
  else if (db.get('SELECT 1 AS x FROM cohortes WHERE nom = ?', v.nom)) s.flash(req, 'erreur', 'Une cohorte porte déjà ce nom.');
  else {
    db.run('INSERT INTO cohortes (nom, date_debut, date_fin) VALUES (?, ?, ?)', v.nom, v.date_debut, v.date_fin);
    s.flash(req, 'succes', `Cohorte ${v.nom} créée.`);
  }
  res.redirect('/admin/cohortes');
});

/* ---------- Grille d'évaluation ---------- */

router.get('/admin/grille', (req, res) => {
  res.render('admin/grille', { titre: "Grille d'évaluation", criteres: db.all('SELECT * FROM criteres ORDER BY ordre') });
});

router.post('/admin/grille', (req, res) => {
  const criteres = db.all('SELECT * FROM criteres ORDER BY ordre');
  const poids = criteres.map((c) => Number(req.body[`poids_${c.id}`]));
  if (poids.some((p) => !Number.isInteger(p) || p < 1 || p > 100)) {
    s.flash(req, 'erreur', 'Chaque poids doit être un entier entre 1 et 100.');
  } else if (poids.reduce((a, b) => a + b, 0) !== 100) {
    s.flash(req, 'erreur', `La somme des poids doit être égale à 100 (actuellement ${poids.reduce((a, b) => a + b, 0)}).`);
  } else {
    db.transaction(() => criteres.forEach((c, i) => db.run('UPDATE criteres SET poids = ? WHERE id = ?', poids[i], c.id)));
    s.flash(req, 'succes', 'Pondération mise à jour. Elle s\'applique aux prochaines évaluations.');
  }
  res.redirect('/admin/grille');
});

/* ---------- Journaux ---------- */

router.get('/admin/journal-ia', (req, res) => {
  const appels = db.all(
    `SELECT j.*, u.prenom || ' ' || u.nom AS utilisateur, p.titre AS projet_titre
       FROM journal_ia j LEFT JOIN utilisateurs u ON u.id = j.utilisateur_id LEFT JOIN projets p ON p.id = j.projet_id
   ORDER BY j.id DESC LIMIT 200`,
  );
  const stats = db.get('SELECT COUNT(*) AS total, SUM(succes) AS succes, ROUND(AVG(CASE WHEN succes = 1 THEN duree_ms END)) AS duree FROM journal_ia');
  res.render('admin/journal-ia', { titre: "Journal de l'IA", appels, stats });
});

router.get('/admin/journal', (req, res) => {
  const actions = db.all(
    `SELECT j.*, u.prenom || ' ' || u.nom AS utilisateur, p.titre AS projet_titre
       FROM journal_activite j LEFT JOIN utilisateurs u ON u.id = j.utilisateur_id LEFT JOIN projets p ON p.id = j.projet_id
   ORDER BY j.id DESC LIMIT 300`,
  );
  res.render('admin/journal', { titre: "Journal d'activité", actions });
});

module.exports = router;
