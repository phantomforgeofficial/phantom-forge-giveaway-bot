import fs from 'fs-extra';

const DB_PATH = './data/giveaways.json';

async function ensureDb() {
  await fs.ensureFile(DB_PATH);
  try {
    const data = await fs.readJSON(DB_PATH);
    if (!('giveaways' in data)) data.giveaways = [];
    if (!('meta' in data)) data.meta = { statusMessageId: null };
    await fs.writeJSON(DB_PATH, data, { spaces: 2 });
  } catch {
    await fs.writeJSON(DB_PATH, { giveaways: [], meta: { statusMessageId: null } }, { spaces: 2 });
  }
}

export async function loadDb() {
  await ensureDb();
  return fs.readJSON(DB_PATH);
}

export async function saveDb(db) {
  await fs.writeJSON(DB_PATH, db, { spaces: 2 });
}

/* ---- Giveaway functions ---- */
export async function addGiveaway(gw) {
  const db = await loadDb();
  db.giveaways.push(gw);
  await saveDb(db);
  return gw;
}

export async function updateGiveaway(id, patch) {
  const db = await loadDb();
  const i = db.giveaways.findIndex(g => g.id === id);
  if (i === -1) return null;
  db.giveaways[i] = { ...db.giveaways[i], ...patch };
  await saveDb(db);
  return db.giveaways[i];
}

export async function getGiveaway(id) {
  const db = await loadDb();
  return db.giveaways.find(g => g.id === id) || null;
}

export async function listGiveaways(filter = {}) {
  const db = await loadDb();
  return db.giveaways.filter(g => {
    for (const [k, v] of Object.entries(filter)) if (g[k] !== v) return false;
    return true;
  });
}

/* ---- Status panel functions ---- */
export async function getStatusMessageId() {
  const db = await loadDb();
  return db.meta?.statusMessageId || null;
}

export async function setStatusMessageId(id) {
  const db = await loadDb();
  db.meta = db.meta || {};
  db.meta.statusMessageId = id;
  await saveDb(db);
}
