require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const fs        = require('fs');
const path      = require('path');
const { pool }  = require('./pool');

// Read init.sql once at startup
const SQL_FILE = path.join(__dirname, 'init.sql');

async function autoMigrate() {
  try {
    const check = await pool.query("SELECT to_regclass('public.territories') AS exists");
    if (check.rows[0].exists) {
      console.log('  Database schema already exists');
      return;
    }
    console.log('  Running database migration...');
    if (!fs.existsSync(SQL_FILE)) {
      console.warn('  init.sql not found - skipping migration');
      return;
    }
    const sql = fs.readFileSync(SQL_FILE, 'utf8');
    await pool.query(sql);
    console.log('  Database schema created successfully');
  } catch (err) {
    console.error('  Migration error:', err.message);
  }
}

const app = express();

app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: 'Too many requests - please try again later' }
}));

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'db_unavailable' });
  }
});

// Manual migrate endpoint — runs init.sql on demand
app.get('/migrate', async (req, res) => {
  try {
    if (!fs.existsSync(SQL_FILE)) {
      return res.status(500).json({ error: 'init.sql not found on server' });
    }
    const sql = fs.readFileSync(SQL_FILE, 'utf8');
    await pool.query(sql);
    res.json({ success: true, message: 'Database schema created successfully. Now visit /setup then /seed.html' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Setup route - create login users
app.get('/setup', async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('TerritoryAlign2026!', 10);
    await pool.query(`INSERT INTO users(personnel_id,name,role,password_hash) VALUES
      ('E056','National Sales Director','NSD','${hash}'),
      ('E051','District Manager 1','DM','${hash}'),
      ('E001','Rep 1','OAM','${hash}')
      ON CONFLICT(personnel_id) DO NOTHING`);
    res.json({ success: true, message: 'Users created! Now visit /seed.html to load all data.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Seed routes
app.use('/seed', require('./routes.seed'));

// API routes
app.use('/api/auth',        require('./routes.auth'));
app.use('/api/territories', require('./routes.territories'));
app.use('/api/hcps',        require('./routes.hcps'));
app.use('/api/requests',    require('./routes.requests'));
app.use('/api',             require('./routes.admin'));

app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.path} not found` }));
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
async function start() {
  await autoMigrate();
  app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  TerritoryAlign API');
    console.log('  Running on port ' + PORT);
    console.log('');
  });
}
start();
module.exports = app;
