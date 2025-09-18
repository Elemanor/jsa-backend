require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { generatePresignedUrl, uploadToS3 } = require('./s3-upload');

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
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin"],
  preflightContinue: false,
  optionsSuccessStatus: 200
}));
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Add Gustavo Mendez to workers if not exists
app.get('/api/workers/init-gustavo', async (req, res) => {
  try {
    // Check if Gustavo already exists
    const check = await pool.query(
      "SELECT id FROM users WHERE LOWER(name) = LOWER('Gustavo Mendez')"
    );

    if (check.rows.length === 0) {
      // Add Gustavo Mendez
      await pool.query(
        "INSERT INTO users (name, role) VALUES ($1, $2)",
        ['Gustavo Mendez', 'worker']
      );
      res.json({ message: 'Gustavo Mendez added successfully' });
    } else {
      res.json({ message: 'Gustavo Mendez already exists' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add David Peniche to workers if not exists
app.get('/api/workers/init-david', async (req, res) => {
  try {
    // Check if David Peniche already exists
    const check = await pool.query(
      "SELECT id FROM users WHERE LOWER(name) = LOWER('David Peniche')"
    );

    if (check.rows.length === 0) {
      // Add David Peniche with PIN
      await pool.query(
        "INSERT INTO users (name, role, pin) VALUES ($1, $2, $3)",
        ['David Peniche', 'worker', '1234']
      );
      res.json({ message: 'David Peniche added successfully' });
    } else {
      res.json({ message: 'David Peniche already exists' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add Mota Marques to workers if not exists
app.get('/api/workers/init-mota', async (req, res) => {
  try {
    // Check if Mota Marques already exists
    const check = await pool.query(
      "SELECT id FROM users WHERE LOWER(name) = LOWER('Mota Marques')"
    );

    if (check.rows.length === 0) {
      // Add Mota Marques with PIN
      await pool.query(
        "INSERT INTO users (name, role, pin) VALUES ($1, $2, $3)",
        ['Mota Marques', 'worker', '1111']
      );
      res.json({ message: 'Mota Marques added successfully' });
    } else {
      // Update PIN for existing Mota Marques
      await pool.query(
        "UPDATE users SET pin = $1 WHERE LOWER(name) = LOWER('Mota Marques')",
        ['1111']
      );
      res.json({ message: 'Mota Marques PIN updated' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  // Support both workerName and worker_name for backward compatibility
  const workerName = req.body.workerName || req.body.worker_name;
  const projectId = req.body.projectId || req.body.project_id;
  const projectName = req.body.projectName || req.body.project_name;
  const siteAddress = req.body.siteAddress || req.body.site_address;
  const signatureImage = req.body.signature_image || req.body.signatureImage;
  const { latitude, longitude, address } = req.body;

  const signinDate = getEasternDate();

  console.log('Worker sign-in attempt:', { workerName, projectName, hasLocation: !!(latitude && longitude), hasSignature: !!signatureImage });

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

    // Add location columns if they don't exist
    await pool.query(`
      ALTER TABLE worker_signins
      ADD COLUMN IF NOT EXISTS signin_latitude DECIMAL(10, 8),
      ADD COLUMN IF NOT EXISTS signin_longitude DECIMAL(11, 8),
      ADD COLUMN IF NOT EXISTS signin_address TEXT
    `).catch(() => {});

    // Use the correctly capitalized name for the insert
    const result = await pool.query(
      'INSERT INTO worker_signins (worker_name, project_id, project_name, site_address, signin_date, signin_latitude, signin_longitude, signin_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [actualWorkerName, projectId, projectName, siteAddress, signinDate, latitude || null, longitude || null, address || null]
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
    // Calculate week number (Sunday-based week)
    const timesheetDate = new Date(date);
    const startOfYear = new Date(timesheetDate.getFullYear(), 0, 1);
    const startOfYearDay = startOfYear.getDay();

    // Find the first Sunday of the year
    const daysToFirstSunday = startOfYearDay === 0 ? 0 : 7 - startOfYearDay;
    const firstSunday = new Date(startOfYear.getTime() + daysToFirstSunday * 86400000);

    // Calculate weeks from first Sunday
    const diffDays = Math.floor((timesheetDate.getTime() - firstSunday.getTime()) / 86400000);
    const weekNumber = Math.max(1, Math.floor(diffDays / 7) + 1);

    // First ensure the week_number column exists
    await pool.query(`
      ALTER TABLE timesheets
      ADD COLUMN IF NOT EXISTS week_number INTEGER
    `).catch(() => {
      // Column might already exist, ignore error
    });

    // Calculate regular and overtime hours
    const regularHours = Math.min(total_hours, 8);
    const overtimeHours = Math.max(total_hours - 8, 0);

    const result = await pool.query(
      'INSERT INTO timesheets (worker_id, worker_name, date, project_name, start_time, end_time, break_duration, total_hours, regular_hours, overtime_hours, notes, week_number) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *',
      [worker_id, worker_name, date, project_name, start_time, end_time, break_duration || 0, total_hours, regularHours, overtimeHours, notes || '', weekNumber]
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

// Mark concrete delivery as complete with actual data
app.put('/api/concrete-deliveries/:id/complete', async (req, res) => {
  const { id } = req.params;
  const { actual_volume, actual_hours, supervisor, status } = req.body;

  try {
    // First, add columns if they don't exist
    await pool.query(`
      ALTER TABLE concrete_deliveries
      ADD COLUMN IF NOT EXISTS actual_volume DECIMAL(10,2),
      ADD COLUMN IF NOT EXISTS actual_hours DECIMAL(10,2),
      ADD COLUMN IF NOT EXISTS supervisor VARCHAR(255)
    `);

    // Update the delivery with actual data
    const result = await pool.query(
      `UPDATE concrete_deliveries
       SET status = $1, actual_volume = $2, actual_hours = $3, supervisor = $4
       WHERE id = $5
       RETURNING *`,
      [status || 'delivered', actual_volume, actual_hours, supervisor, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Delivery not found' });
    } else {
      // Also create or update a concrete pour record for tracking
      const delivery = result.rows[0];

      // Check if a pour record exists for this delivery
      const pourCheck = await pool.query(
        `SELECT id FROM concrete_pours
         WHERE DATE(pour_date) = DATE($1)
         AND project_name = $2
         AND area = $3`,
        [delivery.delivery_date, delivery.project_name, delivery.area]
      );

      if (pourCheck.rows.length > 0) {
        // Update existing pour record
        await pool.query(
          `UPDATE concrete_pours
           SET actual_volume = COALESCE(actual_volume, 0) + $1,
               actual_end = NOW(),
               supervisor = $2,
               status = 'completed'
           WHERE id = $3`,
          [actual_volume, supervisor, pourCheck.rows[0].id]
        );
      } else {
        // Create new pour record
        await pool.query(
          `INSERT INTO concrete_pours
           (project_name, pour_date, area, planned_volume, actual_volume,
            planned_start, planned_end, actual_start, actual_end,
            concrete_type, supplier, supervisor, status)
           VALUES ($1, $2, $3, $4, $5, $6, $6, NOW(), NOW(), $7, 'Local Supplier', $8, 'completed')`,
          [
            delivery.project_name,
            delivery.delivery_date,
            delivery.area,
            delivery.quantity,
            actual_volume,
            delivery.delivery_time ? `${delivery.delivery_date} ${delivery.delivery_time}` : delivery.delivery_date,
            delivery.concrete_type,
            supervisor
          ]
        );
      }

      res.json(result.rows[0]);
    }
  } catch (err) {
    console.error('Error marking delivery complete:', err);
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
    // First ensure the week_number column exists and update existing records
    await pool.query(`
      ALTER TABLE timesheets
      ADD COLUMN IF NOT EXISTS week_number INTEGER
    `).catch(() => {
      // Column might already exist, ignore error
    });

    // Add regular_hours and overtime_hours columns if they don't exist
    await pool.query(`
      ALTER TABLE timesheets
      ADD COLUMN IF NOT EXISTS regular_hours DECIMAL(5,2),
      ADD COLUMN IF NOT EXISTS overtime_hours DECIMAL(5,2)
    `).catch(() => {
      // Columns might already exist, ignore error
    });

    // Update existing timesheets to have week_number if they don't
    await pool.query(`
      UPDATE timesheets
      SET week_number = (
        CASE
          WHEN EXTRACT(DOW FROM date) = 0 THEN
            EXTRACT(WEEK FROM date - INTERVAL '1 day')
          ELSE
            EXTRACT(WEEK FROM date)
        END
      )::INTEGER
      WHERE week_number IS NULL
    `).catch(err => {
      console.error('Error updating week_numbers:', err);
    });

    // Calculate regular and overtime hours for existing records
    await pool.query(`
      UPDATE timesheets
      SET
        regular_hours = LEAST(total_hours, 8),
        overtime_hours = GREATEST(total_hours - 8, 0)
      WHERE regular_hours IS NULL OR overtime_hours IS NULL
    `).catch(err => {
      console.error('Error calculating hours:', err);
    });

    let query = 'SELECT *, COALESCE(regular_hours, LEAST(total_hours, 8)) as regular_hours, COALESCE(overtime_hours, GREATEST(total_hours - 8, 0)) as overtime_hours FROM timesheets WHERE 1=1';
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

    if (week && year) {
      // Calculate the date range for the week
      const startOfYear = new Date(parseInt(year), 0, 1);
      const startOfYearDay = startOfYear.getDay();
      const daysToFirstSunday = startOfYearDay === 0 ? 0 : 7 - startOfYearDay;
      const firstSunday = new Date(startOfYear.getTime() + daysToFirstSunday * 86400000);

      const weekStart = new Date(firstSunday.getTime() + (parseInt(week) - 1) * 7 * 86400000);
      const weekEnd = new Date(weekStart.getTime() + 6 * 86400000);

      query += ` AND date >= $${paramIndex++} AND date <= $${paramIndex++}`;
      params.push(weekStart.toISOString().split('T')[0], weekEnd.toISOString().split('T')[0]);
    } else if (year) {
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
    // Calculate the date range for the week
    const startOfYear = new Date(parseInt(year), 0, 1);
    const startOfYearDay = startOfYear.getDay();
    const daysToFirstSunday = startOfYearDay === 0 ? 0 : 7 - startOfYearDay;
    const firstSunday = new Date(startOfYear.getTime() + daysToFirstSunday * 86400000);

    const weekStart = new Date(firstSunday.getTime() + (parseInt(week) - 1) * 7 * 86400000);
    const weekEnd = new Date(weekStart.getTime() + 6 * 86400000);

    const result = await pool.query(
      `SELECT
        worker_id,
        worker_name,
        SUM(COALESCE(regular_hours, LEAST(total_hours, 8))) as total_regular_hours,
        SUM(COALESCE(overtime_hours, GREATEST(total_hours - 8, 0))) as total_overtime_hours,
        SUM(total_hours) as total_hours,
        COUNT(*) as days_worked
      FROM timesheets
      WHERE date >= $1 AND date <= $2
      GROUP BY worker_id, worker_name
      ORDER BY worker_name`,
      [weekStart.toISOString().split('T')[0], weekEnd.toISOString().split('T')[0]]
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

// Get worker signin status
app.get('/api/worker/signin-status/:workerId', async (req, res) => {
  const { workerId } = req.params;
  const today = getEasternDate();

  try {
    // Check if worker is currently signed in
    const result = await pool.query(
      `SELECT ws.*, u.name as worker_name
       FROM worker_signins ws
       LEFT JOIN users u ON u.id = $1
       WHERE (ws.worker_name = u.name OR ws.worker_name = $1)
       AND ws.signin_date = $2
       AND ws.signout_time IS NULL
       ORDER BY ws.signin_time DESC
       LIMIT 1`,
      [workerId, today]
    );

    if (result.rows.length > 0) {
      res.json({
        signed_in: true,
        signin_time: result.rows[0].signin_time,
        project_name: result.rows[0].project_name,
        site_address: result.rows[0].site_address
      });
    } else {
      res.json({ signed_in: false });
    }
  } catch (err) {
    console.error('Error checking signin status:', err);
    res.json({ signed_in: false });
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
    // Ensure foreman_in_charge column exists
    await pool.query(`
      ALTER TABLE work_areas
      ADD COLUMN IF NOT EXISTS foreman_in_charge VARCHAR(255)
    `).catch(() => {});

    const result = await pool.query(`
      SELECT
        wa.*,
        p.name as project_name,
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
      LEFT JOIN projects p
        ON wa.project_id = p.id
      LEFT JOIN area_worker_assignments awa
        ON wa.id = awa.work_area_id
        AND awa.assignment_date = CURRENT_DATE
      LEFT JOIN users u
        ON awa.worker_id = u.id
      LEFT JOIN area_photos ap
        ON wa.id = ap.work_area_id
      LEFT JOIN area_documents ad
        ON wa.id = ad.work_area_id
      GROUP BY wa.id, p.name
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

  // Validate work area ID
  if (!id || id === 'undefined' || id === 'null') {
    return res.status(400).json({ error: 'Valid work area ID is required' });
  }

  try {
    // Ensure foreman_in_charge column exists
    await pool.query(`
      ALTER TABLE work_areas
      ADD COLUMN IF NOT EXISTS foreman_in_charge VARCHAR(255)
    `).catch(() => {});

    const areaResult = await pool.query(`
      SELECT wa.*, p.name as project_name
      FROM work_areas wa
      LEFT JOIN projects p ON wa.project_id = p.id
      WHERE wa.id = $1
    `, [id]);

    if (areaResult.rows.length === 0) {
      return res.status(404).json({ error: 'Work area not found' });
    }

    const area = areaResult.rows[0];

    // Get assigned workers (get the latest assignment, not just today)
    const workersResult = await pool.query(`
      SELECT DISTINCT ON (u.id) awa.*, u.name, u.role, u.id
      FROM area_worker_assignments awa
      JOIN users u ON awa.worker_id = u.id
      WHERE awa.work_area_id = $1
      ORDER BY u.id, awa.assignment_date DESC
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
      assigned_workers: workersResult.rows.map(w => ({
        id: w.id,
        name: w.name,
        role: w.role
      })),
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
  const { name, description, location, startDate, currentStage, status, projectId, plannedConcreteVolume, foremanInCharge } = req.body;

  try {
    // First, ensure the foreman_in_charge column exists
    await pool.query(`
      ALTER TABLE work_areas
      ADD COLUMN IF NOT EXISTS foreman_in_charge VARCHAR(255)
    `).catch(() => {});

    const result = await pool.query(`
      INSERT INTO work_areas
      (name, description, location, start_date, current_stage, status, project_id, planned_concrete_volume, foreman_in_charge)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [name, description, location, startDate, currentStage || 'initial_layout', status || 'active', projectId, plannedConcreteVolume || 0, foremanInCharge || 'N/A']);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error creating work area:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update work area
app.patch('/api/work-areas/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  try {
    // First, ensure the foreman_in_charge column exists if we're updating it
    if (updates.foremanInCharge !== undefined) {
      await pool.query(`
        ALTER TABLE work_areas
        ADD COLUMN IF NOT EXISTS foreman_in_charge VARCHAR(255)
      `).catch(() => {});
    }

    // Build dynamic update query
    const updateFields = [];
    const values = [];
    let paramIndex = 1;

    Object.keys(updates).forEach(key => {
      // Convert camelCase to snake_case
      const dbKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      updateFields.push(`${dbKey} = $${paramIndex}`);
      values.push(updates[key]);
      paramIndex++;
    });

    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    values.push(id);

    const result = await pool.query(`
      UPDATE work_areas
      SET ${updateFields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Work area not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating work area:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete work area
app.delete('/api/work-areas/:id', async (req, res) => {
  const { id } = req.params;

  // Validate work area ID
  if (!id || id === 'undefined' || id === 'null') {
    return res.status(400).json({ error: 'Valid work area ID is required' });
  }

  try {
    // This will cascade delete all related records (photos, documents, activities, assignments)
    const result = await pool.query(
      'DELETE FROM work_areas WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Work area not found' });
    }

    res.json({ message: 'Work area deleted successfully', deleted: result.rows[0] });
  } catch (err) {
    console.error('Error deleting work area:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update work area stage
app.put('/api/work-areas/:id/stage', async (req, res) => {
  const { id } = req.params;
  const { stage } = req.body;

  // Validate work area ID
  if (!id || id === 'undefined' || id === 'null') {
    return res.status(400).json({ error: 'Valid work area ID is required' });
  }

  // Validate stage
  if (!stage) {
    return res.status(400).json({ error: 'Stage is required' });
  }

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

  // Validate work area ID
  if (!id || id === 'undefined' || id === 'null') {
    return res.status(400).json({ error: 'Valid work area ID is required' });
  }

  // Validate worker IDs
  if (!workerIds || !Array.isArray(workerIds)) {
    return res.status(400).json({ error: 'Worker IDs array is required' });
  }

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

// Note: Server-side upload removed in favor of presigned URLs for better performance and reliability

// Generate presigned URL for general photo uploads
app.post('/api/photos/presigned-url', async (req, res) => {
  const { fileName, fileType } = req.body;

  if (!fileName || !fileType) {
    return res.status(400).json({ error: 'File name and file type are required' });
  }

  try {
    const result = await generatePresignedUrl(fileName, fileType, 'general');
    res.json(result);
  } catch (err) {
    console.error('Error generating presigned URL:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get presigned URL for direct upload from browser
app.post('/api/work-areas/:id/photos/presigned-url', async (req, res) => {
  const { id } = req.params;
  const { fileName, fileType } = req.body;

  if (!id || !fileName || !fileType) {
    return res.status(400).json({ error: 'Work area ID, file name and file type are required' });
  }

  try {
    const result = await generatePresignedUrl(fileName, fileType, `work-areas/${id}`);
    res.json(result);
  } catch (err) {
    console.error('Error generating presigned URL:', err);
    res.status(500).json({ error: err.message });
  }
});

// Original endpoint for backward compatibility (accepts base64)
app.post('/api/work-areas/:id/photos', async (req, res) => {
  const { id } = req.params;
  const { photoUrl, thumbnailUrl, caption, takenBy, latitude, longitude, locationAddress, dailyActivityId } = req.body;

  // Validate work area ID
  if (!id || id === 'undefined' || id === 'null') {
    return res.status(400).json({ error: 'Valid work area ID is required' });
  }

  try {
    // First check if work area exists
    const workAreaCheck = await pool.query('SELECT id FROM work_areas WHERE id = $1', [id]);
    if (workAreaCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Work area not found' });
    }

    const result = await pool.query(`
      INSERT INTO area_photos
      (work_area_id, photo_url, thumbnail_url, caption, taken_by_name,
       latitude, longitude, location_address, daily_activity_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [id, photoUrl, thumbnailUrl, caption, takenBy, latitude, longitude, locationAddress, dailyActivityId]);

    // Set explicit CORS headers for this response
    res.header('Access-Control-Allow-Origin', req.headers.origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');

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

  // Validate work area ID
  if (!id || id === 'undefined' || id === 'null') {
    return res.status(400).json({ error: 'Valid work area ID is required' });
  }

  // Validate required fields
  if (!fileUrl || !name) {
    return res.status(400).json({ error: 'File URL and name are required' });
  }

  try {
    // First check if work area exists
    const workAreaCheck = await pool.query('SELECT id FROM work_areas WHERE id = $1', [id]);
    if (workAreaCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Work area not found' });
    }
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

// Get daily activity for a specific date
app.get('/api/work-areas/:id/daily-activity', async (req, res) => {
  const { id } = req.params;
  const { date } = req.query;
  const activityDate = date || getEasternDate();

  // Validate work area ID
  if (!id || id === 'undefined' || id === 'null') {
    return res.status(400).json({ error: 'Valid work area ID is required' });
  }

  try {
    // First check if work area exists
    const workAreaCheck = await pool.query('SELECT id FROM work_areas WHERE id = $1', [id]);
    if (workAreaCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Work area not found' });
    }

    const result = await pool.query(`
      SELECT da.*,
        COALESCE(json_agg(DISTINCT
          jsonb_build_object(
            'id', ap.id,
            'url', ap.photo_url,
            'thumbnailUrl', ap.thumbnail_url,
            'caption', ap.caption,
            'takenAt', ap.taken_at
          )
        ) FILTER (WHERE ap.id IS NOT NULL), '[]'::json) as photos
      FROM daily_activities da
      LEFT JOIN area_photos ap
        ON da.work_area_id = ap.work_area_id
        AND DATE(ap.taken_at) = da.activity_date
      WHERE da.work_area_id = $1 AND da.activity_date = $2
      GROUP BY da.id
    `, [id, activityDate]);

    if (result.rows.length === 0) {
      // Return empty activity data instead of 404 - this allows frontend to handle gracefully
      return res.json({
        work_area_id: parseInt(id),
        activity_date: activityDate,
        stage: null,
        description: null,
        weather: null,
        temperature: null,
        notes: null,
        photos: []
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching daily activity:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create or update daily activity
app.post('/api/work-areas/:id/daily-activity', async (req, res) => {
  const { id } = req.params;
  const { activityDate, stage, description, weather, temperature, notes, createdBy } = req.body;
  const date = activityDate || getEasternDate();

  // Validate work area ID
  if (!id || id === 'undefined' || id === 'null') {
    return res.status(400).json({ error: 'Valid work area ID is required' });
  }

  try {
    // First check if work area exists
    const workAreaCheck = await pool.query('SELECT id FROM work_areas WHERE id = $1', [id]);
    if (workAreaCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Work area not found' });
    }
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
  const { date } = req.query;
  const targetDate = date || getEasternDate();

  try {
    const result = await pool.query(`
      SELECT DISTINCT u.id, u.name, u.role, ws.signin_time as "signInTime"
      FROM users u
      JOIN worker_signins ws ON LOWER(u.name) = LOWER(ws.worker_name)
      WHERE ws.signin_date = $1 AND ws.signout_time IS NULL
      ORDER BY u.name
    `, [targetDate]);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching signed-in workers:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get workers signed into a specific project
app.get('/api/projects/:projectId/signed-in-workers', async (req, res) => {
  const { projectId } = req.params;
  const today = getEasternDate();

  // Validate projectId
  if (!projectId || projectId === 'undefined' || projectId === 'null') {
    return res.status(400).json({ error: 'Valid project ID is required' });
  }

  try {
    const result = await pool.query(`
      SELECT DISTINCT u.id, u.name, u.role
      FROM users u
      JOIN worker_signins ws ON LOWER(u.name) = LOWER(ws.worker_name)
      WHERE ws.signin_date = $1
        AND ws.project_id = $2
        AND ws.signout_time IS NULL
      ORDER BY u.name
    `, [today, projectId]);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching project signed-in workers:', err);
    res.status(500).json({ error: err.message });
  }
});

// Read-only database query execution (restricted to SELECT only)
app.post('/api/database/query', async (req, res) => {
  const { query, params = [] } = req.body;

  // Security: Only allow SELECT queries
  const normalizedQuery = query.trim().toUpperCase();
  if (!normalizedQuery.startsWith('SELECT') && !normalizedQuery.startsWith('WITH')) {
    return res.status(403).json({
      error: 'Only SELECT queries are allowed for security reasons'
    });
  }

  // Forbidden keywords for security
  const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE'];
  if (forbidden.some(keyword => normalizedQuery.includes(keyword))) {
    return res.status(403).json({
      error: 'Query contains forbidden operations'
    });
  }

  try {
    const startTime = Date.now();
    const result = await pool.query(query, params);
    const executionTime = Date.now() - startTime;

    res.json({
      success: true,
      rows: result.rows,
      rowCount: result.rowCount,
      fields: result.fields?.map(f => ({ name: f.name, dataType: f.dataTypeID })),
      executionTime,
      query: query.substring(0, 500) // Return first 500 chars of query
    });
  } catch (err) {
    console.error('Query execution error:', err);
    res.status(400).json({
      error: err.message,
      hint: err.hint || 'Check your SQL syntax',
      position: err.position
    });
  }
});

// Get database statistics
app.get('/api/database/stats', async (req, res) => {
  try {
    // Get table sizes
    const tableSizes = await pool.query(`
      SELECT
        schemaname,
        tablename,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
        pg_total_relation_size(schemaname||'.'||tablename) AS size_bytes
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
    `);

    // Get row counts
    const tables = tableSizes.rows.map(t => t.tablename);
    const rowCounts = {};

    for (const table of tables) {
      try {
        const count = await pool.query(`SELECT COUNT(*) FROM ${table}`);
        rowCounts[table] = parseInt(count.rows[0].count);
      } catch (err) {
        rowCounts[table] = 0;
      }
    }

    // Get index information
    const indexes = await pool.query(`
      SELECT
        tablename,
        indexname,
        indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname
    `);

    res.json({
      tables: tableSizes.rows.map(t => ({
        ...t,
        rowCount: rowCounts[t.tablename] || 0
      })),
      indexes: indexes.rows,
      totalSize: tableSizes.rows.reduce((acc, t) => acc + parseInt(t.size_bytes), 0)
    });
  } catch (err) {
    console.error('Error fetching database stats:', err);
    res.status(500).json({ error: err.message });
  }
});

// Analyze query performance
app.post('/api/database/explain', async (req, res) => {
  const { query } = req.body;

  // Security check
  const normalizedQuery = query.trim().toUpperCase();
  if (!normalizedQuery.startsWith('SELECT') && !normalizedQuery.startsWith('WITH')) {
    return res.status(403).json({
      error: 'Only SELECT queries can be analyzed'
    });
  }

  try {
    const explainResult = await pool.query(`EXPLAIN ANALYZE ${query}`);
    const planResult = await pool.query(`EXPLAIN (FORMAT JSON) ${query}`);

    res.json({
      executionPlan: explainResult.rows.map(r => r['QUERY PLAN']),
      jsonPlan: planResult.rows[0]['QUERY PLAN'],
      suggestions: analyzeQueryPlan(planResult.rows[0]['QUERY PLAN'])
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Helper function to analyze query plan
function analyzeQueryPlan(plan) {
  const suggestions = [];
  const planStr = JSON.stringify(plan);

  if (planStr.includes('Seq Scan')) {
    suggestions.push('Consider adding indexes to avoid sequential scans');
  }
  if (planStr.includes('Nested Loop')) {
    suggestions.push('Large nested loops detected - consider query optimization');
  }
  if (planStr.includes('Sort')) {
    suggestions.push('Sorting detected - ensure indexes on ORDER BY columns');
  }

  return suggestions;
}

// Helper function to fetch weather from Open-Meteo API
async function fetchOpenMeteoWeather(date) {
  try {
    // Mississauga, Ontario coordinates
    const latitude = 43.5890;
    const longitude = -79.6441;

    // Format date for API
    const dateStr = date || new Date().toISOString().split('T')[0];

    // Open-Meteo API URL (free, no API key needed)
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,windgusts_10m_max,weathercode&current_weather=true&timezone=America/Toronto&start_date=${dateStr}&end_date=${dateStr}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('Failed to fetch weather from Open-Meteo');
    }

    const data = await response.json();

    // Map weather codes to conditions
    const weatherCodeMap = {
      0: 'Clear',
      1: 'Mainly Clear',
      2: 'Partly Cloudy',
      3: 'Overcast',
      45: 'Fog',
      48: 'Fog',
      51: 'Light Drizzle',
      53: 'Moderate Drizzle',
      55: 'Dense Drizzle',
      61: 'Light Rain',
      63: 'Moderate Rain',
      65: 'Heavy Rain',
      71: 'Light Snow',
      73: 'Moderate Snow',
      75: 'Heavy Snow',
      77: 'Snow Grains',
      80: 'Light Showers',
      81: 'Moderate Showers',
      82: 'Heavy Showers',
      85: 'Light Snow Showers',
      86: 'Heavy Snow Showers',
      95: 'Thunderstorm',
      96: 'Thunderstorm with Light Hail',
      99: 'Thunderstorm with Heavy Hail'
    };

    if (data.daily && data.daily.temperature_2m_max && data.daily.temperature_2m_max.length > 0) {
      const weatherCode = data.daily.weathercode[0];
      const condition = weatherCodeMap[weatherCode] || 'Unknown';

      return {
        date: dateStr,
        temperature_high: data.daily.temperature_2m_max[0],
        temperature_low: data.daily.temperature_2m_min[0],
        temperature_avg: (data.daily.temperature_2m_max[0] + data.daily.temperature_2m_min[0]) / 2,
        feels_like: data.current_weather ? data.current_weather.temperature : (data.daily.temperature_2m_max[0] + data.daily.temperature_2m_min[0]) / 2,
        humidity: 65, // Open-Meteo doesn't provide humidity in free tier, using default
        precipitation_mm: data.daily.precipitation_sum[0] || 0,
        wind_speed_kmh: data.daily.windspeed_10m_max[0],
        wind_gust_kmh: data.daily.windgusts_10m_max[0],
        condition: condition,
        condition_code: weatherCode.toString(),
        location: 'Mississauga, Ontario',
        is_manual_entry: false
      };
    }

    return null;
  } catch (error) {
    console.error('Error fetching from Open-Meteo:', error);
    return null;
  }
}

// Weather API endpoints
app.get('/api/weather', async (req, res) => {
  const { date } = req.query;

  try {
    if (date) {
      // First check database for cached data
      const result = await pool.query(
        `SELECT * FROM weather_data WHERE date = $1`,
        [date]
      );

      if (result.rows.length > 0) {
        // Return cached data
        res.json(result.rows[0]);
      } else {
        // Fetch from Open-Meteo API
        const weatherData = await fetchOpenMeteoWeather(date);

        if (weatherData) {
          // Save to database for caching
          try {
            // Ensure table exists
            await pool.query(`
              CREATE TABLE IF NOT EXISTS weather_data (
                id SERIAL PRIMARY KEY,
                date DATE UNIQUE NOT NULL,
                temperature_high REAL,
                temperature_low REAL,
                temperature_avg REAL,
                feels_like REAL,
                humidity INTEGER,
                precipitation_mm REAL,
                precipitation_type TEXT,
                wind_speed_kmh REAL,
                wind_gust_kmh REAL,
                wind_direction TEXT,
                pressure_mb REAL,
                visibility_km REAL,
                condition TEXT,
                condition_code TEXT,
                uv_index INTEGER,
                sunrise TEXT,
                sunset TEXT,
                location TEXT DEFAULT 'Mississauga, Ontario',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_manual_entry BOOLEAN DEFAULT false
              )
            `);

            const savedResult = await pool.query(
              `INSERT INTO weather_data (
                date, temperature_high, temperature_low, temperature_avg, feels_like,
                humidity, wind_speed_kmh, wind_gust_kmh, condition, condition_code,
                precipitation_mm, location, is_manual_entry, updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)
              ON CONFLICT (date) DO UPDATE SET
                temperature_high = EXCLUDED.temperature_high,
                temperature_low = EXCLUDED.temperature_low,
                temperature_avg = EXCLUDED.temperature_avg,
                feels_like = EXCLUDED.feels_like,
                humidity = EXCLUDED.humidity,
                wind_speed_kmh = EXCLUDED.wind_speed_kmh,
                wind_gust_kmh = EXCLUDED.wind_gust_kmh,
                condition = EXCLUDED.condition,
                condition_code = EXCLUDED.condition_code,
                precipitation_mm = EXCLUDED.precipitation_mm,
                updated_at = CURRENT_TIMESTAMP
              WHERE weather_data.is_manual_entry = false
              RETURNING *`,
              [
                weatherData.date,
                weatherData.temperature_high,
                weatherData.temperature_low,
                weatherData.temperature_avg,
                weatherData.feels_like,
                weatherData.humidity,
                weatherData.wind_speed_kmh,
                weatherData.wind_gust_kmh,
                weatherData.condition,
                weatherData.condition_code,
                weatherData.precipitation_mm,
                weatherData.location,
                weatherData.is_manual_entry
              ]
            );

            res.json(savedResult.rows[0] || weatherData);
          } catch (saveErr) {
            console.error('Error saving weather to database:', saveErr);
            // Return the fetched data even if save fails
            res.json(weatherData);
          }
        } else {
          res.json(null);
        }
      }
    } else {
      // Get recent weather data (last 30 days)
      const result = await pool.query(
        `SELECT * FROM weather_data
         WHERE date >= CURRENT_DATE - INTERVAL '30 days'
         ORDER BY date DESC`
      );

      res.json(result.rows);
    }
  } catch (err) {
    console.error('Error fetching weather:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/weather', async (req, res) => {
  const {
    date,
    temperature_high,
    temperature_low,
    humidity,
    wind_speed_kmh,
    wind_gust_kmh,
    condition,
    precipitation_mm,
    location,
    is_manual_entry
  } = req.body;

  try {
    // Try to check if required columns exist
    let tableReady = false;
    try {
      const columnCheck = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'weather_data'
        AND column_name = 'temperature_high'
      `);
      tableReady = columnCheck.rows.length > 0;
    } catch (e) {
      // Table might not exist
      tableReady = false;
    }

    if (!tableReady) {
      // Drop table if it exists with wrong structure
      await pool.query(`DROP TABLE IF EXISTS weather_data`);

      // Create the table with correct structure
      await pool.query(`
        CREATE TABLE weather_data (
          id SERIAL PRIMARY KEY,
          date DATE UNIQUE NOT NULL,
          temperature_high REAL,
          temperature_low REAL,
          temperature_avg REAL,
          feels_like REAL,
          humidity INTEGER,
          precipitation_mm REAL,
          precipitation_type TEXT,
          wind_speed_kmh REAL,
          wind_gust_kmh REAL,
          wind_direction TEXT,
          pressure_mb REAL,
          visibility_km REAL,
          condition TEXT,
          condition_code TEXT,
          uv_index INTEGER,
          sunrise TEXT,
          sunset TEXT,
          location TEXT DEFAULT 'Mississauga, Ontario',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          is_manual_entry BOOLEAN DEFAULT false
        )
      `);
    }

    // Calculate temperature average
    const temperature_avg = (temperature_high + temperature_low) / 2;
    const feels_like = temperature_avg; // Simple approximation

    // Insert or update weather data
    const result = await pool.query(
      `INSERT INTO weather_data (
        date, temperature_high, temperature_low, temperature_avg, feels_like,
        humidity, wind_speed_kmh, wind_gust_kmh, condition, precipitation_mm,
        location, is_manual_entry, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
      ON CONFLICT (date) DO UPDATE SET
        temperature_high = EXCLUDED.temperature_high,
        temperature_low = EXCLUDED.temperature_low,
        temperature_avg = EXCLUDED.temperature_avg,
        feels_like = EXCLUDED.feels_like,
        humidity = EXCLUDED.humidity,
        wind_speed_kmh = EXCLUDED.wind_speed_kmh,
        wind_gust_kmh = EXCLUDED.wind_gust_kmh,
        condition = EXCLUDED.condition,
        precipitation_mm = EXCLUDED.precipitation_mm,
        location = EXCLUDED.location,
        is_manual_entry = EXCLUDED.is_manual_entry,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *`,
      [
        date,
        temperature_high,
        temperature_low,
        temperature_avg,
        feels_like,
        humidity,
        wind_speed_kmh,
        wind_gust_kmh,
        condition,
        precipitation_mm,
        location || 'Mississauga, Ontario',
        is_manual_entry !== undefined ? is_manual_entry : true
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error saving weather:', err);
    res.status(500).json({
      error: err.message,
      details: err.detail || 'No additional details available'
    });
  }
});

// Delete a worker
app.delete('/api/workers/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // Delete from users table
    const result = await pool.query(
      'DELETE FROM users WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Worker not found' });
    }

    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('Error deleting worker:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get duplicate workers (same name)
app.get('/api/workers/duplicates', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u1.id, u1.name, u1.role, u1.created_at,
             (SELECT signin_time FROM worker_signins
              WHERE LOWER(worker_name) = LOWER(u1.name)
              ORDER BY signin_time DESC LIMIT 1) as last_signin
      FROM users u1
      WHERE LOWER(u1.name) IN (
        SELECT LOWER(name)
        FROM users
        GROUP BY LOWER(name)
        HAVING COUNT(*) > 1
      )
      ORDER BY LOWER(u1.name), u1.created_at
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Error finding duplicate workers:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get vacation status for workers
app.get('/api/vacations', async (req, res) => {
  const { date } = req.query;
  const queryDate = date || getEasternDate();

  try {
    // First ensure the table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vacation_schedule (
        id SERIAL PRIMARY KEY,
        worker_name VARCHAR(255) NOT NULL,
        vacation_start DATE NOT NULL,
        vacation_end DATE NOT NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const result = await pool.query(
      `SELECT worker_name, vacation_start, vacation_end, notes
       FROM vacation_schedule
       WHERE $1 BETWEEN vacation_start AND vacation_end`,
      [queryDate]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching vacations:', err);
    res.json([]); // Return empty array instead of error
  }
});

// Set vacation status for a worker
app.post('/api/vacations', async (req, res) => {
  const { worker_name, date, vacation_start, vacation_end, notes } = req.body;

  // Support both single date and date range
  const startDate = vacation_start || date;
  const endDate = vacation_end || date;

  try {
    // Check if vacation schedule table exists, if not create it
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vacation_schedule (
        id SERIAL PRIMARY KEY,
        worker_name VARCHAR(255) NOT NULL,
        vacation_start DATE NOT NULL,
        vacation_end DATE NOT NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Insert vacation record
    const result = await pool.query(
      `INSERT INTO vacation_schedule (worker_name, vacation_start, vacation_end, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [worker_name, startDate, endDate, notes || 'Marked as vacation']
    );

    res.json({ success: true, ...result.rows[0] });
  } catch (err) {
    console.error('Error setting vacation:', err);
    res.status(500).json({ error: err.message });
  }
});

// Mark attendance status (present/absent/vacation)
app.post('/api/attendance/mark', async (req, res) => {
  const { worker_name, date, status } = req.body;
  const queryDate = date || getEasternDate();

  try {
    // Ensure attendance table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        worker_id INTEGER,
        worker_name VARCHAR(255),
        date DATE,
        status VARCHAR(50),
        check_in_time TIME,
        check_out_time TIME,
        sign_in_latitude DOUBLE PRECISION,
        sign_in_longitude DOUBLE PRECISION,
        sign_in_address TEXT,
        sign_out_latitude DOUBLE PRECISION,
        sign_out_longitude DOUBLE PRECISION,
        sign_out_address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Check if attendance record exists
    const existing = await pool.query(
      'SELECT * FROM attendance WHERE LOWER(worker_name) = LOWER($1) AND date = $2',
      [worker_name, queryDate]
    );

    if (existing.rows.length === 0) {
      // Create new attendance record
      await pool.query(
        `INSERT INTO attendance (worker_name, date, status)
         VALUES ($1, $2, $3)`,
        [worker_name, queryDate, status]
      );
    } else {
      // Update existing record
      await pool.query(
        `UPDATE attendance SET status = $1
         WHERE LOWER(worker_name) = LOWER($2) AND date = $3`,
        [status, worker_name, queryDate]
      );
    }

    // If marking as vacation, also create vacation schedule record
    if (status === 'vacation') {
      // Check if vacation schedule exists for today
      const vacationExists = await pool.query(
        `SELECT * FROM vacation_schedule
         WHERE worker_name = $1 AND $2 BETWEEN vacation_start AND vacation_end`,
        [worker_name, queryDate]
      );

      if (vacationExists.rows.length === 0) {
        // Create single day vacation record
        await pool.query(
          `INSERT INTO vacation_schedule (worker_name, vacation_start, vacation_end, notes)
           VALUES ($1, $2, $2, $3)
           ON CONFLICT DO NOTHING`,
          [worker_name, queryDate, queryDate, 'Single day vacation']
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error marking attendance:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get GPS attendance data
app.get('/api/gps-attendance', async (req, res) => {
  const today = getEasternDate();

  try {
    const result = await pool.query(
      `SELECT *,
       signin_latitude as latitude,
       signin_longitude as longitude,
       signin_address as location_address
       FROM worker_signins
       WHERE signin_date = $1 AND signin_latitude IS NOT NULL AND signin_longitude IS NOT NULL
       ORDER BY signin_time DESC`,
      [today]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching GPS attendance:', err);
    res.status(500).json({ error: err.message });
  }
});

// Material Requests endpoints
app.get('/api/material-requests', async (req, res) => {
  const { status, urgency } = req.query;

  try {
    // Ensure material_requests table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS material_requests (
        id SERIAL PRIMARY KEY,
        worker_id INTEGER,
        worker_name VARCHAR(255),
        project_id INTEGER,
        project_name VARCHAR(255),
        items JSONB NOT NULL,
        urgency VARCHAR(20),
        delivery_date DATE,
        notes TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP,
        updated_by VARCHAR(255),
        completion_notes TEXT
      )
    `);

    let query = 'SELECT * FROM material_requests WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (status && status !== 'all') {
      query += ` AND status = $${paramIndex++}`;
      params.push(status);
    }

    if (urgency && urgency !== 'all') {
      query += ` AND urgency = $${paramIndex++}`;
      params.push(urgency);
    }

    query += ' ORDER BY submitted_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching material requests:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/material-requests', async (req, res) => {
  const {
    worker_id,
    worker_name,
    project_id,
    project_name,
    items,
    urgency,
    delivery_date,
    notes
  } = req.body;

  try {
    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS material_requests (
        id SERIAL PRIMARY KEY,
        worker_id INTEGER,
        worker_name VARCHAR(255),
        project_id INTEGER,
        project_name VARCHAR(255),
        items JSONB NOT NULL,
        urgency VARCHAR(20),
        delivery_date DATE,
        notes TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP,
        updated_by VARCHAR(255),
        completion_notes TEXT
      )
    `);

    const result = await pool.query(
      `INSERT INTO material_requests
       (worker_id, worker_name, project_id, project_name, items, urgency, delivery_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [worker_id, worker_name, project_id, project_name, JSON.stringify(items), urgency, delivery_date, notes]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error creating material request:', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/material-requests/:id', async (req, res) => {
  const { id } = req.params;
  const { status, completion_notes, updated_by } = req.body;

  try {
    const result = await pool.query(
      `UPDATE material_requests
       SET status = COALESCE($1, status),
           completion_notes = COALESCE($2, completion_notes),
           updated_by = COALESCE($3, updated_by),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING *`,
      [status, completion_notes, updated_by, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Material request not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating material request:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/material-requests/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM material_requests WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Material request not found' });
    }

    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('Error deleting material request:', err);
    res.status(500).json({ error: err.message });
  }
});

// Worker Profile endpoints
app.get('/api/workers/:workerId', async (req, res) => {
  const { workerId } = req.params;
  try {
    // First ensure workers_info table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workers_info (
        id INTEGER PRIMARY KEY,
        name TEXT,
        phone TEXT,
        email TEXT,
        address TEXT,
        emergency_contact TEXT,
        emergency_phone TEXT,
        start_date DATE,
        position TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).catch(() => {});

    // Get worker info - first try workers_info table, then workers table
    let result = await pool.query('SELECT * FROM workers_info WHERE id = $1', [workerId]);

    if (result.rows.length === 0) {
      // Try workers table
      const workerResult = await pool.query('SELECT * FROM workers WHERE id = $1', [workerId]);
      if (workerResult.rows.length > 0) {
        const worker = workerResult.rows[0];
        // Create initial record in workers_info
        await pool.query(
          'INSERT INTO workers_info (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
          [worker.id, worker.name]
        );
        result = await pool.query('SELECT * FROM workers_info WHERE id = $1', [workerId]);
      }
    }

    // Get certifications
    const certResult = await pool.query(
      'SELECT * FROM worker_certifications WHERE worker_id = $1 ORDER BY issue_date DESC',
      [workerId]
    );

    const workerData = result.rows[0] || {};
    workerData.certifications = certResult.rows;

    res.json(workerData);
  } catch (err) {
    console.error('Error fetching worker:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/workers/:workerId', async (req, res) => {
  const { workerId } = req.params;
  const { name, phone, email, address, emergency_contact, emergency_phone, start_date, position } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO workers_info (id, name, phone, email, address, emergency_contact, emergency_phone, start_date, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         name = COALESCE($2, workers_info.name),
         phone = COALESCE($3, workers_info.phone),
         email = COALESCE($4, workers_info.email),
         address = COALESCE($5, workers_info.address),
         emergency_contact = COALESCE($6, workers_info.emergency_contact),
         emergency_phone = COALESCE($7, workers_info.emergency_phone),
         start_date = COALESCE($8, workers_info.start_date),
         position = COALESCE($9, workers_info.position)
       RETURNING *`,
      [workerId, name, phone, email, address, emergency_contact, emergency_phone, start_date, position]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating worker:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workers/:workerId/attendance', async (req, res) => {
  const { workerId } = req.params;
  const { start_date, end_date } = req.query;

  try {
    const result = await pool.query(
      `SELECT date, status,
        CASE
          WHEN t.total_hours IS NOT NULL THEN t.total_hours
          ELSE 0
        END as hours_worked
       FROM attendance a
       LEFT JOIN timesheets t ON t.worker_id = a.worker_id AND t.date = a.date
       WHERE a.worker_id = $1 AND a.date >= $2 AND a.date <= $3
       ORDER BY a.date`,
      [workerId, start_date, end_date]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching attendance:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workers/:workerId/timesheet-summary', async (req, res) => {
  const { workerId } = req.params;

  try {
    const result = await pool.query(
      `SELECT
        week_number as week,
        SUM(COALESCE(regular_hours, LEAST(total_hours, 8))) as regular_hours,
        SUM(COALESCE(overtime_hours, GREATEST(total_hours - 8, 0))) as overtime_hours,
        SUM(total_hours) as total_hours
       FROM timesheets
       WHERE worker_id = $1 AND date >= CURRENT_DATE - INTERVAL '12 weeks'
       GROUP BY week_number
       ORDER BY week_number DESC
       LIMIT 12`,
      [workerId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching timesheet summary:', err);
    res.status(500).json({ error: err.message });
  }
});

// Concrete Pour Tracking
app.get('/api/concrete-pours', async (req, res) => {
  try {
    // Create table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS concrete_pours (
        id SERIAL PRIMARY KEY,
        project_id INTEGER,
        project_name TEXT,
        pour_date DATE,
        location TEXT,
        planned_volume DECIMAL(10,2),
        actual_volume DECIMAL(10,2),
        planned_start TIME,
        actual_start TIMESTAMP,
        planned_end TIME,
        actual_end TIMESTAMP,
        supplier TEXT,
        mix_type TEXT,
        slump TEXT,
        weather_conditions TEXT,
        temperature DECIMAL(5,2),
        crew_size INTEGER,
        pump_type TEXT,
        notes TEXT,
        status VARCHAR(50) DEFAULT 'scheduled',
        created_by TEXT,
        completed_by TEXT,
        completion_notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).catch(() => {});

    const result = await pool.query(
      'SELECT * FROM concrete_pours ORDER BY pour_date DESC, created_at DESC'
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching concrete pours:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/concrete-pours', async (req, res) => {
  const {
    project_name, pour_date, location, planned_volume,
    planned_start, planned_end, supplier, mix_type,
    crew_size, pump_type, notes, created_by
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO concrete_pours (
        project_name, pour_date, location, planned_volume,
        planned_start, planned_end, supplier, mix_type,
        crew_size, pump_type, notes, status, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *`,
      [
        project_name, pour_date, location, planned_volume,
        planned_start, planned_end, supplier, mix_type,
        crew_size || null, pump_type || null, notes || null,
        'scheduled', created_by
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error creating concrete pour:', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/concrete-pours/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  try {
    // Build dynamic update query
    const setClause = [];
    const values = [];
    let paramCount = 1;

    Object.keys(updates).forEach(key => {
      if (updates[key] !== undefined && updates[key] !== null) {
        setClause.push(`${key} = $${paramCount}`);
        values.push(updates[key]);
        paramCount++;
      }
    });

    if (setClause.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    values.push(id);

    const result = await pool.query(
      `UPDATE concrete_pours
       SET ${setClause.join(', ')}
       WHERE id = $${paramCount}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Concrete pour not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating concrete pour:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/concrete-pours/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM concrete_pours WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Concrete pour not found' });
    }

    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('Error deleting concrete pour:', err);
    res.status(500).json({ error: err.message });
  }
});

// Worker Certifications
app.post('/api/workers/:workerId/certifications', async (req, res) => {
  const { workerId } = req.params;
  const { name, issuer, issue_date, expiry_date } = req.body;

  try {
    // Create table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS worker_certifications (
        id SERIAL PRIMARY KEY,
        worker_id INTEGER,
        name TEXT,
        issuer TEXT,
        issue_date DATE,
        expiry_date DATE,
        file_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).catch(() => {});

    const result = await pool.query(
      `INSERT INTO worker_certifications (worker_id, name, issuer, issue_date, expiry_date)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [workerId, name, issuer, issue_date, expiry_date || null]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error adding certification:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/workers/:workerId/certifications/:certId', async (req, res) => {
  const { workerId, certId } = req.params;

  try {
    await pool.query(
      'DELETE FROM worker_certifications WHERE id = $1 AND worker_id = $2',
      [certId, workerId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting certification:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start server if not in Vercel environment
if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// Export for Vercel
module.exports = app;