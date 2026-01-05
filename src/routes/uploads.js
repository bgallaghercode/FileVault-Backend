// src/routes/uploads.js
const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { authMiddleware } = require('../middleware/auth');
const {
  s3,
  S3_BUCKET,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  getSignedUrl,
} = require('../aws');
const { admin } = require('../firebaseAdmin');

const router = express.Router();
const db = admin.firestore();

function sanitizeFileName(name = '') {
  const onlyName = name.split('/').pop().split('\\').pop();
  return onlyName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

function getUserStorageId(uid) {
  return crypto.createHash('sha256').update(uid).digest('hex').slice(0, 32);
}

/**
 * POST /api/upload-url
 * Body: { fileName, fileType }
 * Auth: Bearer <Firebase ID token>
 *
 * Returns: { uploadUrl, objectKey, bucket }
 */
router.post('/upload-url', authMiddleware, async (req, res) => {
  try {
    const { fileName, fileType } = req.body;
    if (!fileName || !fileType) {
      return res
        .status(400)
        .json({ error: 'fileName and fileType are required' });
    }

    const { uid } = req.user;
    const userStorageId = getUserStorageId(uid);
    const cleanName = sanitizeFileName(fileName);

    const objectKey = `${userStorageId}/${uuidv4()}-${cleanName}`;

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: objectKey,
      ContentType: fileType,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 5 });

    return res.json({
      uploadUrl,
      objectKey,
      bucket: S3_BUCKET,
    });
  } catch (err) {
    console.error('Error generating upload URL:', err);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

/**
 * POST /api/files
 * Called AFTER successful upload to S3.
 * Body: { objectKey, originalName, mimeType, size }
 * Auth: Bearer <Firebase ID token>
 *
 * Stores file metadata in Firestore tied to uid.
 */
router.post('/files', authMiddleware, async (req, res) => {
  try {
    const { objectKey, originalName, mimeType, size } = req.body;
    if (!objectKey || !originalName || !mimeType) {
      return res.status(400).json({
        error: 'objectKey, originalName, and mimeType are required',
      });
    }

    const { uid } = req.user;
    const userStorageId = getUserStorageId(uid);

    const docRef = await db.collection('files').add({
      uid,
      userStorageId,
      bucket: S3_BUCKET,
      objectKey,
      originalName,
      mimeType,
      size: size || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const snapshot = await docRef.get();
    return res.status(201).json({
      id: docRef.id,
      ...snapshot.data(),
    });
  } catch (err) {
    console.error('Error saving file metadata:', err);
    res.status(500).json({ error: 'Failed to save file metadata' });
  }
});

/**
 * GET /api/list-files
 * Auth: Bearer <Firebase ID token>
 *
 * Returns an array of file metadata for the current user.
 */
router.get('/list-files', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.user;

    // Simpler query: just filter by uid, no orderBy in Firestore
    const snapshot = await db
      .collection('files')
      .where('uid', '==', uid)
      .get();

    let files = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Optional: sort in JS by createdAt desc
    files = files.sort((a, b) => {
      const aSec =
        a.createdAt?.seconds ??
        a.createdAt?._seconds ??
        0;
      const bSec =
        b.createdAt?.seconds ??
        b.createdAt?._seconds ??
        0;
      return bSec - aSec;
    });

    return res.json({ uid, files });
  } catch (err) {
    console.error('Error listing files:', err);
    // send back the real message so you can see it in RN too
    res.status(500).json({ error: err.message || 'Failed to list files' });
  }
});

/**
 * POST /api/download-url
 * Body: { objectKey }
 * Auth: Bearer <Firebase ID token>
 *
 * Verifies that the requested objectKey belongs to this uid,
 * then returns a pre-signed GET URL for downloading.
 */
router.post('/download-url', authMiddleware, async (req, res) => {
  try {
    const { objectKey } = req.body;
    if (!objectKey) {
      return res.status(400).json({ error: 'objectKey is required' });
    }

    const { uid } = req.user;

    // Ensure this objectKey belongs to this user
    const snapshot = await db
      .collection('files')
      .where('uid', '==', uid)
      .where('objectKey', '==', objectKey)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ error: 'File not found for this user' });
    }

    const doc = snapshot.docs[0];
    const data = doc.data();

    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: objectKey,
    });

    const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 5 });

    return res.json({
      downloadUrl,
      objectKey,
      originalName: data.originalName,
      mimeType: data.mimeType,
    });
  } catch (err) {
    console.error('Error generating download URL:', err);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

/**
 * DELETE /api/files/:id
 * Auth: Bearer <Firebase ID token>
 *
 * Deletes the file's S3 object AND its Firestore metadata,
 * but only if it belongs to the current uid.
 */
router.delete('/files/:id', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.user;
    const fileId = req.params.id;

    if (!fileId) {
      return res.status(400).json({ error: 'File id is required' });
    }

    const docRef = db.collection('files').doc(fileId);
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      return res.status(404).json({ error: 'File not found' });
    }

    const data = snapshot.data();

    // extra safety: ensure this doc belongs to the current user
    if (data.uid !== uid) {
      return res.status(403).json({ error: 'Not authorized to delete this file' });
    }

    const objectKey = data.objectKey;
    if (!objectKey) {
      return res.status(500).json({ error: 'File metadata missing objectKey' });
    }

    // 1) Delete from S3
    const deleteCmd = new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: objectKey,
    });
    await s3.send(deleteCmd);

    // 2) Delete from Firestore
    await docRef.delete();

    return res.json({ success: true });
  } catch (err) {
    console.error('Error deleting file:', err);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

module.exports = router;