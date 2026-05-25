#!/usr/bin/env node
/**
 * Génère les templates ODT de contrats d'édition pour L'Harmattan Sénégal.
 *
 *   Combinaisons actives :
 *     template_harmattan_2024_edition_simple.odt
 *     template_harmattan_2024_edition_numerique.odt
 *     template_harmattan_2024_edition_complete.odt
 *     template_harmattan_dll_edition_simple.odt
 *     template_harmattan_dll_edition_numerique.odt
 *     template_harmattan_dll_edition_complete.odt
 *     template_tamarinier_edition_simple.odt
 *     template_tamarinier_edition_numerique.odt
 *     template_tamarinier_edition_complete.odt
 *
 *   Quelques anciens noms restent générés pour compatibilité.
 *
 * Sortie dans /tmp/contract-templates-v2/.
 *
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

// ═══════════════════════════════════════════════════════════
// CONFIGURATION PAR VARIANTE
// ═══════════════════════════════════════════════════════════
const CONTRACT_MODELS = {
  harmattan_2024: {
    label: "Harmattan · classique",
    editorLong: "L'Harmattan Sénégal",
    editorShort: "L'Harmattan Sénégal",
    footer: "L'HARMATTAN SÉNÉGAL SARL · 10 VDN Sicap Amitié 3 · BP 45034 Dakar · RC SN DKR 2009-B-11.042 · NINEA 004067155",
    article4: 'classic',
  },
  harmattan_dll: {
    label: "Harmattan · DLL (subventionné)",
    editorLong: "L'Harmattan Sénégal",
    editorShort: "L'Harmattan Sénégal",
    footer: "L'HARMATTAN SÉNÉGAL SARL · 10 VDN Sicap Amitié 3 · BP 45034 Dakar · RC SN DKR 2009-B-11.042 · NINEA 004067155",
    article4: 'dll',
  },
  tamarinier: {
    label: "Le Tamarinier",
    editorLong: "Le Tamarinier (s/c L'Harmattan Sénégal)",
    editorShort: "Le Tamarinier",
    footer: "LE TAMARINIER (s/c L'HARMATTAN SÉNÉGAL) · 10 VDN Sicap Amitié 3 · BP 45034 Dakar · RC SN DKR 2009-B-11.042 · NINEA 004067155",
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
   <style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0.18cm" fo:line-height="140%" fo:text-align="justify"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="11pt" fo:language="fr" fo:country="FR" fo:color="#1a1a1a"/>
  </style:default-style>

  <style:style style:name="CoverTitle" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:margin-top="0.5cm" fo:margin-bottom="0.3cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="26pt" fo:font-weight="bold" fo:letter-spacing="0.08cm" fo:color="${COLOR_PRIMARY}"/>
  </style:style>
  <style:style style:name="CoverSubtitle" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:margin-bottom="0.15cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="11pt" fo:letter-spacing="0.06cm" fo:color="${COLOR_MUTED}"/>
  </style:style>
  <style:style style:name="CoverBookTitle" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:margin-top="1.5cm" fo:margin-bottom="0.2cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="20pt" fo:font-style="italic" fo:font-weight="bold" fo:color="#1a1a1a"/>
  </style:style>
  <style:style style:name="CoverAuthor" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:margin-bottom="1.8cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="14pt" fo:color="#404040"/>
  </style:style>
  <style:style style:name="CoverPartiesTitle" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:margin-top="1.2cm" fo:margin-bottom="0.3cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="9pt" fo:font-weight="bold" fo:letter-spacing="0.08cm" fo:color="${COLOR_MUTED}"/>
  </style:style>
  <style:style style:name="CoverPartyName" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:margin-bottom="0.08cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="12pt" fo:font-weight="bold" fo:color="#1a1a1a"/>
  </style:style>
  <style:style style:name="CoverPartyInfo" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:margin-bottom="0.08cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="10pt" fo:color="#404040"/>
  </style:style>

  <style:style style:name="SectionTitle" style:family="paragraph">
   <style:paragraph-properties fo:break-before="page" fo:text-align="center" fo:margin-top="1cm" fo:margin-bottom="0.2cm" fo:border-bottom="1pt solid ${COLOR_PRIMARY}" fo:padding-bottom="0.25cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="18pt" fo:font-weight="bold" fo:letter-spacing="0.06cm" fo:color="${COLOR_PRIMARY}"/>
  </style:style>
  <style:style style:name="SectionSubtitle" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:margin-bottom="0.8cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="10pt" fo:letter-spacing="0.04cm" fo:color="${COLOR_MUTED}" fo:font-style="italic"/>
  </style:style>

  <style:style style:name="ArticleTitle" style:family="paragraph">
   <style:paragraph-properties fo:margin-top="0.55cm" fo:margin-bottom="0.2cm" fo:keep-with-next="always" fo:border-top="0.5pt solid ${COLOR_DIVIDER}" fo:padding-top="0.2cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="11.5pt" fo:font-weight="bold" fo:color="${COLOR_PRIMARY}"/>
  </style:style>
  <style:style style:name="SubArticle" style:family="paragraph">
   <style:paragraph-properties fo:margin-top="0.25cm" fo:margin-bottom="0.1cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="10.5pt" fo:font-weight="bold" fo:color="#1a1a1a"/>
  </style:style>

  <style:style style:name="Preamble" style:family="paragraph">
   <style:paragraph-properties fo:background-color="${COLOR_ACCENT_BG}" fo:border-left="3pt solid ${COLOR_PRIMARY}" fo:padding="0.3cm 0.5cm" fo:margin-top="0.3cm" fo:margin-bottom="0.4cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="10.5pt" fo:font-style="italic"/>
  </style:style>
  <style:style style:name="Callout" style:family="paragraph">
   <style:paragraph-properties fo:background-color="#fef9c3" fo:border="0.5pt solid #eab308" fo:padding="0.25cm 0.4cm" fo:margin-top="0.3cm" fo:margin-bottom="0.3cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="11pt"/>
  </style:style>

  <style:style style:name="SignHeader" style:family="paragraph">
   <style:paragraph-properties fo:margin-top="0.8cm" fo:text-align="center"/>
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
  <style:style style:name="HeaderRef" style:family="paragraph">
   <style:paragraph-properties fo:text-align="left" fo:border-bottom="0.5pt solid ${COLOR_PRIMARY}" fo:padding-bottom="0.15cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="8.5pt" fo:color="${COLOR_MUTED}"/>
  </style:style>

  <style:style style:name="ConditionCellInner" style:family="table-cell">
   <style:table-cell-properties fo:padding="0.18cm 0.3cm" fo:border-bottom="0.3pt solid ${COLOR_DIVIDER}"/>
  </style:style>
  <style:style style:name="ConditionCellInnerLast" style:family="table-cell">
   <style:table-cell-properties fo:padding="0.18cm 0.3cm"/>
  </style:style>
  <style:style style:name="CondLabel" style:family="paragraph">
   <style:paragraph-properties fo:text-align="left" fo:margin-bottom="0cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="9pt" fo:color="${COLOR_MUTED}" fo:letter-spacing="0.05cm"/>
  </style:style>
  <style:style style:name="CondValue" style:family="paragraph">
   <style:paragraph-properties fo:text-align="right" fo:margin-bottom="0cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="11pt" fo:font-weight="bold" fo:color="#1a1a1a"/>
  </style:style>
  <style:style style:name="CondValuePrimary" style:family="paragraph">
   <style:paragraph-properties fo:text-align="right" fo:margin-bottom="0cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="12pt" fo:font-weight="bold" fo:color="${COLOR_PRIMARY}"/>
  </style:style>
  <style:style style:name="ConditionTable" style:family="table">
   <style:table-properties style:width="14cm" table:align="center" fo:margin-top="1cm" fo:margin-bottom="1cm"/>
  </style:style>
  <style:style style:name="SignTable" style:family="table">
   <style:table-properties style:width="17cm" table:align="center" fo:margin-top="0.6cm"/>
  </style:style>
  <style:style style:name="SignColumn" style:family="table-column">
   <style:table-column-properties style:column-width="8.5cm"/>
  </style:style>
  <style:style style:name="SignCell" style:family="table-cell">
   <style:table-cell-properties fo:border="0.5pt solid ${COLOR_DIVIDER}" fo:padding="0.4cm"/>
  </style:style>
  <style:style style:name="SignatureBox" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:border="0.3pt dashed ${COLOR_MUTED}" fo:background-color="#fafafa" fo:padding="1.5cm 0.5cm" fo:margin-top="0.4cm" fo:margin-bottom="0.2cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="8pt" fo:color="${COLOR_MUTED}"/>
  </style:style>
 </office:styles>

 <office:automatic-styles>
  <style:page-layout style:name="pm1">
   <style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm"
     fo:margin-top="2.5cm" fo:margin-bottom="2.2cm" fo:margin-left="2.2cm" fo:margin-right="2.2cm"/>
   <style:header-style>
    <style:header-footer-properties fo:min-height="1cm" fo:margin-bottom="0.4cm"/>
   </style:header-style>
   <style:footer-style>
    <style:header-footer-properties fo:min-height="1cm" fo:margin-top="0.4cm"/>
   </style:footer-style>
  </style:page-layout>
  <style:page-layout style:name="pm_cover">
   <style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm"
     fo:margin-top="2cm" fo:margin-bottom="1.5cm" fo:margin-left="2cm" fo:margin-right="2cm"/>
  </style:page-layout>
 </office:automatic-styles>

 <office:master-styles>
  <style:master-page style:name="Cover" style:page-layout-name="pm_cover">
   <style:footer>
    <text:p text:style-name="SmallMuted">${esc(cfg.footer)}</text:p>
   </style:footer>
  </style:master-page>
  <style:master-page style:name="Standard" style:page-layout-name="pm1" style:next-style-name="Standard">
   <style:header>
    <text:p text:style-name="HeaderRef">Contrat d'édition · Réf. <text:span text:style-name="Bold">{object_ref}</text:span> · {__THIRDPARTY_NAME__} — {object_options_book_title}</text:p>
   </style:header>
   <style:footer>
    <text:p text:style-name="FooterCenter">${esc(cfg.editorShort.toUpperCase())} · Page <text:page-number/> / <text:page-count/></text:p>
    <text:p text:style-name="SmallMuted">${esc(cfg.footer)}</text:p>
   </style:footer>
  </style:master-page>
 </office:master-styles>
</office:document-styles>`;
}

// ═══════════════════════════════════════════════════════════
// Page de garde
// ═══════════════════════════════════════════════════════════
function buildCoverPage(variant) {
  const cfg = VARIANTS[variant];
  return `
  <text:p text:style-name="CoverSubtitle">${esc(cfg.editorLong.toUpperCase())}</text:p>
  <text:p text:style-name="CoverTitle">CONTRAT D'ÉDITION</text:p>
  <text:p text:style-name="CoverSubtitle">${esc(cfg.label)}</text:p>

  <text:p text:style-name="CoverBookTitle">« {object_options_book_title} »</text:p>
  <text:p text:style-name="CoverAuthor">{__THIRDPARTY_NAME__}</text:p>

  <table:table table:name="ConditionTable" table:style-name="ConditionTable">
   <table:table-column/>
   <table:table-column/>
   <table:table-row>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondLabel">RÉFÉRENCE</text:p>
    </table:table-cell>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondValuePrimary">{object_ref}</text:p>
    </table:table-cell>
   </table:table-row>
   <table:table-row>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondLabel">TYPE DE CONTRAT</text:p>
    </table:table-cell>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondValue">${esc(cfg.label)}</text:p>
    </table:table-cell>
   </table:table-row>
   <table:table-row>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondLabel">DATE DU CONTRAT</text:p>
    </table:table-cell>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondValue">{object_date}</text:p>
    </table:table-cell>
   </table:table-row>
   <table:table-row>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondLabel">OUVRAGE</text:p>
    </table:table-cell>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondValue">{object_options_book_title}</text:p>
    </table:table-cell>
   </table:table-row>
   <table:table-row>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondLabel">SOUS-TITRE</text:p>
    </table:table-cell>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondValue">{object_options_book_subtitle}</text:p>
    </table:table-cell>
   </table:table-row>
   <table:table-row>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondLabel">ISBN</text:p>
    </table:table-cell>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondValue">{object_options_book_isbn}</text:p>
    </table:table-cell>
   </table:table-row>
   <table:table-row>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondLabel">FORMAT</text:p>
    </table:table-cell>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondValue">{object_options_format_ouvrage}</text:p>
    </table:table-cell>
   </table:table-row>
   <table:table-row>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondLabel">TIRAGE INITIAL</text:p>
    </table:table-cell>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondValue">{object_options_tirage_initial} exemplaires</text:p>
    </table:table-cell>
   </table:table-row>
   <table:table-row>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondLabel">ROYALTIES PAPIER</text:p>
    </table:table-cell>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondValuePrimary">{object_options_royalty_rate_print} %</text:p>
    </table:table-cell>
   </table:table-row>
   <table:table-row>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondLabel">ROYALTIES NUMÉRIQUE</text:p>
    </table:table-cell>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondValuePrimary">{object_options_royalty_rate_digital} %</text:p>
    </table:table-cell>
   </table:table-row>
   <table:table-row>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondLabel">SEUIL DE VERSEMENT</text:p>
    </table:table-cell>
    <table:table-cell table:style-name="ConditionCellInner">
     <text:p text:style-name="CondValue">à partir de {object_options_royalty_threshold} exemplaires</text:p>
    </table:table-cell>
   </table:table-row>
   <table:table-row>
    <table:table-cell table:style-name="ConditionCellInnerLast">
     <text:p text:style-name="CondLabel">EXEMPLAIRES AUTEUR</text:p>
    </table:table-cell>
    <table:table-cell table:style-name="ConditionCellInnerLast">
     <text:p text:style-name="CondValue">{object_options_free_author_copies} exemplaires</text:p>
    </table:table-cell>
   </table:table-row>
  </table:table>

  <text:p text:style-name="CoverPartiesTitle">ENTRE LES PARTIES</text:p>
  <table:table table:name="PartiesTable">
   <table:table-column table:style-name="SignColumn"/>
   <table:table-column table:style-name="SignColumn"/>
   <table:table-row>
    <table:table-cell>
     <text:p text:style-name="CoverPartyName">${esc(cfg.editorLong)}</text:p>
     <text:p text:style-name="CoverPartyInfo">10 VDN, Sicap Amitié 3</text:p>
     <text:p text:style-name="CoverPartyInfo">BP 45034 Dakar, Sénégal</text:p>
     <text:p text:style-name="CoverPartyInfo">L'Éditeur</text:p>
    </table:table-cell>
    <table:table-cell>
     <text:p text:style-name="CoverPartyName">{__THIRDPARTY_NAME__}</text:p>
     <text:p text:style-name="CoverPartyInfo">{__THIRDPARTY_ADDRESS__}</text:p>
     <text:p text:style-name="CoverPartyInfo">{__THIRDPARTY_ZIP__} {__THIRDPARTY_TOWN__}</text:p>
     <text:p text:style-name="CoverPartyInfo">{__THIRDPARTY_PHONE__} · {__THIRDPARTY_EMAIL__}</text:p>
     <text:p text:style-name="CoverPartyInfo">L'Auteur</text:p>
    </table:table-cell>
   </table:table-row>
  </table:table>
`;
}

// ═══════════════════════════════════════════════════════════
// Article 4 — variantes (classique vs DLL)
// ═══════════════════════════════════════════════════════════
function buildArticle4Classic(editor) {
  return `
  <text:p text:style-name="ArticleTitle">Article 4 · Droits d'auteur et exemplaires de l'Auteur</text:p>
  <text:p>Le droit d'auteur au Sénégal est régi par la loi n°&#160;2008-09 du 25 janvier 2008 relative au droit d'auteur et aux droits voisins et le décret n°&#160;2015-682 du 26 mai 2015 pris pour son application.</text:p>

  <text:p text:style-name="SubArticle">4.1 · Cession à titre onéreux</text:p>
  <text:p>La cession des droits, objet du présent contrat, est consentie expressément par l'Auteur à titre onéreux à partir du premier (1) exemplaire vendu.</text:p>
  <text:p text:style-name="Callout">${esc(editor)} versera à l'Auteur, à compter du premier exemplaire vendu, un taux de <text:span text:style-name="AccentBold">{object_options_royalty_rate_print} %</text:span> du chiffre d'affaires réalisé à la vente du livre, une fois la barre des <text:span text:style-name="AccentBold">{object_options_royalty_threshold} exemplaires</text:span> vendus atteinte.</text:p>
  <text:p>Ces versements ont pour assiette le prix de vente public au Sénégal.</text:p>
  <text:p>Les droits d'auteur ne portent pas sur les exemplaires remis gratuitement à l'Auteur, ni sur ceux réservés au service de presse (<text:span text:style-name="Bold">{object_options_exemplaires_sp}</text:span> exemplaires), ni sur les exemplaires cédés à prix réduit (remise supérieure à 50&#160;% du prix public).</text:p>

  <text:p text:style-name="SubArticle">4.2 · Exemplaires de l'Auteur</text:p>
  <text:p>L'Auteur disposera sur le premier tirage, pour son usage personnel, de <text:span text:style-name="AccentBold">{object_options_free_author_copies} exemplaires</text:span> remis gratuitement (dits « exemplaires d'auteur »). Les exemplaires supplémentaires lui seront facturés avec 30&#160;% de remise sur le prix catalogue.</text:p>
`;
}

function buildArticle4DLL(editor) {
  return `
  <text:p text:style-name="ArticleTitle">Article 4 · Droits d'auteur et exemplaires de l'Auteur</text:p>
  <text:p>Le droit d'auteur au Sénégal est régi par la loi n°&#160;2008-09 du 25 janvier 2008 relative au droit d'auteur et aux droits voisins et le décret n°&#160;2015-682 du 26 mai 2015 pris pour son application.</text:p>

  <text:p text:style-name="SubArticle">4.1 · Cession à titre onéreux (ouvrage subventionné DLL)</text:p>
  <text:p>La présente cession des droits de l'Auteur est expressément convenue selon les modalités contenues dans le contrat que l'Éditeur a signé avec la <text:span text:style-name="Bold">Direction du Livre et de la Lecture du Sénégal (DLL)</text:span>, en ses articles 3 et 6.</text:p>
  <text:p text:style-name="Callout">${esc(editor)} versera à l'Auteur <text:span text:style-name="AccentBold">{object_options_royalty_rate_print} %</text:span> en droits d'auteur sur les <text:span text:style-name="AccentBold">{object_options_royalty_threshold} premiers exemplaires</text:span> subventionnés par la DLL. Au-delà, l'Éditeur s'engage à verser <text:span text:style-name="AccentBold">10&#160;%</text:span> en droits d'auteur sur tout exemplaire vendu.</text:p>
  <text:p>Les droits d'auteur ne portent pas sur les exemplaires remis à la DLL (100 exemplaires) et à l'Auteur (50 exemplaires), ni sur ceux réservés au Service de Presse (<text:span text:style-name="Bold">{object_options_exemplaires_sp}</text:span> exemplaires), ni sur les exemplaires cédés à prix réduit (remise supérieure à 50&#160;% du prix public).</text:p>
  <text:p>L'Auteur autorise l'Éditeur à mettre son ouvrage en ligne, en ebook et en consultation partielle sur Google pour faire connaître le contenu et générer des occurrences.</text:p>

  <text:p text:style-name="SubArticle">4.2 · Exemplaires de l'Auteur</text:p>
  <text:p>L'Auteur disposera sur le premier tirage, pour son usage personnel, de <text:span text:style-name="AccentBold">{object_options_free_author_copies} exemplaires</text:span> remis gratuitement (dits « exemplaires d'auteur »). Les exemplaires supplémentaires lui seront facturés avec 30&#160;% de remise sur le prix catalogue.</text:p>
`;
}

// ═══════════════════════════════════════════════════════════
// Contrat principal
// ═══════════════════════════════════════════════════════════
function buildMainContract(variant) {
  const cfg = VARIANTS[variant];
  const editor = cfg.editorLong;
  const article4 = cfg.article4 === 'dll' ? buildArticle4DLL(editor) : buildArticle4Classic(editor);
  return `
  <text:p text:style-name="SectionTitle">CONTRAT D'ÉDITION</text:p>
  <text:p text:style-name="SectionSubtitle">Cession des droits d'édition sous forme imprimée</text:p>

  <text:p text:style-name="Preamble">Entre d'une part <text:span text:style-name="Bold">{__THIRDPARTY_NAME__}</text:span>, ci-après dénommé <text:span text:style-name="Italic">« l'Auteur »</text:span>, et <text:span text:style-name="AccentBold">${esc(editor)}</text:span>, ci-après dénommé <text:span text:style-name="Italic">« l'Éditeur »</text:span>, il est convenu de ce qui suit concernant l'ouvrage intitulé <text:span text:style-name="Bold">« {object_options_book_title} »</text:span>.</text:p>

  <text:p>Dans le cadre du présent contrat, l'Auteur cède à ${esc(editor)} le <text:span text:style-name="Bold">droit exclusif d'imprimer, publier, reproduire et vendre</text:span> ledit ouvrage sous forme d'éditions de tous formats, ordinaires, illustrés, de luxe, à tirage limité ou non.</text:p>

  <text:p>De son côté, l'Éditeur s'engage à assurer à ses frais la publication en librairie de cet ouvrage et s'emploiera à lui procurer, par une diffusion dans le public et auprès des tiers susceptibles d'être intéressés, les conditions favorables à son exploitation sous toutes les formes.</text:p>

  <text:p>En considération du risque pris par l'Éditeur en assurant, ainsi qu'il s'y engage, la publication de l'ouvrage dans les conditions prévues ci-dessous, l'Auteur cède à l'Éditeur, outre le droit d'édition graphique, les droits patrimoniaux suivants&#160;:</text:p>
  <text:p>  •  de reproduction ;</text:p>
  <text:p>  •  de traduction.</text:p>

  <text:p>La présente cession est consentie pour avoir effet en tous lieux et pour tout le temps que durera la propriété littéraire de l'Auteur et de ses ayants droit, selon les législations sénégalaises et étrangères ainsi que les conventions internationales actuelles ou futures.</text:p>

  <text:p>L'Auteur garantit à l'Éditeur la jouissance entière et libre de toute servitude des droits cédés, contre tous troubles, revendications et évictions quelconques.</text:p>

  <text:p text:style-name="ArticleTitle">Article 1 · Remise du manuscrit</text:p>
  <text:p>L'Auteur s'engage à remettre à l'Éditeur, dans les quatre (4) mois à compter de la signature du présent contrat, un exemplaire du texte définitif et complet de son ouvrage, conforme aux normes éditoriales de ${esc(editor)}, parfaitement lisible, dactylographié et soigneusement revu pour l'impression.</text:p>
  <text:p>Il déclare conserver par devers lui un double de son texte.</text:p>
  <text:p>La réfection demandée par l'Auteur de toute figure déjà revêtue par lui de son « bon à tirer » sera à la charge de l'Auteur (frais de dessin et de gravure), sauf si elle est motivée par d'éventuels imprévus.</text:p>

  <text:p text:style-name="SubArticle">Attestation anti-plagiat</text:p>
  <text:p text:style-name="Preamble">L'Auteur atteste que, dans ce texte, toute affirmation qui n'est pas le fruit de sa réflexion personnelle est attribuée à sa source et que tout passage recopié d'une autre source est en outre signalé comme tel, soit par des guillemets, soit par une mise en page appropriée. L'Auteur atteste également que tous les visuels utilisés sont libres de droit ou qu'il possède les autorisations légales d'utilisation.</text:p>

  <text:p text:style-name="ArticleTitle">Article 2 · Tirages, formats et publication</text:p>
  <text:p>Les formats, présentations et prix de vente seront déterminés par l'Éditeur en concertation avec l'Auteur.</text:p>
  <text:p>Le premier tirage est fixé à <text:span text:style-name="Bold">{object_options_tirage_initial} exemplaires</text:span>, au format <text:span text:style-name="Bold">{object_options_format_ouvrage}</text:span>. Les retirages sont effectués en continu selon les évolutions techniques ; l'Éditeur s'engage à maintenir l'ouvrage toujours disponible.</text:p>
  <text:p>Le prix public prévisionnel de vente est fixé à <text:span text:style-name="Bold">{object_options_prix_public_previsionnel} €</text:span>, pour un ouvrage d'environ {object_options_nombre_pages_estime} pages.</text:p>

  <text:p text:style-name="ArticleTitle">Article 3 · Obligations de l'Éditeur</text:p>
  <text:p>L'Éditeur s'engage à publier l'œuvre dans un délai de trois (3) mois à compter de la remise du texte définitif et complet, sauf retard imputable à l'Auteur.</text:p>
  <text:p>Passé ce délai, le présent contrat serait résilié de plein droit si l'Éditeur ne procédait pas à la publication dans les trois mois de la mise en demeure qui lui serait faite, par lettre recommandée, par l'Auteur.</text:p>
  <text:p>L'Éditeur s'engage à faire figurer sur la couverture de chacun des exemplaires le nom de l'Auteur, son pseudonyme ou la marque que celui-ci indiquera.</text:p>
  <text:p>L'Éditeur s'engage à assurer à l'œuvre une exploitation permanente et suivie ainsi qu'une diffusion commerciale conforme aux usages de la profession.</text:p>
  <text:p>En cas d'épuisement de toutes les éditions de l'œuvre, le contrat serait résilié de plein droit, sauf convention particulière, si l'Éditeur ne procédait pas à une réimpression dans un délai de six mois à compter de la mise en demeure par lettre recommandée avec accusé de réception de l'Auteur.</text:p>
  <text:p>En cas d'incendie, d'inondation, de cas accidentel ou de force majeure, l'Éditeur ne pourra être tenu pour responsable des exemplaires détériorés, détruits ou disparus.</text:p>

  ${article4}

  <text:p text:style-name="ArticleTitle">Article 5 · Droits de reproduction</text:p>
  <text:p>Sous réserve d'une acceptation de l'Auteur, les droits de reproduction comprennent notamment&#160;:</text:p>
  <text:p>  a)  le droit de traduire en toutes langues et de reproduire les traductions ;</text:p>
  <text:p>  b)  le droit de reproduire tout ou partie de l'ouvrage en pré ou post-publication, et de l'adapter et reproduire en condensés ;</text:p>
  <text:p>  c)  le droit de l'adapter ou reproduire par dessin ou photo ;</text:p>
  <text:p>  d)  le droit de l'adapter pour tout enregistrement sonore ;</text:p>
  <text:p>  e)  le droit de reproduire par photocopie ou microfilm ;</text:p>
  <text:p>  f)  le droit de reproduction graphique différente de l'édition courante ;</text:p>
  <text:p>  g)  tous droits connus et non encore connus qui permettent et permettront de communiquer l'œuvre au public.</text:p>
  <text:p>L'Éditeur devra verser à l'Auteur <text:span text:style-name="Bold">50&#160;%</text:span> des sommes nettes de tous frais et hors toutes taxes de tous droits annexes consentis par lui à des tiers.</text:p>

  <text:p text:style-name="ArticleTitle">Article 6 · Relevés de comptes</text:p>
  <text:p>Les comptes de l'ensemble des droits dus à l'Auteur seront arrêtés le <text:span text:style-name="Bold">30 juin</text:span> de chaque année. Ils lui seront remis sur sa demande et le solde créditeur lui sera payable à partir du 3<text:span text:style-name="Italic">e</text:span> mois suivant l'arrêté des comptes. Ne figureront sur ces relevés de compte que les ouvrages ayant au moins six mois d'exploitation.</text:p>

  <text:p text:style-name="ArticleTitle">Article 7 · Compétence juridictionnelle</text:p>
  <text:p>Le présent contrat, dans son intégralité, engage les héritiers et tous les ayants droit de l'Auteur. Pour toutes contestations, attribution de juridiction est faite aux tribunaux compétents de Dakar.</text:p>
`;
}

// ═══════════════════════════════════════════════════════════
// Avenant numérique
// ═══════════════════════════════════════════════════════════
function buildDigitalAnnex(variant) {
  const cfg = VARIANTS[variant];
  const editor = cfg.editorLong;
  return `
  <text:p text:style-name="SectionTitle">AVENANT AU CONTRAT D'ÉDITION</text:p>
  <text:p text:style-name="SectionSubtitle">Cession des droits numériques</text:p>

  <text:p text:style-name="Preamble">Par contrat conclu en date du {object_date}, l'Auteur a cédé à l'Éditeur le droit exclusif d'imprimer, publier, reproduire et vendre l'ouvrage intitulé <text:span text:style-name="Bold">« {object_options_book_title} »</text:span>. Compte tenu des possibilités d'édition et de publication qu'offrent les nouvelles technologies, les parties conviennent, par le présent avenant, de la cession à ${esc(editor)} des droits numériques par tous procédés, sur tous supports et sur tous réseaux.</text:p>

  <text:p text:style-name="ArticleTitle">Article 1 · Objet de l'avenant</text:p>
  <text:p>Par cession de droits numériques, il est entendu le droit de reproduire, représenter, promouvoir, commercialiser, distribuer, mettre à disposition et vendre l'œuvre, sur une base exclusive, dans tous les formats numériques disponibles, via tous les modèles de distribution, dans le monde entier, par les sites internet et applications détenus, exploités ou contrôlés par l'Éditeur, ses sociétés affiliées ou par des libraires et distributeurs numériques tiers.</text:p>

  <text:p text:style-name="ArticleTitle">Article 2 · Édition numérique</text:p>
  <text:p>L'Éditeur peut introduire dans l'œuvre des liens hypertextes ou tout autre procédé permettant la consultation interactive et/ou sélectionner, indexer ou mettre en forme tout ou partie de l'œuvre et ses adaptations et traductions.</text:p>
  <text:p>L'Éditeur reste seul propriétaire de tous les éléments de fabrication qu'il aura établis ou fait établir pour la réalisation des éditions numériques. L'Éditeur fixe seul le format, la présentation, le prix, la date de mise en vente et les conditions d'accès à l'œuvre, dans le respect du droit moral.</text:p>

  <text:p text:style-name="ArticleTitle">Article 3 · Rémunération</text:p>
  <text:p text:style-name="Callout">${esc(editor)} versera à l'Auteur <text:span text:style-name="AccentBold">{object_options_royalty_rate_digital} %</text:span> du chiffre d'affaires net hors taxes provenant de l'exploitation numérique de l'œuvre.</text:p>
  <text:p>Le règlement de cette rémunération interviendra en même temps et dans les mêmes conditions que la reddition générale des comptes de l'Auteur. <text:span text:style-name="Bold">Les droits numériques inférieurs à {object_options_royalty_digital_threshold_fcfa} FCFA seront reportés sur l'exercice suivant.</text:span></text:p>

  <text:p text:style-name="ArticleTitle">Article 4 · Promotion</text:p>
  <text:p>Aux fins de présentation, de promotion et de publicité de l'ouvrage, l'Éditeur pourra diffuser et permettre la consultation, à titre gratuit par le public, d'extraits de l'œuvre, sur tout support numérique. Cette forme d'exploitation ne donnera lieu à aucun versement de droits d'auteur.</text:p>

  <text:p text:style-name="ArticleTitle">Article 5 · Mesures de protection technique</text:p>
  <text:p>L'Auteur reconnaît être informé que l'Éditeur peut recourir à des mesures techniques de protection et/ou à des informations sous forme électronique pour l'exploitation de l'œuvre (gestion des autorisations, protection contre les actes non autorisés, identification de l'œuvre et suivi de son utilisation).</text:p>

  <text:p text:style-name="ArticleTitle">Article 6 · Compétence juridictionnelle</text:p>
  <text:p>Le présent avenant, dans son intégralité, engage les héritiers et tous les ayants droit de l'Auteur. Pour toutes contestations, attribution de juridiction est faite aux tribunaux compétents de Dakar.</text:p>
`;
}

// ═══════════════════════════════════════════════════════════
// Avenant audiovisuel
// ═══════════════════════════════════════════════════════════
function buildAudiovisualAnnex(variant) {
  const cfg = VARIANTS[variant];
  const editor = cfg.editorLong;
  return `
  <text:p text:style-name="SectionTitle">CESSION DES DROITS D'ADAPTATION</text:p>
  <text:p text:style-name="SectionSubtitle">Droits audiovisuels</text:p>

  <text:p text:style-name="Preamble">Par contrat conclu en date du {object_date}, l'Auteur a cédé à l'Éditeur le droit exclusif d'imprimer, publier, reproduire et vendre l'ouvrage intitulé <text:span text:style-name="Bold">« {object_options_book_title} »</text:span>. Les parties ont un intérêt commun à ce que l'œuvre éditée connaisse la plus large exploitation possible, notamment par voie d'adaptations audiovisuelles.</text:p>

  <text:p text:style-name="ArticleTitle">Article 1 · Droit cédé</text:p>
  <text:p>L'Auteur cède à ${esc(editor)} les droits d'exploitation audiovisuelle attachés à l'œuvre graphique, au moyen de tout enregistrement sonore et visuel, pour tous supports actuels ou futurs de reproduction et de représentation (cinématographique, vidéographique, télévisuelle).</text:p>

  <text:p text:style-name="ArticleTitle">Article 2 · Étendue de la cession</text:p>
  <text:p>La cession est consentie pour la durée de la propriété littéraire, à titre exclusif pour tous les pays et toutes les langues. Elle porte sur les droits d'adaptation de tout ou partie de l'œuvre sous forme d'œuvres audiovisuelles de toutes natures.</text:p>

  <text:p text:style-name="ArticleTitle">Article 3 · Obligations de l'Éditeur</text:p>
  <text:p>L'Éditeur s'engage à rechercher une exploitation des droits cédés conformément aux usages de la profession. Il est habilité à conclure à cet effet tout contrat notamment de mandat, de cession ou de production audiovisuelle avec des tiers. L'Auteur sera informé par l'Éditeur de la conclusion de ces contrats.</text:p>

  <text:p text:style-name="ArticleTitle">Article 4 · Régime des droits d'auteur en cas d'adaptation</text:p>
  <text:p text:style-name="Callout">L'Éditeur devra à l'Auteur <text:span text:style-name="AccentBold">50&#160;%</text:span> de toutes les recettes perçues au titre de l'exploitation de l'adaptation audiovisuelle, déduction faite des frais ou commissions assumées par l'Éditeur.</text:p>

  <text:p text:style-name="ArticleTitle">Article 5 · Régime fiscal (TVA)</text:p>
  <text:p>Les droits d'auteur issus de l'exécution du présent avenant sont assujettis à la TVA au taux de <text:span text:style-name="Bold">18&#160;%</text:span>, payable par l'Éditeur. Les sommes précisées s'entendent nettes de TVA.</text:p>

  <text:p text:style-name="ArticleTitle">Article 6 · Compétence juridictionnelle</text:p>
  <text:p>Pour toutes contestations, attribution de juridiction est faite aux tribunaux compétents de Dakar.</text:p>
`;
}

// ═══════════════════════════════════════════════════════════
// Avenant théâtral
// ═══════════════════════════════════════════════════════════
function buildTheatreAnnex(variant) {
  const cfg = VARIANTS[variant];
  const editor = cfg.editorLong;
  return `
  <text:p text:style-name="SectionTitle">CESSION DES DROITS D'ADAPTATION</text:p>
  <text:p text:style-name="SectionSubtitle">Droits théâtraux</text:p>

  <text:p text:style-name="Preamble">Par contrat conclu en date du {object_date}, l'Auteur a cédé à l'Éditeur le droit exclusif d'imprimer, publier, reproduire et vendre l'ouvrage intitulé <text:span text:style-name="Bold">« {object_options_book_title} »</text:span>. Les parties ont un intérêt commun à ce que l'œuvre éditée connaisse la plus large exploitation possible, notamment par voie d'adaptations théâtrales.</text:p>

  <text:p text:style-name="ArticleTitle">Article 1 · Droit cédé</text:p>
  <text:p>L'Auteur cède à ${esc(editor)} les droits d'exploitation théâtrale attachés à l'œuvre graphique, dont le droit d'adapter tout ou partie de l'œuvre pour le théâtre, le droit de faire lire ou réciter l'ouvrage en public, et le droit d'exploiter séparément tout élément de l'œuvre.</text:p>

  <text:p text:style-name="ArticleTitle">Article 2 · Étendue de la cession</text:p>
  <text:p>La cession est consentie pour la durée de la propriété littéraire, à titre exclusif pour tous les pays et toutes les langues.</text:p>

  <text:p text:style-name="ArticleTitle">Article 3 · Obligations de l'Éditeur</text:p>
  <text:p>L'Éditeur s'engage à rechercher une exploitation des droits cédés conformément aux usages de la profession. Il est habilité à conclure tout contrat de mandat, de cession ou de production théâtrale avec des tiers.</text:p>

  <text:p text:style-name="ArticleTitle">Article 4 · Régime des droits d'auteur</text:p>
  <text:p text:style-name="Callout">L'Éditeur devra à l'Auteur <text:span text:style-name="AccentBold">50&#160;%</text:span> de toutes les recettes perçues au titre de l'exploitation de l'adaptation théâtrale, déduction faite des frais ou commissions assumées par l'Éditeur.</text:p>

  <text:p text:style-name="ArticleTitle">Article 5 · Régime fiscal (TVA)</text:p>
  <text:p>Les droits d'auteur issus de l'exécution du présent avenant sont assujettis à la TVA au taux de <text:span text:style-name="Bold">18&#160;%</text:span>, payable par l'Éditeur. Les sommes précisées s'entendent nettes de TVA.</text:p>

  <text:p text:style-name="ArticleTitle">Article 6 · Compétence juridictionnelle</text:p>
  <text:p>Pour toutes contestations, attribution de juridiction est faite aux tribunaux compétents de Dakar.</text:p>
`;
}

// ═══════════════════════════════════════════════════════════
// Annexe — Engagement d'achat de l'Auteur
// (Cette annexe apparaît systématiquement ; les valeurs (qty=0, discount=0)
// peuvent indiquer un engagement non activé. Dolibarr ne supportant pas
// les blocs conditionnels dans les templates ODT, on assume que le DG
// supprime cette page si non applicable.)
// ═══════════════════════════════════════════════════════════
function buildAuthorPurchaseAnnex() {
  return `
  <text:p text:style-name="SectionTitle">ANNEXE</text:p>
  <text:p text:style-name="SectionSubtitle">Engagement d'achat de l'Auteur</text:p>

  <text:p text:style-name="Preamble">Par contrat conclu en date du {object_date}, l'Auteur a cédé à l'Éditeur le droit exclusif d'imprimer, publier, reproduire et vendre l'ouvrage intitulé <text:span text:style-name="Bold">« {object_options_book_title} »</text:span>.</text:p>

  <text:p text:style-name="Callout">Aux termes du présent contrat, l'Auteur s'engage à acheter <text:span text:style-name="AccentBold">{object_options_author_purchase_qty} exemplaires</text:span> de son livre, sur la base du <text:span text:style-name="Bold">prix public moins {object_options_author_purchase_discount} %</text:span>. Les exemplaires achetés par l'Auteur sur ces bases seront comptabilisés pour le calcul des droits.</text:p>

  <text:p text:style-name="SmallMuted">— Si l'engagement d'achat n'a pas été activé pour ce contrat (quantité 0), cette annexe peut être retirée. —</text:p>
`;
}

// ═══════════════════════════════════════════════════════════
// Bloc signature
// ═══════════════════════════════════════════════════════════
function buildSignatureBlock(variant) {
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

  <text:p text:style-name="SmallMuted">Signature en ligne possible à l'adresse suivante&#160;: {__ONLINE_SIGN_URL__}</text:p>
`;
}

// ═══════════════════════════════════════════════════════════
// content.xml — orchestration
// ═══════════════════════════════════════════════════════════
function buildContent(variant) {
  const cfg = VARIANTS[variant];
  const sections = [];

  sections.push(buildCoverPage(variant));
  sections.push(buildMainContract(variant));

  if (cfg.annexes.includes('digital')) sections.push(buildDigitalAnnex(variant));
  if (cfg.annexes.includes('audiovisual')) sections.push(buildAudiovisualAnnex(variant));
  if (cfg.annexes.includes('theatre')) sections.push(buildTheatreAnnex(variant));
  if (cfg.annexes.includes('purchase')) sections.push(buildAuthorPurchaseAnnex());

  sections.push(buildSignatureBlock(variant));

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
  <meta:generator>senharmattan-shop contract generator v3</meta:generator>
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

console.log('Génération des templates ODT...\n');
for (const variant of Object.keys(VARIANTS)) {
  packageOdt(variant, join(OUT_DIR, `template_${variant}.odt`));
}

console.log(`\nDone. Fichiers prêts dans ${OUT_DIR}`);
console.log('Déploiement (nécessite sudo) :');
console.log(`  sudo cp ${OUT_DIR}/*.odt /var/www/html/dolibarr/documents/doctemplates/contracts/`);
console.log(`  sudo chown www-data:www-data /var/www/html/dolibarr/documents/doctemplates/contracts/template_*.odt`);
