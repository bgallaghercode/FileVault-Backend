// src/routes/folders.js
const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { admin, db } = require('../firebaseAdmin');
const {
  s3,
  S3_BUCKET,
  DeleteObjectCommand,
} = require('../aws');

const router = express.Router();

/**
 * POST /api/folders
 * Create a new folder
 */
router.post('/folders', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.user;
    const { name, parentFolderId } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    // If parentFolderId is provided, verify it exists and belongs to the user
    if (parentFolderId) {
      const parentRef = db.collection('folders').doc(parentFolderId);
      const parentSnap = await parentRef.get();
      if (!parentSnap.exists || parentSnap.data().uid !== uid) {
        return res.status(404).json({ error: 'Parent folder not found' });
      }
    }

    const docRef = await db.collection('folders').add({
      uid,
      name: name.trim(),
      parentFolderId: parentFolderId || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(201).json({
      id: docRef.id,
      name: name.trim(),
      parentFolderId: parentFolderId || null,
    });
  } catch (err) {
    console.error('Error creating folder:', err);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

/**
 * GET /api/folders
 * List folders in a directory
 * Query param: ?parentFolderId=xxx (omit for root)
 */
router.get('/folders', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.user;
    const parentFolderId = req.query.parentFolderId || null;

    const snapshot = await db
      .collection('folders')
      .where('uid', '==', uid)
      .where('parentFolderId', '==', parentFolderId)
      .get();

    const folders = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Sort by name alphabetically
    folders.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    return res.json({ folders });
  } catch (err) {
    console.error('Error listing folders:', err);
    res.status(500).json({ error: 'Failed to list folders' });
  }
});

/**
 * PATCH /api/folders/:id
 * Rename a folder
 */
router.patch('/folders/:id', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.user;
    const folderId = req.params.id;
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    const docRef = db.collection('folders').doc(folderId);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    if (snap.data().uid !== uid) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await docRef.update({ name: name.trim() });
    return res.json({ success: true, name: name.trim() });
  } catch (err) {
    console.error('Error renaming folder:', err);
    res.status(500).json({ error: 'Failed to rename folder' });
  }
});

/**
 * PATCH /api/folders/:id/move
 * Move a folder to a different parent folder
 */
router.patch('/folders/:id/move', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.user;
    const folderId = req.params.id;
    const { parentFolderId } = req.body; // null = root

    const docRef = db.collection('folders').doc(folderId);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    if (snap.data().uid !== uid) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Cannot move folder into itself
    if (parentFolderId === folderId) {
      return res.status(400).json({ error: 'Cannot move a folder into itself' });
    }

    // Validate target folder exists and belongs to user (if not root)
    if (parentFolderId) {
      const targetSnap = await db.collection('folders').doc(parentFolderId).get();
      if (!targetSnap.exists || targetSnap.data().uid !== uid) {
        return res.status(400).json({ error: 'Target folder not found' });
      }

      // Walk up from target to root to ensure we're not creating a cycle
      let current = parentFolderId;
      while (current) {
        if (current === folderId) {
          return res.status(400).json({ error: 'Cannot move a folder into one of its subfolders' });
        }
        const ancestor = await db.collection('folders').doc(current).get();
        if (!ancestor.exists) break;
        current = ancestor.data().parentFolderId || null;
      }
    }

    await docRef.update({ parentFolderId: parentFolderId || null });
    return res.json({ success: true });
  } catch (err) {
    console.error('Error moving folder:', err);
    res.status(500).json({ error: 'Failed to move folder' });
  }
});

/**
 * DELETE /api/folders/:id
 * Delete a folder and all its contents recursively
 */
router.delete('/folders/:id', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.user;
    const folderId = req.params.id;

    const docRef = db.collection('folders').doc(folderId);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    if (snap.data().uid !== uid) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const stats = { deletedFiles: 0, deletedFolders: 0 };
    await deleteFolderRecursive(uid, folderId, stats);

    return res.json({ success: true, ...stats });
  } catch (err) {
    console.error('Error deleting folder:', err);
    res.status(500).json({ error: 'Failed to delete folder' });
  }
});

/**
 * Recursively delete a folder, its files (from S3 + Firestore), and sub-folders.
 */
async function deleteFolderRecursive(uid, folderId, stats) {
  // 1) Delete all files in this folder
  const filesSnapshot = await db
    .collection('files')
    .where('uid', '==', uid)
    .where('folderId', '==', folderId)
    .get();

  for (const fileDoc of filesSnapshot.docs) {
    const fileData = fileDoc.data();
    // Delete from S3
    if (fileData.objectKey) {
      try {
        await s3.send(new DeleteObjectCommand({
          Bucket: S3_BUCKET,
          Key: fileData.objectKey,
        }));
      } catch (e) {
        console.warn('Failed to delete S3 object:', fileData.objectKey, e);
      }
    }
    // Delete Firestore doc
    await fileDoc.ref.delete();
    stats.deletedFiles++;
  }

  // 2) Find and recursively delete all sub-folders
  const subFoldersSnapshot = await db
    .collection('folders')
    .where('uid', '==', uid)
    .where('parentFolderId', '==', folderId)
    .get();

  for (const subFolder of subFoldersSnapshot.docs) {
    await deleteFolderRecursive(uid, subFolder.id, stats);
  }

  // 3) Delete this folder itself
  await db.collection('folders').doc(folderId).delete();
  stats.deletedFolders++;
}

module.exports = router;
