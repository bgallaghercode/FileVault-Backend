// src/firebaseAdmin.js
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!serviceAccountJson) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not set');
  }

  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
  });

  console.log('[firebaseAdmin] Initialized');
}

// ✅ define db AFTER initializeApp
const db = admin.firestore();

module.exports = { admin, db };
