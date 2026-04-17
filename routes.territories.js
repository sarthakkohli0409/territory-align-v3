const router = require('express').Router();
const { query } = require('./pool');
const { auth, requireNSD, scopeFilter } = require('./middleware.auth');

// GET /api/territories
router.get('/', auth, async (req, res) => {
  try {
    const { district, search, idx } = req.query;
    const { role, territory_id, district_id } = req.user;
    const params = [];
    const where  = [];

    if (role === 'OAM') { where.push(`t.id = $${params.length+1}`); params.push(territory_id); }
    if (role === 'DM')  { where.push(`t.district_id = $${params.length+1}`); params.push(district_id); }
    if (district) { where.push(`d.name = $${params.length+1}`); params.push(district); }
    if (search)   {
      where.push(`(t.name ILIKE $${params.length+1} OR u.name ILIKE $${params.length+1})`);
      params.push(`%${search}%`);
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const orderCol = ['idx1','idx2','idx3','idx4'].includes(idx) ? idx : 'idx3';

    const result = await query(
      `SELECT t.id, t.name, t.color, t.hco_count, t.zip_count,
              t.idx1, t.idx2, t.idx3, t.idx4,
              d.name AS district,
              u.name AS rep_name, u.personnel_id AS rep_id
       FROM territories t
       LEFT JOIN districts d ON d.id = t.district_id
       LEFT JOIN users u ON u.territory_id = t.id AND u.role = 'OAM'
       ${whereClause}
       ORDER BY t.${orderCol} DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/territories/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT t.*, d.name AS district, u.name AS rep_name, u.personnel_id AS rep_id
       FROM territories t
       LEFT JOIN districts d ON d.id = t.district_id
       LEFT JOIN users u ON u.territory_id = t.id AND u.role='OAM'
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/territories/:id/hcps
router.get('/:id/hcps', auth, async (req, res) => {
  try {
    const { tier, limit = 50, offset = 0 } = req.query;
    const params = [req.params.id];
    const where = ['h.territory_id = $1'];
    if (tier) { where.push(`h.tier = $${params.length+1}`); params.push(tier); }
    params.push(limit, offset);
    const result = await query(
      `SELECT h.id, h.hcp_id, h.name, h.city, h.state, h.zip,
              h.tier, h.idx1, h.idx2, h.idx3, h.idx4
       FROM hcps h WHERE ${where.join(' AND ')}
       ORDER BY h.idx3 DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    const total = await query('SELECT COUNT(*) FROM hcps WHERE territory_id=$1', [req.params.id]);
    res.json({ hcps: result.rows, total: parseInt(total.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/territories/:id/zips
router.get('/:id/zips', auth, async (req, res) => {
  try {
    const { limit = 50, offset = 0, search } = req.query;
    const params = [req.params.id];
    const where = ['z.territory_id = $1'];
    if (search) { where.push(`(z.code ILIKE $${params.length+1} OR z.city ILIKE $${params.length+1})`); params.push(`%${search}%`); }
    params.push(limit, offset);
    const result = await query(
      `SELECT z.id, z.code, z.city FROM zips z
       WHERE ${where.join(' AND ')}
       ORDER BY z.code
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    const total = await query('SELECT COUNT(*) FROM zips WHERE territory_id=$1', [req.params.id]);
    res.json({ zips: result.rows, total: parseInt(total.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/territories/:id — NSD direct edit (reassign OAM)
router.put('/:id', auth, requireNSD, async (req, res) => {
  const { rep_id } = req.body;
  try {
    // Remove old OAM assignment
    await query('UPDATE users SET territory_id=NULL WHERE territory_id=$1 AND role=$2', [req.params.id, 'OAM']);
    // Assign new OAM
    if (rep_id) {
      await query('UPDATE users SET territory_id=$1 WHERE personnel_id=$2', [req.params.id, rep_id]);
    }
    // Audit log
    await query(
      `INSERT INTO audit_log(user_id,action,detail,district,before_state,after_state)
       SELECT $1, 'Direct edit', $2, d.name,
              json_build_object('rep_id', u_old.personnel_id),
              json_build_object('rep_id', $3)
       FROM territories t
       LEFT JOIN districts d ON d.id = t.district_id
       LEFT JOIN users u_old ON u_old.territory_id = t.id AND u_old.role='OAM'
       WHERE t.id = $4`,
      [req.user.id, `OAM reassignment: territory ${req.params.id} → ${rep_id||'Vacant'}`, rep_id, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
