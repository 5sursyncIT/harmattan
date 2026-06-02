#!/usr/bin/env node
/**
 * Génère les templates ODT de contrats d'édition pour L'Harmattan Sénégal.
 *
 * Objectif : reproduire LE PLUS FIDÈLEMENT POSSIBLE le modèle officiel
 *   « CONTRAT - HARMATTAN a partir de janvier 2024.pdf »
 * (texte des articles, numérotation et structure identiques), tout en gardant
 * les champs dynamiques remplis automatiquement par Dolibarr
 * (auteur, titre, ISBN, taux, seuil, dates, signataire…).
 *
 *   Combinaisons actives :
 *     template_harmattan_2024_edition_simple.odt        (contrat principal seul)
 *     template_harmattan_2024_edition_numerique.odt     (+ avenant numérique)
 *     template_harmattan_2024_edition_complete.odt      (+ numérique, audiovisuel, théâtral)
 *     template_harmattan_dll_*  /  template_tamarinier_*
 *
 *   Chaque variante se termine par l'annexe « Engagement d'achat de l'Auteur ».
 *   Quelques anciens noms restent générés pour compatibilité.
 *
 * Sortie dans /tmp/contract-templates-v2/.
 * Usage : node scripts/build-contract-templates.mjs
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const OUT_DIR = '/tmp/contract-templates-v2';
const WORK_DIR = '/tmp/contract-templates-work';

// ═══════════════════════════════════════════════════════════
// CHARTE VISUELLE
// ═══════════════════════════════════════════════════════════
const COLOR_PRIMARY = '#10531a';
const COLOR_ACCENT_BG = '#f0fdf4';
const COLOR_MUTED = '#6b7280';
const COLOR_DIVIDER = '#d1d5db';
const FONT_SERIF = 'Liberation Serif';
const FONT_SANS = 'Liberation Sans';

// Pied de page reproduisant exactement celui du modèle officiel.
const FOOTER_HARMATTAN = "L'HARMATTAN SENEGAL SARL – 10 VDN Sicap amitié 3, Lotissement Cité Police, BP 45034 Dakar Fann, RC : SN DKR 2009-B-11.042 NINEA : 004067155";
const FOOTER_TAMARINIER = "LE TAMARINIER (s/c L'HARMATTAN SÉNÉGAL) – 10 VDN Sicap amitié 3, Lotissement Cité Police, BP 45034 Dakar Fann, RC : SN DKR 2009-B-11.042 NINEA : 004067155";

// ═══════════════════════════════════════════════════════════
// CONFIGURATION PAR VARIANTE
// ═══════════════════════════════════════════════════════════
const CONTRACT_MODELS = {
  harmattan_2024: {
    label: "Harmattan · classique",
    editorLong: "L'Harmattan Sénégal",
    editorShort: "L'Harmattan Sénégal",
    editorDative: "à L'Harmattan Sénégal",
    footer: FOOTER_HARMATTAN,
    article4: 'classic',
  },
  harmattan_dll: {
    label: "Harmattan · DLL (subventionné)",
    editorLong: "L'Harmattan Sénégal",
    editorShort: "L'Harmattan Sénégal",
    editorDative: "à L'Harmattan Sénégal",
    footer: FOOTER_HARMATTAN,
    article4: 'dll',
  },
  tamarinier: {
    label: "Le Tamarinier",
    editorLong: "Le Tamarinier (s/c L'Harmattan Sénégal)",
    editorShort: "Le Tamarinier",
    editorDative: "au Tamarinier",
    footer: FOOTER_TAMARINIER,
    article4: 'classic',
  },
};

const RIGHTS_SCOPES = {
  edition_simple: {
    label: "Édition · papier seul",
    annexes: ['purchase'],
  },
  edition_numerique: {
    label: "Édition · papier + numérique",
    annexes: ['digital', 'purchase'],
  },
  edition_complete: {
    label: "Édition · complète",
    annexes: ['digital', 'audiovisual', 'theatre', 'purchase'],
  },
};

const VARIANTS = Object.fromEntries(
  Object.entries(CONTRACT_MODELS).flatMap(([modelKey, model]) =>
    Object.entries(RIGHTS_SCOPES).map(([scopeKey, scope]) => [
      `${modelKey}_${scopeKey}`,
      {
        ...model,
        label: `${model.label} · ${scope.label}`,
        scopeLabel: scope.label,
        annexes: scope.annexes,
      },
    ])
  )
);

Object.assign(VARIANTS, {
  // Legacy names kept so older contracts can still regenerate their documents.
  harmattan_2024: { ...CONTRACT_MODELS.harmattan_2024, label: CONTRACT_MODELS.harmattan_2024.label, annexes: RIGHTS_SCOPES.edition_complete.annexes },
  harmattan_dll: { ...CONTRACT_MODELS.harmattan_dll, label: CONTRACT_MODELS.harmattan_dll.label, annexes: RIGHTS_SCOPES.edition_complete.annexes },
  tamarinier: { ...CONTRACT_MODELS.tamarinier, label: CONTRACT_MODELS.tamarinier.label, annexes: RIGHTS_SCOPES.edition_complete.annexes },
  edition_simple: { ...CONTRACT_MODELS.harmattan_2024, label: RIGHTS_SCOPES.edition_simple.label, annexes: RIGHTS_SCOPES.edition_simple.annexes },
  edition_numerique: { ...CONTRACT_MODELS.harmattan_2024, label: RIGHTS_SCOPES.edition_numerique.label, annexes: RIGHTS_SCOPES.edition_numerique.annexes },
  edition_complete: { ...CONTRACT_MODELS.harmattan_2024, label: RIGHTS_SCOPES.edition_complete.label, annexes: RIGHTS_SCOPES.edition_complete.annexes },
});

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

// ═══════════════════════════════════════════════════════════
// styles.xml
// ═══════════════════════════════════════════════════════════
function buildStyles(variant) {
  const cfg = VARIANTS[variant];
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  office:version="1.2">

 <office:font-face-decls>
  <style:font-face style:name="${FONT_SERIF}" svg:font-family="${FONT_SERIF}" style:font-family-generic="roman"/>
  <style:font-face style:name="${FONT_SANS}" svg:font-family="${FONT_SANS}" style:font-family-generic="swiss"/>
 </office:font-face-decls>

 <office:styles>
  <style:default-style style:family="paragraph">
   <style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0.18cm" fo:line-height="135%" fo:text-align="justify"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="11pt" fo:language="fr" fo:country="FR" fo:color="#1a1a1a"/>
  </style:default-style>

  <!-- En-tête (lettre à en-tête) de la première page -->
  <style:style style:name="LetterheadEditor" style:family="paragraph">
   <style:paragraph-properties fo:text-align="left" fo:margin-bottom="0.05cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="15pt" fo:font-weight="bold" fo:color="${COLOR_PRIMARY}"/>
  </style:style>
  <style:style style:name="LetterheadTag" style:family="paragraph">
   <style:paragraph-properties fo:text-align="left" fo:margin-bottom="0.05cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="8.5pt" fo:letter-spacing="0.05cm" fo:color="${COLOR_MUTED}"/>
  </style:style>
  <style:style style:name="LetterheadSlogan" style:family="paragraph">
   <style:paragraph-properties fo:text-align="left" fo:margin-bottom="0.3cm" fo:border-bottom="1pt solid ${COLOR_PRIMARY}" fo:padding-bottom="0.25cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="9pt" fo:font-style="italic" fo:color="${COLOR_MUTED}"/>
  </style:style>
  <style:style style:name="DocTitleBox" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:margin-top="0.4cm" fo:margin-bottom="0.5cm" fo:border="0.75pt solid #1a1a1a" fo:padding="0.2cm 0.3cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="15pt" fo:font-weight="bold" fo:letter-spacing="0.05cm" fo:color="#1a1a1a"/>
  </style:style>

  <!-- Bloc identité de l'auteur (champs surlignés du modèle) -->
  <style:style style:name="IdentityBox" style:family="paragraph">
   <style:paragraph-properties fo:background-color="${COLOR_ACCENT_BG}" fo:border-left="3pt solid ${COLOR_PRIMARY}" fo:padding="0.25cm 0.5cm" fo:margin-top="0.3cm" fo:margin-bottom="0.1cm" fo:text-align="left"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="10.5pt"/>
  </style:style>
  <style:style style:name="IdentityBoxLast" style:family="paragraph">
   <style:paragraph-properties fo:background-color="${COLOR_ACCENT_BG}" fo:border-left="3pt solid ${COLOR_PRIMARY}" fo:padding="0.25cm 0.5cm" fo:margin-bottom="0.4cm" fo:text-align="left"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="10.5pt"/>
  </style:style>

  <!-- Titres de section : SectionTitle force un saut de page (avenants),
       FirstSectionTitle non (première page du contrat principal). -->
  <style:style style:name="SectionTitle" style:family="paragraph">
   <style:paragraph-properties fo:break-before="page" fo:text-align="center" fo:margin-top="0.4cm" fo:margin-bottom="0.2cm" fo:border-bottom="1pt solid ${COLOR_PRIMARY}" fo:padding-bottom="0.25cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="16pt" fo:font-weight="bold" fo:letter-spacing="0.05cm" fo:color="${COLOR_PRIMARY}"/>
  </style:style>
  <style:style style:name="FirstSectionTitle" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:margin-top="0.3cm" fo:margin-bottom="0.6cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="13pt" fo:font-weight="bold" fo:letter-spacing="0.05cm" fo:color="${COLOR_PRIMARY}"/>
  </style:style>
  <style:style style:name="SectionSubtitle" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:margin-bottom="0.6cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="10pt" fo:letter-spacing="0.04cm" fo:color="${COLOR_MUTED}" fo:font-style="italic"/>
  </style:style>

  <style:style style:name="ArticleTitle" style:family="paragraph">
   <style:paragraph-properties fo:margin-top="0.5cm" fo:margin-bottom="0.18cm" fo:keep-with-next="always"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="11.5pt" fo:font-weight="bold" fo:color="${COLOR_PRIMARY}"/>
  </style:style>
  <style:style style:name="SubArticle" style:family="paragraph">
   <style:paragraph-properties fo:margin-top="0.25cm" fo:margin-bottom="0.1cm" fo:keep-with-next="always"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="10.5pt" fo:font-weight="bold" fo:color="#1a1a1a"/>
  </style:style>
  <style:style style:name="ListItem" style:family="paragraph">
   <style:paragraph-properties fo:margin-left="0.8cm" fo:margin-bottom="0.08cm" fo:text-align="justify"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="11pt"/>
  </style:style>

  <style:style style:name="Preamble" style:family="paragraph">
   <style:paragraph-properties fo:background-color="${COLOR_ACCENT_BG}" fo:border-left="3pt solid ${COLOR_PRIMARY}" fo:padding="0.3cm 0.5cm" fo:margin-top="0.3cm" fo:margin-bottom="0.4cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="10.5pt" fo:font-style="italic"/>
  </style:style>
  <style:style style:name="Callout" style:family="paragraph">
   <style:paragraph-properties fo:background-color="#fef9c3" fo:border="0.5pt solid #eab308" fo:padding="0.25cm 0.4cm" fo:margin-top="0.3cm" fo:margin-bottom="0.3cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="11pt"/>
  </style:style>
  <style:style style:name="AuthorInlineSign" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:margin-top="0.3cm" fo:margin-bottom="0.3cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="10pt" fo:font-weight="bold"/>
  </style:style>

  <style:style style:name="SignHeader" style:family="paragraph">
   <style:paragraph-properties fo:margin-top="0.7cm" fo:text-align="center" fo:keep-with-next="always"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="10pt" fo:font-weight="bold" fo:letter-spacing="0.1cm" fo:color="${COLOR_PRIMARY}"/>
  </style:style>
  <style:style style:name="SignLine" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:margin-bottom="0.1cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="10pt"/>
  </style:style>
  <style:style style:name="SignMention" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:margin-top="0.3cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="9pt" fo:font-style="italic" fo:color="${COLOR_MUTED}"/>
  </style:style>

  <style:style style:name="Italic" style:family="text">
   <style:text-properties fo:font-style="italic"/>
  </style:style>
  <style:style style:name="Bold" style:family="text">
   <style:text-properties fo:font-weight="bold"/>
  </style:style>
  <style:style style:name="Upper" style:family="text">
   <style:text-properties fo:font-weight="bold" fo:letter-spacing="0.02cm"/>
  </style:style>
  <style:style style:name="AccentBold" style:family="text">
   <style:text-properties fo:font-weight="bold" fo:color="${COLOR_PRIMARY}"/>
  </style:style>
  <style:style style:name="SmallMuted" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:margin-top="0.2cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="8pt" fo:color="${COLOR_MUTED}"/>
  </style:style>

  <style:style style:name="FooterCenter" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="8pt" fo:color="${COLOR_PRIMARY}" fo:font-weight="bold"/>
  </style:style>
  <style:style style:name="FooterLegal" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="7.5pt" fo:color="${COLOR_MUTED}"/>
  </style:style>
  <style:style style:name="HeaderRef" style:family="paragraph">
   <style:paragraph-properties fo:text-align="left" fo:border-bottom="0.5pt solid ${COLOR_PRIMARY}" fo:padding-bottom="0.15cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="8.5pt" fo:color="${COLOR_MUTED}"/>
  </style:style>

  <style:style style:name="SignTable" style:family="table">
   <style:table-properties style:width="17cm" table:align="center" fo:margin-top="0.5cm"/>
  </style:style>
  <style:style style:name="SignColumn" style:family="table-column">
   <style:table-column-properties style:column-width="8.5cm"/>
  </style:style>
  <style:style style:name="SignCell" style:family="table-cell">
   <style:table-cell-properties fo:border="0.5pt solid ${COLOR_DIVIDER}" fo:padding="0.4cm"/>
  </style:style>
  <style:style style:name="SignatureBox" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:border="0.3pt dashed ${COLOR_MUTED}" fo:background-color="#fafafa" fo:padding="1.2cm 0.5cm" fo:margin-top="0.4cm" fo:margin-bottom="0.2cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="8pt" fo:color="${COLOR_MUTED}"/>
  </style:style>
 </office:styles>

 <office:automatic-styles>
  <style:page-layout style:name="pm1">
   <style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm"
     fo:margin-top="2.2cm" fo:margin-bottom="2.4cm" fo:margin-left="2.2cm" fo:margin-right="2.2cm"/>
   <style:header-style>
    <style:header-footer-properties fo:min-height="0.8cm" fo:margin-bottom="0.4cm"/>
   </style:header-style>
   <style:footer-style>
    <style:header-footer-properties fo:min-height="1cm" fo:margin-top="0.4cm"/>
   </style:footer-style>
  </style:page-layout>
 </office:automatic-styles>

 <office:master-styles>
  <style:master-page style:name="Standard" style:page-layout-name="pm1" style:next-style-name="Standard">
   <style:header>
    <text:p text:style-name="HeaderRef">Contrat d'édition · Réf. <text:span text:style-name="Bold">{object_ref}</text:span> · {__THIRDPARTY_NAME__} — {object_options_book_title}</text:p>
   </style:header>
   <style:footer>
    <text:p text:style-name="FooterCenter">${esc(cfg.editorShort.toUpperCase())} · Page <text:page-number/> / <text:page-count/></text:p>
    <text:p text:style-name="FooterLegal">${esc(cfg.footer)}</text:p>
   </style:footer>
  </style:master-page>
 </office:master-styles>
</office:document-styles>`;
}

// ═══════════════════════════════════════════════════════════
// Ouverture (première page) — reproduit l'en-tête du modèle :
// lettre à en-tête + bloc identité auteur + « Entre d'une part » + Titre.
// ═══════════════════════════════════════════════════════════
function buildOpening(variant) {
  const cfg = VARIANTS[variant];
  const editor = cfg.editorLong;
  const editorDative = cfg.editorDative || editor;
  return `
  <text:p text:style-name="LetterheadEditor">${esc(editor)}</text:p>
  <text:p text:style-name="LetterheadTag">ÉDITION · DIFFUSION · LIBRAIRIE</text:p>
  <text:p text:style-name="LetterheadSlogan">Faire revenir le livre dans le quotidien des Sénégalais</text:p>

  <text:p text:style-name="DocTitleBox">CONTRAT D'ÉDITION</text:p>

  <text:p text:style-name="IdentityBox">Nom et prénoms&#160;: <text:span text:style-name="Bold">{__THIRDPARTY_NAME__}</text:span></text:p>
  <text:p text:style-name="IdentityBox">Adresse&#160;: {__THIRDPARTY_ADDRESS__} {__THIRDPARTY_ZIP__} {__THIRDPARTY_TOWN__}</text:p>
  <text:p text:style-name="IdentityBoxLast">Courriel&#160;: {__THIRDPARTY_EMAIL__}</text:p>

  <text:p>Entre d'une part <text:span text:style-name="Bold">{__THIRDPARTY_NAME__}</text:span>, ci-après dénommé l'<text:span text:style-name="Italic">Auteur</text:span>, et les éditions <text:span text:style-name="AccentBold">${esc(editor)}</text:span>, dénommées ci-dessous ${esc(cfg.editorShort)} ou l'Éditeur d'autre part, il a été convenu de ce qui suit, concernant l'ouvrage&#160;:</text:p>

  <text:p>Titre&#160;: <text:span text:style-name="Bold">« {object_options_book_title} »</text:span></text:p>

  <text:p>Dans le cadre du présent traité, l'Auteur cède ${esc(editorDative)} <text:span text:style-name="Upper">le droit exclusif d'imprimer, publier, reproduire et vendre</text:span> ledit ouvrage sous forme d'éditions de tous formats, ordinaires, illustrés, de luxe, à tirage limité ou non.</text:p>

  <text:p>De son côté, ${esc(editor)} s'engage à assurer à ses frais la publication en librairie de cet ouvrage et s'emploiera à lui procurer, par une diffusion dans le public et auprès des tiers susceptibles d'être intéressés, les conditions favorables à son exploitation sous toutes les formes.</text:p>

  <text:p>En considération du risque pris par ${esc(editor)} en assurant, ainsi qu'il s'y engage, la publication de l'ouvrage dans les conditions prévues ci-dessous, estimant qu'une telle publication est susceptible d'apporter à l'ouvrage un champ d'exploitation étendu, et en vue des avantages que peut offrir l'unité de gestion, l'Auteur cède ${esc(editorDative)}, outre le droit d'édition graphique, les droits patrimoniaux&#160;:</text:p>
  <text:p text:style-name="ListItem">–  de reproduction&#160;;</text:p>
  <text:p text:style-name="ListItem">–  de traduction&#160;;</text:p>
  <text:p>afférant à l'ouvrage sans aucune exception ni réserve et dans les conditions prévues aux articles 5, 6 et 7 ci-après.</text:p>

  <text:p>La présente cession est consentie pour avoir effet en tous lieux et pour tout le temps que durera la propriété littéraire de l'Auteur et de ses ayants droit, et d'après les législations tant sénégalaises qu'étrangères et les conventions internationales actuelles ou futures, y compris les prolongations qui pourraient être apportées à cette durée.</text:p>

  <text:p>L'Auteur garantit à ${esc(editor)} la jouissance entière et libre de toute servitude des droits cédés, contre tous troubles, revendications et évictions quelconques.</text:p>
`;
}

// ═══════════════════════════════════════════════════════════
// Article 4 — variantes (classique vs DLL)
// ═══════════════════════════════════════════════════════════
function buildArticle4Classic(editor) {
  return `
  <text:p text:style-name="ArticleTitle">Article 4 · Droits d'Auteur et exemplaires Auteur</text:p>
  <text:p>Le droit d'auteur au Sénégal est régi par la loi n°&#160;2008-09 du 25 janvier 2008 relative au droit d'auteur et aux droits voisins et le décret n°&#160;2015-682 du 26 mai 2015 portant application de la loi n°&#160;2008-09 du 25 janvier 2008 sur le droit d'auteur et les droits voisins.</text:p>
  <text:p>La cession des droits de reproduction et de représentation peut se faire à titre gratuit ou à titre onéreux.</text:p>
  <text:p>La présente cession des droits de l'Auteur est expressément convenue selon les modalités particulières suivantes&#160;:</text:p>

  <text:p text:style-name="SubArticle">1. Cession à titre onéreux</text:p>
  <text:p>La cession des droits, objet du présent contrat, est consentie expressément par l'Auteur à titre onéreux à partir du premier (01) exemplaire vendu.</text:p>
  <text:p text:style-name="Callout">${esc(editor)} versera à l'Auteur un taux de <text:span text:style-name="AccentBold">{object_options_royalty_rate_print} %</text:span> du chiffre d'affaires réalisé sur les exemplaires vendus au-delà de la barre des <text:span text:style-name="AccentBold">{object_options_royalty_threshold} exemplaires</text:span>.</text:p>
  <text:p>Ces versements ont pour assiette le prix de vente public au Sénégal.</text:p>
  <text:p>Les droits d'auteur ne portent pas sur les exemplaires remis gratuitement à l'Auteur, ni sur ceux réservés au Service de Presse dont le nombre sera fixé par l'Éditeur (<text:span text:style-name="Bold">{object_options_exemplaires_sp}</text:span> exemplaires), ni sur les exemplaires cédés à prix réduit (remise supérieure à 50&#160;% du prix public), à l'Auteur ou à des tiers dans l'intérêt de la diffusion de l'ouvrage.</text:p>

  <text:p text:style-name="SubArticle">2. Exemplaires d'auteur</text:p>
  <text:p>L'Auteur disposera sur le premier tirage, pour son usage personnel, de <text:span text:style-name="AccentBold">{object_options_free_author_copies} exemplaires</text:span> qui lui seront remis gratuitement, dits « exemplaires d'auteur ». Les exemplaires qu'il désirerait en plus de ceux-ci lui seraient facturés avec 30&#160;% de remise sur le prix catalogue.</text:p>
`;
}

function buildArticle4DLL(editor) {
  return `
  <text:p text:style-name="ArticleTitle">Article 4 · Droits d'Auteur et exemplaires Auteur</text:p>
  <text:p>Le droit d'auteur au Sénégal est régi par la loi n°&#160;2008-09 du 25 janvier 2008 relative au droit d'auteur et aux droits voisins et le décret n°&#160;2015-682 du 26 mai 2015 portant application de ladite loi.</text:p>
  <text:p>La présente cession des droits de l'Auteur est expressément convenue selon les modalités particulières suivantes&#160;:</text:p>

  <text:p text:style-name="SubArticle">1. Cession à titre onéreux (ouvrage subventionné DLL)</text:p>
  <text:p>La présente cession des droits de l'Auteur est expressément convenue selon les modalités contenues dans le contrat que l'Éditeur a signé avec la <text:span text:style-name="Bold">Direction du Livre et de la Lecture du Sénégal (DLL)</text:span>, en ses articles 3 et 6.</text:p>
  <text:p text:style-name="Callout">${esc(editor)} versera à l'Auteur <text:span text:style-name="AccentBold">{object_options_royalty_rate_print} %</text:span> en droits d'auteur sur les <text:span text:style-name="AccentBold">{object_options_royalty_threshold} premiers exemplaires</text:span> subventionnés par la DLL. Au-delà, l'Éditeur s'engage à verser <text:span text:style-name="AccentBold">10&#160;%</text:span> en droits d'auteur sur tout exemplaire vendu.</text:p>
  <text:p>Les droits d'auteur ne portent pas sur les exemplaires remis à la DLL (100 exemplaires) et à l'Auteur (50 exemplaires), ni sur ceux réservés au Service de Presse (<text:span text:style-name="Bold">{object_options_exemplaires_sp}</text:span> exemplaires), ni sur les exemplaires cédés à prix réduit (remise supérieure à 50&#160;% du prix public).</text:p>
  <text:p>L'Auteur autorise l'Éditeur à mettre son ouvrage en ligne, en ebook et en consultation partielle sur Google pour faire connaître le contenu et générer des occurrences.</text:p>

  <text:p text:style-name="SubArticle">2. Exemplaires d'auteur</text:p>
  <text:p>L'Auteur disposera sur le premier tirage, pour son usage personnel, de <text:span text:style-name="AccentBold">{object_options_free_author_copies} exemplaires</text:span> remis gratuitement (dits « exemplaires d'auteur »). Les exemplaires supplémentaires lui seront facturés avec 30&#160;% de remise sur le prix catalogue.</text:p>
`;
}

// ═══════════════════════════════════════════════════════════
// Contrat principal (articles 1 à 7 — texte du modèle officiel)
// ═══════════════════════════════════════════════════════════
function buildMainContract(variant) {
  const cfg = VARIANTS[variant];
  const editor = cfg.editorLong;
  const article4 = cfg.article4 === 'dll' ? buildArticle4DLL(editor) : buildArticle4Classic(editor);
  return `
${buildOpening(variant)}

  <text:p text:style-name="ArticleTitle">Article 1 · Remise du manuscrit</text:p>
  <text:p>L'Auteur s'engage à remettre à l'Éditeur, dans les quatre (4) mois à compter de la date de signature, un exemplaire du texte définitif et complet de son ouvrage aux normes éditoriales de ${esc(editor)}, sans faute d'orthographe, c'est-à-dire textes et documents d'illustration s'il y a lieu, parfaitement lisibles, dactylographiés et soigneusement revus pour l'impression.</text:p>
  <text:p>Il déclare conserver par devers lui un double de son texte.</text:p>
  <text:p>La réfection demandée par l'Auteur de toute figure déjà revêtue par lui de son « bon à tirer » sera à la charge de l'Auteur (frais de dessin et de gravure), sauf si elle est motivée par d'éventuels imprévus.</text:p>
  <text:p>Les documents originaux fournis par l'Auteur lui seront restitués sur sa demande par l'Éditeur après la parution de l'ouvrage, le texte remis par l'Auteur et les clichés réalisés aux frais de l'Éditeur restant seuls la propriété de celui-ci.</text:p>

  <text:p text:style-name="SubArticle">Attestation anti-plagiat</text:p>
  <text:p text:style-name="Preamble">« J'atteste que, dans ce texte, toute affirmation qui n'est pas le fruit de ma réflexion personnelle est attribuée à sa source et que tout passage recopié d'une autre source est en outre signalé comme tel, soit par des guillemets, soit par une mise en page appropriée. »</text:p>
  <text:p text:style-name="Preamble">« J'atteste que, dans ce texte, tous les visuels utilisés sont libres de droit, ou je possède les autorisations légales d'utilisation. »</text:p>
  <text:p text:style-name="AuthorInlineSign">(Signature de l'Auteur&#160;: ………………….)</text:p>

  <text:p text:style-name="ArticleTitle">Article 2 · Tirages et formats</text:p>
  <text:p>Les formats, les présentations et les prix de vente des volumes seront déterminés par l'Éditeur.</text:p>
  <text:p>Vu les évolutions techniques, après un premier tirage à <text:span text:style-name="Bold">{object_options_tirage_initial} exemplaires</text:span>, le retirage se fait en continu. L'Éditeur s'engage à maintenir l'ouvrage toujours disponible.</text:p>
  <text:p>À titre indicatif, l'ouvrage paraîtra au format <text:span text:style-name="Bold">{object_options_format_ouvrage}</text:span>, pour environ {object_options_nombre_pages_estime} pages, à un prix public prévisionnel de <text:span text:style-name="Bold">{object_options_prix_public_previsionnel} €</text:span>.</text:p>

  <text:p text:style-name="ArticleTitle">Article 3 · Obligations de l'Éditeur</text:p>
  <text:p>L'Éditeur s'engage à publier l'œuvre dans le délai de trois (3) mois à compter de la remise du texte définitif et complet, sauf retard imputable à l'Auteur.</text:p>
  <text:p>Passé ce délai, le présent contrat serait résilié de plein droit si l'Éditeur ne procédait pas à la publication de l'œuvre dans les trois mois de la mise en demeure qui lui serait faite, par lettre recommandée, par l'Auteur.</text:p>
  <text:p>Il s'engage à faire figurer sur la couverture de chacun des exemplaires le nom de l'Auteur, son pseudonyme ou la marque que celui-ci indiquera.</text:p>
  <text:p>Il s'engage à assurer à l'œuvre une exploitation permanente et suivie et une diffusion commerciale, conformément aux usages de la profession.</text:p>
  <text:p>En conséquence, dans le cas où toutes les éditions de l'œuvre auxquelles aura procédé l'Éditeur viendraient à être épuisées, le présent contrat serait résilié de plein droit, sauf convention particulière, si l'Éditeur ne procédait pas, par lui-même ou par cessionnaire, à une réimpression dans un délai de six mois à compter de la mise en demeure, par lettre recommandée avec accusé de réception, qui lui serait faite par l'Auteur. Celui-ci recouvrerait alors purement et simplement la libre disposition de tous ses droits sur son œuvre, et l'Éditeur serait dégagé de toute obligation ou indemnité vis-à-vis de l'Auteur.</text:p>
  <text:p>En cas de résiliation de ce contrat, toutes les cessions de droits de reproduction, d'adaptation et de représentation que l'Éditeur aurait consenties à des tiers seraient réputées être le fait de l'Auteur lui-même, à qui elles resteraient opposables.</text:p>
  <text:p>En cas d'incendie, d'inondation ou encore de tout cas accidentel ou de force majeure ayant eu pour conséquence la détérioration, la destruction ou la disparition de tout ou partie des exemplaires en stock, l'Éditeur ne pourra être tenu pour responsable des exemplaires détériorés, détruits ou disparus, et il ne sera dû par lui à l'Auteur aucun droit ni aucune indemnité relatifs à ces exemplaires.</text:p>

  ${article4}

  <text:p text:style-name="ArticleTitle">Article 5 · Droits de reproduction et droits annexes</text:p>
  <text:p>Sous réserve d'une acceptation de la part de l'Auteur, les droits de reproduction comprennent notamment&#160;:</text:p>
  <text:p text:style-name="ListItem">a)  le droit de traduire en toutes langues et de reproduire les traductions&#160;;</text:p>
  <text:p text:style-name="ListItem">b)  le droit de reproduire tout ou partie de l'ouvrage en pré ou post-publication et de l'adapter et reproduire en condensés&#160;;</text:p>
  <text:p text:style-name="ListItem">c)  le droit de l'adapter ou reproduire par dessin ou photo&#160;;</text:p>
  <text:p text:style-name="ListItem">d)  le droit de l'adapter pour tout enregistrement sonore et de reproduire les adaptations ainsi faites au moyen de tous procédés de reproduction sonore&#160;;</text:p>
  <text:p text:style-name="ListItem">e)  le droit de reproduire par photocopie ou microfilm&#160;;</text:p>
  <text:p text:style-name="ListItem">f)  le droit de reproduction graphique différente de celle de l'édition courante&#160;;</text:p>
  <text:p text:style-name="ListItem">g)  ainsi que tous droits connus et non encore connus qui permettent et permettront de communiquer l'œuvre au public.</text:p>
  <text:p>En outre, les droits annexes comprennent d'une manière générale la totalité des droits qui sont et seront reconnus, attribués aux auteurs sur leurs œuvres par les dispositions législatives ou réglementaires et les décisions judiciaires de tous les pays ainsi que les conventions internationales présentes ou futures.</text:p>
  <text:p>À condition d'assurer la publication graphique de l'ouvrage, l'Éditeur pourra user de ces droits, soit directement, soit en confiant à des tiers la charge de l'exploitation&#160;; il aura seul le pouvoir de consentir les autorisations et cessions nécessaires.</text:p>
  <text:p>L'Auteur s'engage à communiquer à l'Éditeur toutes demandes qui lui seraient adressées par un tiers en vue d'une acquisition des droits annexes sur l'œuvre.</text:p>
  <text:p text:style-name="Callout">L'Éditeur devra verser à l'Auteur <text:span text:style-name="AccentBold">50&#160;%</text:span> des sommes nettes de tous frais et hors toutes taxes de tous droits annexes consentis par lui à des tiers.</text:p>
  <text:p>Au cas où l'Éditeur estimerait opportun d'exploiter personnellement certains droits annexes, la rémunération de l'Auteur serait déterminée de commun accord entre les parties ou, à défaut, conformément aux conclusions de l'expert désigné par elles.</text:p>

  <text:p text:style-name="ArticleTitle">Article 6 · Relevés de comptes</text:p>
  <text:p>Les comptes de l'ensemble des droits dus à l'Auteur seront arrêtés le <text:span text:style-name="Bold">30 juin</text:span> de chaque année. Ils lui seront remis sur sa demande et le solde créditeur lui sera payable à partir du 3<text:span text:style-name="Italic">e</text:span> mois suivant l'arrêté des comptes, tel qu'indiqué à l'article 4 ci-dessus. Ne figureront sur ces relevés de compte que les ouvrages ayant au moins six mois d'exploitation.</text:p>

  <text:p text:style-name="ArticleTitle">Article 7 · Compétence</text:p>
  <text:p>Le présent contrat, dans son intégralité, engage les héritiers et tous les ayants droit de l'Auteur. Pour toutes contestations pouvant naître à l'occasion du présent contrat, attribution de juridiction est faite aux tribunaux compétents de Dakar.</text:p>

${buildSignatureBlock(true)}
`;
}

// ═══════════════════════════════════════════════════════════
// Avenant numérique (articles 1 à 6 — texte du modèle officiel)
// ═══════════════════════════════════════════════════════════
function buildDigitalAnnex(variant) {
  const cfg = VARIANTS[variant];
  const editor = cfg.editorLong;
  return `
  <text:p text:style-name="SectionTitle">AVENANT AU CONTRAT D'ÉDITION</text:p>
  <text:p text:style-name="SectionSubtitle">Droits numériques</text:p>

  <text:p text:style-name="Preamble">Par contrat conclu en date du {object_date}, l'Auteur a cédé à l'Éditeur le droit exclusif d'imprimer, publier, reproduire et vendre l'ouvrage intitulé <text:span text:style-name="Bold">« {object_options_book_title} »</text:span>. Compte tenu des plus larges possibilités d'édition et de publication qu'offrent les nouvelles technologies, les parties conviennent, par le présent avenant, de la cession par l'Auteur à ${esc(editor)} des droits numériques par tous procédés, sur tous supports et sur tous réseaux.</text:p>
  <text:p>La cession est consentie pour avoir effet pour toutes les langues, dans le monde entier, et pour tout le temps que durera la propriété littéraire de l'Auteur et de ses ayants droit, et d'après les législations tant sénégalaises qu'étrangères et les conventions internationales actuelles, y compris les prolongations qui pourraient être apportées à cette durée.</text:p>
  <text:p>L'Auteur garantit à l'Éditeur la jouissance entière et libre de toute servitude des droits cédés, contre tous troubles, revendications et évictions quelconques. En conséquence, il est prévu ce qui suit&#160;:</text:p>

  <text:p text:style-name="ArticleTitle">Article 1 · Objet de l'avenant</text:p>
  <text:p>Par cession de droits numériques, il est entendu le droit de reproduire, représenter, promouvoir, commercialiser, distribuer, mettre à disposition et vendre ou de proposer à la vente l'œuvre sur une base exclusive, dans tous les formats numériques disponibles, connus à ce jour ou inventés par la suite, via tous les modèles de distribution connus à ce jour ou inventés par la suite (y compris, mais sans s'y limiter, les modèles d'abonnements et de vente à la carte, en streaming et en téléchargement), dans le monde entier, via des sites internet et des applications détenus, exploités ou contrôlés par l'Éditeur, ses sociétés affiliées ou par des libraires et distributeurs numériques tiers.</text:p>

  <text:p text:style-name="ArticleTitle">Article 2 · Édition numérique</text:p>
  <text:p>Dans l'intérêt et pour les nécessités de l'exploitation de l'œuvre sous un format numérique, l'Éditeur peut être amené à introduire dans l'œuvre des liens hypertextes ou toute autre forme de procédé permettant la consultation interactive et/ou sélectionner, indexer ou mettre en forme tout ou partie de l'œuvre et ses adaptations et traductions.</text:p>
  <text:p>L'Éditeur reste seul propriétaire de tous les éléments de fabrication qu'il aura établis ou fait établir pour la réalisation des éditions numériques de l'œuvre, et notamment des fichiers numériques sous quelque format qu'ils soient.</text:p>
  <text:p>L'Éditeur fixe seul le format, la présentation, le prix, la date de mise en vente et les conditions d'accès à l'œuvre. L'Éditeur exploitera l'œuvre dans le respect du droit moral.</text:p>

  <text:p text:style-name="ArticleTitle">Article 3 · Rémunération</text:p>
  <text:p text:style-name="Callout">${esc(editor)} versera à l'Auteur <text:span text:style-name="AccentBold">{object_options_royalty_rate_digital} %</text:span> du chiffre d'affaires net hors taxes provenant de l'exploitation numérique de l'œuvre.</text:p>
  <text:p>Le règlement de cette rémunération par l'Éditeur à l'Auteur interviendra en même temps et dans les mêmes conditions que la reddition générale des comptes de l'Auteur, telle qu'elle est prévue au contrat d'édition. <text:span text:style-name="Bold">Les droits numériques inférieurs à {object_options_royalty_digital_threshold_fcfa} FCFA seront reportés sur l'exercice suivant.</text:span></text:p>

  <text:p text:style-name="ArticleTitle">Article 4 · Promotion</text:p>
  <text:p>Aux fins de présentation, de promotion et de publicité de l'ouvrage, l'Éditeur pourra diffuser et permettre la consultation, à titre gratuit par le public, d'extraits de l'œuvre, sur tout support numérique et par tout procédé de communication connu à ce jour ou inventé par la suite, dans le monde entier. Cette forme d'exploitation ne donnera lieu à aucun versement de droits d'auteur.</text:p>

  <text:p text:style-name="ArticleTitle">Article 5 · Mesures de protection technique</text:p>
  <text:p>Par la signature du présent avenant, l'Auteur reconnaît être informé que l'Éditeur peut recourir à des mesures techniques de protection et/ou des informations sous forme électronique pour l'exploitation de l'œuvre. Ce recours peut résulter de choix commerciaux ou de nécessités techniques et peut notamment avoir pour finalité la gestion des autorisations accordées, la protection de l'œuvre contre des actes non autorisés par la loi ou l'Éditeur, ainsi que l'identification de l'œuvre et le suivi de son utilisation.</text:p>
  <text:p>L'Auteur pourra, s'il en fait la demande écrite, obtenir de l'Éditeur des informations relatives aux caractéristiques des mesures techniques effectivement employées pour assurer l'exploitation de l'œuvre précitée.</text:p>

  <text:p text:style-name="ArticleTitle">Article 6 · Compétence</text:p>
  <text:p>Le présent avenant, dans son intégralité, engage les héritiers et tous les ayants droit de l'Auteur. Pour toutes contestations pouvant naître à l'occasion du présent avenant, attribution de juridiction est faite aux tribunaux compétents de Dakar. Les autres dispositions du contrat d'édition restent inchangées.</text:p>

${buildSignatureBlock(false)}
`;
}

// ═══════════════════════════════════════════════════════════
// Avenant audiovisuel (articles 1 à 8 — texte du modèle officiel)
// ═══════════════════════════════════════════════════════════
function buildAudiovisualAnnex(variant) {
  const cfg = VARIANTS[variant];
  const editor = cfg.editorLong;
  return `
  <text:p text:style-name="SectionTitle">CESSION DES DROITS D'ADAPTATION AUDIOVISUELLE</text:p>
  <text:p text:style-name="SectionSubtitle">Avenant au contrat d'édition</text:p>

  <text:p text:style-name="Preamble">Par contrat conclu en date du {object_date}, l'Auteur a cédé à l'Éditeur le droit exclusif d'imprimer, publier, reproduire et vendre l'ouvrage intitulé <text:span text:style-name="Bold">« {object_options_book_title} »</text:span>. Aux termes de ce contrat, l'Éditeur s'est engagé à publier l'œuvre graphique, à lui assurer une exploitation permanente et suivie et à permettre par tous moyens appropriés sa promotion&#160;; ainsi les contractants ont un intérêt commun à ce que l'œuvre éditée connaisse la plus large exploitation possible, notamment par voie d'adaptations audiovisuelles. Dès lors, l'Éditeur s'engage à susciter l'adaptation audiovisuelle de l'œuvre, et il a été convenu ce qui suit&#160;:</text:p>

  <text:p text:style-name="ArticleTitle">Article 1 · Droit cédé</text:p>
  <text:p>L'Auteur cède à l'Éditeur, qui accepte pour lui et ses ayants droit, les droits d'exploitation audiovisuelle attachés à l'œuvre graphique, au moyen de tout enregistrement sonore et visuel, et pour tous supports actuels ou futurs de reproduction et de représentation, notamment pour l'exploitation cinématographique, vidéographique et télévisuelle.</text:p>

  <text:p text:style-name="ArticleTitle">Article 2 · Étendue de la cession</text:p>
  <text:p>La cession est consentie pour la durée de la propriété littéraire fixée par les lois sénégalaises, étrangères et les conventions internationales actuelles et futures. Elle est accordée à titre exclusif pour tous les pays et toutes les langues. Elle porte sur les droits d'adaptation de tout ou partie de l'œuvre sous forme d'œuvres audiovisuelles de toutes natures consistant en des séquences animées d'images sonorisées ou non, et sur l'ensemble des droits de reproduction et de représentation afférents à ces adaptations. Ces droits comprennent notamment&#160;:</text:p>
  <text:p text:style-name="ListItem">–  le droit d'adapter tout ou partie de l'œuvre en toutes langues pour le cinéma, la télévision et, en général, tout mode d'exploitation actuel ou futur des œuvres audiovisuelles&#160;;</text:p>
  <text:p text:style-name="ListItem">–  le droit de reproduire tout ou partie de ces adaptations sur tous supports actuels ou futurs (films, bandes magnétiques, vidéo-disques ou autres) et de communiquer ces reproductions au public par tous les moyens (vente, location ou autres)&#160;;</text:p>
  <text:p text:style-name="ListItem">–  le droit de représenter tout ou partie de ces adaptations par tous procédés actuels ou futurs, notamment projection publique et télédiffusion par tous moyens (câble, Internet, voie hertzienne, satellite, transmission dans un lieu public de l'œuvre télédiffusée).</text:p>

  <text:p text:style-name="ArticleTitle">Article 3 · Obligations de l'Éditeur</text:p>
  <text:p>L'Éditeur s'engage à rechercher une exploitation des droits cédés conformément aux usages de la profession. Il est habilité à conclure à cet effet tout contrat, notamment de mandat, de cession ou de production audiovisuelle avec des tiers&#160;; l'Auteur s'engageant à transmettre à l'Éditeur les demandes d'adaptation dont il pourrait être saisi directement. L'Auteur sera informé par l'Éditeur de la conclusion de ces contrats.</text:p>

  <text:p text:style-name="ArticleTitle">Article 4 · Régime des droits d'auteur en cas d'adaptation</text:p>
  <text:p text:style-name="Callout">En cas d'exploitation directe des droits par l'Éditeur ou de conclusion d'un contrat avec un tiers, l'Éditeur devra à l'Auteur <text:span text:style-name="AccentBold">50&#160;%</text:span> de toutes les recettes perçues au titre de l'exploitation de l'adaptation audiovisuelle, déduction faite des frais ou commissions assumées par l'Éditeur.</text:p>
  <text:p>Chacune des cessions donnera lieu à des relevés de comptes distincts, et la part revenant à l'Auteur sur toutes les recettes d'exploitation de l'œuvre lui sera réglée dans les trois mois suivant chaque perception par l'Éditeur.</text:p>

  <text:p text:style-name="ArticleTitle">Article 5 · Fin du contrat</text:p>
  <text:p>Dans le cas où toutes les éditions de l'œuvre auxquelles aura procédé l'Éditeur viendraient à être épuisées, le présent contrat serait résilié de plein droit, sauf convention particulière, si l'Éditeur ne procédait pas, par lui-même ou par cessionnaire, à une réimpression dans un délai d'un an à compter de la mise en demeure, par lettre recommandée avec accusé de réception, qui lui serait faite par l'Auteur.</text:p>
  <text:p text:style-name="ListItem">–  Il s'agira d'une résiliation partielle s'il y a une exploitation audiovisuelle&#160;: le présent contrat continuera à produire ses effets pour cette exploitation&#160;;</text:p>
  <text:p text:style-name="ListItem">–  Il s'agira d'une résiliation totale si aucune convention relative à une exploitation audiovisuelle n'est intervenue&#160;: l'Auteur recouvre alors la libre disposition de ses droits après expiration de la période d'exclusivité.</text:p>

  <text:p text:style-name="ArticleTitle">Article 6 · Dispositions diverses</text:p>
  <text:p>L'Auteur garantit à l'Éditeur la jouissance des droits cédés et conférés par le présent contrat contre tous troubles, revendications et évictions quelconques. Les héritiers et ayants droit de l'Auteur sont tenus par l'ensemble des dispositions contenues dans le présent contrat.</text:p>

  <text:p text:style-name="ArticleTitle">Article 7 · Différend</text:p>
  <text:p>Tout différend pouvant naître à l'occasion du présent contrat sera soumis à une conciliation, préalablement à tout recours devant les tribunaux. Pour tout litige non résolu de façon amiable, attribution de juridiction est faite aux tribunaux compétents de Dakar.</text:p>

  <text:p text:style-name="ArticleTitle">Article 8 · TVA</text:p>
  <text:p>Les droits d'auteur issus de l'exécution du présent contrat sont assujettis à la TVA au taux de <text:span text:style-name="Bold">18&#160;%</text:span>, payable par l'Éditeur. En conséquence, les sommes précisées dans le contrat s'entendent nettes.</text:p>

${buildSignatureBlock(false)}
`;
}

// ═══════════════════════════════════════════════════════════
// Avenant théâtral (articles 1 à 8 — texte du modèle officiel)
// ═══════════════════════════════════════════════════════════
function buildTheatreAnnex(variant) {
  const cfg = VARIANTS[variant];
  const editor = cfg.editorLong;
  return `
  <text:p text:style-name="SectionTitle">CESSION DES DROITS D'ADAPTATION THÉÂTRALE</text:p>
  <text:p text:style-name="SectionSubtitle">Avenant au contrat d'édition</text:p>

  <text:p text:style-name="Preamble">Par contrat conclu en date du {object_date}, l'Auteur a cédé à l'Éditeur le droit exclusif d'imprimer, publier, reproduire et vendre l'ouvrage intitulé <text:span text:style-name="Bold">« {object_options_book_title} »</text:span>. Aux termes de ce contrat, l'Éditeur s'est engagé à publier l'œuvre graphique, à lui assurer une exploitation permanente et suivie et à permettre par tous moyens appropriés sa promotion&#160;; ainsi les contractants ont un intérêt commun à ce que l'œuvre éditée connaisse la plus large exploitation possible, notamment par voie d'adaptations théâtrales. Dès lors, l'Éditeur s'engage à susciter l'adaptation théâtrale de l'œuvre, et il a été convenu ce qui suit&#160;:</text:p>

  <text:p text:style-name="ArticleTitle">Article 1 · Droit cédé</text:p>
  <text:p>L'Auteur cède à l'Éditeur, qui accepte pour lui et ses ayants droit, les droits d'exploitation théâtrale attachés à l'œuvre graphique.</text:p>

  <text:p text:style-name="ArticleTitle">Article 2 · Étendue de la cession</text:p>
  <text:p>La cession est consentie pour la durée de la propriété littéraire fixée par les lois sénégalaises, étrangères et les conventions internationales actuelles et futures. Elle est accordée à titre exclusif pour tous les pays et toutes les langues. Elle porte sur les droits d'adaptation de tout ou partie de l'œuvre sous forme d'œuvres théâtrales de toutes natures&#160;:</text:p>
  <text:p text:style-name="ListItem">–  le droit d'adapter tout ou partie de l'œuvre en toutes langues pour le théâtre et, en général, tout mode d'exploitation actuel ou futur des œuvres, le droit de faire lire ou réciter l'ouvrage en public&#160;;</text:p>
  <text:p text:style-name="ListItem">–  le droit d'exploiter séparément par voie d'adaptation, de reproduction et de représentation tout élément de l'œuvre, et notamment ses personnages.</text:p>

  <text:p text:style-name="ArticleTitle">Article 3 · Obligations de l'Éditeur</text:p>
  <text:p>L'Éditeur s'engage à rechercher une exploitation des droits cédés conformément aux usages de la profession. Il est habilité à conclure à cet effet tout contrat, notamment de mandat, de cession ou de production théâtrale avec des tiers&#160;; l'Auteur s'engageant à transmettre à l'Éditeur les demandes d'adaptation dont il pourrait être saisi directement. L'Auteur sera informé par l'Éditeur de la conclusion de ces contrats.</text:p>

  <text:p text:style-name="ArticleTitle">Article 4 · Régime des droits d'auteur en cas d'adaptation</text:p>
  <text:p text:style-name="Callout">En cas d'exploitation directe des droits par l'Éditeur ou de conclusion d'un contrat avec un tiers, l'Éditeur devra à l'Auteur <text:span text:style-name="AccentBold">50&#160;%</text:span> de toutes les recettes perçues au titre de l'exploitation de l'adaptation théâtrale, déduction faite des frais ou commissions assumées par l'Éditeur.</text:p>
  <text:p>Chacune des cessions donnera lieu à des relevés de comptes distincts, et la part revenant à l'Auteur sur toutes les recettes d'exploitation de l'œuvre lui sera réglée dans les trois mois suivant chaque perception par l'Éditeur.</text:p>

  <text:p text:style-name="ArticleTitle">Article 5 · Fin du contrat</text:p>
  <text:p>Dans le cas où toutes les éditions de l'œuvre auxquelles aura procédé l'Éditeur viendraient à être épuisées, le présent contrat serait résilié de plein droit, sauf convention particulière, si l'Éditeur ne procédait pas, par lui-même ou par cessionnaire, à une réimpression dans un délai d'un an à compter de la mise en demeure, par lettre recommandée avec accusé de réception, qui lui serait faite par l'Auteur.</text:p>

  <text:p text:style-name="ArticleTitle">Article 6 · Dispositions diverses</text:p>
  <text:p>L'Auteur garantit à l'Éditeur la jouissance des droits cédés et conférés par le présent contrat contre tous troubles, revendications et évictions quelconques. Les héritiers et ayants droit de l'Auteur sont tenus par l'ensemble des dispositions contenues dans le présent contrat.</text:p>

  <text:p text:style-name="ArticleTitle">Article 7 · Différend</text:p>
  <text:p>Tout différend pouvant naître à l'occasion du présent contrat sera soumis à une conciliation, préalablement à tout recours devant les tribunaux. Pour tout litige non résolu de façon amiable, attribution de juridiction est faite aux tribunaux compétents de Dakar.</text:p>

  <text:p text:style-name="ArticleTitle">Article 8 · TVA</text:p>
  <text:p>Les droits d'auteur issus de l'exécution du présent contrat sont assujettis à la TVA au taux de <text:span text:style-name="Bold">18&#160;%</text:span>, payable par l'Éditeur. En conséquence, les sommes précisées dans le contrat s'entendent nettes.</text:p>

${buildSignatureBlock(false)}
`;
}

// ═══════════════════════════════════════════════════════════
// Annexe — Engagement d'achat de l'Auteur (page « Annexes » du modèle)
// ═══════════════════════════════════════════════════════════
function buildAuthorPurchaseAnnex() {
  return `
  <text:p text:style-name="SectionTitle">ANNEXE</text:p>
  <text:p text:style-name="SectionSubtitle">Engagement d'achat de l'Auteur</text:p>

  <text:p text:style-name="Preamble">Par contrat conclu en date du {object_date}, l'Auteur a cédé à l'Éditeur le droit exclusif d'imprimer, publier, reproduire et vendre l'ouvrage intitulé <text:span text:style-name="Bold">« {object_options_book_title} »</text:span>.</text:p>

  <text:p text:style-name="Callout">Si l'engagement d'achat de l'Auteur est activé pour ce contrat, l'Auteur s'engage à acheter <text:span text:style-name="AccentBold">{object_options_author_purchase_qty} exemplaires</text:span> de son ouvrage, sur la base du <text:span text:style-name="Bold">prix public moins {object_options_author_purchase_discount} %</text:span>. Les exemplaires achetés par l'Auteur sur ces bases seront comptabilisés pour le calcul des droits.</text:p>

  <text:p text:style-name="AuthorInlineSign">(Signature de l'Auteur&#160;: ………………….)</text:p>

  <text:p text:style-name="SmallMuted">— Engagement actif uniquement si la quantité indiquée est supérieure à 0. —</text:p>
`;
}

// ═══════════════════════════════════════════════════════════
// Bloc signature (commun) — withOnline = true uniquement pour le
// contrat principal (le lien de signature en ligne vaut pour l'ensemble).
// ═══════════════════════════════════════════════════════════
function buildSignatureBlock(withOnline) {
  return `
  <text:p>Fait à <text:span text:style-name="Bold">Dakar</text:span> le <text:span text:style-name="Bold">{object_options_date_signature}</text:span>, en deux exemplaires originaux.</text:p>

  <text:p text:style-name="SignHeader">SIGNATURES DES PARTIES</text:p>

  <table:table table:name="SignTable" table:style-name="SignTable">
   <table:table-column table:style-name="SignColumn"/>
   <table:table-column table:style-name="SignColumn"/>
   <table:table-row>
    <table:table-cell table:style-name="SignCell">
     <text:p text:style-name="SignLine"><text:span text:style-name="AccentBold">L'ÉDITEUR</text:span></text:p>
     <text:p text:style-name="SignLine">{object_options_editeur_signataire_nom}</text:p>
     <text:p text:style-name="SignMention">{object_options_editeur_signataire_qualite}</text:p>
     <text:p text:style-name="SignatureBox">Signature et cachet</text:p>
    </table:table-cell>
    <table:table-cell table:style-name="SignCell">
     <text:p text:style-name="SignLine"><text:span text:style-name="AccentBold">L'AUTEUR</text:span></text:p>
     <text:p text:style-name="SignLine">{__THIRDPARTY_NAME__}</text:p>
     <text:p text:style-name="SignMention">Mention manuscrite « Lu et approuvé »</text:p>
     <text:p text:style-name="SignatureBox">Date et signature</text:p>
    </table:table-cell>
   </table:table-row>
  </table:table>
${withOnline ? `
  <text:p text:style-name="SmallMuted">Signature en ligne possible à l'adresse suivante&#160;: {__ONLINE_SIGN_URL__}</text:p>` : ''}
`;
}

// ═══════════════════════════════════════════════════════════
// content.xml — orchestration
// ═══════════════════════════════════════════════════════════
function buildContent(variant) {
  const cfg = VARIANTS[variant];
  const sections = [];

  sections.push(buildMainContract(variant));

  if (cfg.annexes.includes('digital')) sections.push(buildDigitalAnnex(variant));
  if (cfg.annexes.includes('audiovisual')) sections.push(buildAudiovisualAnnex(variant));
  if (cfg.annexes.includes('theatre')) sections.push(buildTheatreAnnex(variant));
  if (cfg.annexes.includes('purchase')) sections.push(buildAuthorPurchaseAnnex());

  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  office:version="1.2">
 <office:automatic-styles/>
 <office:body>
  <office:text>
${sections.join('\n')}
  </office:text>
 </office:body>
</office:document-content>`;
}

// ═══════════════════════════════════════════════════════════
// meta.xml
// ═══════════════════════════════════════════════════════════
function buildMeta(variant) {
  const cfg = VARIANTS[variant];
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.2">
 <office:meta>
  <meta:creation-date>${new Date().toISOString()}</meta:creation-date>
  <dc:title>Contrat d'édition · ${esc(cfg.label)} — ${esc(cfg.editorLong)}</dc:title>
  <dc:creator>${esc(cfg.editorLong)}</dc:creator>
  <meta:generator>senharmattan-shop contract generator v4 (modèle janvier 2024)</meta:generator>
 </office:meta>
</office:document-meta>`;
}

// ═══════════════════════════════════════════════════════════
// manifest.xml
// ═══════════════════════════════════════════════════════════
const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
 <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
 <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
 <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
 <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;

// ═══════════════════════════════════════════════════════════
// Packaging ODT
// ═══════════════════════════════════════════════════════════
function packageOdt(variant, outPath) {
  const workDir = join(WORK_DIR, variant);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, 'META-INF'), { recursive: true });

  writeFileSync(join(workDir, 'mimetype'), 'application/vnd.oasis.opendocument.text', { encoding: 'utf8' });
  writeFileSync(join(workDir, 'META-INF/manifest.xml'), MANIFEST);
  writeFileSync(join(workDir, 'content.xml'), buildContent(variant));
  writeFileSync(join(workDir, 'styles.xml'), buildStyles(variant));
  writeFileSync(join(workDir, 'meta.xml'), buildMeta(variant));

  if (existsSync(outPath)) rmSync(outPath);
  execSync(`cd ${workDir} && zip -q -X -0 ${outPath} mimetype && zip -q -r -X ${outPath} META-INF content.xml styles.xml meta.xml`);
  console.log(`  ✓ ${outPath} (${execSync(`du -h ${outPath}`).toString().trim().split(/\s+/)[0]})`);
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════
rmSync(OUT_DIR, { recursive: true, force: true });
rmSync(WORK_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(WORK_DIR, { recursive: true });

console.log('Génération des templates ODT (modèle officiel janvier 2024)...\n');
for (const variant of Object.keys(VARIANTS)) {
  packageOdt(variant, join(OUT_DIR, `template_${variant}.odt`));
}

console.log(`\nDone. Fichiers prêts dans ${OUT_DIR}`);
console.log('Déploiement (nécessite sudo) :');
console.log(`  sudo cp ${OUT_DIR}/*.odt /var/www/html/dolibarr/documents/doctemplates/contracts/`);
console.log(`  sudo chown www-data:www-data /var/www/html/dolibarr/documents/doctemplates/contracts/template_*.odt`);
