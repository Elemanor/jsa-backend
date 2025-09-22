// Simple authentication endpoints for JSA System
const express = require('express');
const router = express.Router();

// Simple user creation endpoint
router.post('/create-user', async (req, res) => {
  const pool = req.app.locals.pool;

  try {
    const { name, pin, role = 'worker' } = req.body;

    // Validate input
    if (!name || !pin) {
      return res.status(400).json({
        success: false,
        error: 'Name and PIN are required'
      });
    }

    // Check if user exists
    const existing = await pool.query(
      'SELECT id FROM users WHERE LOWER(name) = LOWER($1)',
      [name]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'User already exists'
      });
    }

    // Create user
    const result = await pool.query(
      'INSERT INTO users (name, pin, role) VALUES ($1, $2, $3) RETURNING *',
      [name, pin, role]
    );

    res.json({
      success: true,
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Simple login endpoint
router.post('/simple-login', async (req, res) => {
  const pool = req.app.locals.pool;

  try {
    const { name, pin } = req.body;

    if (!name || !pin) {
      return res.status(400).json({
        success: false,
        error: 'Name and PIN are required'
      });
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE LOWER(name) = LOWER($1) AND pin = $2',
      [name, pin]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    const user = result.rows[0];

    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get all users
router.get('/users', async (req, res) => {
  const pool = req.app.locals.pool;

  try {
    const result = await pool.query(
      'SELECT id, name, role, created_at FROM users ORDER BY name'
    );

    res.json({
      success: true,
      users: result.rows
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Update user role
router.put('/users/:id/role', async (req, res) => {
  const pool = req.app.locals.pool;

  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!['worker', 'foreman', 'supervisor'].includes(role)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid role'
      });
    }

    const result = await pool.query(
      'UPDATE users SET role = $1 WHERE id = $2 RETURNING *',
      [role, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Update role error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;