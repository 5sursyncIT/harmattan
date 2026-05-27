#!/usr/bin/env node
/**
 * Génère le template ODT du devis de contribution auteur (devis-contrat.odt).
 *
 * Placeholders : {REF} {DATE} {RECIPIENT_TITLE} {RECIPIENT_NAME} {BOOK_TITLE}
 *                {BOOK_PAGES} {BOOK_FORMAT} {BOOK_INTERIOR} {BOOK_PAPER}
 *                {BOOK_COVER} {BOOK_PRICE_EUR} {DIFFUSION}
 *                {ITEM_LABEL} {ITEM_PRICE} (dans une ligne dupliquée)
 *                {TOTAL_AMOUNT} {TOTAL_TEXT}
 *
 * Usage : node scripts/build-quote-template.mjs
 *         (sortie : server/templates/devis-contrat.odt)
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '..', 'server', 'templates', 'devis-contrat.odt');
const LOGO_SRC = join(__dirname, '..', 'public', 'images', 'logo.png');
const WORK_DIR = '/tmp/quote-template-work';

const COLOR_PRIMARY = '#10531a';
const COLOR_DARK = '#1a1a1a';
const COLOR_MUTED = '#6b7280';
const FONT_SERIF = 'Liberation Serif';
const FONT_SANS = 'Liberation Sans';

const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
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
   <style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0.1cm" fo:line-height="120%" fo:text-align="justify"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="10.5pt" fo:language="fr" fo:country="FR" fo:color="${COLOR_DARK}"/>
  </style:default-style>

  <style:style style:name="HeaderBrandName" style:family="paragraph">
   <style:paragraph-properties fo:text-align="left" fo:margin-bottom="0.05cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="13pt" fo:color="${COLOR_PRIMARY}" fo:font-weight="bold" fo:letter-spacing="0.05cm"/>
  </style:style>
  <style:style style:name="HeaderTagline" style:family="paragraph">
   <style:paragraph-properties fo:text-align="left" fo:margin-bottom="0.05cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="9pt" fo:color="${COLOR_MUTED}" fo:letter-spacing="0.08cm"/>
  </style:style>
  <style:style style:name="HeaderUnderline" style:family="paragraph">
   <style:paragraph-properties fo:margin-top="0.1cm" fo:margin-bottom="0.2cm" fo:border-bottom="0.5pt solid ${COLOR_PRIMARY}" fo:padding-bottom="0cm"/>
   <style:text-properties fo:font-size="2pt"/>
  </style:style>

  <style:style style:name="QuoteRefBox" style:family="paragraph">
   <style:paragraph-properties fo:text-align="right" fo:background-color="${COLOR_PRIMARY}" fo:padding="0.15cm 0.45cm" fo:margin-top="0.15cm" fo:margin-bottom="0.4cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="13pt" fo:font-weight="bold" fo:letter-spacing="0.05cm" fo:color="#ffffff"/>
  </style:style>

  <!-- Header table (logo + brand) -->
  <style:style style:name="HeaderTable" style:family="table">
   <style:table-properties style:width="17cm" table:align="margins"/>
  </style:style>
  <style:style style:name="HeaderColLogo" style:family="table-column">
   <style:table-column-properties style:column-width="3.5cm"/>
  </style:style>
  <style:style style:name="HeaderColBrand" style:family="table-column">
   <style:table-column-properties style:column-width="13.5cm"/>
  </style:style>
  <style:style style:name="HeaderCell" style:family="table-cell">
   <style:table-cell-properties fo:padding="0cm" fo:vertical-align="middle"/>
  </style:style>

  <style:style style:name="LogoFrame" style:family="graphic">
   <style:graphic-properties style:wrap="none" style:vertical-pos="middle" style:vertical-rel="paragraph" style:horizontal-pos="left" style:horizontal-rel="paragraph"/>
  </style:style>

  <style:style style:name="DateLine" style:family="paragraph">
   <style:paragraph-properties fo:text-align="right" fo:margin-top="0.2cm" fo:margin-bottom="0.05cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="10.5pt"/>
  </style:style>

  <style:style style:name="Recipient" style:family="paragraph">
   <style:paragraph-properties fo:text-align="right" fo:margin-bottom="0.35cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="10.5pt" fo:font-weight="bold"/>
  </style:style>

  <style:style style:name="Greeting" style:family="paragraph">
   <style:paragraph-properties fo:margin-top="0.1cm" fo:margin-bottom="0.15cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="10.5pt"/>
  </style:style>

  <style:style style:name="IntroPara" style:family="paragraph">
   <style:paragraph-properties fo:margin-bottom="0.2cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="10.5pt"/>
  </style:style>

  <style:style style:name="SectionLabel" style:family="paragraph">
   <style:paragraph-properties fo:margin-top="0.15cm" fo:margin-bottom="0.1cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="10.5pt" fo:font-weight="bold"/>
  </style:style>

  <style:style style:name="SpecBullet" style:family="paragraph">
   <style:paragraph-properties fo:margin-left="0.8cm" fo:margin-bottom="0.02cm" fo:text-align="left" fo:line-height="115%"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="10pt"/>
  </style:style>

  <style:style style:name="QuoteIntro" style:family="paragraph">
   <style:paragraph-properties fo:margin-top="0.2cm" fo:margin-bottom="0.1cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="10.5pt"/>
  </style:style>

  <style:style style:name="TotalText" style:family="paragraph">
   <style:paragraph-properties fo:text-align="left" fo:margin-top="0.35cm" fo:margin-bottom="0.1cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="10.5pt" fo:font-style="italic" fo:font-weight="bold" fo:color="${COLOR_PRIMARY}"/>
  </style:style>

  <style:style style:name="Italic" style:family="text">
   <style:text-properties fo:font-style="italic"/>
  </style:style>
  <style:style style:name="Bold" style:family="text">
   <style:text-properties fo:font-weight="bold"/>
  </style:style>

  <!-- Table styles -->
  <style:style style:name="QuoteTable" style:family="table">
   <style:table-properties style:width="17cm" table:align="margins" fo:margin-top="0.15cm" fo:margin-bottom="0.15cm"/>
  </style:style>
  <style:style style:name="QuoteColLabel" style:family="table-column">
   <style:table-column-properties style:column-width="13cm"/>
  </style:style>
  <style:style style:name="QuoteColPrice" style:family="table-column">
   <style:table-column-properties style:column-width="4cm"/>
  </style:style>
  <style:style style:name="QuoteHeaderCell" style:family="table-cell">
   <style:table-cell-properties fo:background-color="#e5e7eb" fo:border="0.5pt solid #9ca3af" fo:padding="0.12cm 0.25cm"/>
  </style:style>
  <style:style style:name="QuoteCell" style:family="table-cell">
   <style:table-cell-properties fo:border="0.5pt solid #d1d5db" fo:padding="0.13cm 0.25cm"/>
  </style:style>
  <style:style style:name="QuoteTotalCell" style:family="table-cell">
   <style:table-cell-properties fo:background-color="#f0fdf4" fo:border="0.8pt solid ${COLOR_PRIMARY}" fo:padding="0.18cm 0.25cm"/>
  </style:style>
  <style:style style:name="QuoteHeaderText" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:margin-bottom="0cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="10pt" fo:font-weight="bold"/>
  </style:style>
  <style:style style:name="QuoteCellText" style:family="paragraph">
   <style:paragraph-properties fo:text-align="left" fo:margin-bottom="0cm" fo:line-height="115%"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="10pt"/>
  </style:style>
  <style:style style:name="QuoteCellPrice" style:family="paragraph">
   <style:paragraph-properties fo:text-align="right" fo:margin-bottom="0cm"/>
   <style:text-properties style:font-name="${FONT_SERIF}" fo:font-size="10pt"/>
  </style:style>
  <style:style style:name="QuoteCellTotalText" style:family="paragraph">
   <style:paragraph-properties fo:text-align="left" fo:margin-bottom="0cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="11pt" fo:font-weight="bold" fo:color="${COLOR_PRIMARY}"/>
  </style:style>
  <style:style style:name="QuoteCellTotalPrice" style:family="paragraph">
   <style:paragraph-properties fo:text-align="right" fo:margin-bottom="0cm"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="12pt" fo:font-weight="bold" fo:color="${COLOR_PRIMARY}"/>
  </style:style>

  <style:style style:name="FooterBank" style:family="paragraph">
   <style:paragraph-properties fo:text-align="center" fo:margin-top="0cm" fo:margin-bottom="0cm" fo:line-height="115%"/>
   <style:text-properties style:font-name="${FONT_SANS}" fo:font-size="7pt" fo:color="${COLOR_MUTED}"/>
  </style:style>
 </office:styles>

 <office:automatic-styles>
  <style:page-layout style:name="pmA4">
   <style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm"
     fo:margin-top="1.5cm" fo:margin-bottom="1.5cm" fo:margin-left="1.8cm" fo:margin-right="1.8cm"/>
   <style:footer-style>
    <style:header-footer-properties fo:min-height="0.9cm" fo:margin-top="0.2cm"/>
   </style:footer-style>
  </style:page-layout>
 </office:automatic-styles>

 <office:master-styles>
  <style:master-page style:name="Standard" style:page-layout-name="pmA4">
   <style:footer>
    <text:p text:style-name="FooterBank">BP 45034 Dakar Fann · SARL au capital de 1 000 000 FCFA · RC : SN DKR 2009-B-11.042 · NINEA : 004067155</text:p>
    <text:p text:style-name="FooterBank">BANQUE : CBAO CLAIR DE LUNE, AVENUE CHEIKH ANTA DIOP · IBAN : SN08 SN012 01212 036199352101 46 · SWIFT : CBAOSNDA</text:p>
    <text:p text:style-name="FooterBank">Code marchand OM 413513 · WAVE 77 242 25 08 · senegal.harmattan.fr</text:p>
   </style:footer>
  </style:master-page>
 </office:master-styles>
</office:document-styles>`;

const CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  office:version="1.2">
 <office:automatic-styles/>
 <office:body>
  <office:text>
   <table:table table:name="HeaderTable" table:style-name="HeaderTable">
    <table:table-column table:style-name="HeaderColLogo"/>
    <table:table-column table:style-name="HeaderColBrand"/>
    <table:table-row>
     <table:table-cell table:style-name="HeaderCell">
      <text:p>
       <draw:frame draw:style-name="LogoFrame" draw:name="logo" text:anchor-type="paragraph" svg:width="3cm" svg:height="1.52cm" draw:z-index="0">
        <draw:image xlink:href="Pictures/logo.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>
       </draw:frame>
      </text:p>
     </table:table-cell>
     <table:table-cell table:style-name="HeaderCell">
      <text:p text:style-name="HeaderBrandName">L'HARMATTAN SÉNÉGAL</text:p>
      <text:p text:style-name="HeaderTagline">ÉDITION · LIBRAIRIE · DIFFUSION</text:p>
      <text:p text:style-name="HeaderTagline">Faire revenir le livre dans le quotidien des Sénégalais</text:p>
     </table:table-cell>
    </table:table-row>
   </table:table>
   <text:p text:style-name="HeaderUnderline"> </text:p>

   <text:p text:style-name="QuoteRefBox">Devis N° {REF}</text:p>

   <text:p text:style-name="DateLine">DAKAR, le {DATE}</text:p>
   <text:p text:style-name="Recipient">À l'attention de {RECIPIENT_TITLE} {RECIPIENT_NAME}</text:p>

   <text:p text:style-name="Greeting">Bonjour,</text:p>

   <text:p text:style-name="IntroPara">Vous avez sollicité auprès de nous, un devis pour la publication d'un ouvrage intitulé&#160;:
    <text:span text:style-name="Bold">{BOOK_TITLE}</text:span> que nous acceptons de publier dans une de nos collections.</text:p>

   <text:p text:style-name="SectionLabel">Le devis ci-dessous est fait selon les termes suivants&#160;:</text:p>
   <text:p text:style-name="SpecBullet">- Le manuscrit sera corrigé par vos soins ou par des correcteurs typographes</text:p>
   <text:p text:style-name="SpecBullet">- Le manuscrit sera mis en pages au format livre par notre département PAO</text:p>
   <text:p text:style-name="SpecBullet">- Le livre fera environ {BOOK_PAGES} pages</text:p>
   <text:p text:style-name="SpecBullet">- Format : {BOOK_FORMAT}</text:p>
   <text:p text:style-name="SpecBullet">- L'intérieur du livre sera en {BOOK_INTERIOR} imprimé sur du papier {BOOK_PAPER}</text:p>
   <text:p text:style-name="SpecBullet">- Couverture {BOOK_COVER}</text:p>
   <text:p text:style-name="SpecBullet">- Prix public du livre à l'international : {BOOK_PRICE_EUR} euros</text:p>
   <text:p text:style-name="SpecBullet">- Parution mondiale, simultanément à {DIFFUSION}</text:p>

   <text:p text:style-name="QuoteIntro">Ainsi votre participation aux frais d'édition est&#160;:</text:p>

   <table:table table:name="QuoteTable" table:style-name="QuoteTable">
    <table:table-column table:style-name="QuoteColLabel"/>
    <table:table-column table:style-name="QuoteColPrice"/>
    <table:table-row>
     <table:table-cell table:style-name="QuoteHeaderCell">
      <text:p text:style-name="QuoteHeaderText">Désignation</text:p>
     </table:table-cell>
     <table:table-cell table:style-name="QuoteHeaderCell">
      <text:p text:style-name="QuoteHeaderText">PRIX</text:p>
     </table:table-cell>
    </table:table-row>
    <table:table-row>
     <table:table-cell table:style-name="QuoteCell">
      <text:p text:style-name="QuoteCellText">{ITEM_LABEL}</text:p>
     </table:table-cell>
     <table:table-cell table:style-name="QuoteCell">
      <text:p text:style-name="QuoteCellPrice">{ITEM_PRICE}</text:p>
     </table:table-cell>
    </table:table-row>
    <table:table-row>
     <table:table-cell table:style-name="QuoteTotalCell">
      <text:p text:style-name="QuoteCellTotalText">TOTAL</text:p>
     </table:table-cell>
     <table:table-cell table:style-name="QuoteTotalCell">
      <text:p text:style-name="QuoteCellTotalPrice">{TOTAL_AMOUNT}</text:p>
     </table:table-cell>
    </table:table-row>
   </table:table>

   <text:p text:style-name="TotalText">Arrêtée la présente facture à la somme de&#160;: {TOTAL_TEXT}</text:p>
  </office:text>
 </office:body>
</office:document-content>`;

const META = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.2">
 <office:meta>
  <meta:creation-date>${new Date().toISOString()}</meta:creation-date>
  <dc:title>Devis de contribution auteur — L'Harmattan Sénégal</dc:title>
  <dc:creator>L'Harmattan Sénégal</dc:creator>
  <meta:generator>senharmattan-shop quote template v1</meta:generator>
 </office:meta>
</office:document-meta>`;

const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
 <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
 <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
 <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
 <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
 <manifest:file-entry manifest:full-path="Pictures/logo.png" manifest:media-type="image/png"/>
</manifest:manifest>`;

// Build
rmSync(WORK_DIR, { recursive: true, force: true });
mkdirSync(join(WORK_DIR, 'META-INF'), { recursive: true });
mkdirSync(join(WORK_DIR, 'Pictures'), { recursive: true });

if (!existsSync(LOGO_SRC)) {
  console.error(`✗ Logo introuvable : ${LOGO_SRC}`);
  process.exit(1);
}
copyFileSync(LOGO_SRC, join(WORK_DIR, 'Pictures', 'logo.png'));

writeFileSync(join(WORK_DIR, 'mimetype'), 'application/vnd.oasis.opendocument.text');
writeFileSync(join(WORK_DIR, 'META-INF/manifest.xml'), MANIFEST);
writeFileSync(join(WORK_DIR, 'content.xml'), CONTENT);
writeFileSync(join(WORK_DIR, 'styles.xml'), STYLES);
writeFileSync(join(WORK_DIR, 'meta.xml'), META);

mkdirSync(dirname(OUT_PATH), { recursive: true });
if (existsSync(OUT_PATH)) rmSync(OUT_PATH);
execSync(`cd ${WORK_DIR} && zip -q -X -0 ${OUT_PATH} mimetype && zip -q -r -X ${OUT_PATH} META-INF content.xml styles.xml meta.xml Pictures`);

console.log(`✓ ${OUT_PATH} (${execSync(`du -h ${OUT_PATH}`).toString().trim().split(/\s+/)[0]})`);
