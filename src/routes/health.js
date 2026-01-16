// src/routes/health.js
const express = require('express');
const { admin, db } = require('../firebaseAdmin');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({ ok: true });
});

router.get('/test-firestore-write', async (req, res) => {
  try {
    const docRef = await db.collection('test').add({
      msg: 'hello from backend',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ ok: true, id: docRef.id });
  } catch (err) {
    console.error('Test Firestore write error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
