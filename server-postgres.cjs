require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');
const cron = require('node-cron');
const { sendJSAEmail } = require('./emailConfig.cjs');

// Helper function to get EST/EDT date
function getEasternDate() {
  const now = new Date();
  // Format date in Eastern timezone
  const easternDateStr = now.toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return easternDateStr; // Returns YYYY-MM-DD format
}

const app = express();
const server = http.createServer(app);

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// CORS configuration
const corsOrigins = process.env.FRONTEND_URL 
  ? [process.env.FRONTEND_URL, "http://localhost:5173", "http://localhost:5174"]
  : ["http://localhost:5173", "http://localhost:5174"];

const io = new Server(server, {
  cors: {
    origin: corsOrigins,
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
  }
});

app.use(cors({
  origin: corsOrigins,
  credentials: true
}));
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join-form', (formId) => {
    socket.join(formId);
    console.log(`Socket ${socket.id} joined form ${formId}`);
  });

  socket.on('auto-save', (data) => {
    const { formId, updates } = data;
    saveFormUpdates(formId, updates, (err) => {
      if (!err) {
        socket.to(formId).emit('form-updated', updates);
      }
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Helper function to save form updates
async function saveFormUpdates(formId, updates, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Update main form data
    if (updates.formData) {
      const fields = [];
      const values = [];
      let paramCount = 1;
      
      const fieldMapping = {
        crewSupervisor: 'crew_supervisor',
        crewSafetyRep: 'crew_safety_rep',
        siteAddress: 'site_address',
        company: 'company',
        projectName: 'project_name',
        date: 'date',
        weather: 'weather',
        formwork: 'formwork'
      };
      
      for (const [key, dbField] of Object.entries(fieldMapping)) {
        if (updates.formData[key] !== undefined) {
          fields.push(`${dbField} = $${paramCount}`);
          values.push(updates.formData[key]);
          paramCount++;
        }
      }
      
      if (fields.length > 0) {
        values.push(formId);
        const query = `UPDATE jsa_forms SET ${fields.join(', ')}, updated_at = NOW() WHERE form_id = $${paramCount}`;
        await client.query(query, values);
      }
    }
    
    // Update job steps
    if (updates.jobSteps) {
      await client.query('DELETE FROM job_steps WHERE form_id = $1', [formId]);
      for (const step of updates.jobSteps) {
        await client.query(
          'INSERT INTO job_steps (form_id, sequence, operation, hazards, safety_controls, risk_level) VALUES ($1, $2, $3, $4, $5, $6)',
          [formId, step.sequence, step.operation, JSON.stringify(step.hazards), JSON.stringify(step.safetyControls), step.riskLevel]
        );
      }
    }
    
    // Update tools
    if (updates.tools) {
      await client.query('DELETE FROM tools WHERE form_id = $1', [formId]);
      for (const tool of updates.tools) {
        await client.query('INSERT INTO tools (form_id, tool_name) VALUES ($1, $2)', [formId, tool]);
      }
    }
    
    // Update PPE
    if (updates.ppe) {
      await client.query('DELETE FROM ppe WHERE form_id = $1', [formId]);
      for (const item of updates.ppe) {
        await client.query('INSERT INTO ppe (form_id, ppe_name) VALUES ($1, $2)', [formId, item]);
      }
    }
    
    // Update crew members
    if (updates.crew) {
      await client.query('DELETE FROM crew_members WHERE form_id = $1', [formId]);
      for (const member of updates.crew) {
        await client.query(
          'INSERT INTO crew_members (form_id, name, signed, is_mobile) VALUES ($1, $2, $3, $4)',
          [formId, member.name, member.signed, member.isMobile || false]
        );
      }
    }
    
    await client.query('COMMIT');
    callback(null);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating form:', err);
    callback(err);
  } finally {
    client.release();
  }
}

// REST API endpoints

// Get all projects
app.get('/api/projects', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM projects ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new project
app.post('/api/projects', async (req, res) => {
  const { name, description, address } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO projects (name, description, address) VALUES ($1, $2, $3) RETURNING *',
      [name, description || '', address || '']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete project
app.delete('/api/projects/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM projects WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all forms
app.get('/api/forms', async (req, res) => {
  const { date } = req.query;
  try {
    let result;
    if (date) {
      result = await pool.query('SELECT * FROM jsa_forms WHERE date = $1 ORDER BY updated_at DESC', [date]);
    } else {
      result = await pool.query('SELECT * FROM jsa_forms ORDER BY updated_at DESC LIMIT 50');
    }
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get specific form with details
app.get('/api/forms/:formId', async (req, res) => {
  const { formId } = req.params;
  try {
    const formResult = await pool.query('SELECT * FROM jsa_forms WHERE form_id = $1', [formId]);
    if (formResult.rows.length === 0) {
      return res.status(404).json({ error: 'Form not found' });
    }
    
    const form = formResult.rows[0];
    const jobSteps = await pool.query('SELECT * FROM job_steps WHERE form_id = $1 ORDER BY sequence', [formId]);
    const tools = await pool.query('SELECT tool_name FROM tools WHERE form_id = $1', [formId]);
    const ppe = await pool.query('SELECT ppe_name FROM ppe WHERE form_id = $1', [formId]);
    const crew = await pool.query('SELECT name, signed, is_mobile FROM crew_members WHERE form_id = $1', [formId]);
    
    res.json({
      form,
      jobSteps: jobSteps.rows.map(step => ({
        ...step,
        hazards: typeof step.hazards === 'string' ? JSON.parse(step.hazards) : step.hazards,
        safetyControls: typeof step.safety_controls === 'string' ? JSON.parse(step.safety_controls) : step.safety_controls
      })),
      tools: tools.rows.map(t => t.tool_name),
      ppe: ppe.rows.map(p => p.ppe_name),
      crew: crew.rows.map(c => ({
        name: c.name,
        signed: c.signed,
        isMobile: c.is_mobile || false
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new form
app.post('/api/forms', async (req, res) => {
  const formId = `JSA-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const { date, company, siteAddress } = req.body;
  
  try {
    const result = await pool.query(
      'INSERT INTO jsa_forms (form_id, date, company, site_address) VALUES ($1, $2, $3, $4) RETURNING *',
      [formId, date, company || 'MJR Contractors Ltd', siteAddress || '']
    );
    res.json({ formId, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update form
app.put('/api/forms/:formId', async (req, res) => {
  const { formId } = req.params;
  const updates = req.body;
  
  await saveFormUpdates(formId, updates, (err) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      io.to(formId).emit('form-updated', updates);
      res.json({ success: true });
    }
  });
});

// Delete form
app.delete('/api/forms/:formId', async (req, res) => {
  const { formId } = req.params;
  try {
    await pool.query('DELETE FROM jsa_forms WHERE form_id = $1', [formId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get forms for calendar view
app.get('/api/forms/calendar/:year/:month', async (req, res) => {
  const { year, month } = req.params;
  
  try {
    // Calculate date range for the month
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0]; // Last day of month
    
    const result = await pool.query(
      'SELECT form_id, date, site_address, crew_supervisor, status, updated_at FROM jsa_forms WHERE date >= $1 AND date <= $2 ORDER BY date, updated_at DESC',
      [startDate, endDate]
    );
    
    // Group forms by date
    const formsByDate = {};
    result.rows.forEach(form => {
      const dateKey = form.date;
      if (!formsByDate[dateKey]) {
        formsByDate[dateKey] = [];
      }
      formsByDate[dateKey].push(form);
    });
    
    res.json(formsByDate);
  } catch (err) {
    console.error('Error fetching calendar forms:', err);
    res.status(500).json({ error: err.message });
  }
});

// Authentication endpoint
app.post('/api/auth/login', async (req, res) => {
  const { name, pin, latitude, longitude, address } = req.body;
  try {
    const result = await pool.query(
      'SELECT id, name, role FROM users WHERE LOWER(name) = LOWER($1) AND pin = $2',
      [name, pin]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid credentials' });
    } else {
      const user = result.rows[0];

      // Create attendance record for workers when they log in
      if (user.role === 'worker') {
        const today = getEasternDate();
        const checkInTime = new Date().toISOString();

        try {
          // Check if attendance record already exists for today
          const existingAttendance = await pool.query(
            'SELECT id FROM attendance WHERE worker_name = $1 AND date = $2',
            [user.name, today]
          );

          if (existingAttendance.rows.length === 0) {
            // Create new attendance record - using worker_name ONLY (no worker_id column)
            await pool.query(
              'INSERT INTO attendance (worker_name, date, status, check_in_time, sign_in_latitude, sign_in_longitude, sign_in_address) VALUES ($1, $2, $3, $4, $5, $6, $7)',
              [user.name, today, 'present', checkInTime, latitude, longitude, address || null]
            );
            console.log('Created attendance record for', user.name);
          } else {
            // Update existing record with GPS data if not already set
            await pool.query(
              'UPDATE attendance SET status = $1, check_in_time = COALESCE(check_in_time, $2), sign_in_latitude = COALESCE(sign_in_latitude, $3), sign_in_longitude = COALESCE(sign_in_longitude, $4), sign_in_address = COALESCE(sign_in_address, $5) WHERE worker_name = $6 AND date = $7',
              ['present', checkInTime, latitude, longitude, address || null, user.name, today]
            );
            console.log('Updated attendance record for', user.name);
          }
        } catch (attendanceErr) {
          console.error('Failed to create/update attendance record:', attendanceErr);
          // Don't fail the login if attendance record fails
        }
      }

      res.json({ user });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Worker sign-in
app.post('/api/worker/signin', async (req, res) => {
  const { workerName, projectId, projectName, siteAddress, latitude, longitude, address } = req.body;
  const signinDate = getEasternDate();
  const signinTime = new Date().toISOString();

  try {
    // Check if already signed in (case-insensitive)
    const existing = await pool.query(
      'SELECT id FROM worker_signins WHERE LOWER(worker_name) = LOWER($1) AND signin_date = $2 AND signout_time IS NULL',
      [workerName, signinDate]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Already signed in today' });
    }

    const result = await pool.query(
      'INSERT INTO worker_signins (worker_name, project_id, project_name, site_address, signin_date, signin_time) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [workerName, projectId, projectName, siteAddress, signinDate, signinTime]
    );

    // Update or create attendance record when worker signs in
    try {
      const checkAttendance = await pool.query(
        'SELECT id FROM attendance WHERE worker_name = $1 AND date = $2',
        [workerName, signinDate]
      );

      if (checkAttendance.rows.length === 0) {
        // Create attendance record - using worker_name ONLY (no worker_id column)
        await pool.query(
          'INSERT INTO attendance (worker_name, date, status, check_in_time, sign_in_latitude, sign_in_longitude, sign_in_address) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [workerName, signinDate, 'present', signinTime, latitude, longitude, address || null]
        );
        console.log('Created attendance record for', workerName, 'on project sign-in');
      } else {
        // Update existing record
        await pool.query(
          'UPDATE attendance SET status = $1, check_in_time = COALESCE(check_in_time, $2), sign_in_latitude = COALESCE(sign_in_latitude, $3), sign_in_longitude = COALESCE(sign_in_longitude, $4), sign_in_address = COALESCE(sign_in_address, $5) WHERE worker_name = $6 AND date = $7',
          ['present', signinTime, latitude, longitude, address || null, workerName, signinDate]
        );
        console.log('Updated attendance record for', workerName, 'on project sign-in');
      }
    } catch (attendanceErr) {
      console.error('Failed to update attendance:', attendanceErr);
      // Don't fail the sign-in if attendance update fails
    }

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fix attendance endpoint - sync attendance records with sign-ins
app.post('/api/fix-attendance', async (req, res) => {
  try {
    const today = getEasternDate();

    // Get all sign-ins for today
    const signins = await pool.query(
      'SELECT DISTINCT worker_name, signin_time FROM worker_signins WHERE signin_date = $1',
      [today]
    );

    let fixed = 0;
    for (const signin of signins.rows) {
      // Check if attendance exists
      const existing = await pool.query(
        'SELECT id FROM attendance WHERE worker_name = $1 AND date = $2',
        [signin.worker_name, today]
      );

      if (existing.rows.length === 0) {
        // Create missing attendance record - using worker_name ONLY
        await pool.query(
          'INSERT INTO attendance (worker_name, date, status, check_in_time) VALUES ($1, $2, $3, $4)',
          [signin.worker_name, today, 'present', signin.signin_time]
        );
        fixed++;
        console.log('Fixed attendance for', signin.worker_name);
      }
    }

    res.json({ success: true, fixed, total: signins.rows.length });
  } catch (err) {
    console.error('Fix attendance error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Fix incorrect dates endpoint
app.post('/api/fix-dates', async (req, res) => {
  try {
    // Update all Sep 16 records to Sep 15 for worker_signins
    const signinsResult = await pool.query(
      "UPDATE worker_signins SET signin_date = '2025-09-15' WHERE signin_date = '2025-09-16' RETURNING *"
    );

    // Update all Sep 16 records to Sep 15 for attendance
    const attendanceResult = await pool.query(
      "UPDATE attendance SET date = '2025-09-15' WHERE date = '2025-09-16' RETURNING *"
    );

    // Update all Sep 16 records to Sep 15 for timesheets
    const timesheetsResult = await pool.query(
      "UPDATE timesheets SET date = '2025-09-15' WHERE date = '2025-09-16' RETURNING *"
    );

    res.json({
      success: true,
      fixed: {
        signins: signinsResult.rowCount,
        attendance: attendanceResult.rowCount,
        timesheets: timesheetsResult.rowCount
      }
    });
  } catch (err) {
    console.error('Fix dates error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Auto sign-out endpoint
app.post('/api/auto-signout', async (req, res) => {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const result = await pool.query(
      'UPDATE worker_signins SET signout_time = $1 WHERE signin_date <= $2 AND signout_time IS NULL RETURNING worker_name, project_name',
      [new Date(yesterdayStr + 'T23:59:59').toISOString(), yesterdayStr]
    );

    console.log(`Auto signed out ${result.rows.length} workers`);
    res.json({ success: true, signedOut: result.rows.length, workers: result.rows });
  } catch (err) {
    console.error('Auto sign-out error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint to check users
app.get('/api/debug/users', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT name, role, pin FROM users WHERE role = 'worker' ORDER BY name"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set default PIN for users without PIN
app.post('/api/debug/set-default-pins', async (req, res) => {
  try {
    // Set default PIN 1234 for all workers without a PIN
    const result = await pool.query(
      "UPDATE users SET pin = '1234' WHERE role = 'worker' AND (pin IS NULL OR pin = '') RETURNING name"
    );
    res.json({
      success: true,
      updated: result.rowCount,
      users: result.rows.map(r => r.name)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Worker sign-out endpoint
app.post('/api/worker/signout', async (req, res) => {
  const { workerName, projectName } = req.body;
  const today = getEasternDate();

  try {
    const result = await pool.query(
      'UPDATE worker_signins SET signout_time = CURRENT_TIMESTAMP WHERE LOWER(worker_name) = LOWER($1) AND project_name = $2 AND signin_date = $3 AND signout_time IS NULL RETURNING id',
      [workerName, projectName, today]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No active sign-in found' });
    }

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});