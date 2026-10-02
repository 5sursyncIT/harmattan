<?php
/**
 * Remédiation one-off — retour + remboursement de la vente POS LIBFAC20260921-024313.
 *
 * Contexte : facture 42658 (cliente Fara Njaay, 17 000 F) validée au POS le 21/09
 * (2× Cantiques crépusculaires + 1× Trois fois, j'ai manqué de dire adieu au poème),
 * acompte 10 000 F espèces encaissé le 30/09 (paiement 34054, banque 33682).
 * La cliente a rendu les 3 livres et récupéré ses 10 000 F (confirmé le 01/10).
 *
 *   1) supprimer le paiement 34054 (l'argent est ressorti de la caisse) ;
 *   2) abandonner la facture (garde son numéro légal, traçable) ;
 *   3) restituer les 3 exemplaires au Rayon (setCanceled ne touche pas le stock).
 *
 * Idempotent + atomique. Exécution : sudo -u www-data php fix-retour-invoice-42658.php
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
require_once $dolRoot.'/compta/bank/class/account.class.php';
require_once $dolRoot.'/product/stock/class/mouvementstock.class.php';

global $db, $conf, $langs;

const PAY       = 34054;
const INV       = 42658;
const WAREHOUSE = 4;
const EXPECT_TTC = 17000;
const EXPECT_PAY = 10000;
const RESTOCK   = [566 => 2, 3429 => 1];

function fail($msg) { fwrite(STDERR, "ERREUR: $msg\n"); exit(1); }

$user = new User($db);
if ($user->fetch(0, 'admin') <= 0 || empty($user->id)) {
    if ($user->fetch(1) <= 0) fail("impossible de charger un utilisateur admin");
}
if (method_exists($user, 'loadRights')) $user->loadRights(); else $user->getrights();
echo "Utilisateur opérateur : {$user->login} (id {$user->id})\n";

$inv = new Facture($db);
if ($inv->fetch(INV) <= 0) fail("facture ".INV." introuvable");
if ($inv->statut == Facture::STATUS_ABANDONED) { echo "Facture ".INV." déjà Abandonnée — rien à faire.\n"; exit(0); }
if ($inv->statut != Facture::STATUS_VALIDATED) fail("facture ".INV." statut inattendu ({$inv->statut})");
if ((float) $inv->total_ttc != EXPECT_TTC) fail("facture ".INV." total inattendu ({$inv->total_ttc})");

$pay = new Paiement($db);
$hasPay = $pay->fetch(PAY) > 0;
if ($hasPay) {
    if ((float) $pay->amount != EXPECT_PAY) fail("paiement ".PAY." montant inattendu ({$pay->amount})");
    $res = $db->query("SELECT fk_facture FROM ".MAIN_DB_PREFIX."paiement_facture WHERE fk_paiement = ".((int) PAY));
    $links = [];
    while ($o = $db->fetch_object($res)) $links[] = (int) $o->fk_facture;
    if ($links !== [INV]) fail("paiement ".PAY." non imputé exclusivement sur ".INV);
    $o = $db->fetch_object($db->query("SELECT COUNT(*) AS nb FROM ".MAIN_DB_PREFIX."accounting_bookkeeping WHERE doc_type='bank' AND fk_doc = ".((int) PAY)));
    if ($o && (int) $o->nb > 0) fail("le paiement ".PAY." a des écritures comptables — traitement comptable requis");
}
// Aucun autre paiement ni avoir sur la facture
$o = $db->fetch_object($db->query("SELECT COUNT(*) AS nb FROM ".MAIN_DB_PREFIX."paiement_facture WHERE fk_facture = ".INV." AND fk_paiement <> ".PAY));
if ((int) $o->nb > 0) fail("la facture porte d'autres paiements");
$o = $db->fetch_object($db->query("SELECT COUNT(*) AS nb FROM ".MAIN_DB_PREFIX."facture WHERE fk_facture_source = ".INV));
if ((int) $o->nb > 0) fail("la facture a des avoirs rattachés");

echo "État vérifié. ----- DÉBUT TRANSACTION -----\n";
$db->begin();

// Garde-fou natif levé en mémoire seulement (collision fk_doc connue du moteur compta maison ;
// on a vérifié que CE paiement n'a aucune écriture).
$conf->global->BANK_ALLOW_TRANSACTION_DELETION_EVEN_IF_IN_ACCOUNTING = '1';

if ($hasPay) {
    if ($pay->delete($user) < 0) { $db->rollback(); fail("suppression paiement KO : ".$pay->error); }
    echo "1/3 ✓ Paiement ".PAY." (10 000 F espèces du 30/09) supprimé\n";
} else {
    echo "1/3 = Paiement ".PAY." déjà absent (saut)\n";
}

$inv->fetch(INV);
$note = "Retour des 3 livres par la cliente + remboursement des 10 000 F verses le 30/09 (regularisation du 01/10/2026).";
if ($inv->setCanceled($user, Facture::CLOSECODE_ABANDONED, $note) < 0) { $db->rollback(); fail("abandon facture KO : ".$inv->error); }
echo "2/3 ✓ Facture ".INV." (LIBFAC20260921-024313) Abandonnée\n";

foreach (RESTOCK as $prod => $qty) {
    $ms = new MouvementStock($db);
    $ms->origin_type = 'facture';
    $ms->origin_id = INV;
    if ($ms->reception($user, $prod, WAREHOUSE, $qty, 0, "Retour client — abandon facture LIBFAC20260921-024313") < 0) {
        $db->rollback(); fail("restitution stock produit $prod KO : ".$ms->error);
    }
    echo "3/3 ✓ +$qty ex. produit $prod au Rayon\n";
}

$db->commit();
echo "----- COMMIT OK -----\n";
exit(0);
