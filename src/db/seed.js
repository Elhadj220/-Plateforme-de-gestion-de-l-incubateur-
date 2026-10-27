/**
 * Chargement du jeu de données de démonstration.
 *
 * Les dates sont calculées RELATIVEMENT à la date du jour : quel que soit le jour de la démonstration,
 * on retrouve des cohortes terminées, une cohorte en cours avec des jalons en retard, des dossiers
 * en attente d'évaluation et des suivis post-incubation à réaliser.
 *
 * Utilisation : npm run seed   (réinitialise complètement la base)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('./index');
const config = require('../config');
const D = require('./donnees-demo');
const { calculerScore } = require('../services/projets');
const { aujourdhui, ajouterJours, ajouterMois } = require('../lib/dates');

/* Générateur pseudo-aléatoire déterministe (mulberry32) : le jeu de données est reproductible. */
function generateur(graine) {
  let a = graine;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const alea = generateur(2026);
const entre = (min, max) => min + Math.floor(alea() * (max - min + 1));

/** Petit fichier PDF valide servant de pièce jointe de démonstration. */
function pdfDemo(titre) {
  const texte = `(${titre.replace(/[()\\]/g, ' ').replace(/[^\x20-\x7e]/g, '?')}) Tj`;
  const contenu = `BT /F1 14 Tf 72 760 Td (Document de demonstration - Incub'ISEP) Tj 0 -24 Td ${texte} ET`;
  const objets = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${contenu.length} >>\nstream\n${contenu}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const positions = [];
  objets.forEach((o, i) => { positions.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n${positions.map((p) => `${String(p).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function fichierDemo(titre) {
  const nom = `${crypto.randomUUID()}.pdf`;
  const contenu = pdfDemo(titre);
  fs.writeFileSync(path.join(config.uploadDir, nom), contenu);
  return { fichier: nom, taille: contenu.length };
}

/** Réinitialise la base : suppression des tables puis recréation. */
function reinitialiser() {
  const tables = ['journal_activite', 'journal_ia', 'comptes_rendus', 'suivis', 'commentaires', 'preuves', 'jalons', 'objectifs',
    'decisions', 'evaluation_notes', 'evaluations', 'criteres', 'documents', 'projets', 'cohortes', 'utilisateurs'];
  db.db.exec('PRAGMA foreign_keys = OFF;');
  tables.forEach((t) => db.db.exec(`DROP TABLE IF EXISTS ${t};`));
  db.db.exec('PRAGMA foreign_keys = ON;');
  db.initSchema();
  fs.mkdirSync(config.uploadDir, { recursive: true });
  for (const f of fs.readdirSync(config.uploadDir)) {
    if (/^[0-9a-f-]{36}\.[a-z]{3,4}$/.test(f)) fs.unlinkSync(path.join(config.uploadDir, f));
  }
}

const COMMENTAIRES_EVAL = {
  favorable: [
    'Projet pertinent qui répond à un besoin clairement identifié. Équipe motivée et prototype crédible.',
    'Bonne connaissance du marché cible et modèle économique réaliste. Je recommande l\'incubation.',
    'Solution innovante, adaptée au contexte local, avec un potentiel d\'impact important.',
  ],
  reserve: [
    'Idée intéressante mais le modèle économique doit être approfondi avant l\'incubation.',
    'Le besoin est réel, mais la faisabilité technique reste à démontrer par un prototype.',
    'Équipe encore incomplète : il faudrait renforcer les compétences commerciales.',
  ],
  defavorable: [
    'Le marché visé est mal défini et la concurrence n\'a pas été analysée.',
    'Projet trop éloigné des domaines et des moyens du CIAT à ce stade.',
    'Le dossier manque de précision sur la solution et sur le besoin de financement.',
  ],
};

const MOTIVATIONS = {
  retenu: 'Dossier retenu à l\'unanimité du comité : besoin avéré, solution adaptée au contexte local et équipe engagée. Points à travailler pendant l\'incubation : modèle économique et premiers clients.',
  refuse: 'Dossier non retenu : le marché cible et la faisabilité technique ne sont pas suffisamment démontrés. Le porteur est encouragé à participer aux ateliers d\'idéation du CIAT avant une nouvelle candidature.',
  ajourne: 'Dossier ajourné : le projet présente un intérêt mais doit préciser son modèle économique et fournir une première validation terrain. Une nouvelle soumission est possible lors du prochain appel.',
};

const JALONS_TYPES = [
  ['Validation du besoin terrain', 'Rapport d\'enquête auprès d\'au moins 20 clients ou usagers potentiels.'],
  ['Prototype fonctionnel', 'Démonstration du prototype et fiche technique.'],
  ['Tests utilisateurs', 'Compte rendu de tests avec au moins 5 utilisateurs et liste des améliorations retenues.'],
  ['Modèle économique et prévisionnel', 'Business model canvas et prévisionnel financier sur 3 ans.'],
  ['Formalisation juridique', 'Statuts ou attestation d\'immatriculation de l\'entreprise.'],
  ['Pitch de fin d\'incubation', 'Support de pitch présenté devant le comité et les partenaires.'],
];

const OBJECTIFS_TYPES = [
  ['Valider la solution auprès des utilisateurs', 'Nombre d\'utilisateurs testeurs', '20 utilisateurs'],
  ['Réaliser les premières ventes', 'Chiffre d\'affaires cumulé', '1 000 000 FCFA'],
  ['Formaliser l\'entreprise', 'Immatriculation (NINEA / RCCM)', 'Obtenue'],
];

// Scénario de chaque projet (index dans D.PROJETS)
const SCENARIOS = {
  c1_termine: [5, 9, 12, 19], c1_refuse: [32, 14, 26],
  c2_termine: [2, 7, 17, 34], c2_refuse: [20, 37, 13], c2_ajourne: [15, 23],
  c3_incubation: [0, 3, 6, 10, 16, 21], c3_refuse: [36, 24], c3_ajourne: [30, 35],
  retenu: [29], en_evaluation: [11, 25, 27, 18], soumis: [31, 33, 28, 22], brouillon: [1, 4, 8],
};

// Statuts des 6 jalons pour les projets de la cohorte en cours (les 4 premiers sont échus)
const PROFILS_JALONS = {
  0: ['valide', 'valide', 'valide', 'en_cours', 'en_cours', 'a_faire'],
  3: ['valide', 'valide', 'soumis', 'en_cours', 'a_faire', 'a_faire'],
  6: ['valide', 'valide', 'valide', 'valide', 'en_cours', 'a_faire'],
  10: ['valide', 'valide', 'a_reprendre', 'a_faire', 'a_faire', 'a_faire'],
  16: ['valide', 'valide', 'valide', 'soumis', 'en_cours', 'a_faire'],
  21: ['valide', 'valide', 'valide', 'valide', 'soumis', 'a_faire'],
};

function seed() {
  const T = aujourdhui();
  const dt = (iso, h = 10) => `${iso} ${String(h).padStart(2, '0')}:${String(entre(0, 59)).padStart(2, '0')}:00`;

  reinitialiser();
  const hash = bcrypt.hashSync(D.MOT_DE_PASSE_DEMO, 10);

  db.transaction(() => {
    /* Grille d'évaluation */
    D.CRITERES.forEach(([code, libelle, description, poids], i) => db.run(
      'INSERT INTO criteres (code, libelle, description, poids, ordre) VALUES (?, ?, ?, ?, ?)', code, libelle, description, poids, i + 1,
    ));
    const criteres = db.all('SELECT * FROM criteres ORDER BY ordre');

    /* Comptes du personnel */
    const creerUtilisateur = (u, role, creeLe) => db.run(
      `INSERT INTO utilisateurs (prenom, nom, email, mot_de_passe, role, genre, telephone, structure, expertise, cree_le)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      u.prenom, u.nom, u.email, hash, role, u.genre, u.telephone || null, u.structure || null, u.expertise || null, creeLe,
    ).id;
    const debutPlateforme = dt(ajouterMois(T, -24));
    const coordo = creerUtilisateur(D.COORDONNATEUR, 'coordonnateur', debutPlateforme);
    const mentors = D.MENTORS.map((m) => creerUtilisateur(m, 'mentor', debutPlateforme));
    const evaluateurs = D.EVALUATEURS.map((e) => creerUtilisateur(e, 'evaluateur', debutPlateforme));
    // Mentor selon le domaine : TIC -> Sarr, Agriculture -> Faye, Énergie et mécanique -> Gueye, autres -> Diallo
    const mentorPour = (domaine) => ({ 0: mentors[0], 1: mentors[2], 2: mentors[1], 3: mentors[2] }[domaine] ?? mentors[3]);

    /* Cohortes (noms calculés : année + semestre de début) */
    const nomCohorte = (iso) => `${iso.slice(0, 4)}-${Number(iso.slice(5, 7)) <= 6 ? 'A' : 'B'}`;
    const cohortes = [[-21, -15], [-14, -8], [-5, 1], [1, 7]].map(([d, f]) => {
      const debut = ajouterMois(T, d);
      const fin = ajouterMois(T, f);
      return { id: db.run('INSERT INTO cohortes (nom, date_debut, date_fin) VALUES (?, ?, ?)', `Cohorte ${nomCohorte(debut)}`, debut, fin).id, debut, fin };
    });

    /* Création d'un projet selon son scénario */
    const creerProjet = (idx, scenario) => {
      const [titre, dom, stade, equipe, besoin, resume, probleme, solution, marche, modele] = D.PROJETS[idx];
      const [prenom, nom, genre, structure] = D.PORTEURS[idx];
      const email = idx === 0 ? 'porteur@demo.sn' : idx === 1 ? 'porteur2@demo.sn'
        : `${prenom}.${nom}`.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z.]/g, '').toLowerCase() + '@demo.sn';
      const tel = `+221 7${entre(0, 8)} ${entre(100, 999)} ${String(entre(0, 99)).padStart(2, '0')} ${String(entre(0, 99)).padStart(2, '0')}`;

      // Dates de référence selon le scénario
      const vague = scenario.startsWith('c1') ? 0 : scenario.startsWith('c2') ? 1 : scenario.startsWith('c3') ? 2 : null;
      const soumission = vague !== null ? ajouterJours(cohortes[vague].debut, -entre(40, 60))
        : scenario === 'retenu' ? ajouterJours(T, -entre(35, 45))
          : scenario === 'en_evaluation' ? ajouterJours(T, -entre(15, 30))
            : scenario === 'soumis' ? ajouterJours(T, -entre(2, 12)) : null;
      const creation = soumission ? ajouterJours(soumission, -entre(5, 20)) : ajouterJours(T, -entre(1, 10));
      const porteurId = db.run(
        `INSERT INTO utilisateurs (prenom, nom, email, mot_de_passe, role, genre, telephone, structure, cree_le)
         VALUES (?, ?, ?, ?, 'porteur', ?, ?, ?, ?)`,
        prenom, nom, email, hash, genre, tel, structure, dt(ajouterJours(creation, -2)),
      ).id;

      const statut = {
        c1_termine: 'termine', c2_termine: 'termine', c3_incubation: 'en_incubation', retenu: 'retenu',
        en_evaluation: 'en_evaluation', soumis: 'soumis', brouillon: 'brouillon',
      }[scenario] || (scenario.endsWith('refuse') ? 'refuse' : 'ajourne');
      const decide = ['termine', 'en_incubation', 'retenu', 'refuse', 'ajourne'].includes(statut);
      const decision = scenario === 'retenu' || ['termine', 'en_incubation'].includes(statut) ? 'retenu' : statut;
      const dateDecision = decide ? (vague !== null ? ajouterJours(cohortes[vague].debut, -entre(8, 15)) : ajouterJours(T, -entre(5, 10))) : null;
      const cohorte = statut === 'retenu' ? cohortes[3] : ['termine', 'en_incubation'].includes(statut) ? cohortes[vague] : null;
      const mentor = ['termine', 'en_incubation'].includes(statut) ? mentorPour(dom) : null;
      const financement = statut === 'termine' ? Math.round((besoin * entre(30, 100)) / 100 / 50000) * 50000
        : statut === 'en_incubation' ? Math.round((besoin * entre(0, 40)) / 100 / 50000) * 50000 : 0;
      // Le brouillon de démonstration n°1 est volontairement incomplet (champs et pièces manquants)
      const incomplet = idx === 1;

      const projetId = db.run(
        `INSERT INTO projets (porteur_id, titre, domaine, resume, probleme, solution, marche_cible, modele_economique, taille_equipe, stade,
                              besoin_financement, financement_obtenu, statut, cohorte_id, mentor_id, date_soumission, date_decision,
                              date_debut_incubation, date_sortie, cree_le, modifie_le)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        porteurId, titre, require('../referentiel').DOMAINES[dom], resume, incomplet ? null : probleme, incomplet ? null : solution,
        incomplet ? null : marche, incomplet ? null : modele, equipe, stade, besoin, financement, statut, cohorte?.id ?? null, mentor,
        soumission ? dt(soumission) : null, dateDecision ? dt(dateDecision, 16) : null,
        mentor ? cohorte.debut : null, statut === 'termine' ? cohorte.fin : null, dt(creation), dt(soumission || creation),
      ).id;

      /* Pièces du dossier */
      const types = statut === 'brouillon'
        ? (idx === 8 ? ['piece_identite', 'cv', 'fiche_projet'] : idx === 4 ? ['piece_identite', 'cv'] : [])
        : ['piece_identite', 'cv', 'fiche_projet', ...(alea() < 0.5 ? ['business_plan'] : [])];
      const noms = { piece_identite: 'piece-identite.pdf', cv: 'cv-porteur.pdf', fiche_projet: 'fiche-projet.pdf', business_plan: 'business-plan.pdf' };
      types.forEach((t) => {
        const f = fichierDemo(`${titre} - ${noms[t]}`);
        db.run('INSERT INTO documents (projet_id, type_doc, nom_original, fichier, mime, taille, depose_par, depose_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          projetId, t, noms[t], f.fichier, 'application/pdf', f.taille, porteurId, dt(ajouterJours(soumission || T, -1)));
      });

      /* Évaluations du comité */
      const evaluer = (evaluateurId, niveau, jour) => {
        const notes = {};
        criteres.forEach((c) => { notes[c.id] = Math.max(0, Math.min(5, niveau + entre(-1, 1))); });
        const score = calculerScore(criteres, notes);
        const reco = score >= 65 ? 'favorable' : score >= 45 ? 'reserve' : 'defavorable';
        const evalId = db.run('INSERT INTO evaluations (projet_id, evaluateur_id, score, recommandation, commentaire, evalue_le) VALUES (?, ?, ?, ?, ?, ?)',
          projetId, evaluateurId, score, reco, COMMENTAIRES_EVAL[reco][entre(0, 2)], dt(jour, 14)).id;
        criteres.forEach((c) => db.run('INSERT INTO evaluation_notes (evaluation_id, critere_id, note) VALUES (?, ?, ?)', evalId, c.id, notes[c.id]));
        return score;
      };
      if (decide) {
        const niveau = decision === 'retenu' ? 4 : decision === 'ajourne' ? 3 : 2;
        const scores = evaluateurs.map((e) => evaluer(e, niveau, ajouterJours(dateDecision, -entre(2, 6))));
        const moyenne = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
        db.run('INSERT INTO decisions (projet_id, decision, motivation, score_moyen, nb_evaluations, decide_par, decide_le) VALUES (?, ?, ?, ?, ?, ?, ?)',
          projetId, decision, MOTIVATIONS[decision], moyenne, scores.length, coordo, dt(dateDecision, 16));
      } else if (statut === 'en_evaluation') {
        // Le membre du comité de démonstration (comite@demo.sn) n'a pas encore évalué ces dossiers
        const nb = entre(1, 2);
        evaluateurs.slice(1, 1 + nb).forEach((e) => evaluer(e, entre(2, 4), ajouterJours(soumission, entre(3, 10))));
      }

      /* Incubation : objectifs, jalons, preuves, commentaires */
      if (mentor) {
        const debut = cohorte.debut;
        const profil = statut === 'termine' ? Array(6).fill('valide') : PROFILS_JALONS[idx];
        profil.forEach((st, k) => {
          let echeance = ajouterMois(debut, k + 1);
          if (statut === 'en_incubation' && k === 4) echeance = ajouterJours(T, 4); // jalon bientôt dû
          if (statut === 'en_incubation' && k === 5) echeance = ajouterMois(T, 1);
          const [jt, jd] = k === 1 && ['pre_serie', 'commercialisation'].includes(stade) ? ['Amélioration du prototype', 'Version améliorée intégrant les retours des premiers utilisateurs.'] : JALONS_TYPES[k];
          const realisation = st === 'valide' ? ajouterJours(echeance, -entre(0, 12)) : null;
          const jalonId = db.run('INSERT INTO jalons (projet_id, titre, description, date_echeance, statut, date_realisation, cree_par, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            projetId, jt, jd, echeance, st, realisation, mentor, dt(debut, 9)).id;
          if (['valide', 'soumis', 'a_reprendre'].includes(st)) {
            const f = fichierDemo(`${titre} - preuve - ${jt}`);
            db.run('INSERT INTO preuves (jalon_id, nom_original, fichier, mime, taille, commentaire, depose_par, depose_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              jalonId, `preuve-${k + 1}.pdf`, f.fichier, 'application/pdf', f.taille, 'Livrable du jalon', porteurId, dt(realisation || ajouterJours(echeance, 3), 11));
          }
          if (st === 'a_reprendre') {
            db.run('INSERT INTO commentaires (projet_id, jalon_id, auteur_id, contenu, cree_le) VALUES (?, ?, ?, ?, ?)', projetId, jalonId, mentor,
              'À reprendre : le compte rendu de tests ne précise pas le nombre d\'utilisateurs ni les améliorations retenues.', dt(ajouterJours(echeance, 6), 15));
          }
        });
        const valides = profil.filter((s) => s === 'valide').length;
        OBJECTIFS_TYPES.forEach(([libelle, indicateur, cible], k) => db.run(
          'INSERT INTO objectifs (projet_id, libelle, indicateur, cible, atteint, cree_par, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?)',
          projetId, libelle, indicateur, cible, statut === 'termine' ? Number(k < 2 || alea() < 0.7) : Number(k === 0 && valides >= 3), mentor, dt(debut, 9),
        ));
        const fil = [
          [mentor, 'Bienvenue dans le programme d\'incubation. Première séance de mentorat fixée la semaine prochaine pour cadrer les objectifs.', 5],
          [porteurId, 'Merci. Nous avons commencé les entretiens avec les utilisateurs, le rapport sera déposé avant l\'échéance.', 12],
        ];
        if (statut === 'en_incubation' && profil.slice(0, 4).some((s) => s !== 'valide')) {
          fil.push([mentor, 'Attention : certains jalons ont dépassé leur échéance. Merci de déposer les preuves ou de proposer un nouveau calendrier.', 140]);
        }
        fil.forEach(([auteur, contenu, j]) => db.run('INSERT INTO commentaires (projet_id, auteur_id, contenu, cree_le) VALUES (?, ?, ?, ?)',
          projetId, auteur, contenu, dt(ajouterJours(debut, j), 17)));

        /* Suivi post-incubation */
        if (statut === 'termine') {
          [['3_mois', 3], ['6_mois', 6]].forEach(([ech, m]) => {
            const prevue = ajouterMois(cohorte.fin, m);
            // Cohorte 2 : deux suivis à 6 mois non encore réalisés (alerte de retard)
            const nonRealise = prevue >= T || (vague === 1 && ech === '6_mois' && [17, 34].includes(idx));
            const actif = alea() < 0.85;
            db.run(`INSERT INTO suivis (projet_id, echeance, date_prevue, date_realisee, statut_activite, chiffre_affaires, emplois_crees, observations, renseigne_par)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            projetId, ech, prevue, nonRealise ? null : ajouterJours(prevue, entre(0, 10)),
            nonRealise ? null : actif ? 'active' : 'en_pause',
            nonRealise ? null : actif ? entre(5, 60) * 100000 : 0,
            nonRealise ? null : actif ? entre(1, 6) : 0,
            nonRealise ? null : actif ? 'Activité poursuivie, clientèle en croissance.' : 'Activité suspendue faute de fonds de roulement.',
            nonRealise ? null : coordo);
          });
        }
      }
      return { projetId, porteurId, mentor };
    };

    const crees = {};
    for (const [scenario, liste] of Object.entries(SCENARIOS)) {
      liste.forEach((idx) => { crees[idx] = creerProjet(idx, scenario); });
    }

    /* Comptes rendus de démonstration (rédigés manuellement et validés) */
    const p0 = crees[0];
    db.run(`INSERT INTO comptes_rendus (projet_id, type_cr, titre, contenu, genere_par_ia, statut, auteur_id, valide_par, cree_le)
            VALUES (?, 'mentorat', ?, ?, 0, 'valide', ?, ?, ?)`,
    p0.projetId, 'Compte rendu de mentorat - AgriMeteo SMS - séance 3',
    `## Participants
- Le porteur de projet et le mentor

## Points abordés
- Résultats des tests du service vocal en wolof auprès de 12 producteurs de Bayakh
- Coût d'envoi des SMS et négociation avec un agrégateur
- Préparation du modèle économique

## Décisions prises
- Prioriser le message vocal, mieux compris que le SMS par les producteurs
- Proposer une offre groupée aux coopératives

## Actions à mener
- Le porteur finalise le prévisionnel financier sur 3 ans
- Le mentor met le porteur en relation avec un agrégateur SMS

## Prochaine séance
Dans trois semaines, au CIAT.`,
    p0.mentor, p0.mentor, dt(ajouterJours(T, -20), 15));

    const p2 = crees[2];
    db.run(`INSERT INTO comptes_rendus (projet_id, type_cr, titre, contenu, genere_par_ia, statut, auteur_id, valide_par, cree_le)
            VALUES (?, 'sortie', ?, ?, 0, 'valide', ?, ?, ?)`,
    p2.projetId, "Rapport de sortie d'incubation - Séchoir solaire coopératif pour mangues",
    `## Rappel du projet
Séchoir solaire de grande capacité permettant à une coopérative de femmes de transformer les mangues invendues.

## Bilan des objectifs et jalons
- Les six jalons ont été validés
- Prototype amélioré installé à Bayakh

## Résultats obtenus
- Première campagne de séchage réalisée
- Contrat avec deux épiceries de Dakar

## Points d'attention pour le suivi à 3 et 6 mois
- Disponibilité des emballages
- Respect des procédures d'hygiène

## Recommandations
- Rechercher une certification sanitaire pour l'export`,
    coordo, coordo, dt(cohortes[1].fin, 12));

    /* Journal d'activité initial */
    db.run("INSERT INTO journal_activite (utilisateur_id, action, details, cree_le) VALUES (?, 'chargement_donnees_demo', 'Jeu de données de démonstration chargé', datetime('now'))", coordo);
  });

  const n = db.get('SELECT (SELECT COUNT(*) FROM utilisateurs) AS u, (SELECT COUNT(*) FROM projets) AS p, (SELECT COUNT(*) FROM jalons) AS j FROM utilisateurs LIMIT 1');
  console.log(`Données de démonstration chargées : ${n.u} utilisateurs, ${n.p} projets, ${n.j} jalons.`);
}

if (require.main === module) {
  seed();
}

module.exports = { seed };
