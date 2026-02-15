const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./donations.db');

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS donations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      phone TEXT,
      place TEXT,
      amount REAL,
      screenshot_file_id TEXT,
      status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

module.exports = db;