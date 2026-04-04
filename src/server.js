// src/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const uploadsRouter = require('./routes/uploads');
const healthRouter = require('./routes/health');
const foldersRouter = require('./routes/folders');
const authRoutes = require('./routes/authRoutes');

const app = express();

app.use(cors());
app.use(express.json());

// Routes
app.use('/api', healthRouter);
app.use('/api', uploadsRouter);
app.use('/api', foldersRouter);
app.use('/api', authRoutes);

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});