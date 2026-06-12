<?php
/**
 * Contract document rebuild endpoint — L'Harmattan Sénégal
 *
 * Régénère le PDF d'un contrat via generateDocument() de Dolibarr.
 * Si le contrat a été signé en ligne (signed_status > 0), copie
 * online_sign_name / online_sign_ip vers les extrafields
 * signature_auteur_nom / signature_auteur_ip / signature_auteur_date
 * puis régénère, pour que les templates ODT les affichent.
 *
 * Usage :
 *   POST /custom/senharmattansync/contract-builddoc.php
 *   Header: X-Dolibarr-Secret: <DOLIBARR_WEBHOOK_SECRET>
 *   Body JSON: { "contract_id": 42 }
 *
 * Déployé par le backend Node (POST /contracts/:id/regenerate-signed).
 */

// phpcs:disable Generic.Files.LineLength
header('Content-Type: application/json');

// ── 1. Authentification par secret partagé (.env de la boutique) ────
function readEnvSecret(): string
{
    // 1) Fichier dédié lisible par www-data (root:www-data 640) — principe du
    //    moindre privilège : pas besoin de lire tout le .env de la boutique.
    $secretFile = '/var/www/html/senharmattan-shop/.webhook-secret';
    if (is_readable($secretFile)) {
        $secret = trim((string) @file_get_contents($secretFile));
        if ($secret !== '') return trim($secret, "\"'");
    }
    // 2) Repli : .env de la boutique, si www-data peut le lire.
    $envFile = '/var/www/html/senharmattan-shop/.env';
    if (is_readable($envFile)) {
        foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            if (strpos($line, 'DOLIBARR_WEBHOOK_SECRET=') === 0) {
                return trim(trim(substr($line, strlen('DOLIBARR_WEBHOOK_SECRET='))), "\"'");
            }
        }
    }
    return '';
}

$providedSecret = $_SERVER['HTTP_X_DOLIBARR_SECRET'] ?? '';
$expectedSecret = readEnvSecret();
if (!$expectedSecret || !hash_equals($expectedSecret, $providedSecret)) {
    http_response_code(401);
    echo json_encode(['error' => 'unauthorized']);
    exit;
}

// ── 2. Lire la requête ──────────────────────────────────────────────
$raw = file_get_contents('php://input');
$payload = json_decode($raw, true);
$contractId = isset($payload['contract_id']) ? (int) $payload['contract_id'] : 0;
if ($contractId <= 0) {
    http_response_code(400);
    echo json_encode(['error' => 'contract_id required']);
    exit;
}

// ── 3. Bootstrap Dolibarr ───────────────────────────────────────────
$_SERVER['REQUEST_METHOD'] = 'GET'; // prevent Dolibarr CSRF on master.inc.php
define('NOLOGIN', 1);
define('NOCSRFCHECK', 1);
define('NOTOKENRENEWAL', 1);
define('NOREQUIREMENU', 1);
define('NOREQUIREHTML', 1);
define('NOREQUIREAJAX', 1);

$dolibarrRoot = '/var/www/html/dolibarr/htdocs';
require_once $dolibarrRoot.'/main.inc.php';
require_once $dolibarrRoot.'/contrat/class/contrat.class.php';

global $conf, $db, $langs, $user;

// ── 4. Charger le contrat ───────────────────────────────────────────
$contract = new Contrat($db);
if ($contract->fetch($contractId) <= 0) {
    http_response_code(404);
    echo json_encode(['error' => 'contract not found']);
    exit;
}

// ── 5. Lire signed_status + online_sign_* via SQL (pas chargé par fetch) ─
$sql = "SELECT signed_status, online_sign_name, online_sign_ip, tms ";
$sql .= "FROM ".MAIN_DB_PREFIX."contrat WHERE rowid = ".(int) $contractId;
$res = $db->query($sql);
$signed = 0; $signName = ''; $signIp = ''; $signDate = '';
if ($res && $obj = $db->fetch_object($res)) {
    $signed = (int) $obj->signed_status;
    $signName = (string) $obj->online_sign_name;
    $signIp = (string) $obj->online_sign_ip;
    // Approximation au moment de la PREMIÈRE écriture seulement (cf. étape 6) :
    // le cron de détection régénère le document dans les 5 min suivant la
    // signature, instant où tms ≈ heure réelle de signature.
    $signDate = $obj->tms ? date('Y-m-d', strtotime($obj->tms)) : date('Y-m-d');
}

// ── 6. Si signé : copier online_sign_* vers les extrafields signature_auteur_* ─
$updated = false;
if ($signed > 0 && $signName !== '') {
    $contract->fetch_optionals();
    $contract->array_options['options_signature_auteur_nom'] = $signName;
    $contract->array_options['options_signature_auteur_ip'] = $signIp;
    // Date FIGÉE à la première écriture : v21 ne stocke pas l'horodatage de la
    // signature en ligne, donc on capture tms une seule fois (≈ heure de
    // signature) et on ne l'écrase plus jamais. Avant ce garde, chaque
    // régénération recopiait le tms COURANT : toute modification ultérieure du
    // contrat décalait la date de signature affichée sur le PDF — une mention
    // contractuelle. Couvre aussi la signature papier, dont la date déclarée
    // (saisie par l'admin) ne doit pas être remplacée par un tms.
    if (empty($contract->array_options['options_signature_auteur_date'])) {
        $contract->array_options['options_signature_auteur_date'] = $signDate;
    }
    if ($contract->insertExtraFields() > 0) {
        $updated = true;
    }
}

// ── 7. Régénérer le document ────────────────────────────────────────
$model = $contract->model_pdf;
if (empty($model)) {
    http_response_code(400);
    echo json_encode(['error' => 'contract has no model_pdf set']);
    exit;
}

if (!is_object($langs) || !$langs) {
    $langs = new Translate('', $conf);
    $langs->setDefaultLang('fr_FR');
}
$langs->load('contracts');

$result = $contract->generateDocument($model, $langs, 0, 0, 0);

if ($result <= 0) {
    http_response_code(500);
    echo json_encode([
        'error' => 'generateDocument failed',
        'dolibarr_error' => $contract->error,
        'dolibarr_errors' => $contract->errors,
    ]);
    exit;
}

// -- 7bis. Purge des documents perimes d'un AUTRE template ------------
// Si le type du contrat a change (ex. << edition simple >> -> << complete >>),
// l'ancien PDF/ODT _simple subsiste a cote du nouveau _complete. On le
// supprime (fichier + index ECM via dol_delete_file) pour ne garder que le
// document du template courant. Sinon un telechargement pourrait servir
// l'ancien document, faisant croire qu'un contrat complet est identique a
// un contrat simple.
require_once $dolibarrRoot.'/core/lib/files.lib.php';
if (preg_match('#template_([a-zA-Z0-9_]+)\\.odt#', (string) $contract->model_pdf, $mCur)) {
    $currentBase = $mCur[1];
    $uploadDirCleanup = !empty($conf->contrat->multidir_output[$contract->entity])
        ? $conf->contrat->multidir_output[$contract->entity]
        : $conf->contrat->dir_output;
    $contractDirCleanup = $uploadDirCleanup.'/'.dol_sanitizeFileName($contract->ref);
    $refSan = dol_sanitizeFileName($contract->ref);
    foreach (glob($contractDirCleanup.'/'.$refSan.'_*.{pdf,odt}', GLOB_BRACE) ?: array() as $stale) {
        $base = basename($stale);
        if ($base !== $refSan.'_'.$currentBase.'.pdf' && $base !== $refSan.'_'.$currentBase.'.odt') {
            dol_delete_file($stale, 0, 0, 0, $contract);
        }
    }
}

// ── 8. Post-traitement PDF : filigrane logo (toujours) + signature (si signé) ─
// Le template passe par LibreOffice (ODT→PDF). On ré-importe chaque page via
// FPDI/TCPDI pour :
//   (a) apposer le logo de L'Harmattan en filigrane sur TOUTES les pages
//       (centré, faible opacité — lisible à travers le texte) ;
//   (b) coller la signature calligraphique (PNG) sur la dernière page, par-dessus
//       le filigrane, uniquement si le contrat est signé en ligne.
$watermarked = false;
$stamped = false;
$stampError = null;
$debugSigDir = null;
$debugSigDirExists = false;
$debugSigFiles = [];
$debugPdfPath = null;
$debugPdfExists = false;

try {
    $uploadDir = !empty($conf->contrat->multidir_output[$contract->entity])
        ? $conf->contrat->multidir_output[$contract->entity]
        : $conf->contrat->dir_output;
    $contractDir = $uploadDir.'/'.dol_sanitizeFileName($contract->ref);
    $sigDir = $contractDir.'/signatures/';

    // Localiser le PDF généré. Le template ODT suffixe son nom au PDF
    // (ex: CT2602-0001_edition_numerique.pdf).
    // Priorité : last_main_doc → suffixe template → ref brute → tout PDF du dossier.
    $pdfPath = null;
    $candidates = [];
    if (!empty($contract->last_main_doc)) {
        $candidates[] = $uploadDir.'/../'.$contract->last_main_doc; // last_main_doc est souvent "contract/REF/file.pdf"
        $candidates[] = $contractDir.'/'.basename($contract->last_main_doc);
    }
    // Suffixe du template (après generic_contract_odt:/path/to/template_X.odt)
    $templateBase = '';
    if (preg_match('#template_([a-zA-Z0-9_]+)\.odt#', (string) $contract->model_pdf, $m)) {
        $templateBase = $m[1];
        $candidates[] = $contractDir.'/'.dol_sanitizeFileName($contract->ref).'_'.$templateBase.'.pdf';
    }
    $candidates[] = $contractDir.'/'.dol_sanitizeFileName($contract->ref).'.pdf';
    foreach ($candidates as $c) {
        if ($c && is_file($c)) { $pdfPath = realpath($c); break; }
    }
    if (!$pdfPath && is_dir($contractDir)) {
        $anyPdf = glob($contractDir.'/*.pdf');
        if (!empty($anyPdf)) {
            usort($anyPdf, function ($a, $b) { return filemtime($b) - filemtime($a); });
            $pdfPath = $anyPdf[0];
        }
    }

    $debugPdfPath = $pdfPath;
    $debugPdfExists = $pdfPath && is_file($pdfPath);

    // Logo en filigrane — chemin surchargeable, désactivable, tolérant si absent
    // (un logo manquant ne doit JAMAIS empêcher la génération du contrat).
    $logoPath = getDolGlobalString('CONTRACT_WATERMARK_LOGO') !== ''
        ? getDolGlobalString('CONTRACT_WATERMARK_LOGO')
        : '/var/www/html/senharmattan-shop/public/images/logo.png';
    $applyWatermark = !getDolGlobalString('CONTRACT_WATERMARK_DISABLE')
        && $logoPath && is_readable($logoPath);

    // Signature calligraphique (uniquement si le contrat est signé en ligne).
    $signaturePng = null;
    if ($signed > 0) {
        $debugSigDir = $sigDir;
        $debugSigDirExists = is_dir($sigDir);
        if (is_dir($sigDir)) {
            // On accepte tout PNG (pas seulement *_signature.png) pour plus de robustesse
            $pngs = glob($sigDir.'*.png');
            $debugSigFiles = array_map('basename', $pngs ?: []);
            if (!empty($pngs)) {
                usort($pngs, function ($a, $b) { return filemtime($b) - filemtime($a); });
                $signaturePng = $pngs[0];
            }
        }
    }
    $needStamp = ($signed > 0 && $signaturePng);

    // On ne ré-écrit le PDF que s'il y a au moins un traitement à appliquer.
    if ($pdfPath && is_file($pdfPath) && ($applyWatermark || $needStamp)) {
        require_once $dolibarrRoot.'/core/lib/pdf.lib.php';
        $pdfIn = pdf_getInstance();
        if (class_exists('TCPDF')) {
            $pdfIn->setPrintHeader(false);
            $pdfIn->setPrintFooter(false);
        }
        $pdfIn->SetFont(pdf_getPDFFont($langs));
        if (getDolGlobalString('MAIN_DISABLE_PDF_COMPRESSION')) {
            $pdfIn->SetCompression(false);
        }

        // Paramètres filigrane : ratio (préservé d'après le PNG), opacité, largeur.
        $logoRatio = 1153 / 586; // défaut = ratio du logo fourni
        if ($applyWatermark) {
            $info = @getimagesize($logoPath);
            if ($info && !empty($info[1])) {
                $logoRatio = $info[0] / $info[1];
            }
        }
        $alpha = getDolGlobalString('CONTRACT_WATERMARK_ALPHA') !== ''
            ? (float) getDolGlobalString('CONTRACT_WATERMARK_ALPHA')
            : 0.07;
        $widthPct = getDolGlobalString('CONTRACT_WATERMARK_WIDTH_PCT') !== ''
            ? (float) getDolGlobalString('CONTRACT_WATERMARK_WIDTH_PCT')
            : 0.62;

        $pageCount = $pdfIn->setSourceFile($pdfPath);
        for ($i = 1; $i <= $pageCount; $i++) {
            $tpl = $pdfIn->importPage($i);
            $size = $pdfIn->getTemplatesize($tpl);
            $pdfIn->AddPage($size['h'] > $size['w'] ? 'P' : 'L');
            $pdfIn->useTemplate($tpl);

            // (a) Filigrane logo, centré, faible opacité, sur CHAQUE page.
            if ($applyWatermark) {
                $wW = $size['w'] * $widthPct;
                $wH = $wW / $logoRatio;
                $wX = ($size['w'] - $wW) / 2;
                $wY = ($size['h'] - $wH) / 2;
                $pdfIn->SetAlpha($alpha);
                $pdfIn->Image($logoPath, $wX, $wY, $wW, $wH, 'PNG');
                $pdfIn->SetAlpha(1);
                $watermarked = true;
            }

            // (b) Signature auteur sur la dernière page (si signé).
            if ($needStamp && $i === $pageCount) {
                // Position de la signature auteur (cellule droite de la SignTable v2).
                // La SignTable est seule sur la dernière page (grâce au page-break forcé
                // dans le template), donc la position est prévisible : zone haute de la page.
                // Défauts calibrés pour A4 portrait (210 x 297 mm) :
                //   - cellule Date et signature : colonne droite, box d'env. 34 mm de haut
                //     qui commence vers y=75 mm après l'en-tête "SIGNATURES DES PARTIES"
                //     + noms + mentions.
                $xStart = getDolGlobalString('CONTRACT_SIGNATURE_XFORIMGSTART') !== ''
                    ? (float) getDolGlobalString('CONTRACT_SIGNATURE_XFORIMGSTART')
                    : ($size['w'] / 2 + 15);
                $yStart = getDolGlobalString('CONTRACT_SIGNATURE_YFORIMGSTART') !== ''
                    ? (float) getDolGlobalString('CONTRACT_SIGNATURE_YFORIMGSTART')
                    : 78;
                $wImg = getDolGlobalString('CONTRACT_SIGNATURE_WFORIMG') !== ''
                    ? (float) getDolGlobalString('CONTRACT_SIGNATURE_WFORIMG')
                    : 65;

                $pdfIn->Image($signaturePng, $xStart, $yStart, $wImg, round($wImg / 4));

                $pdfIn->SetXY($xStart, $yStart + round($wImg / 4) - 4);
                $pdfIn->SetFont(pdf_getPDFFont($langs), '', pdf_getPDFFontSize($langs) - 1);
                $pdfIn->SetTextColor(80, 80, 80);
                $caption = 'Signé électroniquement le '.$signDate.' par '.$signName;
                $pdfIn->MultiCell($wImg, 4, $caption, 0, 'L');
            }
        }

        $pdfIn->Output($pdfPath, 'F');
        $contract->indexFile($pdfPath, 1);
        $stamped = $needStamp;
    }
} catch (Exception $e) {
    $stampError = $e->getMessage();
    dol_syslog('contract-builddoc post-processing error: '.$stampError, LOG_ERR);
}

// ── 9. Réponse ──────────────────────────────────────────────────────
echo json_encode([
    'success' => true,
    'contract_id' => $contractId,
    'ref' => $contract->ref,
    'signed_status' => $signed,
    'signer_name' => $signName,
    'signer_ip' => $signIp,
    'signer_date' => $signDate,
    'extrafields_updated' => $updated,
    'watermark_applied' => $watermarked,
    'signature_stamped' => $stamped,
    'signature_stamp_error' => $stampError,
    'debug' => [
        'signature_dir' => $debugSigDir,
        'signature_dir_exists' => $debugSigDirExists,
        'signature_files' => $debugSigFiles,
        'pdf_path' => $debugPdfPath,
        'pdf_exists' => $debugPdfExists,
    ],
    'last_main_doc' => $contract->last_main_doc,
    'model' => $model,
]);
