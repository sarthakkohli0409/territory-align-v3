const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { query } = require('./pool');
const { auth }  = require('./middleware.auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { personnel_id, password } = req.body;
  if (!personnel_id || !password) {
    return res.status(400).json({ error: 'personnel_id and password are required' });
  }
  try {
    const result = await query(
      `SELECT u.*, t.name AS territory_name, d.name AS district_name
       FROM users u
       LEFT JOIN territories t ON t.id = u.territory_id
       LEFT JOIN districts d ON d.id = u.district_id
       WHERE u.personnel_id = $1 AND u.is_active = TRUE`,
      [personnel_id.toUpperCase()]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      {
        id: user.id,
        personnel_id: user.personnel_id,
        name: user.name,
        role: user.role,
        territory_id: user.territory_id,
        district_id: user.district_id,
        territory_name: user.territory_name,
        district_name: user.district_name,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        personnel_id: user.personnel_id,
        name: user.name,
        role: user.role,
        territory_id: user.territory_id,
        territory_name: user.territory_name,
        district_id: user.district_id,
        district_name: user.district_name,
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.personnel_id, u.name, u.role,
              t.name AS territory_name, d.name AS district_name
       FROM users u
       LEFT JOIN territories t ON t.id = u.territory_id
       LEFT JOIN districts d ON d.id = u.district_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    res.json(result.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/logout  (client just discards token — kept for audit log)
router.post('/logout', auth, (req, res) => {
  res.json({ message: 'Logged out' });
});

module.exports = router;
