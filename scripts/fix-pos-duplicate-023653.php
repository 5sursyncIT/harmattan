<?php
/**
 * Remédiation one-off — doublon POS du 24/08/2026 (terminal 7, caisse_principale).
 *
 * Cause : timeout d'encaissement (faux-négatif). La 1ʳᵉ vente LIBFAC20260824-023652
 * (rowid 41978, 37 000, 2 livres 734+5071) a bien abouti côté Dolibarr mais le POS
 * a affiché « échec » ; le caissier a ressaisi → LIBFAC20260824-023653 (rowid 41979),
 * doublon complet, lui aussi validé + payé. Le client n'a réglé qu'UNE fois 37 000.
 *
 * Donc : 023652 = vente réelle (CONSERVÉE) ; 023653 = doublon à neutraliser.
 *   1) supprimer le paiement fantôme 33139 (espèces, 37 000) → banque + liens ;
 *   2) restituer +1 exemplaire à 734 et +1 à 5071 (le doublon les avait décrémentés) ;
 *   3) passer 023653 en Abandonnée / remplacée (garde son n°, séquence sans trou).
 *
 * Idempotent (vérifie l'état attendu avant chaque écriture, saute ce qui est fait).
 * Atomique (rollback global sur erreur).
 *
 * Exécution : sudo -u www-data php scripts/fix-pos-duplicate-023653.php
 */

define('NOLOGIN', 1);
define('NOCSRFCHECK', 1);
define('NOTOKENRENEWAL', 1);
define('NOREQUIREMENU', 1);
define('NOREQUIREHTML', 1);
define('NOREQUIREAJAX', 1);
$_SERVER['REQUEST_METHOD'] = 'GET';

$dolRoot = '/var/www/html/dolibarr/htdocs';
require_once $dolRoot.'/master.inc.php';
require_once $dolRoot.'/user/class/user.class.php';
require_once $dolRoot.'/compta/facture/class/facture.class.php';
require_once $dolRoot.'/compta/paiement/class/paiement.class.php';
require_once $dolRoot.'/compta/bank/class/account.class.php'; // Account + AccountLine (Paiement::delete)
require_once $dolRoot.'/product/stock/class/mouvementstock.class.php';

global $db, $conf, $langs;

const PAY_PHANTOM = 33139;   // paiement espèces fantôme du doublon
const INV_DUP     = 41979;   // LIBFAC20260824-023653 (doublon)
const INV_KEEP    = 41978;   // LIBFAC20260824-023652 (vente réelle) — référence
const WAREHOUSE   = 4;       // Rayon
const EXPECT_TTC  = 37000;
const EXPECT_PAY  = 37000;
$PRODUCTS = [734, 5071];     // 1 exemplaire chacun

function fail($msg) { fwrite(STDERR, "ERREUR: $msg\n"); exit(1); }

// ── Utilisateur opérateur ─────────────────────────────────────────
$user = new User($db);
if ($user->fetch(0, 'admin') <= 0 || empty($user->id)) {
    if ($user->fetch(1) <= 0) fail("impossible de charger un utilisateur admin");
}
if (method_exists($user, 'loadRights')) $user->loadRights(); else $user->getrights();
echo "Opérateur : {$user->login} (id {$user->id})\n";

// ── Vérifications d'état AVANT écriture ───────────────────────────
$keep = new Facture($db);
if ($keep->fetch(INV_KEEP) <= 0) fail("facture conservée ".INV_KEEP." introuvable — ABANDON");
if ((float) $keep->total_ttc != EXPECT_TTC) fail("facture conservée total inattendu — ABANDON");
if ((int) $keep->paye !== 1) fail("facture conservée ".INV_KEEP." non payée — ABANDON");
echo "Vente réelle ".INV_KEEP." (023652) : validée et payée ✓\n";

$inv = new Facture($db);
if ($inv->fetch(INV_DUP) <= 0) fail("facture doublon ".INV_DUP." introuvable");
if ((float) $inv->total_ttc != EXPECT_TTC) fail("facture ".INV_DUP." total inattendu ({$inv->total_ttc}) — ABANDON");

$payExists = false;
$pay = new Paiement($db);
if ($pay->fetch(PAY_PHANTOM) > 0) {
    if ((float) $pay->amount != EXPECT_PAY) fail("paiement ".PAY_PHANTOM." montant inattendu ({$pay->amount}) — ABANDON");
    $res = $db->query("SELECT fk_facture FROM ".MAIN_DB_PREFIX."paiement_facture WHERE fk_paiement = ".((int) PAY_PHANTOM));
    $links = [];
    while ($o = $db->fetch_object($res)) $links[] = (int) $o->fk_facture;
    if (count($links) !== 1 || $links[0] !== INV_DUP) {
        fail("paiement ".PAY_PHANTOM." non imputé exclusivement sur ".INV_DUP." — ABANDON (vérif manuelle)");
    }
    $oBk = $db->fetch_object($db->query(
        "SELECT COUNT(*) AS nb FROM ".MAIN_DB_PREFIX."accounting_bookkeeping WHERE doc_type='bank' AND fk_doc = ".((int) PAY_PHANTOM)
    ));
    if ($oBk && (int) $oBk->nb > 0) fail("paiement ".PAY_PHANTOM." déjà comptabilisé — ABANDON, traitement compta requis");
    $payExists = true;
    echo "Paiement fantôme ".PAY_PHANTOM." (".EXPECT_PAY." F) : à supprimer\n";
} else {
    echo "Paiement fantôme ".PAY_PHANTOM." déjà absent — saut étape 1\n";
}

$alreadyCancelled = ((int) $inv->statut === Facture::STATUS_ABANDONED);
if ($alreadyCancelled) echo "Facture ".INV_DUP." déjà Abandonnée — saut étape 3\n";

// Restock déjà fait ? (mouvement de restitution repéré par libellé)
$oRe = $db->fetch_object($db->query(
    "SELECT COUNT(*) AS nb FROM ".MAIN_DB_PREFIX."stock_mouvement"
    ." WHERE value > 0 AND label LIKE '%doublon 023653%'"
));
$restockDone = ($oRe && (int) $oRe->nb >= count($PRODUCTS));
if ($restockDone) echo "Restitution stock déjà effectuée — saut étape 2\n";

if (!$payExists && $alreadyCancelled && $restockDone) { echo "Rien à faire : déjà régularisé.\n"; exit(0); }

echo "----- DÉBUT TRANSACTION -----\n";
$db->begin();

// Bug connu du garde-fou AccountLine::delete (fk_doc = id paiement) : levée EN MÉMOIRE.
$conf->global->BANK_ALLOW_TRANSACTION_DELETION_EVEN_IF_IN_ACCOUNTING = '1';

// ── 1) Supprimer le paiement fantôme ──
if ($payExists) {
    // Dolibarr refuse de supprimer un paiement sur une facture SOLDÉE
    // (ErrorDeletePaymentLinkedToAClosedInvoiceNotPossible). On la dévalide
    // d'abord (elle sera de toute façon abandonnée à l'étape 3).
    if ((int) $inv->paye === 1) {
        if ($inv->setUnpaid($user) < 0) { $db->rollback(); fail("dévalidation (set_unpaid) KO : ".$inv->error); }
        echo "1/3 · facture ".INV_DUP." repassée en 'impayée' pour permettre la suppression du paiement\n";
    }
    if ($pay->delete($user) < 0) { $db->rollback(); fail("suppression paiement KO : ".$pay->error); }
    echo "1/3 ✓ Paiement fantôme ".PAY_PHANTOM." supprimé (37 000 F retirés de la caisse Espèces)\n";
} else {
    echo "1/3 = déjà fait\n";
}

// ── 2) Restituer le stock (+1 par produit du doublon) ──
if (!$restockDone) {
    foreach ($PRODUCTS as $pid) {
        $ms = new MouvementStock($db);
        $lbl = "Restitution — annulation doublon 023653 (".INV_DUP.")";
        if ($ms->reception($user, $pid, WAREHOUSE, 1, 0, $lbl) < 0) {
            $db->rollback(); fail("restitution stock produit $pid KO : ".$ms->error);
        }
        echo "2/3 ✓ +1 exemplaire restitué (produit $pid, entrepôt ".WAREHOUSE.")\n";
    }
} else {
    echo "2/3 = déjà fait\n";
}

// ── 3) Abandonner la facture doublon (garde son numéro) ──
if (!$alreadyCancelled) {
    $note = "Doublon technique de LIBFAC20260824-023652 (".INV_KEEP.") — timeout POS 24/08. Paiement fantome annule, stock restitue.";
    if ($inv->setCanceled($user, Facture::CLOSECODE_REPLACED, $note) < 0) {
        $db->rollback(); fail("annulation facture KO : ".$inv->error);
    }
    echo "3/3 ✓ Facture ".INV_DUP." (023653) passée en Abandonnée / remplacée\n";
} else {
    echo "3/3 = déjà fait\n";
}

$db->commit();
echo "----- COMMIT OK -----\n";
echo "Terminé. Reste 1 vente réelle (023652, payée 37 000) ; caisse Espèces allégée de 37 000 ; stock 734/5071 restitué.\n";
exit(0);
