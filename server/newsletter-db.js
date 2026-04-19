import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'newsletter.json');

export function getDb() {
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify([]));
  }
  return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
}

export function saveDb(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}
