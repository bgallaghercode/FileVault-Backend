// src/routes/authRoutes.js
const express = require('express');
const { admin, db } = require('../firebaseAdmin');
const { transporter } = require('../email');

const router = express.Router();

/**
 * POST /api/auth/send-verification
 * Generate a 6-digit code, store it, and email it.
 * Body: { email }
 * No Firebase account required — called before account creation.
 */
router.post('/auth/send-verification', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const trimmedEmail = email.trim().toLowerCase();

    // Generate 6-digit code
    const code = String(Math.floor(100000 + Math.random() * 900000));

    // Store in Firestore with 15-minute expiry
    const expiresAt = Date.now() + 15 * 60 * 1000;

    await db.collection('verificationCodes').add({
      email: trimmedEmail,
      code,
      expiresAt,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Send email
    await transporter.sendMail({
      from: `"CloudVault" <${process.env.GMAIL_USER}>`,
      to: trimmedEmail,
      subject: 'CloudVault Verification Code',
      text: `Your verification code is: ${code}\n\nThis code expires in 15 minutes.`,
      html: `
        <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
          <h2 style="text-align: center;">CloudVault</h2>
          <p>Your verification code is:</p>
          <div style="background: #f5f5f5; border-radius: 8px; padding: 16px; text-align: center; margin: 16px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px;">${code}</span>
          </div>
          <p style="color: #888; font-size: 13px;">This code expires in 15 minutes.</p>
        </div>
      `,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Error sending verification email:', err);
    return res.status(500).json({ error: 'Failed to send verification email' });
  }
});

/**
 * POST /api/auth/create-account
 * Verify the 6-digit code, then create the Firebase account with emailVerified: true.
 * Body: { email, password, code }
 */
router.post('/auth/create-account', async (req, res) => {
  try {
    const { email, password, code } = req.body;

    if (!email || !password || !code) {
      return res.status(400).json({ error: 'Email, password, and code are required' });
    }

    const trimmedEmail = email.trim().toLowerCase();

    // Check if email is already registered
    try {
      await admin.auth().getUserByEmail(trimmedEmail);
      return res.status(400).json({ error: 'An account with this email already exists' });
    } catch (e) {
      // User not found — good, we can create the account
    }

    // Find the most recent code for this email
    const snapshot = await db
      .collection('verificationCodes')
      .where('email', '==', trimmedEmail)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    const doc = snapshot.docs[0];
    const data = doc.data();

    // Check code matches
    if (data.code !== code.trim()) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    // Check expiry
    if (Date.now() > data.expiresAt) {
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }

    // Create user via Admin SDK with emailVerified already true
    await admin.auth().createUser({
      email: trimmedEmail,
      password,
      emailVerified: true,
    });

    // Clean up: delete all verification codes for this email
    const allCodes = await db
      .collection('verificationCodes')
      .where('email', '==', trimmedEmail)
      .get();

    const batch = db.batch();
    allCodes.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    return res.json({ success: true });
  } catch (err) {
    console.error('Error creating account:', err);
    return res.status(500).json({ error: 'Failed to create account' });
  }
});

module.exports = router;
