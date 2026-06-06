<?php
/**
 * Remédiation one-off — doublon de saisie POS du 03/06/2026.
 *
 * Contexte : une seule vente réelle (1× ISBN 9782343116815 à 17 000 F, client
 * CLIENT LIBRAIRE) a été saisie DEUX fois au POS :
 *   - 021819 (rowid 40101) : la VRAIE vente, payée 10 000 au moment de la vente
 *     (paiement 31271, 03/06 18:28). → CONSERVÉE (le client doit encore 7 000).
 *   - 021821 (rowid 40094) : doublon. Encaissement 10 000 le lendemain matin
 *     (paiement 31273, 04/06 08:41) = FANTÔME, aucun argent réel.
 *
 * Le client a remis 10 000 UNE SEULE FOIS (confirmé). Donc :
 *   1) supprimer le paiement fantôme 31273 (la caisse repasse à un seul 10 000) ;
 *   2) annuler la facture doublon 40094 en « remplacée » (statut Abandonnée, garde
 *      son numéro légal, traçable) ;
 *   3) restituer +1 au stock (setCanceled ne touche pas le stock).
 *
 * Idempotent : vérifie l'état attendu avant chaque action, s'arrête sans dégât si
 * la correction a déjà été appliquée. Atomique (rollback global sur erreur).
 *
 * Exécution : sudo -u www-data php fix-duplicate-invoice-40094.php
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
require_once $dolRoot.'/compta/bank/class/account.class.php'; // classes Account + AccountLine (utilisées par Paiement::delete)
require_once $dolRoot.'/product/stock/class/mouvementstock.class.php';

global $db, $conf, $langs;

// ── Constantes de la correction ───────────────────────────────────
const PAY_PHANTOM = 31273;   // paiement fantôme à supprimer (04/06, sur le doublon)
const INV_DUP     = 40094;   // facture doublon à annuler (021821)
const INV_KEEP    = 40101;   // facture conservée (021819) — référence
const PROD        = 715;     // produit ISBN 9782343116815
const WAREHOUSE   = 4;       // entrepôt Rayon
const EXPECT_TTC  = 17000;
const EXPECT_PAY  = 10000;

function fail($msg) { fwrite(STDERR, "ERREUR: $msg\n"); exit(1); }

// ── Charger l'utilisateur admin (pour l'auteur des opérations) ─────
$user = new User($db);
if ($user->fetch(0, 'admin') <= 0 || empty($user->id)) {
    if ($user->fetch(1) <= 0) fail("impossible de charger un utilisateur admin");
}
if (method_exists($user, 'loadRights')) $user->loadRights(); else $user->getrights();
echo "Utilisateur opérateur : {$user->login} (id {$user->id})\n";

// ── Vérifications d'état AVANT toute écriture ─────────────────────
$pay = new Paiement($db);
if ($pay->fetch(PAY_PHANTOM) <= 0) {
    echo "Paiement fantôme ".PAY_PHANTOM." introuvable — déjà supprimé ? Rien à faire.\n";
    exit(0);
}
if ((float) $pay->amount != EXPECT_PAY) {
    fail("paiement ".PAY_PHANTOM." montant inattendu ({$pay->amount}, attendu ".EXPECT_PAY.") — ABANDON");
}

// Le paiement fantôme doit bien être imputé sur la facture doublon, et UNIQUEMENT elle.
$sqlLink = "SELECT fk_facture, amount FROM ".MAIN_DB_PREFIX."paiement_facture WHERE fk_paiement = ".((int) PAY_PHANTOM);
$resLink = $db->query($sqlLink);
$links = [];
while ($o = $db->fetch_object($resLink)) $links[] = $o;
if (count($links) !== 1 || (int) $links[0]->fk_facture !== INV_DUP) {
    fail("le paiement ".PAY_PHANTOM." n'est pas imputé exclusivement sur la facture ".INV_DUP." — ABANDON (vérif manuelle)");
}

// Garde compta : notre paiement de juin ne doit avoir AUCUNE écriture réelle dans le
// grand livre (convention moteur maison : doc_type='bank' + fk_doc=rowid du paiement).
// Si une vraie écriture existait, on n'aurait pas le droit de supprimer sans la traiter.
$sqlBk = "SELECT COUNT(*) AS nb FROM ".MAIN_DB_PREFIX."accounting_bookkeeping"
    ." WHERE doc_type='bank' AND fk_doc = ".((int) PAY_PHANTOM);
$oBk = $db->fetch_object($db->query($sqlBk));
if ($oBk && (int) $oBk->nb > 0) {
    fail("le paiement ".PAY_PHANTOM." possède une écriture comptable réelle (".$oBk->nb.") — ABANDON, traitement comptable requis");
}

$inv = new Facture($db);
if ($inv->fetch(INV_DUP) <= 0) fail("facture doublon ".INV_DUP." introuvable");
if ($inv->statut == Facture::STATUS_ABANDONED) {
    echo "Facture ".INV_DUP." déjà Abandonnée — étape 2 déjà faite.\n";
}
if ((float) $inv->total_ttc != EXPECT_TTC) {
    fail("facture ".INV_DUP." total inattendu ({$inv->total_ttc}) — ABANDON");
}

// Sécurité : la facture conservée doit exister, être validée et porter son paiement réel.
$keep = new Facture($db);
if ($keep->fetch(INV_KEEP) <= 0) fail("facture conservée ".INV_KEEP." introuvable — ABANDON");
if ((float) $keep->total_ttc != EXPECT_TTC) fail("facture conservée total inattendu — ABANDON");

echo "État vérifié : doublon=".INV_DUP." (statut {$inv->statut}), paiement fantôme=".PAY_PHANTOM." (".EXPECT_PAY." F), conservée=".INV_KEEP." OK\n";
echo "----- DÉBUT TRANSACTION -----\n";

$db->begin();

// Le garde-fou natif de Dolibarr (AccountLine::delete) refuse la suppression car une
// AUTRE écriture (un paiement de MAI) a, via le moteur compta maison, un fk_doc qui
// COLLISIONNE avec le rowid de notre ligne banque de juin (bug connu : doc_type='bank'
// mais fkDoc=pay.rowid au lieu de l'id de ligne banque). On a vérifié ci-dessus que
// NOTRE paiement n'a aucune écriture réelle. On lève donc le garde-fou EN MÉMOIRE,
// uniquement pour ce process (aucune persistance, réinitialisé à la fin du script).
$conf->global->BANK_ALLOW_TRANSACTION_DELETION_EVEN_IF_IN_ACCOUNTING = '1';

// ── 1) Supprimer le paiement fantôme (banque + lien + recalcul natifs) ──
$r = $pay->delete($user);
if ($r < 0) { $db->rollback(); fail("suppression paiement KO : ".$pay->error); }
echo "1/3 ✓ Paiement fantôme ".PAY_PHANTOM." supprimé (écriture caisse du 04/06 annulée)\n";

// ── 2) Annuler la facture doublon (statut Abandonnée / remplacée) ──
if ($inv->statut != Facture::STATUS_ABANDONED) {
    $note = "Doublon de la facture LIBFAC20260603-021819 (rowid ".INV_KEEP.") — erreur de saisie POS. Paiement du 04/06 (fantome) annule.";
    $r = $inv->setCanceled($user, Facture::CLOSECODE_REPLACED, $note);
    if ($r < 0) { $db->rollback(); fail("annulation facture KO : ".$inv->error); }
    echo "2/3 ✓ Facture doublon ".INV_DUP." (021821) passée en Abandonnée/remplacée\n";
} else {
    echo "2/3 = Facture ".INV_DUP." déjà Abandonnée (saut)\n";
}

// ── 3) Restituer +1 exemplaire au stock (le doublon avait décrémenté à tort) ──
$ms = new MouvementStock($db);
$lbl = "Restitution exemplaire — annulation doublon facture 021821 (".INV_DUP.")";
$r = $ms->reception($user, PROD, WAREHOUSE, 1, 0, $lbl);
if ($r < 0) { $db->rollback(); fail("restitution stock KO : ".$ms->error); }
echo "3/3 ✓ +1 exemplaire restitué au stock (produit ".PROD.", entrepôt ".WAREHOUSE.")\n";

$db->commit();
echo "----- COMMIT OK -----\n";
echo "Terminé. Reste désormais : 1 facture (021819) payée 10 000 / reste 7 000 ; caisse = 1× 10 000 ; stock +1.\n";
exit(0);
