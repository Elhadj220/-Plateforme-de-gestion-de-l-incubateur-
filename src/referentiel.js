/**
 * Référentiels métier : libellés affichés, listes de valeurs autorisées et règles de complétude.
 */

const ROLES = {
  porteur: 'Porteur de projet',
  mentor: 'Mentor',
  evaluateur: 'Membre du comité',
  coordonnateur: 'Coordonnateur',
};

// Domaines d'application prioritaires du CIAT (section 6 du sujet)
const DOMAINES = [
  'TIC, numérique, IA et données',
  'Mécanique, fabrication et maintenance',
  'Agriculture, transformation et environnement',
  'Énergie et énergies renouvelables',
  'Pharmaceutique et biomédical',
  'Éducation, formation et insertion',
  'Services aux collectivités et entrepreneuriat',
];

const STATUTS = {
  brouillon: { libelle: 'Brouillon', classe: 'gris' },
  soumis: { libelle: 'Soumis', classe: 'bleu' },
  en_evaluation: { libelle: 'En évaluation', classe: 'violet' },
  retenu: { libelle: 'Retenu', classe: 'vert' },
  ajourne: { libelle: 'Ajourné', classe: 'orange' },
  refuse: { libelle: 'Refusé', classe: 'rouge' },
  en_incubation: { libelle: 'En incubation', classe: 'brun' },
  termine: { libelle: 'Incubation terminée', classe: 'vert-fonce' },
};

const STADES = {
  idee: 'Idée',
  prototype: 'Prototype',
  pre_serie: 'Pré-série / pilote',
  commercialisation: 'Commercialisation',
};

const TYPES_DOCUMENT = {
  piece_identite: "Pièce d'identité du porteur",
  cv: 'CV du porteur',
  fiche_projet: 'Fiche projet',
  business_plan: 'Business plan',
  pitch: 'Support de pitch',
  autre: 'Autre document',
};

// Contrôle de complétude du dossier
const DOCUMENTS_OBLIGATOIRES = ['piece_identite', 'cv', 'fiche_projet'];
const CHAMPS_OBLIGATOIRES = {
  titre: 'Titre du projet',
  domaine: 'Domaine',
  resume: 'Résumé',
  probleme: 'Problème adressé',
  solution: 'Solution proposée',
  marche_cible: 'Marché cible',
  stade: "Stade d'avancement",
  taille_equipe: "Taille de l'équipe",
};

const STATUTS_JALON = {
  a_faire: { libelle: 'À faire', classe: 'gris' },
  en_cours: { libelle: 'En cours', classe: 'bleu' },
  soumis: { libelle: 'Soumis au mentor', classe: 'violet' },
  valide: { libelle: 'Validé', classe: 'vert' },
  a_reprendre: { libelle: 'À reprendre', classe: 'orange' },
};

const RECOMMANDATIONS = {
  favorable: 'Favorable',
  reserve: 'Réservé',
  defavorable: 'Défavorable',
};

const DECISIONS = {
  retenu: 'Retenu pour incubation',
  ajourne: 'Ajourné (à retravailler)',
  refuse: 'Refusé',
};

const TYPES_CR = {
  suivi: 'Rapport de suivi',
  comite: 'Procès-verbal du comité de sélection',
  mentorat: 'Compte rendu de séance de mentorat',
  sortie: "Rapport de sortie d'incubation",
};

const ECHEANCES_SUIVI = { '3_mois': 'Suivi à 3 mois', '6_mois': 'Suivi à 6 mois' };
const STATUTS_ACTIVITE = { active: 'Active', en_pause: 'En pause', arretee: 'Arrêtée' };

module.exports = {
  ROLES, DOMAINES, STATUTS, STADES, TYPES_DOCUMENT, DOCUMENTS_OBLIGATOIRES, CHAMPS_OBLIGATOIRES,
  STATUTS_JALON, RECOMMANDATIONS, DECISIONS, TYPES_CR, ECHEANCES_SUIVI, STATUTS_ACTIVITE,
};
