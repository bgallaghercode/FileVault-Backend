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
const { admin, db } = require('../firebaseAdmin');

const router = express.Router();

function sanitizeFileName(name = '') {
  const onlyName = name.split('/').pop().split('\\').pop();
  return onlyName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

function getUserStorageId(uid) {
  return crypto.createHash('sha256').update(uid).digest('hex').slice(0, 32);
}

/**
 * POST /api/upload-url
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
 * Save metadata in Firestore (Admin SDK)
 * Now also stores encryption metadata needed for decrypt:
 * - contentEnc (ivB64, macB64, etc.)
 * - fileKeyWrap (EtM envelope of the per-file key wrapped under vault key)
 */
router.post('/files', authMiddleware, async (req, res) => {
  try {
    const { objectKey, originalName, mimeType, size, contentEnc, fileKeyWrap, thumbnailEnc, folderId } = req.body;

    if (!objectKey || !originalName || !mimeType) {
      return res.status(400).json({
        error: 'objectKey, originalName, and mimeType are required',
      });
    }

    // Optional: basic validation to fail fast with a clear error
    // (helps you catch older clients that forgot to send these)
    if (contentEnc) {
      if (!contentEnc.ivB64 || !contentEnc.macB64) {
        return res.status(400).json({ error: 'contentEnc must include ivB64 and macB64' });
      }
    }
    if (fileKeyWrap) {
      if (!fileKeyWrap.ivB64 || !fileKeyWrap.ctB64 || !fileKeyWrap.macB64) {
        return res.status(400).json({ error: 'fileKeyWrap must include ivB64, ctB64, and macB64' });
      }
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

      // ✅ store encryption metadata (server never decrypts; just stores opaque blobs)
      contentEnc: contentEnc || null,
      fileKeyWrap: fileKeyWrap || null,
      thumbnailEnc: thumbnailEnc || null,
      folderId: folderId || null,

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
 */
router.get('/list-files', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.user;
    const folderId = req.query.folderId || null;

    const snapshot = await db
      .collection('files')
      .where('uid', '==', uid)
      .get();

    let files = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Filter by folder (in JS for backward compat with old docs missing folderId)
    if (folderId) {
      files = files.filter((f) => f.folderId === folderId);
    } else {
      // Root: show files with no folderId (null, undefined, or missing)
      files = files.filter((f) => !f.folderId);
    }

    // Sort newest first
    files = files.sort((a, b) => {
      const aSec =
        a.createdAt?.seconds ?? a.createdAt?._seconds ?? 0;
      const bSec =
        b.createdAt?.seconds ?? b.createdAt?._seconds ?? 0;
      return bSec - aSec;
    });

    return res.json({ uid, files });
  } catch (err) {
    console.error('Error listing files:', err);
    res.status(500).json({ error: err.message || 'Failed to list files' });
  }
});

/**
 * POST /api/download-url
 */
router.post('/download-url', authMiddleware, async (req, res) => {
  try {
    const { objectKey } = req.body;
    if (!objectKey) {
      return res.status(400).json({ error: 'objectKey is required' });
    }

    const { uid } = req.user;

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
 * Delete S3 + Firestore
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

    if (data.uid !== uid) {
      return res
        .status(403)
        .json({ error: 'Not authorized to delete this file' });
    }

    const objectKey = data.objectKey;
    if (!objectKey) {
      return res.status(500).json({ error: 'File metadata missing objectKey' });
    }

    // Delete from S3
    const deleteCmd = new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: objectKey,
    });
    await s3.send(deleteCmd);

    // Delete metadata
    await docRef.delete();

    return res.json({ success: true });
  } catch (err) {
    console.error('Error deleting file:', err);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

/**
 * GET /api/files/:id/meta
 * Return file metadata for the authenticated user
 */
router.get('/files/:id/meta', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.user;
    const fileId = req.params.id;

    const docRef = db.collection('files').doc(fileId);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'File not found' });
    }

    const data = snap.data();

    if (data.uid !== uid) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    return res.json({
      id: snap.id,
      ...data,
    });
  } catch (err) {
    console.error('Error loading file meta:', err);
    return res.status(500).json({ error: 'Failed to load file metadata' });
  }
});

/**
 * PATCH /api/files/:id/move
 * Move a file to a different folder
 */
router.patch('/files/:id/move', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.user;
    const fileId = req.params.id;
    const { folderId } = req.body; // null = root

    const docRef = db.collection('files').doc(fileId);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (snap.data().uid !== uid) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Validate target folder exists and belongs to user (if not root)
    if (folderId) {
      const folderSnap = await db.collection('folders').doc(folderId).get();
      if (!folderSnap.exists || folderSnap.data().uid !== uid) {
        return res.status(400).json({ error: 'Target folder not found' });
      }
    }

    await docRef.update({ folderId: folderId || null });
    return res.json({ success: true });
  } catch (err) {
    console.error('Error moving file:', err);
    res.status(500).json({ error: 'Failed to move file' });
  }
});

/**
 * PATCH /api/files/:id
 * Rename a file (update originalName)
 */
router.patch('/files/:id', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.user;
    const fileId = req.params.id;
    const { originalName } = req.body;

    if (!originalName || !originalName.trim()) {
      return res.status(400).json({ error: 'originalName is required' });
    }

    const docRef = db.collection('files').doc(fileId);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (snap.data().uid !== uid) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await docRef.update({ originalName: originalName.trim() });
    return res.json({ success: true });
  } catch (err) {
    console.error('Error renaming file:', err);
    res.status(500).json({ error: 'Failed to rename file' });
  }
});

/**
 * PATCH /api/files/:id/thumbnail
 * Backfill an encrypted thumbnail for an existing file
 */
router.patch('/files/:id/thumbnail', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.user;
    const fileId = req.params.id;
    const { thumbnailEnc } = req.body;

    if (!thumbnailEnc) {
      return res.status(400).json({ error: 'thumbnailEnc is required' });
    }

    // Size guard (~20KB max for the encrypted envelope)
    if (JSON.stringify(thumbnailEnc).length > 20000) {
      return res.status(400).json({ error: 'Thumbnail too large' });
    }

    const docRef = db.collection('files').doc(fileId);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (snap.data().uid !== uid) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await docRef.update({ thumbnailEnc });
    return res.json({ success: true });
  } catch (err) {
    console.error('Error updating thumbnail:', err);
    res.status(500).json({ error: 'Failed to update thumbnail' });
  }
});

module.exports = router;