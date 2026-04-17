const router  = require('express').Router();
const { query } = require('./pool');
const { auth, requireNSD } = require('./middleware.auth');
const multer  = require('multer');
const XLSX    = require('xlsx');
const path    = require('path');
const fs      = require('fs');

// ── AUDIT LOG ────────────────────────────────────────────────────────────────

// GET /api/audit
router.get('/audit', auth, async (req, res) => {
  try {
    const { action, role, district, from, to, limit = 100, offset = 0 } = req.query;
    const params = [];
    const where  = [];

    if (req.user.role === 'DM') {
      where.push(`a.district = (SELECT name FROM districts WHERE id=$${params.length+1})`);
      params.push(req.user.district_id);
    }
    if (action)   { where.push(`a.action = $${params.length+1}`);   params.push(action); }
    if (role)     { where.push(`u.role = $${params.length+1}`);      params.push(role); }
    if (district) { where.push(`a.district = $${params.length+1}`);  params.push(district); }
    if (from)     { where.push(`a.created_at >= $${params.length+1}`); params.push(from); }
    if (to)       { where.push(`a.created_at <= $${params.length+1}`); params.push(to); }

    const whereClause = where.length ? 'WHERE '+where.join(' AND ') : '';
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(
      `SELECT a.id, a.action, a.detail, a.before_state, a.after_state,
              a.district, a.created_at,
              u.name AS user_name, u.personnel_id, u.role AS user_role
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       ${whereClause}
       ORDER BY a.created_at DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );

    const countParams = params.slice(0, -2);
    const total = await query(
      `SELECT COUNT(*) FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ${whereClause}`,
      countParams
    );
    res.json({ logs: result.rows, total: parseInt(total.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── VERSIONS ─────────────────────────────────────────────────────────────────

// GET /api/versions
router.get('/versions', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT v.*, u.name AS uploaded_by_name
       FROM versions v
       LEFT JOIN users u ON u.id = v.uploaded_by
       ORDER BY v.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/versions/:label/rollback — NSD only
router.post('/versions/:label/rollback', auth, requireNSD, async (req, res) => {
  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: 'reason is required for audit compliance' });

  try {
    const target = await query('SELECT * FROM versions WHERE version_label=$1', [req.params.label]);
    if (!target.rows[0]) return res.status(404).json({ error: 'Version not found' });

    const current = await query('SELECT * FROM versions WHERE is_current=TRUE');

    // Mark versions
    await query('UPDATE versions SET is_current=FALSE');
    await query('UPDATE versions SET is_current=TRUE WHERE version_label=$1', [req.params.label]);

    await query(
      `INSERT INTO audit_log(user_id,action,detail,before_state,after_state,district)
       VALUES($1,'Rollback',$2,$3,$4,'NATION')`,
      [
        req.user.id,
        `Rolled back from ${current.rows[0]?.version_label} to ${req.params.label}: ${reason}`,
        JSON.stringify({ version: current.rows[0]?.version_label }),
        JSON.stringify({ version: req.params.label, reason })
      ]
    );

    res.json({ success: true, message: `Rolled back to ${req.params.label}` });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── BULK UPLOAD ───────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// POST /api/upload
router.post('/upload', auth, requireNSD, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const mode = req.body.mode || 'append';

  try {
    const wb = XLSX.readFile(req.file.path);
    const zttSheet = wb.Sheets['ZTT'];
    const salesSheet = wb.Sheets['Sales Dta'];
    if (!zttSheet) return res.status(400).json({ error: 'ZTT sheet not found in uploaded file' });

    const zttData   = XLSX.utils.sheet_to_json(zttSheet);
    const salesData = salesSheet ? XLSX.utils.sheet_to_json(salesSheet) : [];

    // Validation
    const requiredZTT = ['Zip Code ID','Zip Code Name','Territory Name','District Name'];
    const hasAllCols  = requiredZTT.every(c => Object.keys(zttData[0] || {}).includes(c));
    if (!hasAllCols) return res.status(400).json({ error: 'Missing required columns in ZTT sheet' });

    // Create new version
    const existing = await query('SELECT version_label FROM versions ORDER BY created_at DESC LIMIT 1');
    const lastLabel = existing.rows[0]?.version_label || 'v0.0';
    const [, major, minor] = lastLabel.match(/v(\d+)\.(\d+)/) || [,'1','0'];
    const newLabel = `v${major}.${parseInt(minor)+1}`;

    // Safely resolve user ID from personnel_id (avoids FK errors after re-seed)
    const userRes = await query('SELECT id FROM users WHERE personnel_id=$1', [req.user.personnel_id]);
    const uploaderId = userRes.rows[0]?.id || null;

    const versionRes = await query(
      `INSERT INTO versions(version_label,description,uploaded_by,zip_count,hcp_count,upload_mode,is_current)
       VALUES($1,$2,$3,$4,$5,$6,TRUE) RETURNING id`,
      [newLabel, `${mode} upload via UI`, uploaderId, zttData.length, salesData.length, mode]
    );
    const versionId = versionRes.rows[0].id;
    await query('UPDATE versions SET is_current=FALSE WHERE version_label!=$1', [newLabel]);

    // Fetch territory map
    const terrRows = await query('SELECT id, name FROM territories');
    const terrMap  = {};
    terrRows.rows.forEach(t => { terrMap[t.name] = t.id; });

    const distRows = await query('SELECT id, name FROM districts');
    const distMap  = {};
    distRows.rows.forEach(d => { distMap[d.name] = d.id; });

    if (mode === 'replace') {
      await query('DELETE FROM zips');
    }

    // Batch insert ZIPs
    const BATCH = 500;
    let zipCount = 0;
    for (let i = 0; i < zttData.length; i += BATCH) {
      const batch = zttData.slice(i, i + BATCH);
      const values = [], params = [];
      let p = 1;
      for (const row of batch) {
        const code   = String(row['Zip Code ID'] || '').padStart(5,'0');
        const city   = row['Zip Code Name'] || null;
        const terrId = terrMap[row['Territory Name']] || null;
        const distId = distMap[row['District Name']] || null;
        if (!code || code === '00000') continue;
        values.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4})`);
        params.push(code, city, terrId, distId, versionId);
        p += 5; zipCount++;
      }
      if (values.length) {
        await query(
          `INSERT INTO zips(code,city,territory_id,district_id,version_id)
           VALUES ${values.join(',')}
           ON CONFLICT DO NOTHING`,
          params
        );
      }
    }

    await query(
      `INSERT INTO audit_log(user_id,action,detail,before_state,after_state,district,version_id)
       VALUES($1,$2,$3,$4,$5,'NATION',$6)`,
      [req.user.id, 'Bulk upload',
       `${mode} upload — ${newLabel} (${zipCount} ZIPs)`,
       JSON.stringify({version: lastLabel}), JSON.stringify({version: newLabel}), versionId]
    );

    fs.unlinkSync(req.file.path);
    res.json({ success: true, version: newLabel, zips: zipCount });
  } catch (err) {
    console.error(err);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// ── EXPORTS ───────────────────────────────────────────────────────────────────

// GET /api/export/ztt
router.get('/export/ztt', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT z.code AS "ZIP", z.city AS "City",
              t.name AS "Territory", d.name AS "District",
              u.name AS "OAM", u.personnel_id AS "Rep_ID"
       FROM zips z
       LEFT JOIN territories t ON t.id = z.territory_id
       LEFT JOIN districts d ON d.id = z.district_id
       LEFT JOIN users u ON u.territory_id = z.territory_id AND u.role='OAM'
       ORDER BY z.code`
    );
    const csv = [Object.keys(result.rows[0] || {}).join(',')];
    result.rows.forEach(r => csv.push(Object.values(r).map(v => `"${v||''}"`).join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=ZTT_export_${Date.now()}.csv`);
    res.send(csv.join('\n'));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/export/audit
router.get('/export/audit', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT a.created_at AS "Timestamp", u.name AS "User", u.role AS "Role",
              a.action AS "Action", a.detail AS "Detail",
              a.before_state AS "Before", a.after_state AS "After", a.district AS "District"
       FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
       ORDER BY a.created_at DESC`
    );
    const csv = [Object.keys(result.rows[0] || {}).join(',')];
    result.rows.forEach(r => csv.push(Object.values(r).map(v => `"${JSON.stringify(v)||''}"`).join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=audit_log_${Date.now()}.csv`);
    res.send(csv.join('\n'));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/export/territories
router.get('/export/territories', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT t.name AS "Territory", d.name AS "District",
              u.name AS "OAM", u.personnel_id AS "Rep_ID",
              t.hco_count AS "HCO_Count", t.zip_count AS "ZIP_Count",
              t.idx1 AS "Index_1", t.idx2 AS "Index_2", t.idx3 AS "Index_3", t.idx4 AS "Index_4"
       FROM territories t
       LEFT JOIN districts d ON d.id=t.district_id
       LEFT JOIN users u ON u.territory_id=t.id AND u.role='OAM'
       ORDER BY t.idx3 DESC`
    );
    const csv = [Object.keys(result.rows[0] || {}).join(',')];
    result.rows.forEach(r => csv.push(Object.values(r).map(v => `"${v||''}"`).join(',')));
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition',`attachment; filename=territories_${Date.now()}.csv`);
    res.send(csv.join('\n'));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/conflicts
router.get('/conflicts', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT c.*, r.request_id FROM conflicts c
       LEFT JOIN requests r ON r.id=c.request_id
       WHERE c.is_dismissed=FALSE ORDER BY
       CASE c.severity WHEN 'high' THEN 1 WHEN 'med' THEN 2 ELSE 3 END`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/roster
router.get('/roster', auth, async (req, res) => {
  try {
    const { role, district, search, limit=100, offset=0 } = req.query;
    const params = [];
    const where = [];
    if (role)     { where.push(`u.role=$${params.length+1}`);      params.push(role); }
    if (district) { where.push(`d.name=$${params.length+1}`);      params.push(district); }
    if (search)   { where.push(`(u.name ILIKE $${params.length+1} OR u.personnel_id ILIKE $${params.length+1})`); params.push(`%${search}%`); }
    params.push(parseInt(limit), parseInt(offset));
    const result = await query(
      `SELECT u.id, u.personnel_id, u.name, u.role, u.is_active,
              t.name AS territory, d.name AS district
       FROM users u
       LEFT JOIN territories t ON t.id=u.territory_id
       LEFT JOIN districts d ON d.id=u.district_id OR d.id=t.district_id
       ${where.length?'WHERE '+where.join(' AND '):''}
       ORDER BY u.role, u.name
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
