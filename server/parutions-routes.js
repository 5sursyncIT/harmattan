/**
 * Parutions — relais entre la fin du pipeline éditorial et la commercialisation.
 *
 * Ce module donne à l'équipe communication (librarian) et à l'éditeur un
 * tableau de bord des ouvrages depuis `editorial_validated` jusqu'à la
 * parution (`published`) avec :
 *   • une checklist de lancement en 3 phases (brief interne dès la validation
 *     éditoriale, teasing dès le BAT validé, lancement officiel à l'impression
 *     terminée), cochable et tracée dans la frise du manuscrit ;
 *   • un kit de lancement téléchargeable (fiche .txt + couverture BAT) ;
 *   • des indicateurs auto-détectés (produit lié, « à paraître », dépôt légal).
 *
 * Depuis le 23/07/2026, la frise se prolonge au-delà de l'impression : deux
 * stages `in_communication` puis `published` (terminal) sont avancés
 * automatiquement au fil de la checklist (première action de lancement →
 * « En communication » ; checklist 17/17 → « Paru »), ou manuellement depuis
 * la fiche manuscrit. Données locales en SQLite (table parution_checklists).
 *
 * Sécurité : monté sur /api/admin/parutions — whitelist RBAC : super_admin,
 * admin, editor, librarian (+ surcharges module `parutions`).
 */

import { Router } from 'express';
import { existsSync, readdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import sharp from 'sharp';
import { STAGE_LABELS, logManuscriptEvent, transition } from './manuscript-workflow.js';
import { notifyTransition } from './manuscript-emails.js';

// Répertoire des documents produits Dolibarr (couvertures recto uploadées
// depuis /admin/books) — même chemin que refs-with-real-covers (index.js).
const DOLIBARR_PRODUCT_DOCS = '/var/www/html/dolibarr/documents/produit';

// Stages couverts par le tableau de bord des parutions.
const PARUTION_STAGES = ['print_preparation', 'printing', 'printed', 'in_communication', 'published'];
// Phase 2 : le brief de campagne se prépare EN AMONT, pendant que la couverture
// se fait — dès la validation éditoriale et jusqu'au BAT.
const BRIEF_STAGES = ['editorial_validated', 'cover_design', 'bat_author_review'];
const ALL_STAGES = [...BRIEF_STAGES, ...PARUTION_STAGES];

// Checklist de lancement — source unique de vérité (le front la reçoit via GET /).
// phase 'brief'    : préparation interne (pas de publication), dès editorial_validated.
// phase 'teasing'  : actionnable dès print_preparation (BAT validé, ISBN connu).
// phase 'lancement': actions du jour J, attendues au stade printed.
export const PARUTION_CHECKLIST = [
  { key: 'brief_angle',        phase: 'brief',     label: "Angle éditorial défini (pourquoi ce livre, pour qui)" },
  { key: 'brief_bio',          phase: 'brief',     label: "Bio et photo de l'auteur récupérées" },
  { key: 'brief_date',         phase: 'brief',     label: 'Date de parution cible fixée (même provisoire)' },
  { key: 'brief_dossier',      phase: 'brief',     label: 'Dossier de campagne préparé (argumentaire, visuels pressentis)' },
  { key: 'fiche_produit',      phase: 'teasing',   label: 'Fiche produit complétée (couverture, 4e de couverture, prix)' },
  { key: 'a_paraitre',         phase: 'teasing',   label: '« Ouvrage à paraître » activé (date de parution + résumé)' },
  { key: 'tag_nouveautes',     phase: 'teasing',   label: 'Tag « Nouveautés » appliqué au livre' },
  { key: 'banniere_teasing',   phase: 'teasing',   label: "Bannière d'annonce sur la page d'accueil" },
  { key: 'article_news',      phase: 'teasing',   label: 'Article « Prochainement » publié dans les actualités' },
  { key: 'email_auteur',       phase: 'teasing',   label: "Auteur informé de la date de parution prévue" },
  { key: 'catalogue_actif',    phase: 'lancement', label: '« À paraître » retiré — livre disponible au catalogue' },
  { key: 'tag_selection',      phase: 'lancement', label: 'Tag « Livre du mois » / « Notre sélection »' },
  { key: 'banniere_parution',  phase: 'lancement', label: 'Bannière « Vient de paraître »' },
  { key: 'newsletter',         phase: 'lancement', label: 'Newsletter de parution envoyée aux abonnés' },
  { key: 'fiche_auteur',       phase: 'lancement', label: 'Fiche auteur publique à jour (bio, photo)' },
  { key: 'coordination_auteur', phase: 'lancement', label: "Coordination auteur (photos, citation, événement de lancement)" },
  { key: 'depot_legal',        phase: 'lancement', label: 'Dépôt légal enregistré (registre)' },
];
const CHECKLIST_KEYS = new Set(PARUTION_CHECKLIST.map((i) => i.key));
const BRIEF_TOTAL = PARUTION_CHECKLIST.filter((i) => i.phase === 'brief').length;
const TEASING_TOTAL = PARUTION_CHECKLIST.filter((i) => i.phase === 'teasing').length;
const TOTAL_ITEMS = PARUTION_CHECKLIST.length;

function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS parution_checklists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    manuscript_id INTEGER NOT NULL,
    item_key TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    done_by TEXT,
    done_at DATETIME,
    UNIQUE(manuscript_id, item_key)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_parution_checklists_ms ON parution_checklists(manuscript_id)`);
  // Journal des newsletters de parution envoyées (anti double-envoi + audit).
  db.exec(`CREATE TABLE IF NOT EXISTS parution_newsletter_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    manuscript_id INTEGER NOT NULL,
    subject TEXT,
    recipients INTEGER NOT NULL DEFAULT 0,
    sent_by TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
}

// Date du jour côté Dakar (le serveur est en CEST : sans ça, la bascule
// « à paraître → disponible » partirait avec 2 h d'avance).
function todayDakar() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Dakar' });
}

/**
 * Bascule automatique du jour de parution (cron quotidien) : pour chaque livre
 * « à paraître » dont release_date est atteinte, retire le flag (le livre
 * redevient un livre catalogue normal — les précommandes, elles, sont déjà
 * gérées par le cron preorders existant). Si un manuscrit est lié au produit,
 * coche automatiquement « catalogue_actif » et trace la frise.
 * @returns {number} nombre de livres basculés
 */
export function runReleaseDaySwitch(db, { cache } = {}) {
  const today = todayDakar();
  const due = db.prepare(
    `SELECT product_id, release_date FROM book_upcoming
     WHERE release_date IS NOT NULL AND release_date != '' AND release_date <= ?`
  ).all(today);
  let switched = 0;
  for (const row of due) {
    try {
      // Conserve la date réelle de sortie avant de vider book_upcoming : elle
      // pilote l'entrée/sortie automatique du tag « Nouveautés ».
      try {
        db.prepare(`
          INSERT INTO book_release_dates (product_id, release_date, source, updated_at)
          VALUES (?, ?, 'jour_j', datetime('now'))
          ON CONFLICT(product_id) DO UPDATE SET
            release_date = excluded.release_date, source = 'jour_j', updated_at = datetime('now')
        `).run(row.product_id, row.release_date);
      } catch (e) { console.warn('[PARUTIONS] book_release_dates upsert:', e.message); }
      db.prepare('DELETE FROM book_upcoming WHERE product_id = ?').run(row.product_id);
      cache?.del('upcoming_books:public');
      switched += 1;
      try {
        db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
          .run('system', 'release_autopublish',
            `Jour J (${row.release_date}) : « à paraître » retiré automatiquement — produit #${row.product_id} disponible au catalogue`);
      } catch { /* journal non bloquant */ }

      const manuscript = db.prepare('SELECT id FROM manuscripts WHERE dolibarr_product_id = ?').get(row.product_id);
      if (manuscript) {
        db.prepare(
          `INSERT INTO parution_checklists (manuscript_id, item_key, done, done_by, done_at)
           VALUES (?, 'catalogue_actif', 1, 'system', datetime('now'))
           ON CONFLICT(manuscript_id, item_key)
           DO UPDATE SET done = 1, done_by = 'system', done_at = datetime('now')`
        ).run(manuscript.id);
        logManuscriptEvent(db, manuscript.id, 'comm_checklist', { role: 'system', label: 'cron' },
          `✔ (auto) « À paraître » retiré à la date de parution (${row.release_date}) — livre disponible au catalogue`);
        // Jour J = le livre entre en communication (frise prolongée). Pas
        // d'email ici (cron sans transporter) : la transition est tracée.
        autoAdvanceCommunication(db, manuscript.id, { role: 'system', label: 'cron' }, {
          firstLaunchNote: `Jour J (${row.release_date}) : livre disponible au catalogue — communication en cours`,
        });
      }
    } catch (err) {
      console.error('[PARUTIONS] release switch error (produit', row.product_id, '):', err.message);
    }
  }
  return switched;
}

// Fenêtre « Nouveautés » : un ouvrage paru reste en Nouveautés pendant N jours
// après sa date de parution, puis en sort automatiquement. Surcharge possible
// via NOUVEAUTES_WINDOW_DAYS dans le .env.
const NOUVEAUTES_WINDOW_DAYS = Math.max(7, parseInt(process.env.NOUVEAUTES_WINDOW_DAYS || '90', 10) || 90);

/**
 * Synchronise le tag « Nouveautés » avec les dates réelles de parution
 * (cron quotidien, après runReleaseDaySwitch) :
 *  - ENTRÉE : tout produit dont la date de parution est atteinte et dans la
 *    fenêtre (et qui n'est plus « à paraître ») est tagué automatiquement ;
 *  - SORTIE : un produit quitte les Nouveautés quand sa date de parution est
 *    plus vieille que la fenêtre — ou, si sa date est inconnue (tag posé à la
 *    main), quand son année de publication (extrafield Dolibarr) est
 *    antérieure à l'année de la fenêtre, ou quand le tag a été posé il y a
 *    plus de NOUVEAUTES_WINDOW_DAYS.
 * Les entrées épinglées (pinned=1) sont des choix éditoriaux : jamais retirées.
 * @returns {{added: number, removed: number}}
 */
export async function refreshNouveautesTag(db, { cache, dolibarrPool } = {}) {
  const tag = db.prepare("SELECT id FROM book_tags WHERE slug = 'nouveaute'").get();
  if (!tag) return { added: 0, removed: 0 };
  const today = todayDakar();
  const cutoffDate = new Date(`${today}T12:00:00Z`);
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - NOUVEAUTES_WINDOW_DAYS);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  const added = db.prepare(`
    INSERT OR IGNORE INTO book_tag_products (tag_id, product_id)
    SELECT ?, brd.product_id FROM book_release_dates brd
    WHERE brd.release_date <= ? AND brd.release_date > ?
      AND brd.product_id NOT IN (SELECT product_id FROM book_upcoming)
  `).run(tag.id, today, cutoff).changes;

  let removed = db.prepare(`
    DELETE FROM book_tag_products
    WHERE tag_id = ? AND pinned = 0 AND (
      product_id IN (SELECT product_id FROM book_release_dates WHERE release_date <= ?)
      OR (product_id NOT IN (SELECT product_id FROM book_release_dates) AND date(added_at) <= ?)
    )
  `).run(tag.id, cutoff, cutoff).changes;

  // Livres tagués à la main sans date précise : l'année de publication
  // (extrafield Dolibarr) sert de garde-fou — un ouvrage publié avant l'année
  // de la fenêtre n'est pas une nouveauté, quel que soit l'âge du tag.
  if (dolibarrPool) {
    const candidates = db.prepare(`
      SELECT product_id FROM book_tag_products
      WHERE tag_id = ? AND pinned = 0
        AND product_id NOT IN (SELECT product_id FROM book_release_dates)
    `).all(tag.id).map((r) => r.product_id);
    if (candidates.length) {
      const minYear = parseInt(cutoff.slice(0, 4), 10);
      try {
        const [stale] = await dolibarrPool.query(
          `SELECT fk_object FROM llx_product_extrafields
           WHERE fk_object IN (${candidates.map(() => '?').join(',')})
             AND publication_year IS NOT NULL AND publication_year != ''
             AND CAST(publication_year AS UNSIGNED) < ?`,
          [...candidates, minYear]
        );
        const del = db.prepare('DELETE FROM book_tag_products WHERE tag_id = ? AND product_id = ?');
        for (const r of stale) removed += del.run(tag.id, r.fk_object).changes;
      } catch (err) {
        console.warn('[PARUTIONS] nettoyage Nouveautés par année de publication:', err.message);
      }
    }
  }

  if ((added || removed) && cache) {
    for (const k of cache.keys()) {
      if (k.startsWith('home:tags') || k.startsWith('tag:')) cache.del(k);
    }
  }
  return { added, removed };
}

/**
 * Prolongement de la frise au-delà de l'impression : avance la machine à états
 * au fil des actions de lancement. `printed` → `in_communication` dès qu'une
 * action de lancement est effectuée ; → `published` quand la checklist est
 * complète (fullyDone). Non bloquant : un stage inattendu est simplement ignoré.
 * @returns {Array} manuscrits mis à jour (un par transition effectuée)
 */
export function autoAdvanceCommunication(db, manuscriptId, actor, { firstLaunchNote, fullyDone = false } = {}) {
  const advanced = [];
  try {
    let m = db.prepare('SELECT id, current_stage FROM manuscripts WHERE id = ?').get(manuscriptId);
    if (!m) return advanced;
    if (m.current_stage === 'printed') {
      advanced.push({
        to_stage: 'in_communication',
        manuscript: transition(db, m.id, 'in_communication', actor,
          { note: firstLaunchNote || 'Lancement commercial démarré' }),
      });
      m = { ...m, current_stage: 'in_communication' };
    }
    if (fullyDone && m.current_stage === 'in_communication') {
      advanced.push({
        to_stage: 'published',
        manuscript: transition(db, m.id, 'published', actor,
          { note: 'Checklist de lancement complète — ouvrage paru' }),
      });
    }
  } catch (err) {
    console.warn('[PARUTIONS] avancement auto workflow:', err.message);
  }
  return advanced;
}

// Badge de navigation : ouvrages dont la checklist attendue au stade courant
// n'est pas complète — brief dès editorial_validated, brief+teasing dès
// print_preparation, tout au stade printed.
export function countParutionsTodo(db) {
  try {
    return db.prepare(
      `SELECT COUNT(*) AS c FROM manuscripts m
       WHERE m.current_stage IN ('editorial_validated','cover_design','bat_author_review','print_preparation','printing','printed','in_communication')
         AND (SELECT COUNT(*) FROM parution_checklists pc
              WHERE pc.manuscript_id = m.id AND pc.done = 1)
             < (CASE WHEN m.current_stage IN ('printed','in_communication') THEN ?
                     WHEN m.current_stage IN ('print_preparation','printing') THEN ?
                     ELSE ? END)`
    ).get(TOTAL_ITEMS, BRIEF_TOTAL + TEASING_TOTAL, BRIEF_TOTAL)?.c || 0;
  } catch {
    return 0; // table pas encore créée (premier démarrage)
  }
}

export function createParutionsRouter({ db, dolibarrPool, auth, csrfProtection, siteUrl, transporter, cache }) {
  const router = Router();
  ensureTables(db);
  const csrf = csrfProtection || ((req, res, next) => next());
  void cache; // réservé aux évolutions (invalidation ciblée)

  const getProductInfo = async (productId) => {
    if (!productId || !dolibarrPool) return null;
    try {
      const [rows] = await dolibarrPool.query(
        'SELECT rowid, ref, label, barcode, price_ttc FROM llx_product WHERE rowid = ? LIMIT 1',
        [productId]
      );
      return rows?.[0] || null;
    } catch (err) {
      console.warn('[PARUTIONS] Dolibarr product lookup failed:', err.message);
      return null;
    }
  };

  // Dernière couverture disponible pour un manuscrit (BAT de préférence,
  // sinon la maquette de l'infographiste).
  const pickCoverFile = (manuscriptId) => db.prepare(
    `SELECT * FROM manuscript_files
     WHERE manuscript_id = ? AND kind IN ('bat_cover', 'cover_artwork')
     ORDER BY CASE kind WHEN 'bat_cover' THEN 0 ELSE 1 END, version DESC, uploaded_at DESC
     LIMIT 1`
  ).get(manuscriptId);

  const getChecklistState = (manuscriptId) => {
    const rows = db.prepare(
      'SELECT item_key, done, done_by, done_at FROM parution_checklists WHERE manuscript_id = ?'
    ).all(manuscriptId);
    const byKey = Object.fromEntries(rows.map((r) => [r.item_key, r]));
    return PARUTION_CHECKLIST.map((item) => ({
      ...item,
      done: !!byKey[item.key]?.done,
      done_by: byKey[item.key]?.done_by || null,
      done_at: byKey[item.key]?.done_at || null,
    }));
  };

  const loadManuscript = (id) => db.prepare(
    `SELECT m.*, a.firstname || ' ' || a.lastname AS author_name,
            a.email AS author_email, a.bio AS author_bio, a.slug AS author_slug,
            a.photo_url AS author_photo_url, a.display_name AS author_display_name
     FROM manuscripts m JOIN authors a ON a.id = m.author_id
     WHERE m.id = ?`
  ).get(id);

  // ═══════════════════════════════════════════════════════════
  // LISTE — tableau de bord des parutions
  // ═══════════════════════════════════════════════════════════
  router.get('/', auth, (req, res) => {
    const rows = db.prepare(
      `SELECT m.*, a.firstname || ' ' || a.lastname AS author_name,
              a.slug AS author_slug, a.photo_url AS author_photo_url, a.bio AS author_bio
       FROM manuscripts m JOIN authors a ON a.id = m.author_id
       WHERE m.current_stage IN ('editorial_validated','cover_design','bat_author_review','print_preparation','printing','printed','in_communication','published')
       ORDER BY CASE m.current_stage
                  WHEN 'in_communication' THEN 0 WHEN 'printed' THEN 1 WHEN 'printing' THEN 2 WHEN 'print_preparation' THEN 3
                  WHEN 'bat_author_review' THEN 4 WHEN 'cover_design' THEN 5 WHEN 'published' THEN 7 ELSE 6 END,
                m.updated_at DESC`
    ).all();

    const out = rows.map((m) => {
      const checklist = getChecklistState(m.id);
      const brief = checklist.filter((i) => i.phase === 'brief');
      const teasing = checklist.filter((i) => i.phase === 'teasing');
      const lancement = checklist.filter((i) => i.phase === 'lancement');

      // Indicateurs auto-détectés depuis les modules existants.
      let upcoming = null;
      if (m.dolibarr_product_id) {
        try {
          upcoming = db.prepare('SELECT release_date, summary FROM book_upcoming WHERE product_id = ?')
            .get(m.dolibarr_product_id) || null;
        } catch { /* table absente */ }
      }
      let legalDeposit = null;
      try {
        legalDeposit = db.prepare(
          `SELECT status FROM legal_deposits
           WHERE (product_id IS NOT NULL AND product_id = ?) OR (isbn IS NOT NULL AND isbn != '' AND isbn = ?)
           ORDER BY (status = 'deposited') DESC LIMIT 1`
        ).get(m.dolibarr_product_id || -1, m.isbn || '') || null;
      } catch { /* table absente */ }
      const cover = pickCoverFile(m.id);

      return {
        id: m.id,
        ref: m.ref,
        title: m.title,
        subtitle: m.subtitle || null,
        genre: m.genre || null,
        current_stage: m.current_stage,
        stage_label: STAGE_LABELS[m.current_stage] || m.current_stage,
        // 'brief' = campagne à préparer en amont (couverture en cours) ;
        // 'parution' = teasing/lancement (BAT validé et au-delà).
        section: BRIEF_STAGES.includes(m.current_stage) ? 'brief' : 'parution',
        updated_at: m.updated_at,
        author_name: m.author_name,
        author_slug: m.author_slug || null,
        author_has_photo: !!m.author_photo_url,
        author_has_bio: !!(m.author_bio && m.author_bio.trim()),
        has_synopsis: !!(m.synopsis && m.synopsis.trim()),
        isbn: m.isbn || null,
        print_qty: m.print_qty || null,
        dolibarr_product_id: m.dolibarr_product_id || null,
        upcoming: upcoming ? { release_date: upcoming.release_date, has_summary: !!upcoming.summary } : null,
        legal_deposit_status: legalDeposit?.status || null,
        has_cover: !!cover,
        checklist,
        brief_done: brief.filter((i) => i.done).length,
        brief_total: brief.length,
        teasing_done: teasing.filter((i) => i.done).length,
        teasing_total: teasing.length,
        launch_done: lancement.filter((i) => i.done).length,
        launch_total: lancement.length,
        newsletter_sent_at: db.prepare(
          'SELECT sent_at FROM parution_newsletter_log WHERE manuscript_id = ? ORDER BY id DESC LIMIT 1'
        ).get(m.id)?.sent_at || null,
      };
    });
    res.json({ manuscripts: out, checklist_items: PARUTION_CHECKLIST });
  });

  // ═══════════════════════════════════════════════════════════
  // CHECKLIST — cocher / décocher un item (tracé dans la frise)
  // ═══════════════════════════════════════════════════════════
  router.post('/:id/checklist/:key', auth, csrf, (req, res) => {
    const item = PARUTION_CHECKLIST.find((i) => i.key === req.params.key);
    if (!item || !CHECKLIST_KEYS.has(req.params.key)) {
      return res.status(400).json({ error: 'Item de checklist inconnu' });
    }
    const manuscript = db.prepare('SELECT id, ref, current_stage FROM manuscripts WHERE id = ?').get(req.params.id);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    // Le brief est cochable dès editorial_validated ; teasing/lancement
    // seulement à partir de print_preparation (BAT validé).
    const allowedStages = item.phase === 'brief' ? ALL_STAGES : PARUTION_STAGES;
    if (!allowedStages.includes(manuscript.current_stage)) {
      return res.status(400).json({ error: `Checklist « ${item.phase} » indisponible au stade ${manuscript.current_stage}` });
    }
    const done = req.body?.done ? 1 : 0;
    const doneBy = req.admin.username || String(req.admin.id);
    db.prepare(
      `INSERT INTO parution_checklists (manuscript_id, item_key, done, done_by, done_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(manuscript_id, item_key)
       DO UPDATE SET done = excluded.done, done_by = excluded.done_by, done_at = excluded.done_at`
    ).run(manuscript.id, item.key, done, doneBy);

    const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
    logManuscriptEvent(db, manuscript.id, 'comm_checklist', actor,
      `${done ? '✔' : '✘ (décoché)'} ${item.label}`);

    // Jalons de frise : brief complet → « Brief communication prêt » ;
    // toutes les cases cochées → « Lancement commercial préparé ».
    const doneCount = db.prepare(
      'SELECT COUNT(*) AS c FROM parution_checklists WHERE manuscript_id = ? AND done = 1'
    ).get(manuscript.id)?.c || 0;
    let briefReady = false;
    if (done && item.phase === 'brief') {
      const briefKeys = PARUTION_CHECKLIST.filter((i) => i.phase === 'brief').map((i) => i.key);
      const briefDone = db.prepare(
        `SELECT COUNT(*) AS c FROM parution_checklists
         WHERE manuscript_id = ? AND done = 1 AND item_key IN (${briefKeys.map(() => '?').join(',')})`
      ).get(manuscript.id, ...briefKeys)?.c || 0;
      if (briefDone === BRIEF_TOTAL) {
        logManuscriptEvent(db, manuscript.id, 'communication_brief_ready', actor,
          'Brief de campagne complet — la communication peut préparer le lancement');
        briefReady = true;
      }
    }
    let launchPrepared = false;
    if (done && doneCount === TOTAL_ITEMS) {
      logManuscriptEvent(db, manuscript.id, 'launch_prepared', actor,
        'Checklist de lancement commercial complète');
      launchPrepared = true;
    }

    // Prolongement de la frise : première action de lancement cochée après
    // l'impression → « En communication » ; checklist 17/17 → « Paru ».
    // L'auteur et les admins sont notifiés comme pour toute transition.
    let newStage = null;
    if (done && (item.phase === 'lancement' || launchPrepared)) {
      const sysActor = { role: 'system', id: req.admin.id, label: req.admin.username };
      const advanced = autoAdvanceCommunication(db, manuscript.id, sysActor, {
        firstLaunchNote: `Lancement commercial démarré (« ${item.label} »)`,
        fullyDone: launchPrepared,
      });
      for (const step of advanced) {
        try { notifyTransition(db, transporter, step.manuscript, step.to_stage, sysActor, siteUrl); }
        catch (err) { console.warn('[PARUTIONS] notification transition:', err.message); }
        newStage = step.to_stage;
      }
    }
    res.json({ success: true, done: !!done, done_count: doneCount, brief_ready: briefReady, launch_prepared: launchPrepared, new_stage: newStage });
  });

  // ═══════════════════════════════════════════════════════════
  // KIT DE LANCEMENT — fiche .txt téléchargeable
  // ═══════════════════════════════════════════════════════════
  router.get('/:id/kit/fiche', auth, async (req, res) => {
    const m = loadManuscript(req.params.id);
    if (!m) return res.status(404).json({ error: 'Manuscrit introuvable' });

    // Prix et libellé catalogue depuis Dolibarr (TTC uniquement — jamais de HT/TVA).
    let product = null;
    if (m.dolibarr_product_id && dolibarrPool) {
      try {
        const [rows] = await dolibarrPool.query(
          'SELECT rowid, ref, label, barcode, price_ttc FROM llx_product WHERE rowid = ? LIMIT 1',
          [m.dolibarr_product_id]
        );
        product = rows?.[0] || null;
      } catch (err) { console.warn('[PARUTIONS] Dolibarr product lookup failed:', err.message); }
    }
    let upcoming = null;
    if (m.dolibarr_product_id) {
      try {
        upcoming = db.prepare('SELECT release_date, summary FROM book_upcoming WHERE product_id = ?')
          .get(m.dolibarr_product_id) || null;
      } catch { /* table absente */ }
    }

    const fmtPrice = (p) => (p == null ? '—' : `${Math.round(Number(p)).toLocaleString('fr-FR')} F CFA`);
    const line = (label, value) => `${label.padEnd(24)}: ${value || '—'}`;
    const base = siteUrl || '';
    const authorName = m.author_display_name || m.author_name;
    const content = [
      '════════════════════════════════════════════════════',
      '  KIT DE LANCEMENT — L\'HARMATTAN SÉNÉGAL',
      '════════════════════════════════════════════════════',
      '',
      line('Titre', m.title),
      line('Sous-titre', m.subtitle),
      line('Auteur', authorName),
      line('Genre', m.genre),
      line('Référence manuscrit', m.ref),
      line('ISBN', m.isbn || product?.barcode),
      line('Tirage', m.print_qty ? `${m.print_qty} exemplaires` : null),
      line('Prix de vente (TTC)', product ? fmtPrice(product.price_ttc) : null),
      line('Date de parution', upcoming?.release_date),
      line('Étape du pipeline', STAGE_LABELS[m.current_stage] || m.current_stage),
      '',
      '──── SYNOPSIS ─────────────────────────────────────',
      m.synopsis || '(à compléter)',
      '',
      '──── RÉSUMÉ « À PARAÎTRE » (site) ─────────────────',
      upcoming?.summary || '(non renseigné)',
      '',
      '──── BIO AUTEUR ───────────────────────────────────',
      (m.author_bio && m.author_bio.trim()) || '(à compléter sur la fiche auteur)',
      '',
      '──── LIENS UTILES ─────────────────────────────────',
      line('Fiche produit (admin)', m.dolibarr_product_id ? `${base}/admin/books` : '(produit non lié)'),
      line('Fiche auteur (public)', m.author_slug ? `${base}/auteurs/${m.author_slug}` : null),
      line('Panneau Parutions', `${base}/admin/parutions`),
      line('Bannières', `${base}/admin/slides`),
      line('Tags curation', `${base}/admin/tags`),
      line('Actualités', `${base}/admin/news`),
      line('Newsletter', `${base}/admin/newsletter`),
      line('Dépôt légal', `${base}/admin/legal-deposits`),
      '',
      `Généré le ${new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Dakar' })} — ${m.ref}`,
      '',
    ].join('\n');

    const safe = (m.title || 'ouvrage').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'ouvrage';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="kit-lancement-${safe}.txt"`);
    res.send('\ufeff' + content); // BOM : accents corrects à l'ouverture sous Windows
  });

  // ═══════════════════════════════════════════════════════════
  // KIT DE LANCEMENT — couverture (BAT de préférence)
  // ═══════════════════════════════════════════════════════════
  router.get('/:id/kit/cover', auth, (req, res) => {
    const manuscript = db.prepare('SELECT id, title FROM manuscripts WHERE id = ?').get(req.params.id);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    const file = pickCoverFile(manuscript.id);
    if (!file) return res.status(404).json({ error: 'Aucune couverture déposée pour cet ouvrage' });
    if (file.external_url) return res.redirect(file.external_url);
    if (!file.file_path || !existsSync(file.file_path)) {
      return res.status(404).json({ error: 'Fichier couverture introuvable sur le serveur' });
    }
    res.download(file.file_path, file.file_name || 'couverture');
  });

  // ═══════════════════════════════════════════════════════════
  // NEWSLETTER « NOUVELLE PARUTION » — pré-remplie depuis le kit
  // ═══════════════════════════════════════════════════════════
  const escapeHtml = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmtPriceTtc = (p) => (p == null ? null : `${Math.round(Number(p)).toLocaleString('fr-FR')} F CFA`);

  // Construit la campagne. Le lien de désinscription est un marqueur %%UNSUB%%
  // remplacé par le lien personnel de chaque abonné au moment de l'envoi.
  const buildNewsletterEmail = (m, product, upcoming) => {
    const base = siteUrl || '';
    const title = escapeHtml(m.title);
    const authorName = escapeHtml(m.author_display_name || m.author_name);
    const summary = escapeHtml((upcoming?.summary || '').trim() || (m.synopsis || '').trim()).slice(0, 900);
    const price = fmtPriceTtc(product?.price_ttc);
    const productUrl = `${base}/produit/${m.dolibarr_product_id}`;
    const coverUrl = `${base}/api/image/${m.dolibarr_product_id}`;
    const subject = `Nouvelle parution — « ${m.title} » de ${m.author_display_name || m.author_name}`;
    const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">
  <h2 style="color:#10531a;border-bottom:2px solid #10531a;padding-bottom:8px">Nouvelle parution</h2>
  <p>Bonjour,</p>
  <p>Les éditions L'Harmattan Sénégal ont le plaisir de vous annoncer la parution de :</p>
  <div style="text-align:center;margin:22px 0">
    <img src="${coverUrl}" alt="${title}" style="max-width:240px;max-height:340px;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.18)" />
  </div>
  <h3 style="text-align:center;margin:0 0 4px;color:#0f172a">« ${title} »</h3>
  ${m.subtitle ? `<p style="text-align:center;color:#475569;font-style:italic;margin:0 0 6px">${escapeHtml(m.subtitle)}</p>` : ''}
  <p style="text-align:center;color:#334155;margin:0 0 16px">de <strong>${authorName}</strong>${m.genre ? ` · ${escapeHtml(m.genre)}` : ''}</p>
  ${summary ? `<p style="color:#334155;line-height:1.65">${summary}</p>` : ''}
  ${price ? `<p style="text-align:center;font-size:1.05em"><strong>${price}</strong></p>` : ''}
  <div style="text-align:center;margin:24px 0">
    <a href="${productUrl}" style="background:#10531a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:bold;display:inline-block">Découvrir le livre</a>
  </div>
  <p style="color:#666;font-size:0.9em;margin-top:28px">L'équipe éditoriale — L'Harmattan Sénégal</p>
  <p style="color:#94a3b8;font-size:0.78em;border-top:1px solid #e2e8f0;padding-top:10px;margin-top:18px">
    Vous recevez cet email car vous êtes abonné·e à la newsletter de L'Harmattan Sénégal.
    <a href="%%UNSUB%%" style="color:#94a3b8">Se désinscrire</a>
  </p>
</div>`;
    return { subject, html };
  };

  const countSubscribers = () =>
    db.prepare('SELECT COUNT(*) AS c FROM newsletter WHERE confirmed = 1').get()?.c || 0;

  // Lien de désinscription personnel : (ré)génère un token si l'abonné n'en a
  // plus (le token d'inscription est effacé à la confirmation).
  const unsubLinkFor = (subscriber) => {
    let token = subscriber.token;
    if (!token) {
      token = crypto.randomBytes(24).toString('hex');
      db.prepare('UPDATE newsletter SET token = ? WHERE id = ?').run(token, subscriber.id);
    }
    return `${siteUrl || ''}/api/newsletter/unsubscribe?token=${token}`;
  };

  router.get('/:id/newsletter/preview', auth, async (req, res) => {
    const m = loadManuscript(req.params.id);
    if (!m) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (!m.dolibarr_product_id) {
      return res.status(400).json({ error: 'Produit non lié : reliez d\'abord la fiche livre (ISBN) pour générer la newsletter' });
    }
    const product = await getProductInfo(m.dolibarr_product_id);
    let upcoming = null;
    try {
      upcoming = db.prepare('SELECT release_date, summary FROM book_upcoming WHERE product_id = ?')
        .get(m.dolibarr_product_id) || null;
    } catch { /* table absente */ }
    const { subject, html } = buildNewsletterEmail(m, product, upcoming);
    const lastSent = db.prepare(
      'SELECT sent_at, recipients, sent_by FROM parution_newsletter_log WHERE manuscript_id = ? ORDER BY id DESC LIMIT 1'
    ).get(m.id) || null;
    res.json({
      subject,
      html: html.replace('%%UNSUB%%', `${siteUrl || ''}/api/newsletter/unsubscribe`),
      subscribers: countSubscribers(),
      last_sent: lastSent,
    });
  });

  router.post('/:id/newsletter/test', auth, csrf, async (req, res) => {
    if (!transporter) return res.status(503).json({ error: 'Envoi d\'emails non configuré sur le serveur' });
    const email = String(req.body?.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Adresse email invalide' });
    const m = loadManuscript(req.params.id);
    if (!m) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (!m.dolibarr_product_id) return res.status(400).json({ error: 'Produit non lié' });
    const product = await getProductInfo(m.dolibarr_product_id);
    let upcoming = null;
    try {
      upcoming = db.prepare('SELECT release_date, summary FROM book_upcoming WHERE product_id = ?').get(m.dolibarr_product_id) || null;
    } catch { /* table absente */ }
    const { subject, html } = buildNewsletterEmail(m, product, upcoming);
    try {
      await transporter.sendMail({
        from: '"L\'Harmattan Sénégal" <noreply@senharmattan.com>',
        to: email,
        subject: `[TEST] ${subject}`,
        html: html.replace('%%UNSUB%%', `${siteUrl || ''}/api/newsletter/unsubscribe`),
      });
      res.json({ success: true });
    } catch (err) {
      res.status(502).json({ error: `Échec de l'envoi test : ${err.message}` });
    }
  });

  router.post('/:id/newsletter/send', auth, csrf, async (req, res) => {
    if (!transporter) return res.status(503).json({ error: 'Envoi d\'emails non configuré sur le serveur' });
    const m = loadManuscript(req.params.id);
    if (!m) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (!m.dolibarr_product_id) return res.status(400).json({ error: 'Produit non lié' });

    // Anti double-envoi : une campagne déjà partie ne repart pas sans `force`.
    const already = db.prepare(
      'SELECT sent_at, recipients FROM parution_newsletter_log WHERE manuscript_id = ? ORDER BY id DESC LIMIT 1'
    ).get(m.id);
    if (already && !req.body?.force) {
      return res.status(409).json({
        error: `Newsletter déjà envoyée le ${already.sent_at} à ${already.recipients} abonné(s). Renvoyez avec « forcer » si c'est voulu.`,
        last_sent: already,
      });
    }

    const subscribers = db.prepare('SELECT id, email, token FROM newsletter WHERE confirmed = 1').all();
    if (!subscribers.length) return res.status(400).json({ error: 'Aucun abonné confirmé à la newsletter' });

    const product = await getProductInfo(m.dolibarr_product_id);
    let upcoming = null;
    try {
      upcoming = db.prepare('SELECT release_date, summary FROM book_upcoming WHERE product_id = ?').get(m.dolibarr_product_id) || null;
    } catch { /* table absente */ }
    const { subject, html } = buildNewsletterEmail(m, product, upcoming);
    const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };

    // Journal AVANT l'envoi (verrouille le double-clic), puis envoi séquentiel en
    // arrière-plan : on répond tout de suite, le SMTP prend son temps.
    db.prepare(
      'INSERT INTO parution_newsletter_log (manuscript_id, subject, recipients, sent_by) VALUES (?, ?, ?, ?)'
    ).run(m.id, subject, subscribers.length, req.admin.username || String(req.admin.id));

    (async () => {
      let ok = 0, ko = 0;
      for (const sub of subscribers) {
        try {
          await transporter.sendMail({
            from: '"L\'Harmattan Sénégal" <noreply@senharmattan.com>',
            to: sub.email,
            subject,
            html: html.replace('%%UNSUB%%', unsubLinkFor(sub)),
          });
          ok += 1;
        } catch (err) {
          ko += 1;
          console.warn('[PARUTIONS] newsletter → échec', sub.email, ':', err.message);
        }
      }
      console.log(`[PARUTIONS] Newsletter « ${m.title} » : ${ok} envoyée(s), ${ko} échec(s)`);
      try {
        logManuscriptEvent(db, m.id, 'email_sent', actor,
          `Newsletter de parution → ${ok}/${subscribers.length} abonné(s)${ko ? ` (${ko} échec(s))` : ''}`);
        // La case « newsletter » de la checklist se coche toute seule.
        db.prepare(
          `INSERT INTO parution_checklists (manuscript_id, item_key, done, done_by, done_at)
           VALUES (?, 'newsletter', 1, ?, datetime('now'))
           ON CONFLICT(manuscript_id, item_key)
           DO UPDATE SET done = 1, done_by = excluded.done_by, done_at = datetime('now')`
        ).run(m.id, req.admin.username || 'system');
      } catch (err) { console.warn('[PARUTIONS] newsletter post-send log warning:', err.message); }
    })();

    res.json({ success: true, queued: subscribers.length });
  });

  // ═══════════════════════════════════════════════════════════
  // PACK RÉSEAUX — visuels générés depuis la couverture
  // ═══════════════════════════════════════════════════════════
  const SOCIAL_FORMATS = {
    square: { width: 1080, height: 1080, label: 'carre-1080' },
    og: { width: 1200, height: 628, label: 'banniere-1200x628' },
  };

  // Source image de la couverture : d'abord la couverture recto de la fiche
  // produit (JPG/PNG/WEBP), sinon le BAT/maquette du manuscrit (PDF → pdftoppm).
  const resolveCoverImage = async (m) => {
    if (m.dolibarr_product_id) {
      const product = await getProductInfo(m.dolibarr_product_id);
      if (product?.ref) {
        const dir = join(DOLIBARR_PRODUCT_DOCS, product.ref);
        try {
          const files = readdirSync(dir)
            .filter((n) => /\.(jpg|jpeg|png|webp)$/i.test(n) && !n.startsWith('default_cover') && !/verso/i.test(n))
            .sort();
          if (files.length) return { path: join(dir, files[files.length - 1]), cleanup: null };
        } catch { /* pas de dossier produit */ }
      }
    }
    const file = pickCoverFile(m.id);
    if (!file || !file.file_path || !existsSync(file.file_path)) return null;
    if (/\.pdf$/i.test(file.file_path)) {
      const tmp = mkdtempSync(join(tmpdir(), 'parution-cover-'));
      try {
        execFileSync('pdftoppm', ['-png', '-f', '1', '-singlefile', '-r', '150', file.file_path, join(tmp, 'cover')], { timeout: 30000 });
        const out = join(tmp, 'cover.png');
        if (existsSync(out)) return { path: out, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
      } catch (err) {
        console.warn('[PARUTIONS] pdftoppm failed:', err.message);
      }
      rmSync(tmp, { recursive: true, force: true });
      return null;
    }
    if (/\.(jpg|jpeg|png|webp)$/i.test(file.file_path)) return { path: file.file_path, cleanup: null };
    return null;
  };

  const escapeXml = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  // Coupe le titre en 2 lignes max (~n caractères par ligne).
  const wrapTitle = (title, perLine) => {
    const words = String(title || '').split(/\s+/);
    const lines = [''];
    for (const w of words) {
      const cur = lines[lines.length - 1];
      if (cur && (cur + ' ' + w).length > perLine) {
        if (lines.length === 2) { lines[1] = lines[1].slice(0, perLine - 1) + '…'; break; }
        lines.push(w);
      } else {
        lines[lines.length - 1] = cur ? `${cur} ${w}` : w;
      }
    }
    return lines;
  };

  router.get('/:id/kit/social/:format', auth, async (req, res) => {
    const fmt = SOCIAL_FORMATS[req.params.format];
    if (!fmt) return res.status(400).json({ error: 'Format inconnu (square | og)' });
    const m = loadManuscript(req.params.id);
    if (!m) return res.status(404).json({ error: 'Manuscrit introuvable' });

    const source = await resolveCoverImage(m);
    if (!source) {
      return res.status(404).json({ error: 'Aucune couverture exploitable (ni image produit, ni BAT/maquette)' });
    }
    try {
      const { width, height } = fmt;
      const bandH = Math.round(height * 0.22);
      const coverH = height - bandH - Math.round(height * 0.08);

      // Fond : couverture floutée et assombrie plein cadre.
      const background = await sharp(source.path)
        .resize(width, height, { fit: 'cover' })
        .blur(28)
        .modulate({ brightness: 0.55 })
        .toBuffer();
      // Premier plan : couverture nette, entière, centrée au-dessus du bandeau.
      const foreground = await sharp(source.path)
        .resize({ height: coverH, width: Math.round(width * 0.8), fit: 'inside', withoutEnlargement: false })
        .toBuffer();
      const fgMeta = await sharp(foreground).metadata();

      const authorName = m.author_display_name || m.author_name;
      const titleSize = Math.round(height * 0.045);
      const lines = wrapTitle(m.title, Math.floor(width / (titleSize * 0.62)));
      const titleSvg = lines.map((l, i) =>
        `<text x="50%" y="${height - bandH + Math.round(bandH * 0.34) + i * (titleSize + 6)}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${titleSize}" font-weight="bold" fill="#ffffff">${escapeXml(l)}</text>`
      ).join('');
      const authorY = height - bandH + Math.round(bandH * 0.34) + lines.length * (titleSize + 6) + 4;
      const overlay = Buffer.from(
        `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
          <rect x="0" y="${height - bandH}" width="${width}" height="${bandH}" fill="#10531a" fill-opacity="0.94"/>
          ${titleSvg}
          <text x="50%" y="${authorY}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${Math.round(titleSize * 0.72)}" fill="#d1fae5">${escapeXml(authorName)} — L'Harmattan Sénégal</text>
        </svg>`
      );

      const png = await sharp(background)
        .composite([
          { input: foreground, top: Math.round((height - bandH - fgMeta.height) / 2), left: Math.round((width - fgMeta.width) / 2) },
          { input: overlay, top: 0, left: 0 },
        ])
        .png()
        .toBuffer();

      const safe = (m.title || 'ouvrage').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'ouvrage';
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', `attachment; filename="${safe}-${fmt.label}.png"`);
      res.send(png);
    } catch (err) {
      console.error('[PARUTIONS] social image error:', err.message);
      res.status(500).json({ error: 'Échec de génération du visuel' });
    } finally {
      try { source.cleanup?.(); } catch { /* tmp déjà nettoyé */ }
    }
  });

  return router;
}
