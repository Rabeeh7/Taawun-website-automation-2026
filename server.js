const express = require('express');
const db = require('./database');

const app = express();
const PORT = 3000;

app.use(express.json());

// Get all donations
app.get('/api/donations', (req, res) => {
  db.all("SELECT * FROM donations ORDER BY created_at DESC", [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: "Database error" });
    }
    res.json(rows);
  });
});

// Approve donation
app.post('/api/approve/:id', (req, res) => {
  const id = req.params.id;
  db.run("UPDATE donations SET status = 'approved' WHERE id = ?", [id], function (err) {
    if (err) return res.status(500).json({ error: true });
    res.json({ success: true });
  });
});

// Reject donation
app.post('/api/reject/:id', (req, res) => {
  const id = req.params.id;
  db.run("UPDATE donations SET status = 'rejected' WHERE id = ?", [id], function (err) {
    if (err) return res.status(500).json({ error: true });
    res.json({ success: true });
  });
});

app.listen(PORT, () => {
  console.log(`API running at http://localhost:${PORT}`);
});
