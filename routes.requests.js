const router = require('express').Router();
const { query } = require('./pool');
const { auth, requireDMorNSD } = require('./middleware.auth');

// ── helpers ───────────────────────────────────────────────────────────────────
function nextReqId(last) {
  const n = parseInt((last || 'REQ-000').replace('REQ-','')) + 1;
  return 'REQ-' + String(n).padStart(3, '0');
}

async function logAudit(userId, action, detail, before, after, district) {
  await query(
    `INSERT INTO audit_log(user_id,action,detail,before_state,after_state,district)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [userId, action, detail, JSON.stringify(before), JSON.stringify(after), district]
  );
}

// ── GET /api/requests ─────────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { status, type, district, search, limit = 50, offset = 0 } = req.query;
    const { role, territory_id, district_id } = req.user;
    const params = [];
    const where  = [];

    // Role scoping
    if (role === 'OAM') { where.push(`r.requester_id = $${params.length+1}`); params.push(req.user.id); }
    if (role === 'DM')  { where.push(`t_src.district_id = $${params.length+1}`); params.push(district_id); }

    if (status)   { where.push(`r.status = $${params.length+1}`);      params.push(status); }
    if (type)     { where.push(`r.type = $${params.length+1}`);         params.push(type); }
    if (district) { where.push(`t_src.district_id IN (SELECT id FROM districts WHERE name=$${params.length+1})`); params.push(district); }
    if (search)   {
      where.push(`(r.request_id ILIKE $${params.length+1} OR t_src.name ILIKE $${params.length+1} OR u_req.name ILIKE $${params.length+1})`);
      params.push(`%${search}%`);
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(
      `SELECT r.*,
              t_src.name  AS src_territory,  t_src.color  AS src_color,
              t_dst.name  AS dest_territory, t_dst.color  AS dst_color,
              u_req.name  AS requester_name, u_req.role   AS requester_role,
              u_apr.name  AS approver_name,
              d.name AS district
       FROM requests r
       LEFT JOIN territories t_src ON t_src.id = r.src_territory_id
       LEFT JOIN territories t_dst ON t_dst.id = r.dest_territory_id
       LEFT JOIN users u_req ON u_req.id = r.requester_id
       LEFT JOIN users u_apr ON u_apr.id = r.approver_id
       LEFT JOIN districts d  ON d.id = t_src.district_id
       ${whereClause}
       ORDER BY r.created_at DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );

    const countParams = params.slice(0, -2);
    const total = await query(
      `SELECT COUNT(*) FROM requests r
       LEFT JOIN territories t_src ON t_src.id = r.src_territory_id
       LEFT JOIN users u_req ON u_req.id = r.requester_id
       ${whereClause}`,
      countParams
    );

    res.json({ requests: result.rows, total: parseInt(total.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/requests/:id ─────────────────────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  try {
    const [req_row, comments] = await Promise.all([
      query(
        `SELECT r.*,
                t_src.name AS src_territory, t_dst.name AS dest_territory,
                u_req.name AS requester_name, u_req.role AS requester_role,
                u_apr.name AS approver_name, d.name AS district
         FROM requests r
         LEFT JOIN territories t_src ON t_src.id = r.src_territory_id
         LEFT JOIN territories t_dst ON t_dst.id = r.dest_territory_id
         LEFT JOIN users u_req ON u_req.id = r.requester_id
         LEFT JOIN users u_apr ON u_apr.id = r.approver_id
         LEFT JOIN districts d ON d.id = t_src.district_id
         WHERE r.request_id = $1`,
        [req.params.id]
      ),
      query(
        `SELECT rc.*, u.name AS user_name, u.role AS user_role
         FROM request_comments rc
         JOIN users u ON u.id = rc.user_id
         WHERE rc.request_id = (SELECT id FROM requests WHERE request_id=$1)
         ORDER BY rc.created_at ASC`,
        [req.params.id]
      )
    ]);
    if (!req_row.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ ...req_row.rows[0], comments: comments.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/requests ────────────────────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const {
    type, src_territory_name, dest_territory_name,
    hcp_zip, reason, priority, comment
  } = req.body;

  if (!type || !src_territory_name) {
    return res.status(400).json({ error: 'type and src_territory_name are required' });
  }

  try {
    // Get last request ID
    const lastReq = await query('SELECT request_id FROM requests ORDER BY created_at DESC LIMIT 1');
    const request_id = nextReqId(lastReq.rows[0]?.request_id);

    const srcTerr = await query(
      `SELECT t.*, d.name AS district FROM territories t LEFT JOIN districts d ON d.id=t.district_id WHERE t.name=$1`,
      [src_territory_name]
    );
    const dstTerr = dest_territory_name
      ? await query('SELECT * FROM territories WHERE name=$1', [dest_territory_name])
      : { rows: [null] };

    if (!srcTerr.rows[0]) return res.status(404).json({ error: 'Source territory not found' });

    const src = srcTerr.rows[0];
    const dst = dstTerr.rows[0];

    // Conflict check: ZIP already dual-mapped?
    let has_conflict = false, conflict_msg = null;
    if (type === 'Reassign ZIP' && hcp_zip) {
      const zipCount = await query('SELECT COUNT(*) FROM zips WHERE code=$1', [hcp_zip]);
      if (parseInt(zipCount.rows[0].count) > 1) {
        has_conflict = true;
        conflict_msg = `ZIP ${hcp_zip} is already mapped to multiple territories.`;
      }
    }

    // Insert request
    const result = await query(
      `INSERT INTO requests(request_id,type,status,priority,requester_id,src_territory_id,dest_territory_id,
         hcp_zip,reason,comment,before_state,after_state,has_conflict,conflict_msg)
       VALUES($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        request_id, type, priority || 'Normal', req.user.id,
        src.id, dst?.id || null,
        hcp_zip || null, reason || null, comment || null,
        JSON.stringify({ territory: src.name, hcos: src.hco_count, idx1:src.idx1, idx2:src.idx2, idx3:src.idx3, idx4:src.idx4 }),
        JSON.stringify({ territory: dst?.name || null, hcos: dst?.hco_count || 0 }),
        has_conflict, conflict_msg
      ]
    );

    // Save comment
    if (comment) {
      await query(
        'INSERT INTO request_comments(request_id,user_id,comment) VALUES($1,$2,$3)',
        [result.rows[0].id, req.user.id, comment]
      );
    }

    await logAudit(
      req.user.id, 'Request submitted',
      `${request_id}: ${type} — ${src_territory_name}${dest_territory_name ? ' → '+dest_territory_name : ''}`,
      { territory: src_territory_name },
      { status: 'pending' },
      src.district
    );

    res.status(201).json({ request_id, ...result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PUT /api/requests/:id/approve ────────────────────────────────────────────
router.put('/:id/approve', auth, requireDMorNSD, async (req, res) => {
  try {
    const r = await query(
      `SELECT r.*, t.name AS src_territory, d.name AS district
       FROM requests r
       LEFT JOIN territories t ON t.id = r.src_territory_id
       LEFT JOIN districts d ON d.id = t.district_id
       WHERE r.request_id=$1`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    const req_row = r.rows[0];
    if (req_row.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });

    // NSD approves → final
    // DM approves OAM request → still pending (needs NSD)
    const isFinal = req.user.role === 'NSD';
    const newStatus = isFinal ? 'approved' : 'pending';

    await query(
      `UPDATE requests SET status=$1, approver_id=$2, resolved_at=$3 WHERE request_id=$4`,
      [newStatus, req.user.id, isFinal ? new Date() : null, req.params.id]
    );

    // Apply the alignment change if NSD-approved
    if (isFinal) {
      await applyApprovedRequest(req_row);
    }

    // Comment
    const msg = isFinal
      ? 'Approved. Alignment updated.'
      : `Forwarded to NSD for final approval. DM ${req.user.name} has reviewed.`;
    await query(
      'INSERT INTO request_comments(request_id,user_id,comment) VALUES($1,$2,$3)',
      [req_row.id, req.user.id, msg]
    );

    await logAudit(
      req.user.id,
      isFinal ? 'Approved' : 'DM Approved (forwarded)',
      `${req.params.id}: ${req_row.type}`,
      req_row.before_state,
      req_row.after_state,
      req_row.district
    );

    res.json({ success: true, status: newStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PUT /api/requests/:id/reject ─────────────────────────────────────────────
router.put('/:id/reject', auth, requireDMorNSD, async (req, res) => {
  const { rejection_reason } = req.body;
  try {
    const r = await query(
      `SELECT r.*, t.name AS src_territory, d.name AS district
       FROM requests r
       LEFT JOIN territories t ON t.id=r.src_territory_id
       LEFT JOIN districts d ON d.id=t.district_id
       WHERE r.request_id=$1`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    const req_row = r.rows[0];

    await query(
      `UPDATE requests SET status='rejected', approver_id=$1, rejection_reason=$2, resolved_at=NOW()
       WHERE request_id=$3`,
      [req.user.id, rejection_reason || 'Does not meet alignment criteria.', req.params.id]
    );

    await query(
      'INSERT INTO request_comments(request_id,user_id,comment) VALUES($1,$2,$3)',
      [req_row.id, req.user.id, `Rejected: ${rejection_reason || 'Does not meet alignment criteria.'}`]
    );

    await logAudit(req.user.id, 'Rejected', `${req.params.id}: ${req_row.type}`,
      req_row.before_state, { status:'rejected', reason: rejection_reason }, req_row.district);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/requests/:id/comment ───────────────────────────────────────────
router.post('/:id/comment', auth, async (req, res) => {
  const { comment } = req.body;
  if (!comment?.trim()) return res.status(400).json({ error: 'Comment is required' });
  try {
    const r = await query('SELECT id FROM requests WHERE request_id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    await query('INSERT INTO request_comments(request_id,user_id,comment) VALUES($1,$2,$3)',
      [r.rows[0].id, req.user.id, comment.trim()]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Apply approved request to alignment data ──────────────────────────────────
async function applyApprovedRequest(r) {
  if (r.type === 'Change HCP territory' && r.hcp_zip && r.dest_territory_id) {
    const terr = await query('SELECT district_id FROM territories WHERE id=$1', [r.dest_territory_id]);
    await query(
      'UPDATE hcps SET territory_id=$1, district_id=$2, updated_at=NOW() WHERE hcp_id=$3',
      [r.dest_territory_id, terr.rows[0]?.district_id, r.hcp_zip]
    );
  }
  if (r.type === 'Reassign ZIP' && r.hcp_zip && r.dest_territory_id) {
    const terr = await query('SELECT district_id FROM territories WHERE id=$1', [r.dest_territory_id]);
    await query(
      'UPDATE zips SET territory_id=$1, district_id=$2 WHERE code=$3',
      [r.dest_territory_id, terr.rows[0]?.district_id, r.hcp_zip]
    );
  }
  if (r.type === 'Add HCP' && r.hcp_zip && r.dest_territory_id) {
    // HCP already exists — just reassign territory
    const terr = await query('SELECT district_id FROM territories WHERE id=$1', [r.dest_territory_id]);
    await query(
      'UPDATE hcps SET territory_id=$1, district_id=$2, updated_at=NOW() WHERE hcp_id=$3',
      [r.dest_territory_id, terr.rows[0]?.district_id, r.hcp_zip]
    );
  }
  if (r.type === 'Remove HCP' && r.hcp_zip) {
    await query('UPDATE hcps SET territory_id=NULL, district_id=NULL WHERE hcp_id=$1', [r.hcp_zip]);
  }
  // Recompute territory aggregates for affected territories
  const affectedIds = [r.src_territory_id, r.dest_territory_id].filter(Boolean);
  for (const tid of affectedIds) {
    await query(`
      UPDATE territories SET
        hco_count = (SELECT COUNT(*) FROM hcps WHERE territory_id=$1),
        idx1 = COALESCE((SELECT SUM(idx1) FROM hcps WHERE territory_id=$1),0),
        idx2 = COALESCE((SELECT SUM(idx2) FROM hcps WHERE territory_id=$1),0),
        idx3 = COALESCE((SELECT SUM(idx3) FROM hcps WHERE territory_id=$1),0),
        idx4 = COALESCE((SELECT SUM(idx4) FROM hcps WHERE territory_id=$1),0),
        updated_at = NOW()
      WHERE id=$1`, [tid]);
  }
}

module.exports = router;
