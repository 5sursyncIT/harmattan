#!/usr/bin/env node
/**
 * Propositions d'années de parution pour les livres du catalogue dont
 * l'extrafield `publication_year` est vide.
 *
 * Contexte : le tri « Plus récents » du catalogue s'appuie sur publication_year.
 * Les livres sans année sont relégués en fin de liste — d'où l'intérêt de
 * combler les trous. Environ 40 % du fonds seulement est renseigné.
 *
 * Le script N'ÉCRIT RIEN par défaut : il produit deux CSV à relire.
 *   1. …-propositions-<date>.csv : un millésime trouvé dans le texte, avec
 *      l'extrait qui l'a déclenché et un niveau de confiance.
 *   2. …-sans-indice-<date>.csv  : aucun indice exploitable, l'ISBN est fourni
 *      pour une recherche manuelle.
 *
 * Niveaux de confiance :
 *   haute   « Date de publication : 1996 » — champ explicite, fiable.
 *   moyenne dépôt légal, ©, « L'Harmattan, 2014 », « 2e édition 2011 »…
 *   faible  millésime isolé dans le texte ou le titre : c'est souvent le SUJET
 *           du livre (« la crise de 1929 »), à ne valider qu'après lecture.
 *
 * Pour appliquer : ouvrir le CSV, mettre `oui` dans la colonne `valider` sur les
 * lignes retenues (corriger `annee_proposee` au besoin), puis relancer avec
 * --apply. Seules les lignes validées sont écrites, et uniquement si l'année est
 * toujours vide en base. Un journal JSON réversible est déposé dans backups/.
 *
 * Usage :
 *   node scripts/suggest-publication-years.mjs                 (analyse, aucun écrit)
 *   node scripts/suggest-publication-years.mjs --apply <csv>   (écrit les lignes validées)
 */
import 'dotenv/config';
import { writeFileSync, readFileSync } from 'node:fs';
import { openMysql } from './tiers-hygiene-lib.mjs';

const OUT_DIR = '/var/www/html/senharmattan-shop/backups';
const TODAY = new Date().toISOString().slice(0, 10);
const ANNEE_MAX = new Date().getFullYear() + 2;
const ANNEE_MIN = 1400;

const applyIndex = process.argv.indexOf('--apply');
const applyCsv = applyIndex !== -1 ? process.argv[applyIndex + 1] : null;

// ── Texte : décode les entités HTML et retire le balisage, comme le fait le
// serveur pour l'affichage. Sans ça les millésimes sont noyés dans le HTML.
function cleanText(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&bull;/g, '•')
    .replace(/&eacute;/g, 'é').replace(/&egrave;/g, 'è').replace(/&agrave;/g, 'à')
    .replace(/&ccedil;/g, 'ç').replace(/&ocirc;/g, 'ô').replace(/&ucirc;/g, 'û')
    .replace(/&icirc;/g, 'î').replace(/&iuml;/g, 'ï').replace(/&acirc;/g, 'â')
    .replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'")
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const plausible = (y) => Number.isInteger(y) && y >= ANNEE_MIN && y <= ANNEE_MAX;

// Règles ordonnées : la première qui matche gagne. Chaque motif capture l'année
// dans son groupe 1.
const REGLES = [
  { confiance: 'haute', source: 'date de publication',
    re: /date\s+de\s+publication\s*:?\s*[^\n•|]{0,40}?((?:19|20)\d{2})/i },
  { confiance: 'moyenne', source: 'dépôt légal',
    re: /d[ée]p[ôo]t\s+l[ée]gal[^\n]{0,30}?((?:19|20)\d{2})/i },
  { confiance: 'moyenne', source: 'copyright',
    re: /(?:©|\(c\)|copyright)\s*[^\n]{0,20}?((?:19|20)\d{2})/i },
  { confiance: 'moyenne', source: 'éditeur + millésime',
    re: /(?:l['’ ]?harmattan|[ée]ditions?|presses|karthala|pr[ée]sence africaine)[^\n]{0,25}?,\s*((?:19|20)\d{2})/i },
  { confiance: 'moyenne', source: 'mention d\'édition',
    re: /(?:1\s*[èe]re|1re|premi[èe]re|nouvelle|r[ée][ée]dition|\d\s*e)\s+[ée]dition[^\n]{0,25}?((?:19|20)\d{2})/i },
  { confiance: 'moyenne', source: 'parution',
    re: /(?:paru|parue|publi[ée]|publi[ée]e|parution)[^\n]{0,25}?((?:19|20)\d{2})/i },
];

// Un millésime entouré de ces mots parle de logistique ou du SUJET du livre,
// jamais de la parution : on refuse la proposition plutôt que de polluer le CSV.
const CONTEXTE_INTERDIT = /(livraison|livr[ée]|arriv[ée]|re[çc]u|r[ée]assort|commande|stock|inventaire|facture|d[ée]p[ôo]t|exemplaires?|\b\d+\s*ex\b|guerre|si[èe]cle|n[ée]\s+en|mort\s+en|d[ée]c[ée]d)/i;

function extraitAutour(texte, index, longueur) {
  const debut = Math.max(0, index - 50);
  const fin = Math.min(texte.length, index + longueur + 50);
  return (debut > 0 ? '…' : '') + texte.slice(debut, fin) + (fin < texte.length ? '…' : '');
}

function proposer(livre) {
  const texte = [cleanText(livre.description), cleanText(livre.longdescript)]
    .filter(Boolean).join(' ||| ');

  for (const regle of REGLES) {
    const m = texte.match(regle.re);
    if (!m) continue;
    const annee = parseInt(m[1], 10);
    if (!plausible(annee)) continue;
    return { annee, confiance: regle.confiance, source: regle.source,
             extrait: extraitAutour(texte, m.index, m[0].length) };
  }

  // Dernier recours : un millésime isolé, hors contexte logistique. Le plus
  // récent l'emporte (un livre cite souvent des dates plus anciennes que la sienne).
  let meilleur = null;
  for (const m of texte.matchAll(/\b((?:19|20)\d{2})\b/g)) {
    const annee = parseInt(m[1], 10);
    if (!plausible(annee)) continue;
    const autour = texte.slice(Math.max(0, m.index - 45), m.index + 45);
    if (CONTEXTE_INTERDIT.test(autour)) continue;
    if (!meilleur || annee > meilleur.annee) {
      meilleur = { annee, confiance: 'faible', source: 'millésime isolé (texte)',
                   extrait: extraitAutour(texte, m.index, 4) };
    }
  }
  if (meilleur) return meilleur;

  // Millésime dans le titre — le plus souvent le sujet, jamais la parution :
  // signalé en faible pour que le relecteur tranche.
  const t = String(livre.label || '').match(/\b((?:19|20)\d{2})\b/);
  if (t && plausible(parseInt(t[1], 10))) {
    return { annee: parseInt(t[1], 10), confiance: 'faible', source: 'millésime dans le titre',
             extrait: livre.label };
  }
  return null;
}

// ── CSV : séparateur `;` et BOM UTF-8 pour qu'Excel FR ouvre le fichier
// directement, accents compris.
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (entetes, lignes) =>
  '﻿' + [entetes.join(';'), ...lignes.map((l) => l.map(csvCell).join(';'))].join('\r\n') + '\r\n';

function parseCsv(contenu) {
  const texte = contenu.replace(/^﻿/, '');
  const lignes = [];
  let champ = '', ligne = [], dansGuillemets = false;
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    if (dansGuillemets) {
      if (c === '"' && texte[i + 1] === '"') { champ += '"'; i++; }
      else if (c === '"') dansGuillemets = false;
      else champ += c;
    } else if (c === '"') dansGuillemets = true;
    else if (c === ';') { ligne.push(champ); champ = ''; }
    else if (c === '\n') { ligne.push(champ); lignes.push(ligne); ligne = []; champ = ''; }
    else if (c !== '\r') champ += c;
  }
  if (champ !== '' || ligne.length) { ligne.push(champ); lignes.push(ligne); }
  return lignes.filter((l) => l.some((c) => c !== ''));
}

const LIVRES_SANS_ANNEE = `
  SELECT p.rowid AS id, p.ref, p.label, p.description,
         pe.longdescript, pe.auteur, pe.publication_year
    FROM llx_product p
    LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid
   WHERE p.entity = 1 AND p.fk_product_type = 0 AND p.tosell = 1
     AND (pe.publication_year IS NULL
          OR pe.publication_year < ${ANNEE_MIN} OR pe.publication_year > ${ANNEE_MAX})
   ORDER BY p.rowid DESC
`;

async function analyser(pool) {
  const [livres] = await pool.query(LIVRES_SANS_ANNEE);
  const propositions = [], sansIndice = [];
  const parConfiance = { haute: 0, moyenne: 0, faible: 0 };

  for (const livre of livres) {
    const p = proposer(livre);
    if (p) {
      parConfiance[p.confiance]++;
      propositions.push([livre.id, livre.ref || '', livre.label || '', livre.auteur || '',
                         p.annee, p.confiance, p.source, p.extrait, '']);
    } else {
      sansIndice.push([livre.id, livre.ref || '', livre.label || '', livre.auteur || '', '', '']);
    }
  }

  // Les plus fiables d'abord : le relecteur traite le haut du fichier en priorité.
  const rang = { haute: 0, moyenne: 1, faible: 2 };
  propositions.sort((a, b) => rang[a[5]] - rang[b[5]] || b[4] - a[4]);

  const fPropositions = `${OUT_DIR}/publication-years-propositions-${TODAY}.csv`;
  const fSansIndice = `${OUT_DIR}/publication-years-sans-indice-${TODAY}.csv`;
  writeFileSync(fPropositions, toCsv(
    ['product_id', 'isbn', 'titre', 'auteur', 'annee_proposee', 'confiance', 'source', 'extrait', 'valider'],
    propositions));
  writeFileSync(fSansIndice, toCsv(
    ['product_id', 'isbn', 'titre', 'auteur', 'annee_proposee', 'valider'], sansIndice));

  console.log(`Livres sans année exploitable : ${livres.length}`);
  console.log(`  proposition trouvée : ${propositions.length}`
    + ` (haute ${parConfiance.haute} · moyenne ${parConfiance.moyenne} · faible ${parConfiance.faible})`);
  console.log(`  aucun indice        : ${sansIndice.length}`);
  console.log(`\nÀ relire :\n  ${fPropositions}\n  ${fSansIndice}`);
  console.log('\nMettre « oui » dans la colonne `valider`, puis :');
  console.log(`  node scripts/suggest-publication-years.mjs --apply ${fPropositions}`);
}

async function appliquer(pool, chemin) {
  const lignes = parseCsv(readFileSync(chemin, 'utf8'));
  if (!lignes.length) throw new Error('CSV vide');
  const entetes = lignes[0].map((h) => h.trim().toLowerCase());
  const col = (nom) => {
    const i = entetes.indexOf(nom);
    if (i === -1) throw new Error(`Colonne « ${nom} » absente du CSV`);
    return i;
  };
  const iId = col('product_id'), iAnnee = col('annee_proposee'), iValider = col('valider');

  const retenues = [];
  for (const l of lignes.slice(1)) {
    if (!/^(oui|o|x|1|yes)$/i.test((l[iValider] || '').trim())) continue;
    const id = parseInt(l[iId], 10);
    const annee = parseInt(l[iAnnee], 10);
    if (!Number.isInteger(id)) { console.warn(`Ignoré : product_id illisible « ${l[iId]} »`); continue; }
    if (!plausible(annee)) { console.warn(`Ignoré #${id} : année « ${l[iAnnee]} » hors ${ANNEE_MIN}-${ANNEE_MAX}`); continue; }
    retenues.push({ id, annee });
  }

  if (!retenues.length) {
    console.log('Aucune ligne validée (colonne `valider` = oui). Rien à écrire.');
    return;
  }

  const journal = [];
  let ecrits = 0, ignores = 0;
  for (const { id, annee } of retenues) {
    // Relecture de l'état courant : on n'écrase jamais une année saisie entre-temps.
    const [[actuel]] = await pool.query(
      'SELECT publication_year AS annee FROM llx_product_extrafields WHERE fk_object = ?', [id]);
    if (actuel && actuel.annee !== null && actuel.annee >= ANNEE_MIN && actuel.annee <= ANNEE_MAX) {
      console.warn(`Ignoré #${id} : déjà renseigné (${actuel.annee})`);
      ignores++;
      continue;
    }
    // La ligne d'extrafields peut ne pas exister du tout pour un produit.
    await pool.query(
      `INSERT INTO llx_product_extrafields (fk_object, publication_year) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE publication_year = VALUES(publication_year)`, [id, annee]);
    journal.push({ product_id: id, avant: actuel ? actuel.annee : null, apres: annee });
    ecrits++;
  }

  if (!ecrits) {
    console.log(`Aucune écriture${ignores ? ` : ${ignores} ligne(s) déjà renseignée(s)` : ''}.`);
    return;
  }

  const fJournal = `${OUT_DIR}/publication-years-applique-${TODAY}.json`;
  writeFileSync(fJournal, JSON.stringify(
    { date: new Date().toISOString(), source: chemin, modifications: journal }, null, 2));

  console.log(`Années écrites : ${ecrits}${ignores ? ` · ignorées (déjà renseignées) : ${ignores}` : ''}`);
  console.log(`Journal réversible : ${fJournal}`);
  console.log('Le catalogue reflète le changement après expiration du cache produits (5 min).');
}

const pool = openMysql();
try {
  if (applyIndex !== -1) {
    if (!applyCsv) throw new Error('Usage : --apply <fichier.csv>');
    await appliquer(pool, applyCsv);
  } else {
    await analyser(pool);
  }
} finally {
  await pool.end();
}
