require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

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

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// CORS configuration
const corsOrigins = process.env.FRONTEND_URL 
  ? [process.env.FRONTEND_URL, "http://localhost:5173", "http://localhost:5174", "https://mjr-jsa-app.netlify.app"]
  : ["http://localhost:5173", "http://localhost:5174"];

app.use(cors({
  origin: corsOrigins,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Helper function to save form updates
async function saveFormUpdates(formId, updates) {
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
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating form:', err);
    throw err;
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
  
  try {
    await saveFormUpdates(formId, updates);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// Authentication endpoint
app.post('/api/auth/login', async (req, res) => {
  const { name, pin, latitude, longitude, address } = req.body;

  console.log('Login attempt:', {
    name,
    pin: pin ? '***' : 'empty',
    hasLocation: !!(latitude && longitude),
    address: address || 'No address'
  });

  try {
    // Try case-insensitive name match
    const result = await pool.query(
      'SELECT id, name, role FROM users WHERE LOWER(name) = LOWER($1) AND pin = $2',
      [name, pin]
    );

    if (result.rows.length === 0) {
      // Log failed attempts for debugging
      console.log('Login failed for:', name);

      // Check if user exists but wrong PIN
      const userCheck = await pool.query(
        'SELECT name FROM users WHERE LOWER(name) = LOWER($1)',
        [name]
      );

      if (userCheck.rows.length > 0) {
        res.status(401).json({ error: 'Invalid PIN' });
      } else {
        res.status(401).json({ error: 'User not found' });
      }
    } else {
      const user = result.rows[0];
      console.log('Login successful:', user);

      // If worker role, create automatic attendance record (with or without location)
      if (user.role === 'worker') {
        const today = getEasternDate();
        const checkInTime = new Date().toISOString();

        try {
          // Check if attendance already exists by worker name
          const existingAttendance = await pool.query(
            'SELECT id FROM attendance WHERE LOWER(worker_name) = LOWER($1) AND date = $2',
            [user.name, today]
          );

          if (existingAttendance.rows.length === 0) {
            // Create attendance record with GPS data
            await pool.query(`
              INSERT INTO attendance (
                worker_name, date, status,
                check_in_time, sign_in_latitude, sign_in_longitude, sign_in_address
              ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [user.name, today, 'present', checkInTime, latitude, longitude, address || null]
            );
            console.log('Created attendance record with GPS for:', user.name);
          } else {
            // Update existing attendance with GPS data if not already set
            await pool.query(`
              UPDATE attendance
              SET sign_in_latitude = COALESCE(sign_in_latitude, $1),
                  sign_in_longitude = COALESCE(sign_in_longitude, $2),
                  sign_in_address = COALESCE(sign_in_address, $3),
                  check_in_time = COALESCE(check_in_time, $4),
                  status = 'present'
              WHERE LOWER(worker_name) = LOWER($5) AND date = $6`,
              [latitude, longitude, address || null, checkInTime, user.name, today]
            );
            console.log('Updated attendance with GPS for:', user.name);
          }
        } catch (attendanceErr) {
          console.error('Error creating/updating attendance for', user.name, ':', attendanceErr.message);
          console.error('Full error:', attendanceErr);
          // Don't fail login if attendance update fails
        }
      }

      res.json({ user });
    }
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Worker sign-in
app.post('/api/worker/signin', async (req, res) => {
  const { workerName, projectId, projectName, siteAddress, latitude, longitude, address } = req.body;
  const signinDate = getEasternDate();

  console.log('Worker sign-in attempt:', { workerName, projectName, hasLocation: !!(latitude && longitude) });

  try {
    // First, get the correct capitalization of the worker name from users table
    const userCheck = await pool.query(
      'SELECT id, name FROM users WHERE LOWER(name) = LOWER($1)',
      [workerName]
    );

    const actualWorkerName = userCheck.rows.length > 0 ? userCheck.rows[0].name : workerName;
    const workerId = userCheck.rows.length > 0 ? userCheck.rows[0].id : null;

    // Check if already signed in (using case-insensitive check)
    const existing = await pool.query(
      'SELECT id FROM worker_signins WHERE LOWER(worker_name) = LOWER($1) AND signin_date = $2 AND signout_time IS NULL',
      [actualWorkerName, signinDate]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Already signed in today' });
    }

    // Use the correctly capitalized name for the insert
    const result = await pool.query(
      'INSERT INTO worker_signins (worker_name, project_id, project_name, site_address, signin_date) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [actualWorkerName, projectId, projectName, siteAddress, signinDate]
    );

    // Automatically mark attendance as present when signing in
    try {
      // Check if attendance record exists by worker name
      const attendanceCheck = await pool.query(
        'SELECT * FROM attendance WHERE LOWER(worker_name) = LOWER($1) AND date = $2',
        [actualWorkerName, signinDate]
      );

      if (attendanceCheck.rows.length === 0) {
        // Create attendance record with worker_name
        await pool.query(
          `INSERT INTO attendance (worker_name, date, status, check_in_time, sign_in_latitude, sign_in_longitude, sign_in_address)
           VALUES ($1, $2, $3, NOW(), $4, $5, $6)`,
          [actualWorkerName, signinDate, 'present', latitude || null, longitude || null, address || null]
        );
        console.log('Created attendance for', actualWorkerName);
      } else {
        // Update existing record to present with GPS data if available
        await pool.query(
          `UPDATE attendance SET status = $1, check_in_time = COALESCE(check_in_time, NOW()),
           sign_in_latitude = COALESCE(sign_in_latitude, $2),
           sign_in_longitude = COALESCE(sign_in_longitude, $3),
           sign_in_address = COALESCE(sign_in_address, $4)
           WHERE LOWER(worker_name) = LOWER($5) AND date = $6`,
          ['present', latitude || null, longitude || null, address || null, actualWorkerName, signinDate]
        );
        console.log('Updated attendance for', actualWorkerName);
      }
    } catch (attendanceErr) {
      console.error('Error updating attendance for', actualWorkerName, ':', attendanceErr.message);
      console.error('Full attendance error:', attendanceErr);
      // Don't fail the sign-in if attendance update fails
    }

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Foreman sign-in with JSA association
app.post('/api/foreman/signin', async (req, res) => {
  const { foremanId, foremanName, projectId, projectName } = req.body;
  const signinDate = getEasternDate();
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Check if foreman already signed in today for this project
    const existing = await client.query(
      'SELECT id, form_id FROM foreman_signins WHERE foreman_id = $1 AND project_id = $2 AND signin_date = $3',
      [foremanId, projectId, signinDate]
    );
    
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      return res.json({ 
        success: true, 
        alreadySignedIn: true,
        formId: existing.rows[0].form_id 
      });
    }
    
    // Check if a JSA form exists for this project and date
    let formResult = await client.query(
      'SELECT form_id FROM jsa_forms WHERE project_name = $1 AND date = $2',
      [projectName, signinDate]
    );
    
    let formId;
    if (formResult.rows.length === 0) {
      // Create new JSA form for today
      formId = `JSA-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      await client.query(
        'INSERT INTO jsa_forms (form_id, date, company, project_name, crew_supervisor, site_address, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [formId, signinDate, 'MJR Contractors Ltd', projectName, foremanName, '', 'draft']
      );
    } else {
      formId = formResult.rows[0].form_id;
      // Update the crew supervisor if not set
      await client.query(
        'UPDATE jsa_forms SET crew_supervisor = $1 WHERE form_id = $2 AND (crew_supervisor IS NULL OR crew_supervisor = \'\')',
        [foremanName, formId]
      );
    }
    
    // Record foreman sign-in
    await client.query(
      'INSERT INTO foreman_signins (foreman_id, foreman_name, project_id, project_name, form_id, signin_date) VALUES ($1, $2, $3, $4, $5, $6)',
      [foremanId, foremanName, projectId, projectName, formId, signinDate]
    );
    
    // Add foreman to crew members for this form
    const crewExists = await client.query(
      'SELECT id FROM crew_members WHERE form_id = $1 AND name = $2',
      [formId, foremanName]
    );
    
    if (crewExists.rows.length === 0) {
      await client.query(
        'INSERT INTO crew_members (form_id, name, signed, is_mobile) VALUES ($1, $2, $3, $4)',
        [formId, foremanName, true, false]
      );
    } else {
      await client.query(
        'UPDATE crew_members SET signed = true WHERE form_id = $1 AND name = $2',
        [formId, foremanName]
      );
    }
    
    await client.query('COMMIT');
    res.json({ 
      success: true, 
      formId,
      message: `Signed in and associated with JSA form for ${signinDate}`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in foreman sign-in:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Get foreman sign-in history
app.get('/api/foreman/signins/:foremanId', async (req, res) => {
  const { foremanId } = req.params;
  const { date } = req.query;

  try {
    let query = 'SELECT * FROM foreman_signins WHERE foreman_id = $1';
    const params = [foremanId];

    if (date) {
      query += ' AND signin_date = $2';
      params.push(date);
    }

    query += ' ORDER BY signin_date DESC, signin_time DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save signature
app.post('/api/signatures', async (req, res) => {
  const { worker_id, worker_name, initials, project_id, project_name, date, signature_type, signature_image } = req.body;

  try {
    const result = await pool.query(
      'INSERT INTO signatures (worker_id, worker_name, initials, project_id, project_name, date, signature_type, signature_image) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [worker_id, worker_name, initials, project_id, project_name, date, signature_type || 'attendance', signature_image]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error saving signature:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get worker sign-ins
app.get('/api/worker/signins/:workerId', async (req, res) => {
  const { workerId } = req.params;
  const { date } = req.query;

  try {
    let query = 'SELECT * FROM worker_signins WHERE worker_name = (SELECT name FROM users WHERE id = $1)';
    const params = [workerId];

    if (date) {
      query += ' AND signin_date = $2';
      params.push(date);
    }

    query += ' ORDER BY signin_date DESC, signin_time DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Worker sign out
app.post('/api/worker/signout', async (req, res) => {
  const { workerId, projectName } = req.body;
  const today = getEasternDate();

  try {
    // Get worker name
    const userResult = await pool.query('SELECT name FROM users WHERE id = $1', [workerId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Worker not found' });
    }
    const workerName = userResult.rows[0].name;

    // Update sign out time
    const result = await pool.query(
      'UPDATE worker_signins SET signout_time = NOW() WHERE worker_name = $1 AND project_name = $2 AND signin_date = $3 AND signout_time IS NULL RETURNING *',
      [workerName, projectName, today]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No active sign-in found' });
    }

    res.json({ success: true, signout: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get worker timesheets
app.get('/api/timesheets/worker/:workerId', async (req, res) => {
  const { workerId } = req.params;

  try {
    // First check if timesheets table exists
    const tableCheck = await pool.query(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'timesheets')"
    );

    if (!tableCheck.rows[0].exists) {
      // Create timesheets table if it doesn't exist
      await pool.query(`
        CREATE TABLE IF NOT EXISTS timesheets (
          id SERIAL PRIMARY KEY,
          worker_id INTEGER,
          worker_name TEXT,
          date DATE,
          project_name TEXT,
          start_time TIME,
          end_time TIME,
          break_duration INTEGER DEFAULT 0,
          total_hours DECIMAL(5,2),
          notes TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }

    const result = await pool.query(
      'SELECT * FROM timesheets WHERE worker_id = $1 ORDER BY date DESC LIMIT 10',
      [workerId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching timesheets:', err);
    res.status(500).json({ error: err.message });
  }
});

// Submit timesheet
app.post('/api/timesheets', async (req, res) => {
  const { worker_id, worker_name, date, project_name, start_time, end_time, break_duration, total_hours, notes } = req.body;

  try {
    const result = await pool.query(
      'INSERT INTO timesheets (worker_id, worker_name, date, project_name, start_time, end_time, break_duration, total_hours, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
      [worker_id, worker_name, date, project_name, start_time, end_time, break_duration || 0, total_hours, notes || '']
    );

    // Automatically mark attendance as present when submitting timesheet
    try {
      const timesheetDate = typeof date === 'string' ? date : new Date(date).toISOString().split('T')[0];

      // Check if attendance record exists
      const attendanceCheck = await pool.query(
        'SELECT * FROM attendance WHERE worker_name = $1 AND date = $2',
        [worker_name, timesheetDate]
      );

      if (attendanceCheck.rows.length === 0) {
        // Create attendance record
        await pool.query(
          'INSERT INTO attendance (worker_name, date, status, check_in_time) VALUES ($1, $2, $3, $4)',
          [worker_name, timesheetDate, 'present', start_time]
        );
      } else {
        // Update existing record to present
        await pool.query(
          'UPDATE attendance SET status = $1, check_in_time = COALESCE(check_in_time, $2) WHERE worker_name = $3 AND date = $4',
          ['present', start_time, worker_name, timesheetDate]
        );
      }
    } catch (attendanceErr) {
      console.error('Error updating attendance:', attendanceErr);
      // Don't fail the timesheet submission if attendance update fails
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all workers
app.get('/api/workers', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, role FROM users WHERE role = 'worker' ORDER BY name"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get concrete deliveries for a date
app.get('/api/concrete-deliveries/:date', async (req, res) => {
  const { date } = req.params;

  try {
    // Check if table exists first
    const tableCheck = await pool.query(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'concrete_deliveries')"
    );

    if (!tableCheck.rows[0].exists) {
      // Return empty array if table doesn't exist
      return res.json([]);
    }

    const result = await pool.query(
      'SELECT * FROM concrete_deliveries WHERE date = $1 ORDER BY time',
      [date]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching concrete deliveries:', err);
    res.json([]); // Return empty array on error
  }
});

// Get calendar events
app.get('/api/calendar-events', async (req, res) => {
  const { start_date, end_date } = req.query;

  try {
    // Check if table exists
    const tableCheck = await pool.query(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'calendar_events')"
    );

    if (!tableCheck.rows[0].exists) {
      return res.json([]);
    }

    const result = await pool.query(
      'SELECT * FROM calendar_events WHERE event_date >= $1 AND event_date <= $2 ORDER BY event_date, event_time',
      [start_date, end_date]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching calendar events:', err);
    res.json([]);
  }
});

// Get project signatures
app.get('/api/project-signatures', async (req, res) => {
  const { project, date } = req.query;

  try {
    // Check if signatures table exists
    const tableCheck = await pool.query(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'signatures')"
    );

    if (!tableCheck.rows[0].exists) {
      return res.json([]);
    }

    let query = 'SELECT * FROM signatures WHERE 1=1';
    const params = [];

    if (project) {
      params.push(project);
      query += ` AND project_name = $${params.length}`;
    }

    if (date) {
      params.push(date);
      query += ` AND date = $${params.length}`;
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching project signatures:', err);
    res.json([]);
  }
});

// Get workers for today by project
app.get('/api/worker/today/:projectName', async (req, res) => {
  const { projectName } = req.params;
  const today = getEasternDate();

  try {
    const result = await pool.query(
      'SELECT DISTINCT worker_name FROM worker_signins WHERE project_name = $1 AND signin_date = $2 AND signout_time IS NULL',
      [projectName, today]
    );
    // Return in the format expected by frontend
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching today\'s workers:', err);
    res.json([]);
  }
});

// Get worker sign-ins for a date
app.get('/api/worker-signins', async (req, res) => {
  const { date } = req.query;

  try {
    let query = 'SELECT * FROM worker_signins WHERE 1=1';
    const params = [];

    if (date) {
      params.push(date);
      query += ` AND signin_date = $${params.length}`;
    }

    query += ' ORDER BY signin_time DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching worker sign-ins:', err);
    res.json([]);
  }
});

// Add concrete delivery
app.post('/api/concrete-deliveries', async (req, res) => {
  // Handle both old and new field formats
  const {
    project_name,
    delivery_date,
    delivery_time,
    truck_number,
    volume_m3,
    slump,
    notes,
    // New fields from ConcreteSchedule
    area,
    quantity,
    concrete_type,
    status,
    project_id
  } = req.body;

  console.log('Adding concrete delivery:', req.body);

  try {
    // Check if table exists, create if not
    const tableCheck = await pool.query(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'concrete_deliveries')"
    );

    if (!tableCheck.rows[0].exists) {
      await pool.query(`
        CREATE TABLE concrete_deliveries (
          id SERIAL PRIMARY KEY,
          project_name TEXT,
          project_id TEXT,
          date DATE,
          time TEXT,
          truck_load TEXT,
          slump TEXT,
          additives TEXT,
          area TEXT,
          quantity TEXT,
          concrete_type TEXT,
          status TEXT,
          pour_type TEXT,
          confirmed BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } else {
      // Add new columns if they don't exist
      await pool.query(`
        ALTER TABLE concrete_deliveries
        ADD COLUMN IF NOT EXISTS project_id TEXT,
        ADD COLUMN IF NOT EXISTS project_name TEXT,
        ADD COLUMN IF NOT EXISTS area TEXT,
        ADD COLUMN IF NOT EXISTS quantity TEXT,
        ADD COLUMN IF NOT EXISTS concrete_type TEXT,
        ADD COLUMN IF NOT EXISTS status TEXT,
        ADD COLUMN IF NOT EXISTS pour_type TEXT
      `).catch(err => {
        console.log('Columns might already exist:', err.message);
      });
    }

    // Ensure delivery_time is in proper format (HH:MM:SS) or null
    let formattedTime = null;
    if (delivery_time) {
      if (!delivery_time.includes(':')) {
        formattedTime = '00:00:00'; // Default time if invalid
      } else if (delivery_time.split(':').length === 2) {
        formattedTime = `${delivery_time}:00`; // Add seconds if missing
      } else {
        formattedTime = delivery_time;
      }
    }

    // Handle null values and ensure proper types
    // Use volume_m3 or quantity for volume
    const volumeValue = volume_m3 ? parseFloat(volume_m3) : (quantity ? parseFloat(quantity) : null);
    const truckValue = truck_number || null;
    // Use slump or concrete_type
    const slumpValue = slump || concrete_type || null;
    // Use notes or area for notes
    const notesValue = notes || (area ? `Area: ${area}` : null);
    const statusValue = status || 'scheduled';
    const projectIdValue = project_id || null;

    console.log('Inserting concrete delivery with values:', {
      project_name,
      project_id: projectIdValue,
      delivery_date,
      formattedTime,
      truckValue,
      volumeValue,
      slumpValue,
      notesValue,
      area,
      quantity,
      concrete_type,
      status: statusValue
    });

    const result = await pool.query(
      `INSERT INTO concrete_deliveries (
        project_name, project_id, date, time,
        truck_load, slump, additives,
        area, quantity, concrete_type, status, pour_type
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        project_name, projectIdValue, delivery_date, formattedTime,
        truckValue, slumpValue, notesValue,
        area || null, quantity || null, concrete_type || null, statusValue, 'standard'
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error adding concrete delivery:', err);
    console.error('Error details:', err.detail || err.message);
    console.error('Request body was:', req.body);
    res.status(500).json({
      error: err.message,
      detail: err.detail || 'No additional details available',
      hint: err.hint || 'Check the data format'
    });
  }
});

// Update concrete delivery
app.put('/api/concrete-deliveries/:id', async (req, res) => {
  const { id } = req.params;
  const { delivery_time, truck_number, volume_m3, slump, notes } = req.body;

  try {
    const result = await pool.query(
      'UPDATE concrete_deliveries SET delivery_time = $1, truck_number = $2, volume_m3 = $3, slump = $4, notes = $5 WHERE id = $6 RETURNING *',
      [delivery_time, truck_number, volume_m3, slump, notes, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Delivery not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating concrete delivery:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete concrete delivery
app.delete('/api/concrete-deliveries/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query('DELETE FROM concrete_deliveries WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting concrete delivery:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get form by ID
app.get('/api/forms/:formId', async (req, res) => {
  const { formId } = req.params;

  try {
    // Check if forms table exists
    const tableCheck = await pool.query(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'forms')"
    );

    if (!tableCheck.rows[0].exists) {
      // Create forms table if it doesn't exist
      await pool.query(`
        CREATE TABLE forms (
          id TEXT PRIMARY KEY,
          project_id INTEGER,
          project_name TEXT,
          form_type TEXT,
          status TEXT DEFAULT 'draft',
          data JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }

    const result = await pool.query(
      'SELECT * FROM forms WHERE id = $1',
      [formId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Form not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching form:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update form by ID
app.put('/api/forms/:formId', async (req, res) => {
  const { formId } = req.params;
  const formData = req.body;

  try {
    // Check if forms table exists
    const tableCheck = await pool.query(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'forms')"
    );

    if (!tableCheck.rows[0].exists) {
      // Create forms table if it doesn't exist
      await pool.query(`
        CREATE TABLE forms (
          id TEXT PRIMARY KEY,
          project_id INTEGER,
          project_name TEXT,
          form_type TEXT,
          status TEXT DEFAULT 'draft',
          data JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }

    // Check if form exists
    const existingForm = await pool.query(
      'SELECT * FROM forms WHERE id = $1',
      [formId]
    );

    if (existingForm.rows.length === 0) {
      // Insert new form
      const result = await pool.query(
        'INSERT INTO forms (id, project_id, project_name, form_type, status, data) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [formId, formData.project_id, formData.project_name, formData.form_type, formData.status || 'draft', JSON.stringify(formData)]
      );
      res.json(result.rows[0]);
    } else {
      // Update existing form
      const result = await pool.query(
        'UPDATE forms SET data = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
        [JSON.stringify(formData), formData.status || 'draft', formId]
      );
      res.json(result.rows[0]);
    }
  } catch (err) {
    console.error('Error updating form:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all forms
app.get('/api/forms', async (req, res) => {
  try {
    // Check if forms table exists
    const tableCheck = await pool.query(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'forms')"
    );

    if (!tableCheck.rows[0].exists) {
      // Create forms table if it doesn't exist
      await pool.query(`
        CREATE TABLE forms (
          id TEXT PRIMARY KEY,
          project_id INTEGER,
          project_name TEXT,
          form_type TEXT,
          status TEXT DEFAULT 'draft',
          data JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      return res.json([]);
    }

    const result = await pool.query('SELECT * FROM forms ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching forms:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete form
app.delete('/api/forms/:formId', async (req, res) => {
  const { formId } = req.params;

  try {
    await pool.query('DELETE FROM forms WHERE id = $1', [formId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting form:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all timesheets (admin)
app.get('/api/timesheets', async (req, res) => {
  const { week, year, worker_id, worker_name } = req.query;

  try {
    let query = 'SELECT * FROM timesheets WHERE 1=1';
    let params = [];
    let paramIndex = 1;

    if (worker_id) {
      query += ` AND worker_id = $${paramIndex++}`;
      params.push(worker_id);
    }

    if (worker_name) {
      query += ` AND worker_name = $${paramIndex++}`;
      params.push(worker_name);
    }

    if (week) {
      query += ` AND week_number = $${paramIndex++}`;
      params.push(week);
    }

    if (year) {
      // Extract year from date column if year column doesn't exist
      query += ` AND EXTRACT(YEAR FROM date) = $${paramIndex++}`;
      params.push(year);
    }

    query += ' ORDER BY date DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching timesheets:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get weekly timesheet summary
app.get('/api/timesheets/weekly-summary', async (req, res) => {
  const { week, year } = req.query;

  if (!week || !year) {
    return res.status(400).json({ error: 'Week and year are required' });
  }

  try {
    const result = await pool.query(
      `SELECT
        worker_id,
        worker_name,
        SUM(regular_hours) as total_regular_hours,
        SUM(overtime_hours) as total_overtime_hours,
        SUM(total_hours) as total_hours,
        COUNT(*) as days_worked
      FROM timesheets
      WHERE week_number = $1 AND EXTRACT(YEAR FROM date) = $2
      GROUP BY worker_id, worker_name
      ORDER BY worker_name`,
      [week, year]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching weekly summary:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get worker's timesheets
app.get('/api/timesheets/worker/:workerId', async (req, res) => {
  const { workerId } = req.params;
  const { week, year } = req.query;

  try {
    let query = 'SELECT * FROM timesheets WHERE worker_id = $1';
    let params = [workerId];
    let paramIndex = 2;

    if (week && year) {
      query += ` AND week_number = $${paramIndex++} AND EXTRACT(YEAR FROM date) = $${paramIndex++}`;
      params.push(week, year);
    }

    query += ' ORDER BY date DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching worker timesheets:', err);
    res.status(500).json({ error: err.message });
  }
});

// Approve timesheet
app.put('/api/timesheets/:id/approve', async (req, res) => {
  const { id } = req.params;
  const { approved_by } = req.body;

  try {
    const result = await pool.query(
      'UPDATE timesheets SET status = $1, approved_at = NOW(), approved_by = $2 WHERE id = $3 RETURNING *',
      ['approved', approved_by, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Timesheet not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error approving timesheet:', err);
    res.status(500).json({ error: err.message });
  }
});

// Reject timesheet
app.put('/api/timesheets/:id/reject', async (req, res) => {
  const { id } = req.params;
  const { rejected_by } = req.body;

  try {
    const result = await pool.query(
      'UPDATE timesheets SET status = $1, rejected_by = $2 WHERE id = $3 RETURNING *',
      ['rejected', rejected_by, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Timesheet not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error rejecting timesheet:', err);
    res.status(500).json({ error: err.message });
  }
});

// Edit timesheet
app.put('/api/timesheets/:id/edit', async (req, res) => {
  const { id } = req.params;
  const { start_time, end_time, break_hours, work_description, edited_by } = req.body;

  try {
    const result = await pool.query(
      `UPDATE timesheets
       SET start_time = $1, end_time = $2, break_hours = $3,
           work_description = $4, edited_by = $5, edited_at = NOW()
       WHERE id = $6 RETURNING *`,
      [start_time, end_time, break_hours, work_description, edited_by, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Timesheet not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error editing timesheet:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete timesheet
app.delete('/api/timesheets/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM timesheets WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Timesheet not found' });
    }

    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('Error deleting timesheet:', err);
    res.status(500).json({ error: err.message });
  }
});

// Search for specific worker across all tables
app.get('/api/workers/search/:name', async (req, res) => {
  const { name } = req.params;

  try {
    const results = {};

    // Get all tables first
    const tablesResult = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    // Search each table for the worker
    for (const row of tablesResult.rows) {
      const tableName = row.table_name;

      try {
        // Get columns for this table
        const columnsResult = await pool.query(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_name = $1
          AND table_schema = 'public'
          AND (column_name LIKE '%name%' OR data_type LIKE '%char%' OR data_type = 'text')
        `, [tableName]);

        // Search in each text column
        for (const col of columnsResult.rows) {
          const searchQuery = `
            SELECT COUNT(*) as total_count,
                   COUNT(CASE WHEN ${col.column_name} ILIKE $1 THEN 1 END) as matches
            FROM ${tableName}
            WHERE ${col.column_name} IS NOT NULL
          `;

          const searchResult = await pool.query(searchQuery, [`%${name}%`]);

          if (searchResult.rows[0].matches > 0) {
            // Found the worker, now get full data
            const dataQuery = `SELECT * FROM ${tableName} WHERE ${col.column_name} ILIKE $1`;
            const dataResult = await pool.query(dataQuery, [`%${name}%`]);

            // Also get all unique names from this column
            const uniqueQuery = `SELECT DISTINCT ${col.column_name} as name FROM ${tableName} WHERE ${col.column_name} IS NOT NULL ORDER BY ${col.column_name}`;
            const uniqueResult = await pool.query(uniqueQuery);

            if (!results[tableName]) {
              results[tableName] = {
                total_records: searchResult.rows[0].total_count,
                unique_count: uniqueResult.rows.length,
                columns_searched: [],
                matches: [],
                all_names: uniqueResult.rows.map(r => r.name)
              };
            }

            results[tableName].columns_searched.push(col.column_name);
            results[tableName].matches.push(...dataResult.rows);
          }
        }
      } catch (err) {
        // Skip tables that can't be searched
        console.log(`Skipped table ${tableName}: ${err.message}`);
      }
    }

    res.json({
      search_term: name,
      tables_with_matches: results,
      summary: Object.keys(results).map(table => ({
        table,
        total_people: results[table].unique_count,
        has_more_than_15: results[table].unique_count > 15
      }))
    });

  } catch (err) {
    console.error('Error searching for worker:', err);
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint to find all workers across all tables
app.get('/api/workers/debug-all', async (req, res) => {
  try {
    const results = {};

    // Check users table
    try {
      const usersResult = await pool.query('SELECT id, name, role FROM users ORDER BY name');
      results.users = {
        count: usersResult.rows.length,
        data: usersResult.rows
      };
    } catch (err) {
      results.users = { error: err.message };
    }

    // Check workers table if it exists
    try {
      const workersResult = await pool.query('SELECT * FROM workers ORDER BY name');
      results.workers = {
        count: workersResult.rows.length,
        data: workersResult.rows
      };
    } catch (err) {
      results.workers = { error: 'Table does not exist or ' + err.message };
    }

    // Check crew_members table if it exists
    try {
      const crewResult = await pool.query('SELECT * FROM crew_members ORDER BY name');
      results.crew_members = {
        count: crewResult.rows.length,
        data: crewResult.rows
      };
    } catch (err) {
      results.crew_members = { error: 'Table does not exist or ' + err.message };
    }

    // Check worker_signins table if it exists
    try {
      const signinsResult = await pool.query('SELECT DISTINCT worker_name FROM worker_signins ORDER BY worker_name');
      results.worker_signins = {
        count: signinsResult.rows.length,
        unique_workers: signinsResult.rows
      };
    } catch (err) {
      results.worker_signins = { error: 'Table does not exist or ' + err.message };
    }

    // Check attendance table for unique workers
    try {
      const attendanceResult = await pool.query('SELECT DISTINCT worker_name FROM attendance WHERE worker_name IS NOT NULL ORDER BY worker_name');
      results.attendance_workers = {
        count: attendanceResult.rows.length,
        unique_workers: attendanceResult.rows
      };
    } catch (err) {
      results.attendance_workers = { error: err.message };
    }

    // Check timesheets table for unique workers
    try {
      const timesheetsResult = await pool.query('SELECT DISTINCT worker_name FROM timesheets WHERE worker_name IS NOT NULL ORDER BY worker_name');
      results.timesheets_workers = {
        count: timesheetsResult.rows.length,
        unique_workers: timesheetsResult.rows
      };
    } catch (err) {
      results.timesheets_workers = { error: err.message };
    }

    // Check all tables in the database
    try {
      const tablesResult = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      results.all_tables = tablesResult.rows.map(r => r.table_name);
    } catch (err) {
      results.all_tables = { error: err.message };
    }

    res.json(results);
  } catch (err) {
    console.error('Error in debug endpoint:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get attendance for a specific date
app.get('/api/attendance/:date', async (req, res) => {
  const { date } = req.params;

  try {
    // Get all workers from users table (role = 'worker')
    const workersResult = await pool.query(
      `SELECT id, name, role FROM users
       WHERE role = 'worker'
       ORDER BY name`
    );

    // Get all attendance records for the date
    const attendanceResult = await pool.query(
      'SELECT * FROM attendance WHERE date = $1',
      [date]
    );

    console.log(`Found ${attendanceResult.rows.length} attendance records for ${date}`);

    // Create a map of attendance by both worker_id and worker_name
    const attendanceByIdMap = {};
    const attendanceByNameMap = {};

    attendanceResult.rows.forEach(record => {
      if (record.worker_id) {
        attendanceByIdMap[record.worker_id] = record;
      }
      if (record.worker_name) {
        // Store by lowercase name for case-insensitive matching
        attendanceByNameMap[record.worker_name.toLowerCase()] = record;
      }
    });

    // Combine workers with attendance data
    const attendanceData = workersResult.rows.map(worker => {
      // Try to find attendance by ID first, then by name
      const attendanceRecord = attendanceByIdMap[worker.id] ||
                              attendanceByNameMap[worker.name.toLowerCase()];

      return {
        id: worker.id,
        worker_id: worker.id,
        worker_name: worker.name,
        name: worker.name,
        role: worker.role,
        date: date,
        status: attendanceRecord ? attendanceRecord.status : 'absent',
        check_in_time: attendanceRecord?.check_in_time || null,
        check_out_time: attendanceRecord?.check_out_time || null,
        sign_in_latitude: attendanceRecord?.sign_in_latitude || null,
        sign_in_longitude: attendanceRecord?.sign_in_longitude || null,
        sign_in_address: attendanceRecord?.sign_in_address || null,
        sign_out_latitude: attendanceRecord?.sign_out_latitude || null,
        sign_out_longitude: attendanceRecord?.sign_out_longitude || null,
        sign_out_address: attendanceRecord?.sign_out_address || null
      };
    });

    res.json(attendanceData);
  } catch (err) {
    console.error('Error fetching attendance:', err);
    res.status(500).json({ error: err.message });
  }
});

// Toggle attendance status
app.post('/api/attendance/toggle', async (req, res) => {
  const { userId, userName, date } = req.body;

  try {
    // Check if attendance record exists
    const existingResult = await pool.query(
      'SELECT * FROM attendance WHERE worker_name = $1 AND date = $2',
      [userName, date]
    );

    if (existingResult.rows.length > 0) {
      // Toggle status
      const currentStatus = existingResult.rows[0].status;
      const newStatus = currentStatus === 'present' ? 'absent' : 'present';

      const result = await pool.query(
        'UPDATE attendance SET status = $1, updated_at = NOW() WHERE worker_name = $2 AND date = $3 RETURNING *',
        [newStatus, userName, date]
      );
      res.json(result.rows[0]);
    } else {
      // Create new record as present
      const result = await pool.query(
        'INSERT INTO attendance (worker_name, date, status, check_in_time) VALUES ($1, $2, $3, CURRENT_TIME) RETURNING *',
        [userName, date, 'present']
      );
      res.json(result.rows[0]);
    }
  } catch (err) {
    console.error('Error toggling attendance:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all workers for debugging
app.get('/api/workers/all', async (req, res) => {
  try {
    // Get all users and workers to see what we have
    const usersResult = await pool.query(
      'SELECT id, name, role FROM users ORDER BY name'
    );

    let workersResult = { rows: [] };
    try {
      workersResult = await pool.query(
        'SELECT id, name, role FROM workers ORDER BY name'
      );
    } catch (err) {
      // Workers table might not exist
    }

    res.json({
      users_table: usersResult.rows,
      users_count: usersResult.rows.length,
      workers_table: workersResult.rows,
      workers_count: workersResult.rows.length
    });
  } catch (err) {
    console.error('Error fetching all workers:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get attendance location data for a specific date
app.get('/api/attendance-location/:date', async (req, res) => {
  const { date } = req.params;

  try {
    // Get all workers first
    const workersResult = await pool.query(
      `SELECT id, name, role FROM users
       WHERE role = 'worker'
       ORDER BY name`
    );

    // Get attendance records with location data
    const attendanceResult = await pool.query(
      'SELECT * FROM attendance WHERE date = $1',
      [date]
    );

    console.log(`GPS Attendance: Found ${attendanceResult.rows.length} records for ${date}`);

    // Create maps for matching
    const attendanceByIdMap = {};
    const attendanceByNameMap = {};

    attendanceResult.rows.forEach(record => {
      if (record.worker_id) {
        attendanceByIdMap[record.worker_id] = record;
      }
      if (record.worker_name) {
        attendanceByNameMap[record.worker_name.toLowerCase()] = record;
      }
    });

    // Build complete attendance list with GPS data
    const attendanceData = workersResult.rows.map(worker => {
      const record = attendanceByIdMap[worker.id] ||
                    attendanceByNameMap[worker.name.toLowerCase()];

      return {
        id: record?.id || worker.id,
        worker_id: worker.id,
        worker_name: worker.name,
        date: date,
        status: record ? record.status : 'absent',
        check_in_time: record?.check_in_time || null,
        check_out_time: record?.check_out_time || null,
        sign_in_latitude: record?.sign_in_latitude || null,
        sign_in_longitude: record?.sign_in_longitude || null,
        sign_in_address: record?.sign_in_address || null,
        sign_out_latitude: record?.sign_out_latitude || null,
        sign_out_longitude: record?.sign_out_longitude || null,
        sign_out_address: record?.sign_out_address || null
      };
    });

    res.json(attendanceData);
  } catch (err) {
    console.error('Error fetching attendance location:', err);
    res.json([]);
  }
});

// Fix missing attendance records
app.post('/api/fix-attendance', async (req, res) => {
  const { date } = req.body;
  const targetDate = date || getEasternDate();

  try {
    // Get all worker sign-ins for the date
    const signins = await pool.query(
      'SELECT DISTINCT worker_name FROM worker_signins WHERE signin_date = $1',
      [targetDate]
    );

    console.log(`Found ${signins.rows.length} unique workers signed in on ${targetDate}`);

    let created = 0;
    let updated = 0;

    for (const signin of signins.rows) {
      const workerName = signin.worker_name;

      // Get worker ID from users table
      const userResult = await pool.query(
        'SELECT id FROM users WHERE LOWER(name) = LOWER($1)',
        [workerName]
      );

      const workerId = userResult.rows.length > 0 ? userResult.rows[0].id : null;

      // Check if attendance exists
      const existingAttendance = await pool.query(
        'SELECT id FROM attendance WHERE LOWER(worker_name) = LOWER($1) AND date = $2',
        [workerName, targetDate]
      );

      if (existingAttendance.rows.length === 0) {
        // Create attendance record with worker_name only
        await pool.query(
          `INSERT INTO attendance (worker_name, date, status, check_in_time)
           VALUES ($1, $2, 'present', NOW())`,
          [workerName, targetDate]
        );
        created++;
        console.log(`Created attendance for ${workerName}`);
      } else {
        // Update to ensure status is present
        await pool.query(
          `UPDATE attendance SET status = 'present'
           WHERE LOWER(worker_name) = LOWER($1) AND date = $2`,
          [workerName, targetDate]
        );
        updated++;
      }
    }

    res.json({
      success: true,
      date: targetDate,
      signinsFound: signins.rows.length,
      attendanceCreated: created,
      attendanceUpdated: updated
    });
  } catch (err) {
    console.error('Error fixing attendance:', err);
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

// Fix Vitor Esteves specifically
app.post('/api/fix-vitor', async (req, res) => {
  try {
    // Update Vitor's sign-in to Sep 15
    const signinsResult = await pool.query(
      "UPDATE worker_signins SET signin_date = '2025-09-15' WHERE worker_name = 'Vitor Esteves' AND signin_date = '2025-09-16' RETURNING *"
    );

    // Update Vitor's attendance to Sep 15
    const attendanceResult = await pool.query(
      "UPDATE attendance SET date = '2025-09-15' WHERE worker_name = 'Vitor Esteves' AND date = '2025-09-16' RETURNING *"
    );

    res.json({
      success: true,
      fixed: {
        signins: signinsResult.rowCount,
        attendance: attendanceResult.rowCount,
        records: signinsResult.rows
      }
    });
  } catch (err) {
    console.error('Fix Vitor error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Auto sign-out workers at midnight
app.post('/api/auto-signout', async (req, res) => {
  try {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    // Sign out all workers who are still signed in from yesterday
    const result = await pool.query(
      `UPDATE worker_signins
       SET signout_time = $1
       WHERE signin_date = $2 AND signout_time IS NULL
       RETURNING worker_name, project_name`,
      ['23:59:59', yesterdayStr]
    );

    // Also update attendance records
    await pool.query(
      `UPDATE attendance
       SET check_out_time = $1
       WHERE date = $2 AND check_out_time IS NULL`,
      [yesterday.toISOString().replace('T', ' ').split('.')[0] + ' 23:59:59', yesterdayStr]
    );

    console.log(`Auto signed-out ${result.rows.length} workers at midnight`);
    res.json({
      success: true,
      signedOut: result.rows.length,
      workers: result.rows
    });
  } catch (err) {
    console.error('Error in auto sign-out:', err);
    res.status(500).json({ error: err.message });
  }
});

// Manual sign-out endpoint for specific worker
app.post('/api/worker/signout', async (req, res) => {
  const { workerName, projectName } = req.body;
  const today = getEasternDate();

  try {
    // Update worker sign-in record
    const result = await pool.query(
      `UPDATE worker_signins
       SET signout_time = NOW()
       WHERE LOWER(worker_name) = LOWER($1)
       AND signin_date = $2
       AND signout_time IS NULL
       RETURNING id`,
      [workerName, today]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No active sign-in found' });
    }

    // Update attendance record
    await pool.query(
      `UPDATE attendance
       SET check_out_time = NOW()
       WHERE LOWER(worker_name) = LOWER($1)
       AND date = $2`,
      [workerName, today]
    );

    res.json({ success: true, message: 'Successfully signed out' });
  } catch (err) {
    console.error('Error signing out worker:', err);
    res.status(500).json({ error: err.message });
  }
});

// Add specific missing users (Augusto Duarte and Armando Hernandez)
app.post('/api/add-missing-users', async (req, res) => {
  try {
    // Add the two missing users
    const users = [
      { name: 'Augusto Duarte', email: 'augusto@mjr.com', pin: '1111', role: 'worker' },
      { name: 'Armando Hernandez', email: 'armando@mjr.com', pin: '1111', role: 'worker' }
    ];

    const results = [];
    for (const user of users) {
      try {
        // Try to insert, or update if email already exists
        const result = await pool.query(
          `INSERT INTO users (name, email, pin, role) VALUES ($1, $2, $3, $4)
           ON CONFLICT (email) DO UPDATE
           SET name = EXCLUDED.name, pin = EXCLUDED.pin, role = EXCLUDED.role
           RETURNING *`,
          [user.name, user.email, user.pin, user.role]
        );
        results.push({
          action: 'added',
          user: result.rows[0]
        });
      } catch (userErr) {
        results.push({
          action: 'error',
          user: user.name,
          error: userErr.message
        });
      }
    }

    // Verify the users were added
    const verifyResult = await pool.query(
      "SELECT id, name, email, role FROM users WHERE name IN ('Augusto Duarte', 'Armando Hernandez') ORDER BY name"
    );

    res.json({
      success: true,
      message: 'Missing users addition process completed',
      results: results,
      verified_users: verifyResult.rows
    });
  } catch (err) {
    console.error('Error adding missing users:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// WORK AREAS MANAGEMENT ENDPOINTS
// ============================================

// Get all work areas
app.get('/api/work-areas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        wa.*,
        COUNT(DISTINCT awa.worker_id) as assigned_workers_count,
        COALESCE(json_agg(DISTINCT
          jsonb_build_object(
            'id', u.id,
            'name', u.name,
            'role', u.role
          )
        ) FILTER (WHERE u.id IS NOT NULL), '[]'::json) as assigned_workers,
        COUNT(DISTINCT ap.id) as photos_count,
        COUNT(DISTINCT ad.id) as documents_count
      FROM work_areas wa
      LEFT JOIN area_worker_assignments awa
        ON wa.id = awa.work_area_id
        AND awa.assignment_date = CURRENT_DATE
      LEFT JOIN users u
        ON awa.worker_id = u.id
      LEFT JOIN area_photos ap
        ON wa.id = ap.work_area_id
      LEFT JOIN area_documents ad
        ON wa.id = ad.work_area_id
      GROUP BY wa.id
      ORDER BY wa.created_at DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching work areas:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get single work area with details
app.get('/api/work-areas/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const areaResult = await pool.query(
      'SELECT * FROM work_areas WHERE id = $1',
      [id]
    );

    if (areaResult.rows.length === 0) {
      return res.status(404).json({ error: 'Work area not found' });
    }

    const area = areaResult.rows[0];

    // Get assigned workers
    const workersResult = await pool.query(`
      SELECT awa.*, u.name, u.role
      FROM area_worker_assignments awa
      JOIN users u ON awa.worker_id = u.id
      WHERE awa.work_area_id = $1 AND awa.assignment_date = CURRENT_DATE
    `, [id]);

    // Get documents
    const docsResult = await pool.query(
      'SELECT * FROM area_documents WHERE work_area_id = $1 ORDER BY uploaded_at DESC',
      [id]
    );

    // Get photos
    const photosResult = await pool.query(
      'SELECT * FROM area_photos WHERE work_area_id = $1 ORDER BY taken_at DESC LIMIT 50',
      [id]
    );

    // Get daily activities
    const activitiesResult = await pool.query(
      'SELECT * FROM daily_activities WHERE work_area_id = $1 ORDER BY activity_date DESC LIMIT 30',
      [id]
    );

    res.json({
      ...area,
      assignedWorkers: workersResult.rows,
      documents: docsResult.rows,
      photos: photosResult.rows,
      dailyActivities: activitiesResult.rows
    });
  } catch (err) {
    console.error('Error fetching work area:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create new work area
app.post('/api/work-areas', async (req, res) => {
  const { name, description, location, startDate, currentStage, status, projectId } = req.body;

  try {
    const result = await pool.query(`
      INSERT INTO work_areas
      (name, description, location, start_date, current_stage, status, project_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [name, description, location, startDate, currentStage || 'initial_layout', status || 'active', projectId]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error creating work area:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update work area stage
app.put('/api/work-areas/:id/stage', async (req, res) => {
  const { id } = req.params;
  const { stage } = req.body;

  try {
    // Update stage
    let result = await pool.query(`
      UPDATE work_areas
      SET current_stage = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [stage, id]);

    // If stage is 'stripping', mark as finished
    if (stage === 'stripping') {
      result = await pool.query(`
        UPDATE work_areas
        SET status = 'finished', end_date = CURRENT_DATE, updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [id]);
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating stage:', err);
    res.status(500).json({ error: err.message });
  }
});

// Assign workers to area
app.post('/api/work-areas/:id/assign-workers', async (req, res) => {
  const { id } = req.params;
  const { workerIds, date } = req.body;
  const assignmentDate = date || getEasternDate();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Remove existing assignments for this date
    await client.query(
      'DELETE FROM area_worker_assignments WHERE work_area_id = $1 AND assignment_date = $2',
      [id, assignmentDate]
    );

    // Add new assignments
    for (const workerId of workerIds) {
      // Get worker details
      const workerResult = await client.query(
        'SELECT name, role FROM users WHERE id = $1',
        [workerId]
      );

      if (workerResult.rows.length > 0) {
        const worker = workerResult.rows[0];
        await client.query(`
          INSERT INTO area_worker_assignments
          (work_area_id, worker_id, worker_name, assignment_date, role)
          VALUES ($1, $2, $3, $4, $5)
        `, [id, workerId, worker.name, assignmentDate, worker.role]);
      }
    }

    await client.query('COMMIT');

    // Get updated assignments
    const result = await client.query(`
      SELECT awa.*, u.name, u.role
      FROM area_worker_assignments awa
      JOIN users u ON awa.worker_id = u.id
      WHERE awa.work_area_id = $1 AND awa.assignment_date = $2
    `, [id, assignmentDate]);

    res.json(result.rows);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error assigning workers:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Upload photo for work area
app.post('/api/work-areas/:id/photos', async (req, res) => {
  const { id } = req.params;
  const { photoUrl, thumbnailUrl, caption, takenBy, latitude, longitude, locationAddress, dailyActivityId } = req.body;

  try {
    const result = await pool.query(`
      INSERT INTO area_photos
      (work_area_id, photo_url, thumbnail_url, caption, taken_by_name,
       latitude, longitude, location_address, daily_activity_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [id, photoUrl, thumbnailUrl, caption, takenBy, latitude, longitude, locationAddress, dailyActivityId]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error saving photo:', err);
    res.status(500).json({ error: err.message });
  }
});

// Upload document for work area
app.post('/api/work-areas/:id/documents', async (req, res) => {
  const { id } = req.params;
  const { documentType, name, fileUrl, fileSize, fileType, uploadedBy, description } = req.body;

  try {
    const result = await pool.query(`
      INSERT INTO area_documents
      (work_area_id, document_type, name, file_url, file_size, file_type,
       uploaded_by_name, description)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [id, documentType, name, fileUrl, fileSize, fileType, uploadedBy, description]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error saving document:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create or update daily activity
app.post('/api/work-areas/:id/daily-activity', async (req, res) => {
  const { id } = req.params;
  const { activityDate, stage, description, weather, temperature, notes, createdBy } = req.body;
  const date = activityDate || getEasternDate();

  try {
    const result = await pool.query(`
      INSERT INTO daily_activities
      (work_area_id, activity_date, stage, description, weather, temperature, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (work_area_id, activity_date)
      DO UPDATE SET
        stage = EXCLUDED.stage,
        description = EXCLUDED.description,
        weather = EXCLUDED.weather,
        temperature = EXCLUDED.temperature,
        notes = EXCLUDED.notes
      RETURNING *
    `, [id, date, stage, description, weather, temperature, notes, createdBy]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error saving daily activity:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get signed-in workers (for assignment dropdown)
app.get('/api/workers/signed-in', async (req, res) => {
  const today = getEasternDate();

  try {
    const result = await pool.query(`
      SELECT DISTINCT u.id, u.name, u.role
      FROM users u
      JOIN worker_signins ws ON LOWER(u.name) = LOWER(ws.worker_name)
      WHERE ws.signin_date = $1 AND ws.signout_time IS NULL
      ORDER BY u.name
    `, [today]);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching signed-in workers:', err);
    res.status(500).json({ error: err.message });
  }
});

// Export for Vercel
module.exports = app;