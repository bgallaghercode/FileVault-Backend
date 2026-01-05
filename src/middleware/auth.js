// src/middleware/auth.js
const { admin } = require('../firebaseAdmin');

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : null;

    if (!token) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }

    const decoded = await admin.auth().verifyIdToken(token);

    // This is the trusted Firebase user ID
    req.user = { uid: decoded.uid };
    next();
  } catch (err) {
    console.error('Error verifying Firebase ID token:', err);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { authMiddleware };