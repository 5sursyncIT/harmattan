// Nettoyage des images de couverture en doublon : garde 1 recto + 1 verso par produit,
// supprime les autres via l'API Dolibarr (le service Node n'a pas les droits fichiers).
//
// La liste des fichiers et leur date viennent du DISQUE (rapide). Le RECTO conservé est
// celui que le catalogue affiche déjà comme couverture : priorité aux noms recto/cover/
// front/couverture, puis le plus récent. Le VERSO conservé = le plus récent.
//
// Usage :
//   node scripts/cleanup-extra-covers.mjs 9782343207902         # dry-run, un produit (par ref)
//   node scripts/cleanup-extra-covers.mjs 9782343207902 --apply # applique sur ce produit
//   node scripts/cleanup-extra-covers.mjs --all                 # dry-run sur tout le catalogue
//   node scripts/cleanup-extra-covers.mjs --all --apply         # applique sur tout
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const env = {};
for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

const BASE = '/var/www/html/dolibarr/documents/produit';
const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const refArg = process.argv.find((a) => /^\d{8,}$/.test(a)); // ISBN/ref = dossier

const api = axios.create({
  baseURL: env.DOLIBARR_URL,
  headers: { DOLAPIKEY: env.DOLIBARR_ADMIN_API_KEY, 'Content-Type': 'application/json' },
});

const isVerso = (n) => /(^|[-_. ])(verso|back|dos|arriere|arrière)([-_. ]|\.)/i.test(n);
const isRectoNamed = (n) => /(^|[-_. ])(recto|front|cover|couverture|couv)([-_. ]|\.)/i.test(n);
const isImg = (n) => /\.(jpg|jpeg|png|gif|webp)$/i.test(n) && !n.startsWith('default_cover');

function planForRef(ref) {
  const dir = path.join(BASE, ref);
  let names;
  try { names = fs.readdirSync(dir).filter(isImg); } catch { return null; }
  if (!names.length) return null;
  const withMtime = names.map((n) => {
    let mt = 0; try { mt = fs.statSync(path.join(dir, n)).mtimeMs; } catch { /* ignore */ }
    return { name: n, mt };
  });
  // RECTO : priorité au nom (recto/cover/...) puis plus récent — = ce que /api/image choisit
  const recto = withMtime.filter((d) => !isVerso(d.name)).sort((a, b) => {
    const ar = isRectoNamed(a.name) ? 1 : 0, br = isRectoNamed(b.name) ? 1 : 0;
    if (ar !== br) return br - ar;
    return b.mt - a.mt;
  });
  const verso = withMtime.filter((d) => isVerso(d.name)).sort((a, b) => b.mt - a.mt);
  const toDelete = [...recto.slice(1), ...verso.slice(1)];
  return { ref, keepRecto: recto[0]?.name, keepVerso: verso[0]?.name, toDelete };
}

async function run(ref) {
  const plan = planForRef(ref);
  if (!plan || !plan.toDelete.length) return 0;
  console.log(`${ref} — garde: ${[plan.keepRecto, plan.keepVerso].filter(Boolean).join(' + ')}`);
  for (const d of plan.toDelete) {
    console.log(`   ${APPLY ? 'SUPPRIME' : 'à supprimer'} : ${d.name}`);
    if (APPLY) {
      try {
        await api.delete('/documents', { params: { modulepart: 'produit', original_file: `${ref}/${d.name}` } });
      } catch (e) {
        console.warn(`   ✗ échec ${d.name}: ${e.response?.data?.error || e.message}`);
      }
    }
  }
  return plan.toDelete.length;
}

let refs;
if (ALL) refs = fs.readdirSync(BASE).filter((d) => { try { return fs.statSync(path.join(BASE, d)).isDirectory(); } catch { return false; } });
else if (refArg) refs = [refArg];
else { console.error('Préciser une ref produit (ISBN) ou --all'); process.exit(1); }

console.log(`${APPLY ? '*** APPLICATION ***' : '--- DRY-RUN ---'} sur ${refs.length} dossier(s)\n`);
let totDel = 0, touched = 0;
for (const ref of refs) {
  const n = await run(ref);
  if (n > 0) { totDel += n; touched++; }
}
console.log(`\n${touched} produit(s) concerné(s), ${totDel} image(s) ${APPLY ? 'supprimée(s)' : 'à supprimer'}.`);
