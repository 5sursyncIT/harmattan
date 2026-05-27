<?php
/**
 * Document builddoc endpoint — L'Harmattan Sénégal
 *
 * Génère le PDF d'une facture (llx_facture) ou d'un devis (llx_propal)
 * via Dolibarr::generateDocument() et retourne le binaire PDF directement.
 *
 * À déployer dans /var/www/html/dolibarr/htdocs/custom/senharmattansync/
 * Pattern identique à contract-builddoc.php.
 *
 * Usage :
 *   POST /custom/senharmattansync/document-builddoc.php
 *   Header: X-Dolibarr-Secret: <DOLIBARR_WEBHOOK_SECRET>
 *   Body JSON: { "type": "invoice"|"propal", "id": 42 }
 *
 *   → Si succès: Content-Type: application/pdf, binaire PDF
 *   → Sinon: 4xx/5xx + JSON erreur
 *
 * Appelé par le backend Node (GET /api/admin/invoices/:id/pdf
 * et /api/admin/propals/:id/pdf) quand l'API REST builddoc est cassée.
 */

// ── 1. Authentification par secret partagé ─────────────────────────
function readEnvSecret(): string
{
    $envFile = '/var/www/html/senharmattan-shop/.env';
    if (!file_exists($envFile)) return '';
    foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        if (strpos($line, 'DOLIBARR_WEBHOOK_SECRET=') === 0) {
            return trim(substr($line, strlen('DOLIBARR_WEBHOOK_SECRET=')));
        }
    }
    return '';
}

$providedSecret = $_SERVER['HTTP_X_DOLIBARR_SECRET'] ?? '';
$expectedSecret = readEnvSecret();
if (!$expectedSecret || !hash_equals($expectedSecret, $providedSecret)) {
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'unauthorized']);
    exit;
}

// ── 2. Parser la requête ───────────────────────────────────────────
$raw = file_get_contents('php://input');
$payload = json_decode($raw, true);
$type = $payload['type'] ?? '';
$id = isset($payload['id']) ? (int) $payload['id'] : 0;
if ($id <= 0 || !in_array($type, ['invoice', 'propal'], true)) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'payload requires { type: invoice|propal, id: number }']);
    exit;
}

// ── 3. Bootstrap Dolibarr ──────────────────────────────────────────
$_SERVER['REQUEST_METHOD'] = 'GET';
define('NOLOGIN', 1);
define('NOCSRFCHECK', 1);
define('NOTOKENRENEWAL', 1);
define('NOREQUIREMENU', 1);
define('NOREQUIREHTML', 1);
define('NOREQUIREAJAX', 1);

$dolRoot = '/var/www/html/dolibarr/htdocs';
require_once $dolRoot.'/main.inc.php';

global $conf, $db, $langs, $user;

// ── 4. Charger l'objet Facture ou Propal ───────────────────────────
if ($type === 'invoice') {
    require_once $dolRoot.'/compta/facture/class/facture.class.php';
    $obj = new Facture($db);
    $defaultModel = 'crabe';
    $moduleConfKey = 'facture';
} else {
    require_once $dolRoot.'/comm/propal/class/propal.class.php';
    $obj = new Propal($db);
    $defaultModel = 'azur';
    $moduleConfKey = 'propal';
}

if ($obj->fetch($id) <= 0) {
    http_response_code(404);
    header('Content-Type: application/json');
    echo json_encode(['error' => $type.' not found', 'id' => $id]);
    exit;
}

// ── 5. Préparer les langs et générer le document ───────────────────
if (!is_object($langs) || !$langs) {
    $langs = new Translate('', $conf);
    $langs->setDefaultLang('fr_FR');
}
$langs->load($type === 'invoice' ? 'bills' : 'propal');
$langs->load('main');
$langs->load('companies');
$langs->load('products');

$model = !empty($obj->model_pdf) ? $obj->model_pdf : $defaultModel;

$generated = $obj->generateDocument($model, $langs, 0, 0, 0);

if ($generated <= 0) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode([
        'error' => 'generateDocument failed',
        'model' => $model,
        'dolibarr_error' => $obj->error,
        'dolibarr_errors' => $obj->errors,
    ]);
    exit;
}

// ── 6. Localiser le PDF généré ─────────────────────────────────────
$outputDir = !empty($conf->{$moduleConfKey}->multidir_output[$obj->entity])
    ? $conf->{$moduleConfKey}->multidir_output[$obj->entity]
    : $conf->{$moduleConfKey}->dir_output;
$refSan = dol_sanitizeFileName($obj->ref);
$folder = $outputDir.'/'.$refSan;

$pdfPath = null;
$candidates = [
    $folder.'/'.$refSan.'.pdf',
];
if (!empty($obj->last_main_doc)) {
    // last_main_doc est souvent "facture/REF/file.pdf" (relatif à documents/)
    $candidates[] = dirname($outputDir).'/'.$obj->last_main_doc;
    $candidates[] = $folder.'/'.basename($obj->last_main_doc);
}

foreach ($candidates as $c) {
    if ($c && is_file($c)) { $pdfPath = $c; break; }
}

if (!$pdfPath && is_dir($folder)) {
    $any = glob($folder.'/*.pdf');
    if (!empty($any)) {
        usort($any, function ($a, $b) { return filemtime($b) - filemtime($a); });
        $pdfPath = $any[0];
    }
}

if (!$pdfPath || !is_file($pdfPath)) {
    http_response_code(404);
    header('Content-Type: application/json');
    echo json_encode([
        'error' => 'pdf not found on disk after generation',
        'folder' => $folder,
        'candidates_checked' => $candidates,
    ]);
    exit;
}

// ── 7. Streamer le PDF binaire ─────────────────────────────────────
header('Content-Type: application/pdf');
header('Content-Disposition: inline; filename="'.$refSan.'.pdf"');
header('Content-Length: '.filesize($pdfPath));
header('Cache-Control: private, no-store');
readfile($pdfPath);
exit;
