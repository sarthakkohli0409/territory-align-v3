const router = require('express').Router();
const { query } = require('./pool');
const { auth, requireNSD } = require('./middleware.auth');

// ── HCPs ─────────────────────────────────────────────────────────────────────

// GET /api/hcps
router.get('/', auth, async (req, res) => {
  try {
    const { territory, district, tier, search, limit = 50, offset = 0 } = req.query;
    const { role, territory_id, district_id } = req.user;
    const params = [];
    const where  = [];

    if (role === 'OAM') { where.push(`h.territory_id = $${params.length+1}`); params.push(territory_id); }
    if (role === 'DM')  { where.push(`h.district_id = $${params.length+1}`);  params.push(district_id); }
    if (territory) { where.push(`t.name = $${params.length+1}`); params.push(territory); }
    if (district)  { where.push(`d.name = $${params.length+1}`); params.push(district); }
    if (tier)      { where.push(`h.tier = $${params.length+1}`); params.push(tier); }
    if (search)    {
      where.push(`(h.hcp_id ILIKE $${params.length+1} OR h.city ILIKE $${params.length+1} OR h.zip ILIKE $${params.length+1})`);
      params.push(`%${search}%`);
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(
      `SELECT h.id, h.hcp_id, h.name, h.city, h.state, h.zip,
              h.tier, h.idx1, h.idx2, h.idx3, h.idx4,
              t.name AS territory, t.color, d.name AS district
       FROM hcps h
       LEFT JOIN territories t ON t.id = h.territory_id
       LEFT JOIN districts d ON d.id = h.district_id
       ${whereClause}
       ORDER BY h.idx3 DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );

    // Total count (same filters, no limit/offset)
    const countParams = params.slice(0, -2);
    const total = await query(
      `SELECT COUNT(*) FROM hcps h
       LEFT JOIN territories t ON t.id = h.territory_id
       LEFT JOIN districts d ON d.id = h.district_id
       ${whereClause}`,
      countParams
    );

    res.json({ hcps: result.rows, total: parseInt(total.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/hcps/:hcp_id
router.get('/:hcp_id', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT h.*, t.name AS territory, t.color, d.name AS district
       FROM hcps h
       LEFT JOIN territories t ON t.id = h.territory_id
       LEFT JOIN districts d ON d.id = h.district_id
       WHERE h.hcp_id = $1`,
      [req.params.hcp_id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'HCP not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/hcps/:hcp_id/territory — NSD direct reassign
router.put('/:hcp_id/territory', auth, requireNSD, async (req, res) => {
  const { new_territory_name } = req.body;
  try {
    const terrResult = await query('SELECT id, district_id FROM territories WHERE name=$1', [new_territory_name]);
    if (!terrResult.rows[0]) return res.status(404).json({ error: 'Territory not found' });
    const { id: terrId, district_id } = terrResult.rows[0];

    const old = await query('SELECT territory_id FROM hcps WHERE hcp_id=$1', [req.params.hcp_id]);
    await query('UPDATE hcps SET territory_id=$1, district_id=$2, updated_at=NOW() WHERE hcp_id=$3',
      [terrId, district_id, req.params.hcp_id]);

    await query(
      `INSERT INTO audit_log(user_id,action,detail,before_state,after_state)
       VALUES($1,'Direct edit',$2,$3,$4)`,
      [req.user.id, `HCP ${req.params.hcp_id} reassigned to ${new_territory_name}`,
       JSON.stringify({territory_id: old.rows[0]?.territory_id}),
       JSON.stringify({territory_id: terrId, territory_name: new_territory_name})]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── ZIPs ─────────────────────────────────────────────────────────────────────

// GET /api/zips
router.get('/zips', auth, async (req, res) => {
  try {
    const { territory, district, search, limit = 50, offset = 0 } = req.query;
    const { role, territory_id, district_id } = req.user;
    const params = [];
    const where  = [];

    if (role === 'OAM') { where.push(`z.territory_id = $${params.length+1}`); params.push(territory_id); }
    if (role === 'DM')  { where.push(`z.district_id = $${params.length+1}`);  params.push(district_id); }
    if (territory) { where.push(`t.name = $${params.length+1}`); params.push(territory); }
    if (district)  { where.push(`d.name = $${params.length+1}`); params.push(district); }
    if (search)    {
      where.push(`(z.code ILIKE $${params.length+1} OR z.city ILIKE $${params.length+1})`);
      params.push(`%${search}%`);
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(
      `SELECT z.id, z.code, z.city,
              t.name AS territory, t.color, d.name AS district,
              u.name AS rep_name, u.personnel_id AS rep_id
       FROM zips z
       LEFT JOIN territories t ON t.id = z.territory_id
       LEFT JOIN districts d ON d.id = z.district_id
       LEFT JOIN users u ON u.territory_id = z.territory_id AND u.role='OAM'
       ${whereClause}
       ORDER BY z.code
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );

    const countParams = params.slice(0, -2);
    const total = await query(
      `SELECT COUNT(*) FROM zips z
       LEFT JOIN territories t ON t.id = z.territory_id
       LEFT JOIN districts d ON d.id = z.district_id
       ${whereClause}`,
      countParams
    );
    res.json({ zips: result.rows, total: parseInt(total.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/zips/conflicts — dual-mapped ZIPs
router.get('/zips/conflicts', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT z.code, z.city, array_agg(t.name) AS territories, COUNT(*) AS count
       FROM zips z
       LEFT JOIN territories t ON t.id = z.territory_id
       GROUP BY z.code, z.city
       HAVING COUNT(*) > 1
       ORDER BY count DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/zips/:code/territory — NSD direct reassign
router.put('/zips/:code/territory', auth, requireNSD, async (req, res) => {
  const { new_territory_name } = req.body;
  try {
    const terr = await query('SELECT id, district_id FROM territories WHERE name=$1', [new_territory_name]);
    if (!terr.rows[0]) return res.status(404).json({ error: 'Territory not found' });
    const { id: terrId, district_id } = terr.rows[0];

    await query('UPDATE zips SET territory_id=$1, district_id=$2 WHERE code=$3', [terrId, district_id, req.params.code]);
    await query(
      `INSERT INTO audit_log(user_id,action,detail,before_state,after_state)
       VALUES($1,'Direct edit',$2,$3,$4)`,
      [req.user.id, `ZIP ${req.params.code} reassigned to ${new_territory_name}`,
       JSON.stringify({zip: req.params.code}),
       JSON.stringify({territory_name: new_territory_name})]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
