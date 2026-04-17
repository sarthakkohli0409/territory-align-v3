const jwt = require('jsonwebtoken');

// ── Verify JWT token ─────────────────────────────────────────────────────────
async function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Always resolve fresh user ID from DB using personnel_id
    // This prevents stale IDs after a re-seed
    const { pool } = require('./pool');
    const result = await pool.query(
      'SELECT id, personnel_id, name, role, territory_id, district_id FROM users WHERE personnel_id=$1 AND is_active=TRUE',
      [decoded.personnel_id]
    );
    if (!result.rows[0]) {
      return res.status(401).json({ error: 'User not found - please log in again' });
    }
    req.user = { ...decoded, id: result.rows[0].id, ...result.rows[0] };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Role guards ──────────────────────────────────────────────────────────────
function requireNSD(req, res, next) {
  if (req.user?.role !== 'NSD') {
    return res.status(403).json({ error: 'NSD access required' });
  }
  next();
}

function requireDMorNSD(req, res, next) {
  if (!['DM', 'NSD'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'DM or NSD access required' });
  }
  next();
}

// ── Scope filter: OAM sees own territory, DM sees own district, NSD sees all ─
function scopeFilter(req) {
  const { role, territory_id, district_id } = req.user;
  if (role === 'NSD') return { sql: '', params: [], offset: 0 };
  if (role === 'DM')  return { sql: ' AND t.district_id = $', params: [district_id], offset: 1 };
  return { sql: ' AND t.id = $', params: [territory_id], offset: 1 };
}

module.exports = { auth, requireNSD, requireDMorNSD, scopeFilter };
