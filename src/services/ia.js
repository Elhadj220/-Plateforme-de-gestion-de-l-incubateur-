/**
 * Intégration de l'IA générative (Google Gemini, API REST).
 *
 * Trois fonctions métier :
 *   1. analyserDossier   : pré-analyse d'un dossier pour aider le comité (forces, faiblesses, questions).
 *   2. genererCompteRendu: brouillon de compte rendu (suivi, PV de comité, mentorat, sortie).
 *   3. suggererJalons    : proposition de jalons à partir des objectifs du projet.
 *
 * Principes appliqués :
 *   - minimisation des données : aucun nom, e-mail ni téléphone n'est transmis au modèle ;
 *   - l'IA produit des BROUILLONS : un humain relit, corrige et valide avant tout enregistrement définitif ;
 *   - chaque appel est tracé dans la table journal_ia ;
 *   - si l'API est indisponible (pas de clé, quota, réseau), un modèle de secours déterministe
 *     produit un brouillon structuré, clairement signalé comme tel.
 */
const config = require('../config');
const db = require('../db');
const { STADES, STATUTS, STATUTS_JALON, TYPES_CR, RECOMMANDATIONS } = require('../referentiel');
const { formatDate, ajouterJours, aujourdhui } = require('../lib/dates');
const { formatMontant } = require('../lib/texte');

const SYSTEME = `Tu es l'assistant du Centre d'Innovation, d'Application et de Transfert (CIAT) de l'ISEP Amadou Trawaré de Diamniadio (Sénégal).
Tu aides l'équipe de l'incubateur à rédiger des documents professionnels en français.
Règles impératives :
- Utilise UNIQUEMENT les informations fournies dans les données. N'invente aucun chiffre, aucune date, aucun nom, aucun partenaire.
- Si une information nécessaire est absente, écris « Information non renseignée ».
- Ton sobre, factuel et bienveillant. Pas d'emojis.
- Mise en forme autorisée : titres commençant par "## ", listes commençant par "- ", texte en **gras**. Rien d'autre (pas de tableaux, pas de liens).`;

/** Appel brut à un modèle Gemini. Lève une erreur si la réponse est inexploitable. */
async function appelerModele(modele, prompt, { json = false, temperature = 0.4 } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modele)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEME }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens: 8192, ...(json ? { responseMimeType: 'application/json' } : {}) },
  };
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.gemini.timeoutMs),
    });
  } catch (err) {
    const e = new Error(err.name === 'TimeoutError' ? `${modele} : délai dépassé` : `${modele} : réseau indisponible (${err.cause?.code || err.message})`);
    e.reessayable = true;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`${modele} : erreur ${res.status} (${data?.error?.message || res.statusText})`);
    // Surcharge, quota, erreur serveur ou modèle retiré : on peut tenter le modèle suivant
    e.reessayable = [404, 429, 500, 502, 503, 504].includes(res.status);
    throw e;
  }
  const candidat = data.candidates?.[0];
  const texte = (candidat?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!texte) {
    const e = new Error(`${modele} : réponse vide (motif : ${candidat?.finishReason || data.promptFeedback?.blockReason || 'inconnu'})`);
    e.reessayable = true;
    throw e;
  }
  return texte;
}

/**
 * Essaie le modèle principal puis les modèles de remplacement (surcharge, quota, réseau).
 * Retourne { texte, modele }.
 */
async function appelerGemini(prompt, options) {
  if (!config.gemini.apiKey) throw new Error('Clé GEMINI_API_KEY absente');
  const erreurs = [];
  const debut = Date.now();
  for (const modele of config.gemini.modeles) {
    // Au-delà de 60 s cumulées, on n'essaie plus d'autre modèle : l'utilisateur attend.
    if (erreurs.length && Date.now() - debut > 60000) break;
    try {
      return { texte: await appelerModele(modele, prompt, options), modele };
    } catch (err) {
      erreurs.push(err.message);
      if (!err.reessayable) break;
    }
  }
  throw new Error(erreurs.join(' ; '));
}

/**
 * Exécute un appel IA avec repli sur le modèle de secours, et trace le tout.
 * Retourne { texte, source: 'gemini' | 'secours', erreur }.
 */
async function executer({ fonction, userId, projetId, prompt, secours, json = false }) {
  const debut = Date.now();
  try {
    const { texte, modele } = await appelerGemini(prompt, { json });
    tracer({ fonction, userId, projetId, prompt, reponse: texte, succes: 1, duree: Date.now() - debut, modele });
    return { texte, source: 'gemini', modele };
  } catch (err) {
    const texte = secours();
    tracer({ fonction, userId, projetId, prompt, reponse: texte, succes: 0, duree: Date.now() - debut, modele: 'modele-de-secours', erreur: err.message });
    return { texte, source: 'secours', erreur: err.message };
  }
}

function tracer({ fonction, userId, projetId, prompt, reponse, succes, duree, modele, erreur = null }) {
  db.run(
    `INSERT INTO journal_ia (utilisateur_id, fonction, projet_id, modele, succes, duree_ms, prompt, reponse, erreur)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    userId, fonction, projetId, modele, succes, duree, prompt, reponse, erreur,
  );
}

/* ------------------------------------------------------------------ */
/* Préparation des données (pseudonymisées)                             */
/* ------------------------------------------------------------------ */

function ficheProjet(p) {
  return [
    `Titre : ${p.titre}`,
    `Domaine : ${p.domaine}`,
    `Statut : ${STATUTS[p.statut]?.libelle || p.statut}`,
    `Stade d'avancement : ${STADES[p.stade] || 'Information non renseignée'}`,
    `Taille de l'équipe : ${p.taille_equipe ?? 'Information non renseignée'}`,
    `Cohorte : ${p.cohorte_nom || 'Information non renseignée'}`,
    `Besoin de financement : ${p.besoin_financement != null ? formatMontant(p.besoin_financement) : 'Information non renseignée'}`,
    `Financement obtenu : ${formatMontant(p.financement_obtenu || 0)}`,
    `Résumé : ${p.resume || 'Information non renseignée'}`,
    `Problème : ${p.probleme || 'Information non renseignée'}`,
    `Solution : ${p.solution || 'Information non renseignée'}`,
    `Marché cible : ${p.marche_cible || 'Information non renseignée'}`,
    `Modèle économique : ${p.modele_economique || 'Information non renseignée'}`,
  ].join('\n');
}

function donneesSuivi(projetId) {
  const objectifs = db.all('SELECT libelle, indicateur, cible, atteint FROM objectifs WHERE projet_id = ? ORDER BY id', projetId);
  const jalons = db.all('SELECT id, titre, date_echeance, statut, date_realisation FROM jalons WHERE projet_id = ? ORDER BY date_echeance', projetId);
  const commentaires = db.all(
    `SELECT c.contenu, c.cree_le, u.role FROM commentaires c JOIN utilisateurs u ON u.id = c.auteur_id
      WHERE c.projet_id = ? ORDER BY c.cree_le DESC LIMIT 10`,
    projetId,
  );
  const suivis = db.all('SELECT * FROM suivis WHERE projet_id = ? ORDER BY date_prevue', projetId);
  const evaluations = db.all('SELECT score, recommandation, commentaire FROM evaluations WHERE projet_id = ?', projetId);
  const decision = db.get('SELECT decision, motivation, score_moyen, decide_le FROM decisions WHERE projet_id = ? ORDER BY id DESC LIMIT 1', projetId);
  return { objectifs, jalons, commentaires, suivis, evaluations, decision };
}

function texteSuivi(d) {
  const today = aujourdhui();
  const lignes = [];
  lignes.push('Objectifs :');
  if (!d.objectifs.length) lignes.push('- Aucun objectif enregistré');
  d.objectifs.forEach((o) => lignes.push(`- ${o.libelle} | indicateur : ${o.indicateur || 'n.r.'} | cible : ${o.cible || 'n.r.'} | ${o.atteint ? 'atteint' : 'non atteint'}`));
  lignes.push('Jalons :');
  if (!d.jalons.length) lignes.push('- Aucun jalon enregistré');
  d.jalons.forEach((j) => {
    const retard = j.statut !== 'valide' && j.date_echeance < today ? ' | EN RETARD' : '';
    lignes.push(`- ${j.titre} | échéance ${formatDate(j.date_echeance)} | ${STATUTS_JALON[j.statut]?.libelle}${j.date_realisation ? ` | réalisé le ${formatDate(j.date_realisation)}` : ''}${retard}`);
  });
  lignes.push('Derniers commentaires (rôle de l\'auteur) :');
  if (!d.commentaires.length) lignes.push('- Aucun commentaire');
  d.commentaires.forEach((c) => lignes.push(`- [${c.role}] ${c.contenu}`));
  if (d.evaluations.length) {
    lignes.push('Évaluations du comité :');
    d.evaluations.forEach((e, i) => lignes.push(`- Évaluateur ${i + 1} : ${e.score}/100, avis ${RECOMMANDATIONS[e.recommandation]} — ${e.commentaire}`));
  }
  if (d.decision) lignes.push(`Décision : ${d.decision.decision} (score moyen ${d.decision.score_moyen ?? 'n.r.'}/100) — ${d.decision.motivation}`);
  if (d.suivis.length) {
    lignes.push('Suivis post-incubation :');
    d.suivis.forEach((s) => lignes.push(`- ${s.echeance} prévu le ${formatDate(s.date_prevue)} : ${s.date_realisee ? `réalisé, activité ${s.statut_activite}, CA ${formatMontant(s.chiffre_affaires)}, emplois créés ${s.emplois_crees}` : 'non réalisé'}`));
  }
  return lignes.join('\n');
}

/* ------------------------------------------------------------------ */
/* 1. Pré-analyse d'un dossier                                         */
/* ------------------------------------------------------------------ */

async function analyserDossier(projet, userId) {
  const prompt = `Réalise une pré-analyse du dossier de candidature ci-dessous pour aider le comité de sélection de l'incubateur.
Cette analyse est une aide : elle ne remplace pas l'évaluation humaine et ne doit PAS donner de décision ni de note.

Structure attendue :
## Synthèse
(3 phrases maximum)
## Points forts
(3 à 5 puces)
## Points de vigilance
(3 à 5 puces)
## Informations manquantes ou à préciser
(puces)
## Questions à poser au porteur lors de l'audition
(3 à 5 questions)

Données du dossier :
${ficheProjet(projet)}`;

  return executer({
    fonction: 'analyse_dossier', userId, projetId: projet.id, prompt,
    secours: () => secoursAnalyse(projet),
  });
}

function secoursAnalyse(p) {
  const manque = [];
  if (!p.marche_cible) manque.push('Marché cible');
  if (!p.modele_economique) manque.push('Modèle économique');
  if (p.besoin_financement == null) manque.push('Besoin de financement chiffré');
  if (!p.taille_equipe) manque.push("Composition de l'équipe");
  return `## Synthèse
Le projet « ${p.titre} » relève du domaine ${p.domaine} et se situe au stade ${STADES[p.stade] || 'non renseigné'}. ${p.resume ? p.resume.split('.').slice(0, 1).join('.') + '.' : ''}

## Points forts
- Problème identifié : ${p.probleme ? 'oui, décrit dans le dossier' : 'Information non renseignée'}
- Solution proposée : ${p.solution ? 'décrite dans le dossier' : 'Information non renseignée'}
- Équipe de ${p.taille_equipe ?? '?'} personne(s)

## Points de vigilance
- Vérifier la faisabilité technique au regard du stade ${STADES[p.stade] || 'non renseigné'}
- Vérifier la cohérence entre le besoin de financement (${formatMontant(p.besoin_financement)}) et le plan d'action
- Évaluer la connaissance du marché cible

## Informations manquantes ou à préciser
${manque.length ? manque.map((m) => `- ${m}`).join('\n') : '- Aucune information obligatoire manquante'}

## Questions à poser au porteur lors de l'audition
- Quels clients ou usagers avez-vous déjà rencontrés ?
- Quelles sont les trois prochaines étapes techniques de votre projet ?
- Comment comptez-vous générer vos premiers revenus ?

**Note :** brouillon produit par le modèle de secours (IA indisponible), à compléter par l'évaluateur.`;
}

/* ------------------------------------------------------------------ */
/* 2. Brouillon de compte rendu                                        */
/* ------------------------------------------------------------------ */

const CONSIGNES_CR = {
  suivi: `Rédige un RAPPORT DE SUIVI d'incubation.
Structure : ## Contexte du projet / ## État d'avancement des jalons / ## Atteinte des objectifs / ## Difficultés et retards / ## Recommandations et prochaines étapes`,
  comite: `Rédige le PROCÈS-VERBAL du comité de sélection pour ce dossier.
Structure : ## Objet / ## Présentation du dossier / ## Synthèse des évaluations / ## Décision et motivation / ## Suites à donner`,
  mentorat: `Rédige le COMPTE RENDU d'une séance de mentorat, à partir des notes de séance fournies.
Structure : ## Participants (rôles uniquement) / ## Points abordés / ## Décisions prises / ## Actions à mener (responsable et échéance si connus) / ## Prochaine séance`,
  sortie: `Rédige le RAPPORT DE SORTIE d'incubation.
Structure : ## Rappel du projet / ## Bilan des objectifs et jalons / ## Résultats obtenus / ## Points d'attention pour le suivi à 3 et 6 mois / ## Recommandations`,
};

async function genererCompteRendu(projet, typeCr, notes, userId) {
  const d = donneesSuivi(projet.id);
  const prompt = `${CONSIGNES_CR[typeCr]}
Date du document : ${formatDate(aujourdhui())}.
Désigne les personnes uniquement par leur rôle (le porteur, le mentor, le coordonnateur, le comité).
Longueur : 300 à 600 mots.

Fiche du projet :
${ficheProjet(projet)}

Données de suivi :
${texteSuivi(d)}

Notes saisies par l'utilisateur :
${notes?.trim() ? notes.trim() : 'Aucune note complémentaire.'}`;

  return executer({
    fonction: 'compte_rendu', userId, projetId: projet.id, prompt,
    secours: () => secoursCompteRendu(projet, typeCr, d, notes),
  });
}

function secoursCompteRendu(p, typeCr, d, notes) {
  const today = aujourdhui();
  const valides = d.jalons.filter((j) => j.statut === 'valide').length;
  const retards = d.jalons.filter((j) => j.statut !== 'valide' && j.date_echeance < today);
  const L = [];
  L.push(`## ${TYPES_CR[typeCr]} — ${p.titre}`);
  L.push(`Date : ${formatDate(today)}. Domaine : ${p.domaine}. Cohorte : ${p.cohorte_nom || 'Information non renseignée'}.`);
  L.push('');
  L.push('## Contexte du projet');
  L.push(p.resume || 'Information non renseignée');
  L.push('');
  L.push('## État d\'avancement');
  L.push(`- Jalons validés : **${valides} sur ${d.jalons.length}**`);
  L.push(`- Jalons en retard : **${retards.length}**`);
  retards.forEach((j) => L.push(`- En retard : ${j.titre} (échéance ${formatDate(j.date_echeance)})`));
  L.push('');
  L.push('## Objectifs');
  if (!d.objectifs.length) L.push('- Aucun objectif enregistré');
  d.objectifs.forEach((o) => L.push(`- ${o.libelle} : ${o.atteint ? 'atteint' : 'en cours'}${o.cible ? ` (cible : ${o.cible})` : ''}`));
  if (d.decision) {
    L.push('');
    L.push('## Décision du comité');
    L.push(`- Décision : **${d.decision.decision}** — score moyen ${d.decision.score_moyen ?? 'n.r.'}/100`);
    L.push(`- Motivation : ${d.decision.motivation}`);
  }
  L.push('');
  L.push('## Notes de séance');
  L.push(notes?.trim() || 'Aucune note complémentaire.');
  L.push('');
  L.push('## Recommandations et prochaines étapes');
  L.push(retards.length ? '- Traiter en priorité les jalons en retard et fixer de nouvelles échéances réalistes' : '- Poursuivre selon le calendrier prévu');
  L.push('- Mettre à jour les preuves de réalisation sur la plateforme');
  L.push('');
  L.push('**Note :** brouillon produit par le modèle de secours (IA indisponible), à relire et compléter avant validation.');
  return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* 3. Suggestion de jalons                                             */
/* ------------------------------------------------------------------ */

async function suggererJalons(projet, userId) {
  const d = donneesSuivi(projet.id);
  const debut = projet.date_debut_incubation || aujourdhui();
  const prompt = `Propose entre 4 et 6 jalons d'incubation réalistes et vérifiables pour le projet ci-dessous, sur une période de 6 mois à partir du ${debut}.
Chaque jalon doit produire un livrable vérifiable (preuve déposable sur la plateforme).
Tiens compte des objectifs et des jalons déjà existants (ne les duplique pas).

Réponds UNIQUEMENT avec un tableau JSON de la forme :
[{"titre": "…(max 80 caractères)", "description": "…preuve attendue…(max 250 caractères)", "date_echeance": "AAAA-MM-JJ"}]

Fiche du projet :
${ficheProjet(projet)}

Données de suivi :
${texteSuivi(d)}`;

  const r = await executer({
    fonction: 'suggestion_jalons', userId, projetId: projet.id, prompt, json: true,
    secours: () => JSON.stringify(secoursJalons(projet, debut)),
  });
  let jalons = analyserJalons(r.texte, debut);
  if (!jalons.length) {
    jalons = secoursJalons(projet, debut);
    r.source = 'secours';
  }
  return { jalons, source: r.source, erreur: r.erreur };
}

/** Valide et nettoie la réponse JSON du modèle (on ne fait jamais confiance au format). */
function analyserJalons(texte, debut) {
  try {
    const brut = JSON.parse(String(texte).replace(/^```(json)?|```$/g, '').trim());
    const liste = Array.isArray(brut) ? brut : brut.jalons;
    if (!Array.isArray(liste)) return [];
    return liste
      .filter((j) => j && typeof j.titre === 'string' && j.titre.trim())
      .slice(0, 8)
      .map((j, i) => ({
        titre: j.titre.trim().slice(0, 120),
        description: String(j.description || '').trim().slice(0, 500),
        date_echeance: /^\d{4}-\d{2}-\d{2}$/.test(j.date_echeance) && j.date_echeance >= debut ? j.date_echeance : ajouterJours(debut, 30 * (i + 1)),
      }));
  } catch {
    return [];
  }
}

function secoursJalons(p, debut) {
  const base = [
    ['Étude de marché terrain', 'Rapport d\'enquête auprès d\'au moins 20 clients ou usagers potentiels.'],
    ['Prototype fonctionnel', 'Démonstration vidéo et fiche technique du prototype.'],
    ['Tests utilisateurs', 'Compte rendu de tests avec au moins 5 utilisateurs et liste des améliorations.'],
    ['Modèle économique validé', 'Business model canvas et prévisionnel financier sur 3 ans.'],
    ['Formalisation juridique', 'Statuts ou attestation d\'immatriculation de la structure.'],
    ['Pitch devant partenaires', 'Support de pitch et liste des partenaires rencontrés.'],
  ];
  if (p.stade === 'prototype' || p.stade === 'pre_serie' || p.stade === 'commercialisation') {
    base[1] = ['Amélioration du prototype', 'Version améliorée du prototype intégrant les retours des premiers utilisateurs.'];
  }
  return base.map(([titre, description], i) => ({ titre, description, date_echeance: ajouterJours(debut, 30 * (i + 1)) }));
}

module.exports = { analyserDossier, genererCompteRendu, suggererJalons, analyserJalons, iaConfiguree: () => !!config.gemini.apiKey };
