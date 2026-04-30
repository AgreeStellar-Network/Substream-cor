const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = './data/substream.db';
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(dbPath);

console.log('Creating manual core tables...');
db.exec(`
  CREATE TABLE IF NOT EXISTS creators (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS content (
    id TEXT PRIMARY KEY,
    creator_address TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    thumbnail TEXT,
    type TEXT NOT NULL,
    tags TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    creator_id TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    subscribed_at TEXT NOT NULL,
    unsubscribed_at TEXT,
    PRIMARY KEY (creator_id, wallet_address)
  );
`);
console.log('Manual core tables created.');
db.close();
