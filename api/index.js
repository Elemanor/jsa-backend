require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { generatePresignedUrl, uploadToS3 } = require('./s3-upload');
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

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

// Increase limits for photo uploads
app.use(express.json({ limit: '10mb' }));  // Reduced from 50mb to 10mb for Vercel
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Add middleware to ensure CORS headers are always sent
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Setup work_area_workers table endpoint
app.get('/api/setup-worker-table', async (req, res) => {
  try {
    // Create the table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS work_area_workers (
        id SERIAL PRIMARY KEY,
        work_area_id UUID NOT NULL REFERENCES work_areas(id) ON DELETE CASCADE,
        worker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        work_date DATE DEFAULT CURRENT_DATE,
        worker_name VARCHAR(255),
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        hours_worked DECIMAL(4,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_work_area_workers_area_id
      ON work_area_workers(work_area_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_work_area_workers_worker_id
      ON work_area_workers(worker_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_work_area_workers_date
      ON work_area_workers(work_date)
    `);

    // Create unique constraint
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS unique_work_area_worker_date
      ON work_area_workers(work_area_id, worker_id, work_date)
    `);

    // Test the table
    const test = await pool.query('SELECT COUNT(*) FROM work_area_workers');

    res.json({
      success: true,
      message: 'Work area workers table setup complete',
      currentRows: test.rows[0].count
    });
  } catch (err) {
    console.error('Error setting up worker table:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update Romeu Morim to foreman
app.get('/api/update-romeu-foreman', async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE users SET role = 'foreman' WHERE LOWER(name) = LOWER('Romeu Morim') RETURNING *"
    );

    if (result.rows.length > 0) {
      res.json({ message: 'Romeu Morim updated to foreman', user: result.rows[0] });
    } else {
      // If not exists, create as foreman
      await pool.query(
        "INSERT INTO users (name, role, pin) VALUES ($1, $2, $3)",
        ['Romeu Morim', 'foreman', '1234']
      );
      res.json({ message: 'Romeu Morim added as foreman' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// Add Alvaro Aleman to workers if not exists
app.get('/api/workers/init-alvaro', async (req, res) => {
  try {
    // Check if Alvaro Aleman already exists
    const check = await pool.query(
      "SELECT id FROM users WHERE LOWER(name) = LOWER('Alvaro Aleman')"
    );

    if (check.rows.length === 0) {
      // Add Alvaro Aleman with PIN
      await pool.query(
        "INSERT INTO users (name, role, pin) VALUES ($1, $2, $3)",
        ['Alvaro Aleman', 'worker', '1111']
      );
      res.json({ message: 'Alvaro Aleman added successfully' });
    } else {
      // Update PIN for existing Alvaro Aleman
      await pool.query(
        "UPDATE users SET pin = $1 WHERE LOWER(name) = LOWER('Alvaro Aleman')",
        ['1111']
      );
      res.json({ message: 'Alvaro Aleman PIN updated' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force set Romeu Morim PIN
app.get('/api/workers/set-romeu-pin', async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE users SET pin = '2024' WHERE id = 14 OR LOWER(name) = LOWER('Romeu Morim')"
    );
    res.json({ message: `Updated ${result.rowCount} records. Romeu Morim PIN is now 2024` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Romeu Morim to foreman
app.get('/api/workers/update-romeu-foreman', async (req, res) => {
  try {
    // Update Romeu Morim's role to foreman and set PIN to 2024
    const result = await pool.query(
      "UPDATE users SET role = 'foreman', pin = '2024' WHERE LOWER(name) = LOWER('Romeu Morim')"
    );

    if (result.rowCount > 0) {
      res.json({ message: 'Romeu Morim updated to foreman with PIN 2024 successfully' });
    } else {
      // If not exists, create as foreman
      await pool.query(
        "INSERT INTO users (name, role, pin) VALUES ($1, $2, $3)",
        ['Romeu Morim', 'foreman', '2024']
      );
      res.json({ message: 'Romeu Morim added as foreman with PIN 2024 successfully' });
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
    // Try case-insensitive name match - include display_name
    const result = await pool.query(
      'SELECT id, name, role, display_name FROM users WHERE LOWER(name) = LOWER($1) AND pin = $2',
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
      // Add displayName field for frontend use
      user.displayName = user.display_name || user.name;
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
                check_in_time, latitude, longitude, address
              ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [user.name, today, 'present', checkInTime, latitude, longitude, address || null]
            );
            console.log('Created attendance record with GPS for:', user.name);
          } else {
            // Update existing attendance with GPS data if not already set
            await pool.query(`
              UPDATE attendance
              SET latitude = COALESCE(latitude, $1),
                  longitude = COALESCE(longitude, $2),
                  address = COALESCE(address, $3),
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

// Worker registration with certificates
app.post('/api/auth/register', upload.fields([
  { name: 'workingAtHeightsCert', maxCount: 1 },
  { name: 'whimisCert', maxCount: 1 },
  { name: 'worker4StepCert', maxCount: 1 }
]), async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      dateOfBirth,
      address,
      email,
      phone,
      emergencyContact,
      emergencyPhone,
      language,
      role,
      pin
    } = req.body;

    const fullName = `${firstName} ${lastName}`;
    const registrationDate = new Date().toISOString();

    // Ensure PIN is set - use provided PIN or default to '1111'
    const workerPin = pin && pin.trim() !== '' ? pin : '1111';

    console.log('New worker registration:', { fullName, language, pin: workerPin });

    // First, check if user already exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE LOWER(name) = LOWER($1)',
      [fullName]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        error: 'User with this name already exists',
        success: false
      });
    }

    // Upload certificates to S3 if provided
    let certificateUrls = {};

    if (req.files) {
      const uploadPromises = [];

      if (req.files.workingAtHeightsCert) {
        uploadPromises.push(
          uploadToS3(
            req.files.workingAtHeightsCert[0].buffer,
            req.files.workingAtHeightsCert[0].originalname,
            req.files.workingAtHeightsCert[0].mimetype,
            'certificates'
          ).then(result => {
            certificateUrls.workingAtHeights = result.fileUrl;
          })
        );
      }

      if (req.files.whimisCert) {
        uploadPromises.push(
          uploadToS3(
            req.files.whimisCert[0].buffer,
            req.files.whimisCert[0].originalname,
            req.files.whimisCert[0].mimetype,
            'certificates'
          ).then(result => {
            certificateUrls.whimis = result.fileUrl;
          })
        );
      }

      if (req.files.worker4StepCert) {
        uploadPromises.push(
          uploadToS3(
            req.files.worker4StepCert[0].buffer,
            req.files.worker4StepCert[0].originalname,
            req.files.worker4StepCert[0].mimetype,
            'certificates'
          ).then(result => {
            certificateUrls.worker4Step = result.fileUrl;
          })
        );
      }

      await Promise.all(uploadPromises);
    }

    // Create tables if they don't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS worker_details (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        first_name VARCHAR(100),
        last_name VARCHAR(100),
        date_of_birth DATE,
        address TEXT,
        email VARCHAR(255),
        phone VARCHAR(50),
        emergency_contact VARCHAR(255),
        emergency_phone VARCHAR(50),
        language VARCHAR(10),
        registration_date TIMESTAMP,
        working_at_heights_cert TEXT,
        whimis_cert TEXT,
        worker_4step_cert TEXT,
        UNIQUE(user_id)
      )
    `);

    // Start transaction
    await pool.query('BEGIN');

    try {
      // Insert into users table
      const userResult = await pool.query(
        'INSERT INTO users (name, pin, role) VALUES ($1, $2, $3) RETURNING id',
        [fullName, workerPin, role || 'worker']
      );

      const userId = userResult.rows[0].id;

      // Insert into worker_details table
      await pool.query(`
        INSERT INTO worker_details (
          user_id, first_name, last_name, date_of_birth,
          address, email, phone, emergency_contact, emergency_phone,
          language, registration_date,
          working_at_heights_cert, whimis_cert, worker_4step_cert
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `, [
        userId, firstName, lastName, dateOfBirth,
        address, email || null, phone, emergencyContact, emergencyPhone,
        language, registrationDate,
        certificateUrls.workingAtHeights || null,
        certificateUrls.whimis || null,
        certificateUrls.worker4Step || null
      ]);

      // Commit transaction
      await pool.query('COMMIT');

      console.log('Worker registered successfully:', fullName);

      res.json({
        success: true,
        message: 'Registration successful',
        user: {
          id: userId,
          name: fullName,
          role: role || 'worker',
          pin: workerPin
        }
      });

    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      error: 'Failed to register worker',
      details: error.message,
      success: false
    });
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

    // Calculate total hours from start and end times
    let calculatedTotalHours = total_hours || 0;
    if (start_time && end_time) {
      const [startHour, startMin] = start_time.split(':').map(Number);
      const [endHour, endMin] = end_time.split(':').map(Number);

      // Calculate duration in minutes
      let durationMinutes = (endHour * 60 + endMin) - (startHour * 60 + startMin);

      // Handle overnight shifts (if end time is before start time, add 24 hours)
      if (durationMinutes < 0) {
        durationMinutes += 24 * 60;
      }

      // Subtract break duration (convert from decimal hours to minutes)
      const breakMinutes = parseFloat(break_duration || 0) * 60;
      durationMinutes -= breakMinutes;

      // Convert to hours (rounded to 2 decimal places)
      calculatedTotalHours = Math.round((durationMinutes / 60) * 100) / 100;
    }

    // For now, just track total hours - overtime will be calculated weekly
    const regularHours = calculatedTotalHours;
    const overtimeHours = 0; // Overtime is calculated on weekly basis, not daily

    const result = await pool.query(
      'INSERT INTO timesheets (worker_id, worker_name, date, project_name, start_time, end_time, break_duration, total_hours, regular_hours, overtime_hours, notes, week_number) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *',
      [worker_id, worker_name, date, project_name, start_time, end_time, break_duration || 0, calculatedTotalHours, regularHours, overtimeHours, notes || '', weekNumber]
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
    // Get all workers from users table with their details
    const result = await pool.query(`
      SELECT
        u.id, u.name, u.role,
        wd.first_name, wd.last_name, wd.date_of_birth,
        wd.address, wd.email, wd.phone,
        wd.emergency_contact, wd.emergency_phone,
        wd.language, wd.registration_date,
        wd.working_at_heights_cert,
        wd.whimis_cert,
        wd.worker_4step_cert
      FROM users u
      LEFT JOIN worker_details wd ON u.id = wd.user_id
      WHERE u.role IN ('worker', 'foreman')
      ORDER BY u.name
    `);

    // Format the response
    const workers = result.rows.map(worker => ({
      id: worker.id,
      name: worker.name,
      role: worker.role,
      firstName: worker.first_name,
      lastName: worker.last_name,
      dateOfBirth: worker.date_of_birth,
      address: worker.address,
      email: worker.email,
      phone: worker.phone,
      emergencyContact: worker.emergency_contact,
      emergencyPhone: worker.emergency_phone,
      language: worker.language,
      registrationDate: worker.registration_date,
      certificates: {
        workingAtHeights: worker.working_at_heights_cert,
        whimis: worker.whimis_cert,
        worker4Step: worker.worker_4step_cert
      }
    }));

    res.json(workers);
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
      `SELECT
        id,
        date as delivery_date,
        time as delivery_time,
        project_id,
        project_name,
        area,
        quantity,
        concrete_type,
        status,
        actual_volume,
        actual_hours,
        supervisor
       FROM concrete_deliveries
       WHERE date = $1
       ORDER BY time`,
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

// Get signed-in workers (currently signed in, not signed out)
app.get('/api/signed-in-workers', async (req, res) => {
  const { date } = req.query;

  try {
    let query = `
      SELECT
        ws.*,
        u.id as worker_id,
        u.role,
        u.phone
      FROM worker_signins ws
      LEFT JOIN users u ON LOWER(ws.worker_name) = LOWER(u.name)
      WHERE ws.signout_time IS NULL
    `;
    const params = [];

    if (date) {
      params.push(date);
      query += ` AND ws.signin_date = $${params.length}`;
    }

    query += ' ORDER BY ws.signin_time DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching signed-in workers:', err);
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

    // Ensure concrete_pours table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS concrete_pours (
        id SERIAL PRIMARY KEY,
        project_name VARCHAR(255),
        pour_date DATE,
        area VARCHAR(255),
        planned_volume DECIMAL(10,2),
        actual_volume DECIMAL(10,2),
        planned_start TIMESTAMP,
        planned_end TIMESTAMP,
        actual_start TIMESTAMP,
        actual_end TIMESTAMP,
        concrete_type VARCHAR(100),
        supplier VARCHAR(255),
        supervisor VARCHAR(255),
        status VARCHAR(50),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
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
        const plannedTime = delivery.delivery_time
          ? `${delivery.delivery_date} ${delivery.delivery_time}`
          : `${delivery.delivery_date} 08:00:00`;

        await pool.query(
          `INSERT INTO concrete_pours
           (project_name, pour_date, area, planned_volume, actual_volume,
            planned_start, planned_end, actual_start, actual_end,
            concrete_type, supplier, supervisor, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), $8, 'Local Supplier', $9, 'completed')`,
          [
            delivery.project_name,
            delivery.delivery_date,
            delivery.area,
            parseFloat(delivery.quantity) || 0,
            parseFloat(actual_volume) || 0,
            plannedTime,
            plannedTime, // Using same time for start and end as placeholder
            delivery.concrete_type || '30 MPA',
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

    // First, get the raw timesheet data
    let query = `
      SELECT *,
        total_hours as regular_hours,
        0 as overtime_hours
      FROM timesheets
      WHERE 1=1
    `;
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

    // Calculate weekly overtime (after 44 hours per week)
    const timesheets = result.rows;
    const weeklyHours = {};

    // Group timesheets by week and worker
    timesheets.forEach(entry => {
      const weekKey = `${entry.worker_name}-${entry.week_number}-${new Date(entry.date).getFullYear()}`;
      if (!weeklyHours[weekKey]) {
        weeklyHours[weekKey] = {
          totalHours: 0,
          entries: []
        };
      }
      weeklyHours[weekKey].totalHours += parseFloat(entry.total_hours || 0);
      weeklyHours[weekKey].entries.push(entry);
    });

    // Apply overtime calculation (44 hours per week threshold)
    const processedTimesheets = timesheets.map(entry => {
      const weekKey = `${entry.worker_name}-${entry.week_number}-${new Date(entry.date).getFullYear()}`;
      const weekData = weeklyHours[weekKey];

      // Calculate how much overtime this week has
      const weeklyOvertime = Math.max(weekData.totalHours - 44, 0);

      // For simplicity, show overtime only on entries that push the week over 44 hours
      let entryOvertime = 0;
      let cumulativeHours = 0;

      // Find this entry's position in the week
      const sortedEntries = weekData.entries.sort((a, b) => new Date(a.date) - new Date(b.date));
      for (let e of sortedEntries) {
        const prevCumulative = cumulativeHours;
        cumulativeHours += parseFloat(e.total_hours || 0);

        if (e.id === entry.id) {
          // This is our entry - check if it crosses the 44-hour threshold
          if (prevCumulative < 44 && cumulativeHours > 44) {
            entryOvertime = cumulativeHours - 44;
          } else if (prevCumulative >= 44) {
            entryOvertime = parseFloat(e.total_hours || 0);
          }
          break;
        }
      }

      return {
        ...entry,
        regular_hours: parseFloat(entry.total_hours || 0) - entryOvertime,
        overtime_hours: entryOvertime
      };
    });

    res.json(processedTimesheets);
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

// Get attendance with query parameter
app.get('/api/attendance', async (req, res) => {
  const { date } = req.query;

  if (!date) {
    return res.status(400).json({ error: 'Date parameter is required' });
  }

  try {
    // Get all workers from users table
    const workersResult = await pool.query(
      `SELECT id, name, role FROM users ORDER BY name`
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
        check_in_time: attendanceRecord ? attendanceRecord.check_in_time : null,
        check_out_time: attendanceRecord ? attendanceRecord.check_out_time : null,
        latitude: attendanceRecord ? attendanceRecord.latitude : null,
        longitude: attendanceRecord ? attendanceRecord.longitude : null,
        address: attendanceRecord ? attendanceRecord.address : null,
        sign_in_address: attendanceRecord ? attendanceRecord.address : null,
        attendance_id: attendanceRecord ? attendanceRecord.id : null
      };
    });

    res.json(attendanceData);
  } catch (err) {
    console.error('Error fetching attendance:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get attendance for a specific date (path parameter version)
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

// Get worker signin status (query parameter version)
app.get('/api/worker/signin-status', async (req, res) => {
  const { workerId, date } = req.query;
  const targetDate = date || getEasternDate();

  try {
    // Get user name from ID
    const userResult = await pool.query(
      'SELECT name FROM users WHERE id = $1',
      [workerId]
    );

    if (userResult.rows.length === 0) {
      return res.json({ signed_in: false });
    }

    const workerName = userResult.rows[0].name;

    // Check if worker is currently signed in
    const result = await pool.query(
      `SELECT *
       FROM worker_signins
       WHERE LOWER(worker_name) = LOWER($1)
       AND signin_date = $2
       AND signout_time IS NULL
       ORDER BY signin_time DESC
       LIMIT 1`,
      [workerName, targetDate]
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

// Get timesheet data for a worker
app.get('/api/worker/timesheet-data', async (req, res) => {
  const { workerId, date } = req.query;
  const targetDate = date || getEasternDate();

  try {
    // Get worker name from ID
    const userResult = await pool.query(
      'SELECT name FROM users WHERE id = $1',
      [workerId]
    );

    if (userResult.rows.length === 0) {
      return res.json({ signin_time: null, signout_time: null });
    }

    const workerName = userResult.rows[0].name;

    // Get today's sign-in/out data
    const result = await pool.query(
      `SELECT signin_time, signout_time
       FROM worker_signins
       WHERE LOWER(worker_name) = LOWER($1)
       AND signin_date = $2
       ORDER BY signin_time DESC
       LIMIT 1`,
      [workerName, targetDate]
    );

    if (result.rows.length > 0) {
      res.json({
        signin_time: result.rows[0].signin_time,
        signout_time: result.rows[0].signout_time
      });
    } else {
      res.json({ signin_time: null, signout_time: null });
    }
  } catch (err) {
    console.error('Error fetching timesheet data:', err);
    res.status(500).json({ error: 'Failed to fetch timesheet data' });
  }
});

// Get worker signin status (path parameter version - keep for compatibility)
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

// Add David Peniche and Romeo Duarte as foremen
app.post('/api/add-new-foremen', async (req, res) => {
  try {
    const foremen = [
      { name: 'David Peniche', email: 'david.peniche@mjr.com', pin: '1111', role: 'foreman' },
      { name: 'Romeo Duarte', email: 'romeo.duarte@mjr.com', pin: '1111', role: 'foreman' }
    ];

    const results = [];
    for (const foreman of foremen) {
      try {
        const result = await pool.query(
          `INSERT INTO users (name, email, pin, role) VALUES ($1, $2, $3, $4)
           ON CONFLICT (email) DO UPDATE
           SET name = EXCLUDED.name, pin = EXCLUDED.pin, role = EXCLUDED.role
           RETURNING *`,
          [foreman.name, foreman.email, foreman.pin, foreman.role]
        );
        results.push({
          action: 'added',
          user: result.rows[0]
        });
      } catch (userErr) {
        results.push({
          action: 'error',
          user: foreman.name,
          error: userErr.message
        });
      }
    }

    const verifyResult = await pool.query(
      "SELECT id, name, email, role FROM users WHERE name IN ('David Peniche', 'Romeo Duarte') ORDER BY name"
    );

    res.json({
      success: true,
      message: 'Foremen added successfully',
      results: results,
      foremen: verifyResult.rows
    });
  } catch (err) {
    console.error('Error adding foremen:', err);
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

// Get work areas by project ID
app.get('/api/projects/:id/work-areas', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(`
      SELECT wa.*, p.name as project_name,
        (SELECT COUNT(*) FROM area_worker_assignments
         WHERE work_area_id = wa.id AND assignment_date = CURRENT_DATE) as workers_today,
        0 as today_concrete_volume,
        0 as open_rfis
      FROM work_areas wa
      LEFT JOIN projects p ON wa.project_id = p.id
      WHERE wa.project_id = $1
      ORDER BY wa.created_at DESC
    `, [id]);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching project work areas:', err);
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

    // Check if planned_concrete_volume column exists
    const columnCheck = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'work_areas'
      AND column_name = 'planned_concrete_volume'
    `);

    const hasPlannedVolume = columnCheck.rows.length > 0;

    let result;
    if (hasPlannedVolume) {
      // Include planned_concrete_volume if column exists
      result = await pool.query(`
        INSERT INTO work_areas
        (name, description, location, start_date, current_stage, status, project_id, planned_concrete_volume, foreman_in_charge)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `, [name, description, location, startDate, currentStage || 'initial_layout', status || 'active', projectId, plannedConcreteVolume || 0, foremanInCharge || 'N/A']);
    } else {
      // Exclude planned_concrete_volume if column doesn't exist
      result = await pool.query(`
        INSERT INTO work_areas
        (name, description, location, start_date, current_stage, status, project_id, foreman_in_charge)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [name, description, location, startDate, currentStage || 'initial_layout', status || 'active', projectId, foremanInCharge || 'N/A']);
    }

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

// REMOVED DUPLICATE - Using the endpoint at line 6605 instead
// This was causing conflicts with the other photo endpoint

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

// Original endpoint for backward compatibility (accepts base64, JSON, or FormData)
app.post('/api/work-areas/:id/photos', upload.single('photo'), async (req, res) => {
  const { id } = req.params;

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

    let photoUrl, thumbnailUrl, caption, takenBy, takenDate;
    const { latitude, longitude, locationAddress, dailyActivityId } = req.body;

    // Check if request has file upload (multipart/form-data)
    if (req.file) {
      // Handle file upload via multer
      try {
        if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
          // Upload to S3
          const s3Result = await uploadToS3(
            req.file.buffer,
            req.file.originalname,
            req.file.mimetype,
            `work-areas/${id}`
          );
          photoUrl = s3Result.fileUrl;
          thumbnailUrl = s3Result.fileUrl;
        } else {
          // Convert to base64 if S3 not configured
          const base64 = req.file.buffer.toString('base64');
          photoUrl = `data:${req.file.mimetype};base64,${base64}`;
          thumbnailUrl = photoUrl;
        }
      } catch (uploadError) {
        console.error('Error handling file upload:', uploadError);
        return res.status(500).json({ error: 'Failed to process uploaded file' });
      }

      caption = req.body.caption || `Work area photo - ${new Date().toLocaleDateString()}`;
      takenBy = req.body.taken_by_name || 'Field Worker';
      takenDate = req.body.taken_at || new Date().toISOString();
    }
    // Check if request has base64 data
    else if (req.body.photo && req.body.photo.startsWith('data:')) {
      // Handle base64 image data
      try {
        // Check if AWS credentials are configured
        if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
          const base64Data = req.body.photo.replace(/^data:image\/\w+;base64,/, '');
          const buffer = Buffer.from(base64Data, 'base64');

          // Upload to S3
          const s3Result = await uploadToS3(buffer, 'photo.jpg', 'image/jpeg', `work-areas/${id}`);
          photoUrl = s3Result.fileUrl;
          thumbnailUrl = s3Result.fileUrl;
        } else {
          // No S3 configured - store as base64 data URL
          console.log('S3 not configured, storing photo as base64 data URL');
          photoUrl = req.body.photo;  // Keep the full base64 data URL
          thumbnailUrl = req.body.photo;
        }
      } catch (uploadError) {
        console.error('Error uploading to S3, falling back to base64:', uploadError);
        // Fallback to storing as base64 data URL
        photoUrl = req.body.photo;
        thumbnailUrl = req.body.photo;
      }

      caption = req.body.caption || `Photo from ${req.body.date || new Date().toISOString().split('T')[0]}`;
      takenBy = req.body.takenBy || 'Field Worker';
      // Convert date string to proper timestamp
      if (req.body.date) {
        takenDate = new Date(req.body.date + 'T12:00:00Z').toISOString();
      } else {
        takenDate = new Date().toISOString();
      }
    } else if (req.body.photoUrl || req.body.photo_url) {
      // Handle already uploaded URL (support both camelCase and snake_case)
      const {
        photoUrl: pUrl,
        photo_url,
        thumbnailUrl: tUrl,
        thumbnail_url,
        caption: cap,
        takenBy: by,
        taken_by_name,
        taken_date,
        taken_at
      } = req.body;

      photoUrl = pUrl || photo_url;
      thumbnailUrl = tUrl || thumbnail_url || photoUrl;
      caption = cap || `Work area photo - ${new Date().toLocaleDateString()}`;
      takenBy = by || taken_by_name || 'Field Worker';
      takenDate = taken_date || taken_at || new Date().toISOString();
    } else {
      console.error('No photo data provided in request body:', Object.keys(req.body));
      return res.status(400).json({ error: 'No photo data provided', receivedFields: Object.keys(req.body) });
    }

    // Log the data we're about to insert
    console.log('Attempting to insert photo with data:', {
      work_area_id: id,
      photo_url: photoUrl ? photoUrl.substring(0, 100) + '...' : 'null',
      thumbnail_url: thumbnailUrl ? thumbnailUrl.substring(0, 100) + '...' : 'null',
      caption: caption,
      taken_by_name: takenBy,
      taken_at: takenDate
    });

    const result = await pool.query(`
      INSERT INTO area_photos
      (work_area_id, photo_url, thumbnail_url, caption, taken_by_name, taken_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [id, photoUrl, thumbnailUrl, caption, takenBy, takenDate]);

    console.log('Photo saved successfully:', {
      id: result.rows[0].id,
      work_area_id: result.rows[0].work_area_id,
      taken_at: result.rows[0].taken_at,
      photo_url: photoUrl.substring(0, 50) + '...'
    });

    // Set explicit CORS headers for this response
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error saving photo:', err);
    console.error('Error details:', {
      code: err.code,
      message: err.message,
      detail: err.detail,
      table: err.table,
      column: err.column
    });

    // If area_photos table doesn't exist, create it
    if (err.code === '42P01') {
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS area_photos (
            id SERIAL PRIMARY KEY,
            work_area_id UUID REFERENCES work_areas(id) ON DELETE CASCADE,
            photo_url TEXT NOT NULL,
            thumbnail_url TEXT,
            caption TEXT,
            taken_by_name VARCHAR(255),
            taken_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Retry the insert
        const result = await pool.query(`
          INSERT INTO area_photos
          (work_area_id, photo_url, thumbnail_url, caption, taken_by_name, taken_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *
        `, [id, photoUrl, thumbnailUrl, caption, takenBy, takenDate]);

        res.json(result.rows[0]);
      } catch (createErr) {
        console.error('Error creating area_photos table:', createErr);
        res.status(500).json({ error: createErr.message });
      }
    } else {
      // Return more detailed error information
      res.status(500).json({
        error: err.message,
        code: err.code,
        detail: err.detail || 'Database error occurred',
        hint: err.hint || 'Check if the photo_url and caption are not too long',
        requestData: {
          work_area_id: id,
          hasPhotoUrl: !!photoUrl,
          hasThumbnailUrl: !!thumbnailUrl,
          caption: caption,
          takenBy: takenBy
        }
      });
    }
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

// Assign worker to work area
app.post('/api/work-areas/:areaId/assign-worker', async (req, res) => {
  const { areaId } = req.params;
  const { workerId, date } = req.body;
  const assignDate = date || getEasternDate();

  try {
    // First ensure the table exists with proper structure
    await pool.query(`
      CREATE TABLE IF NOT EXISTS work_area_workers (
        id SERIAL PRIMARY KEY,
        work_area_id UUID NOT NULL,
        worker_id INTEGER NOT NULL,
        work_date DATE NOT NULL,
        worker_name VARCHAR(255),
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        hours_worked DECIMAL(4,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(work_area_id, worker_id, work_date)
      )
    `).catch(() => {});

    // Get worker name
    const workerResult = await pool.query(
      'SELECT name FROM users WHERE id = $1',
      [workerId]
    );
    const workerName = workerResult.rows.length > 0 ? workerResult.rows[0].name : null;

    // Check if assignment already exists
    const existing = await pool.query(
      `SELECT id FROM work_area_workers
       WHERE work_area_id::text = $1 AND worker_id = $2 AND work_date = $3`,
      [areaId, workerId, assignDate]
    );

    if (existing.rows.length > 0) {
      return res.json({ message: 'Worker already assigned to this area for today', success: true });
    }

    // Create assignment with worker name
    const result = await pool.query(
      `INSERT INTO work_area_workers (work_area_id, worker_id, work_date, worker_name, assigned_at)
       VALUES ($1::uuid, $2, $3, $4, NOW())
       RETURNING *`,
      [areaId, workerId, assignDate, workerName]
    );

    console.log(`Assigned worker ${workerName} (${workerId}) to work area ${areaId} for date ${assignDate}`);
    res.json({ ...result.rows[0], success: true, worker_name: workerName });
  } catch (err) {
    console.error('Error assigning worker to work area:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get workers assigned to a work area
app.get('/api/work-areas/:areaId/workers', async (req, res) => {
  const { areaId } = req.params;
  const { date } = req.query;
  const workDate = date || getEasternDate();

  try {
    const result = await pool.query(
      `SELECT
        u.id as worker_id,
        u.name as worker_name,
        u.name as user_name,
        u.role,
        waw.assigned_at,
        ws.signin_time,
        ws.signout_time,
        CASE
          WHEN ws.signout_time IS NOT NULL AND ws.signin_time IS NOT NULL
          THEN EXTRACT(EPOCH FROM (ws.signout_time - ws.signin_time))/3600
          ELSE NULL
        END as hours_worked
       FROM work_area_workers waw
       JOIN users u ON waw.worker_id = u.id
       LEFT JOIN worker_signins ws ON u.name = ws.worker_name
         AND ws.signin_date = waw.work_date
       WHERE waw.work_area_id::text = $1 AND waw.work_date = $2
       ORDER BY u.name`,
      [areaId, workDate]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching work area workers:', err);
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

// Get work areas assigned to a foreman (MOCK DATA for Romeu)
app.get('/api/foreman/work-areas/:foremanId', async (req, res) => {
  const { foremanId } = req.params;

  // Mock data for Romeu Morim (ID: 14)
  if (foremanId === '14') {
    const mockWorkAreas = [
      {
        id: 'pc3-rs-03',
        name: 'PC3-RS-03',
        description: 'Primary Clarifiers - Train 3',
        location: 'Wastewater Treatment Plant - North Section',
        status: 'active',
        current_stage: 'formwork',
        start_date: new Date().toISOString(),
        end_date: null,
        foreman_assigned_date: new Date().toISOString(),
        workers_today: 12,
        total_documents: 8,
        open_rfis: 2,
        pending_instructions: 1,
        pending_change_orders: 0,
        today_concrete_volume: 125.5,
        today_photos: 3
      }
    ];

    res.json(mockWorkAreas);
  } else {
    res.json([]);
  }
});

// Get work area details with documents, RFIs, etc. (MOCK DATA)
app.get('/api/work-areas/:areaId/details', async (req, res) => {
  const { areaId } = req.params;

  // Mock data for PC3-RS-03
  if (areaId === 'pc3-rs-03') {
    const mockDetails = {
      area: {
        id: 'pc3-rs-03',
        name: 'PC3-RS-03',
        description: 'Primary Clarifiers - Train 3',
        location: 'Wastewater Treatment Plant - North Section',
        status: 'active',
        current_stage: 'formwork'
      },
      documents: [
        {
          id: 1,
          document_type: 'layout_submission',
          name: 'PC3-Foundation-Layout-Rev2.pdf',
          uploaded_by_name: 'John Smith',
          uploaded_at: new Date('2025-01-18').toISOString()
        },
        {
          id: 2,
          document_type: 'work_order_change',
          name: 'WOC-PC3-001-Rebar-Change.pdf',
          uploaded_by_name: 'Project Manager',
          uploaded_at: new Date('2025-01-17').toISOString()
        }
      ],
      rfis: [
        {
          id: 1,
          rfi_number: 'RFI-PC3-001',
          title: 'Rebar Spacing Clarification',
          description: 'Need clarification on rebar spacing for clarifier wall section 3B',
          status: 'open',
          priority: 'high',
          submitted_by_name: 'Romeu Morim',
          submitted_date: new Date('2025-01-19').toISOString(),
          response_needed_by: new Date('2025-01-21').toISOString()
        },
        {
          id: 2,
          rfi_number: 'RFI-PC3-002',
          title: 'Waterstop Detail at Construction Joint',
          description: 'Please confirm waterstop type and installation method at CJ-3',
          status: 'open',
          priority: 'normal',
          submitted_by_name: 'Site Engineer',
          submitted_date: new Date('2025-01-18').toISOString()
        }
      ],
      siteInstructions: [
        {
          id: 1,
          instruction_number: 'SI-PC3-001',
          title: 'Concrete Pour Sequence',
          description: 'Follow the attached pour sequence for clarifier base slab. Pour in 3 sections as marked.',
          instruction_type: 'method',
          issued_by: 'Project Engineer',
          issued_date: new Date('2025-01-19').toISOString(),
          acknowledgement_required: true,
          acknowledged_date: null
        }
      ],
      changeOrders: [],
      todayConcretePour: {
        expected_volume_m3: 125.5,
        concrete_type: '35MPa',
        supplier: 'Ready Mix Concrete Co.',
        start_time: '08:00',
        notes: 'Foundation pour for clarifier base slab - Section A'
      },
      todayWorkers: [
        { id: 1, worker_name: 'Mike Johnson', role: 'Concrete Foreman', check_in_time: '06:30', hours_worked: 4 },
        { id: 2, worker_name: 'Carlos Rodriguez', role: 'Rebar Installer', check_in_time: '06:45', hours_worked: 3.5 },
        { id: 3, worker_name: 'Tom Wilson', role: 'Formwork Carpenter', check_in_time: '07:00', hours_worked: 3 },
        { id: 4, worker_name: 'David Chen', role: 'Concrete Finisher', check_in_time: '07:00', hours_worked: 3 },
        { id: 5, worker_name: 'James Brown', role: 'Equipment Operator', check_in_time: '06:30', hours_worked: 4 }
      ],
      recentPhotos: [
        {
          id: 1,
          photo_url: '/placeholder-photo-1.jpg',
          thumbnail_url: '/placeholder-photo-1-thumb.jpg',
          caption: 'Rebar installation progress - North wall',
          taken_at: new Date('2025-01-19T10:30:00').toISOString()
        },
        {
          id: 2,
          photo_url: '/placeholder-photo-2.jpg',
          thumbnail_url: '/placeholder-photo-2-thumb.jpg',
          caption: 'Formwork setup complete - Section A',
          taken_at: new Date('2025-01-19T09:15:00').toISOString()
        }
      ]
    };

    res.json(mockDetails);
  } else {
    res.status(404).json({ error: 'Work area not found' });
  }
});

// Upload document to work area
app.post('/api/work-areas/:areaId/documents', async (req, res) => {
  const { areaId } = req.params;
  const { document_type, name, file_url, file_size, file_type, uploaded_by, uploaded_by_name, description } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO area_documents
       (work_area_id, document_type, name, file_url, file_size, file_type, uploaded_by, uploaded_by_name, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [areaId, document_type, name, file_url, file_size, file_type, uploaded_by, uploaded_by_name, description]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error uploading document:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create or update concrete pour info
app.post('/api/work-areas/:areaId/concrete-pour', async (req, res) => {
  const { areaId } = req.params;
  const { pour_date, expected_volume_m3, concrete_type, supplier, notes, created_by } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO work_area_concrete_pours
       (work_area_id, pour_date, expected_volume_m3, concrete_type, supplier, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (work_area_id, pour_date)
       DO UPDATE SET
         expected_volume_m3 = $3,
         concrete_type = $4,
         supplier = $5,
         notes = $6,
         updated_at = NOW()
       RETURNING *`,
      [areaId, pour_date, expected_volume_m3, concrete_type, supplier, notes, created_by]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error saving concrete pour info:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get today's attendance for a work area
app.get('/api/work-areas/:areaId/attendance/today', async (req, res) => {
  const { areaId } = req.params;

  try {
    const result = await pool.query(
      `SELECT awa.*, u.name as worker_full_name, u.role as worker_role
       FROM area_worker_assignments awa
       LEFT JOIN users u ON awa.worker_id = u.id
       WHERE awa.work_area_id = $1 AND awa.assignment_date = CURRENT_DATE
       ORDER BY awa.check_in_time`,
      [areaId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching attendance:', err);
    res.status(500).json({ error: err.message });
  }
});

// Setup initial work area for Romeu
app.get('/api/setup-romeu-work-area', async (req, res) => {
  try {
    // Check if work area already exists
    let areaResult = await pool.query(
      `SELECT * FROM work_areas WHERE name = 'PC3-RS-03'`
    );

    if (areaResult.rows.length === 0) {
      // Create new work area
      areaResult = await pool.query(
        `INSERT INTO work_areas (
          name,
          description,
          location,
          status,
          current_stage,
          start_date,
          created_by
        ) VALUES (
          'PC3-RS-03',
          'Primary Clarifiers - Train 3',
          'Wastewater Treatment Plant - North Section',
          'active',
          'initial_layout',
          CURRENT_DATE,
          14
        ) RETURNING *`
      );
    }

    const workAreaId = areaResult.rows[0].id;

    // Then assign Romeu as the foreman
    const assignmentResult = await pool.query(
      `INSERT INTO work_area_foreman_assignments (
        work_area_id,
        foreman_id,
        foreman_name,
        assigned_date,
        is_active,
        assigned_by,
        notes
      ) VALUES (
        $1,
        14,
        'Romeu Morim',
        CURRENT_DATE,
        true,
        1,
        'Initial assignment to Primary Clarifiers - Train 3'
      ) RETURNING *`,
      [workAreaId]
    );

    // Add some sample concrete pour data for today
    await pool.query(
      `INSERT INTO work_area_concrete_pours (
        work_area_id,
        pour_date,
        expected_volume_m3,
        concrete_type,
        supplier,
        notes,
        created_by
      ) VALUES (
        $1,
        CURRENT_DATE,
        125.5,
        '35MPa',
        'Ready Mix Concrete Co.',
        'Foundation pour for clarifier base slab',
        14
      )`,
      [workAreaId]
    );

    // Add sample RFI
    await pool.query(
      `INSERT INTO work_area_rfis (
        work_area_id,
        rfi_number,
        title,
        description,
        status,
        priority,
        submitted_by,
        submitted_by_name,
        submitted_date
      ) VALUES (
        $1,
        'RFI-PC3-001',
        'Rebar Spacing Clarification',
        'Need clarification on rebar spacing for clarifier wall section 3B',
        'open',
        'high',
        14,
        'Romeu Morim',
        CURRENT_DATE
      )`,
      [workAreaId]
    );

    // Add sample site instruction
    await pool.query(
      `INSERT INTO work_area_site_instructions (
        work_area_id,
        instruction_number,
        title,
        description,
        instruction_type,
        issued_by,
        issued_date,
        acknowledgement_required
      ) VALUES (
        $1,
        'SI-PC3-001',
        'Concrete Pour Sequence',
        'Follow the attached pour sequence for clarifier base slab. Pour in 3 sections as marked.',
        'method',
        'Project Engineer',
        CURRENT_DATE,
        true
      )`,
      [workAreaId]
    );

    res.json({
      message: 'Work area PC3-RS-03 created and assigned to Romeu Morim',
      workArea: areaResult.rows[0],
      assignment: assignmentResult.rows[0]
    });
  } catch (err) {
    console.error('Error setting up work area:', err);
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

// Weather Events endpoints (for Construction Calendar)
app.get('/api/weather-events', async (req, res) => {
  try {
    const { month, year } = req.query;

    let query = 'SELECT * FROM weather_events';
    const params = [];

    if (month && year) {
      query += ' WHERE EXTRACT(MONTH FROM date) = $1 AND EXTRACT(YEAR FROM date) = $2';
      params.push(month, year);
    }

    query += ' ORDER BY date DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching weather events:', err);
    res.json([]); // Return empty array if table doesn't exist
  }
});

app.post('/api/weather-events', async (req, res) => {
  try {
    const {
      date,
      type,
      start_time,
      end_time,
      hours_worked,
      description,
      affected_projects,
      crew_count
    } = req.body;

    // Create table if doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS weather_events (
        id SERIAL PRIMARY KEY,
        date DATE NOT NULL,
        type VARCHAR(50) NOT NULL,
        start_time VARCHAR(10),
        end_time VARCHAR(10),
        hours_worked DECIMAL(4,2),
        description TEXT,
        affected_projects JSONB,
        crew_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(date)
      )
    `);

    const result = await pool.query(`
      INSERT INTO weather_events (
        date, type, start_time, end_time, hours_worked,
        description, affected_projects, crew_count
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (date) DO UPDATE SET
        type = EXCLUDED.type,
        start_time = EXCLUDED.start_time,
        end_time = EXCLUDED.end_time,
        hours_worked = EXCLUDED.hours_worked,
        description = EXCLUDED.description,
        affected_projects = EXCLUDED.affected_projects,
        crew_count = EXCLUDED.crew_count,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [
      date,
      type,
      start_time,
      end_time,
      hours_worked,
      description,
      JSON.stringify(affected_projects),
      crew_count
    ]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error saving weather event:', err);
    res.status(500).json({ error: err.message });
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
// Get unread material requests count
app.get('/api/material-requests/unread-count', async (req, res) => {
  try {
    // Ensure table has a viewed column
    await pool.query(`
      ALTER TABLE material_requests
      ADD COLUMN IF NOT EXISTS viewed BOOLEAN DEFAULT FALSE
    `);

    // Count unviewed requests
    const result = await pool.query(
      `SELECT COUNT(*) as count
       FROM material_requests
       WHERE viewed = FALSE
       AND status IN ('pending', 'approved')`
    );

    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error('Error getting unread count:', err);
    res.json({ count: 0 });
  }
});

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

// Mark all material requests as viewed
app.put('/api/material-requests/mark-viewed', async (req, res) => {
  try {
    await pool.query(
      `UPDATE material_requests
       SET viewed = TRUE
       WHERE viewed = FALSE`
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error marking requests as viewed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/material-requests', upload.array('photos', 5), async (req, res) => {
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
    // Ensure table exists with photo_urls column
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
        photo_urls TEXT[],
        status VARCHAR(50) DEFAULT 'pending',
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP,
        updated_by VARCHAR(255),
        completion_notes TEXT
      )
    `);

    // Add photo_urls column if it doesn't exist
    await pool.query(`
      ALTER TABLE material_requests
      ADD COLUMN IF NOT EXISTS photo_urls TEXT[]
    `);

    // Upload photos to S3 if provided
    let photoUrls = [];
    if (req.files && req.files.length > 0) {
      const uploadPromises = req.files.map(file =>
        uploadToS3(file.buffer, file.originalname, file.mimetype, 'material-requests')
      );
      const uploadResults = await Promise.all(uploadPromises);
      photoUrls = uploadResults.map(result => result.fileUrl);
    }

    // Parse items if it's a string (from FormData)
    const parsedItems = typeof items === 'string' ? JSON.parse(items) : items;

    const result = await pool.query(
      `INSERT INTO material_requests
       (worker_id, worker_name, project_id, project_name, items, urgency, delivery_date, notes, photo_urls)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [worker_id, worker_name, project_id, project_name, parsedItems, urgency, delivery_date, notes, photoUrls]
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

// ============================================
// MJR COMMUNITY FEED API ENDPOINTS
// ============================================

// Get all community feed posts with stats
app.get('/api/community-feed', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.*,
        COALESCE(l.like_count, 0) as like_count,
        COALESCE(c.comment_count, 0) as comment_count,
        COALESCE(ul.user_liked, false) as user_liked
      FROM community_feed_posts p
      LEFT JOIN (
        SELECT post_id, COUNT(*) as like_count
        FROM community_feed_likes
        GROUP BY post_id
      ) l ON p.id = l.post_id
      LEFT JOIN (
        SELECT post_id, COUNT(*) as comment_count
        FROM community_feed_comments
        GROUP BY post_id
      ) c ON p.id = c.post_id
      LEFT JOIN (
        SELECT post_id, true as user_liked
        FROM community_feed_likes
        WHERE user_id = $1
      ) ul ON p.id = ul.post_id
      ORDER BY p.created_at DESC
    `, [req.query.user_id || 0]);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching community feed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create a new feed post (manual post)
app.post('/api/community-feed', upload.single('photo'), async (req, res) => {
  try {
    const { foreman_id, foreman_name, work_area_id, work_area_name, caption } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'Photo is required' });
    }

    // Upload photo to S3
    const uploadResult = await uploadToS3(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      'community-feed'
    );

    const result = await pool.query(`
      INSERT INTO community_feed_posts
      (foreman_id, foreman_name, work_area_id, work_area_name, photo_url, caption, post_type)
      VALUES ($1, $2, $3, $4, $5, $6, 'manual')
      RETURNING *
    `, [foreman_id, foreman_name, work_area_id, work_area_name, uploadResult.fileUrl, caption]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error creating feed post:', err);
    res.status(500).json({ error: err.message });
  }
});

// Auto-create feed post from work area photo upload
app.post('/api/community-feed/from-work-area', async (req, res) => {
  try {
    const { foreman_id, foreman_name, work_area_id, work_area_name, photo_url, task_id, caption } = req.body;

    const result = await pool.query(`
      INSERT INTO community_feed_posts
      (foreman_id, foreman_name, work_area_id, work_area_name, photo_url, caption, post_type, task_id)
      VALUES ($1, $2, $3, $4, $5, $6, 'work_area_progress', $7)
      RETURNING *
    `, [foreman_id, foreman_name, work_area_id, work_area_name, photo_url, caption, task_id]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error creating feed post from work area:', err);
    res.status(500).json({ error: err.message });
  }
});

// Like a post
app.post('/api/community-feed/:postId/like', async (req, res) => {
  try {
    const { postId } = req.params;
    const { user_id, user_name } = req.body;

    const result = await pool.query(`
      INSERT INTO community_feed_likes (post_id, user_id, user_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (post_id, user_id) DO NOTHING
      RETURNING *
    `, [postId, user_id, user_name]);

    res.json(result.rows[0] || { message: 'Already liked' });
  } catch (err) {
    console.error('Error liking post:', err);
    res.status(500).json({ error: err.message });
  }
});

// Unlike a post
app.delete('/api/community-feed/:postId/like', async (req, res) => {
  try {
    const { postId } = req.params;
    const { user_id } = req.body;

    const result = await pool.query(`
      DELETE FROM community_feed_likes
      WHERE post_id = $1 AND user_id = $2
      RETURNING *
    `, [postId, user_id]);

    res.json(result.rows[0] || { message: 'Like not found' });
  } catch (err) {
    console.error('Error unliking post:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get comments for a post
app.get('/api/community-feed/:postId/comments', async (req, res) => {
  try {
    const { postId } = req.params;

    const result = await pool.query(`
      SELECT * FROM community_feed_comments
      WHERE post_id = $1
      ORDER BY created_at ASC
    `, [postId]);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching comments:', err);
    res.status(500).json({ error: err.message });
  }
});

// Add a comment to a post
app.post('/api/community-feed/:postId/comments', async (req, res) => {
  try {
    const { postId } = req.params;
    const { user_id, user_name, comment_text } = req.body;

    const result = await pool.query(`
      INSERT INTO community_feed_comments (post_id, user_id, user_name, comment_text)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [postId, user_id, user_name, comment_text]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error adding comment:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a comment
app.delete('/api/community-feed/comments/:commentId', async (req, res) => {
  try {
    const { commentId } = req.params;
    const { user_id } = req.body;

    const result = await pool.query(`
      DELETE FROM community_feed_comments
      WHERE id = $1 AND user_id = $2
      RETURNING *
    `, [commentId, user_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found or unauthorized' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error deleting comment:', err);
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

// RFI (Request for Information) endpoints
app.get('/api/rfi', async (req, res) => {
  try {
    // Create RFI table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rfi_requests (
        id SERIAL PRIMARY KEY,
        worker_id INTEGER,
        worker_name VARCHAR(255),
        project_id INTEGER,
        project_name VARCHAR(255),
        subject VARCHAR(255) NOT NULL,
        description TEXT NOT NULL,
        priority VARCHAR(20) DEFAULT 'medium',
        category VARCHAR(50),
        attachments JSONB,
        response TEXT,
        responded_by VARCHAR(255),
        responded_at TIMESTAMP,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const result = await pool.query(`
      SELECT * FROM rfi_requests
      ORDER BY
        CASE
          WHEN status = 'pending' THEN 0
          WHEN status = 'in_review' THEN 1
          WHEN status = 'answered' THEN 2
          ELSE 3
        END,
        CASE priority
          WHEN 'high' THEN 0
          WHEN 'medium' THEN 1
          WHEN 'low' THEN 2
          ELSE 3
        END,
        created_at DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching RFI requests:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rfi', async (req, res) => {
  const {
    worker_id,
    worker_name,
    project_id,
    project_name,
    subject,
    description,
    priority,
    category,
    attachments
  } = req.body;

  try {
    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rfi_requests (
        id SERIAL PRIMARY KEY,
        worker_id INTEGER,
        worker_name VARCHAR(255),
        project_id INTEGER,
        project_name VARCHAR(255),
        subject VARCHAR(255) NOT NULL,
        description TEXT NOT NULL,
        priority VARCHAR(20) DEFAULT 'medium',
        category VARCHAR(50),
        attachments JSONB,
        response TEXT,
        responded_by VARCHAR(255),
        responded_at TIMESTAMP,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const result = await pool.query(`
      INSERT INTO rfi_requests (
        worker_id, worker_name, project_id, project_name,
        subject, description, priority, category, attachments, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [
      worker_id, worker_name, project_id, project_name,
      subject, description, priority || 'medium', category,
      attachments ? JSON.stringify(attachments) : null, 'pending'
    ]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error creating RFI request:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rfi/:id', async (req, res) => {
  const { id } = req.params;
  const { status, response, responded_by } = req.body;

  try {
    const result = await pool.query(`
      UPDATE rfi_requests
      SET status = $1, response = $2, responded_by = $3,
          responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
    `, [status, response, responded_by, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'RFI request not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating RFI request:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/rfi/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM rfi_requests WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'RFI request not found' });
    }

    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('Error deleting RFI request:', err);
    res.status(500).json({ error: err.message });
  }
});

// Timesheet endpoints for fetching real worked hours
app.get('/api/timesheets/weekly', async (req, res) => {
  const { userId, startDate, endDate } = req.query;

  try {
    // Fetch timesheets for the requested period using existing column names
    let query = `
      SELECT
        date,
        start_time as sign_in_time,
        end_time as sign_out_time,
        COALESCE(break_duration, break_hours * 60, 0) as break_duration,
        COALESCE(total_hours, hours_worked, 0) as total_hours,
        COALESCE(overtime_hours, 0) as overtime_hours,
        project_name,
        work_description as task_description,
        COALESCE(status, 'pending') as status
      FROM timesheets
      WHERE 1=1
    `;

    const params = [];

    if (userId) {
      // Try to match by worker_id or by worker_name from users table
      const userResult = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
      if (userResult.rows.length > 0) {
        params.push(userId, userResult.rows[0].name);
        query += ` AND (worker_id = $1 OR worker_name = $2)`;
      } else {
        params.push(userId);
        query += ` AND worker_id = $1`;
      }
    }

    if (startDate) {
      params.push(startDate);
      query += ` AND date >= $${params.length}`;
    }

    if (endDate) {
      params.push(endDate);
      query += ` AND date <= $${params.length}`;
    }

    query += ' ORDER BY date DESC';

    const result = await pool.query(query, params);

    res.json({
      success: true,
      timesheets: result.rows
    });
  } catch (err) {
    console.error('Error fetching weekly timesheets:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get previous weeks' timesheet submissions
app.get('/api/timesheets/history', async (req, res) => {
  const { userId, weeks = 4 } = req.query;

  try {
    const weeksAgo = new Date();
    weeksAgo.setDate(weeksAgo.getDate() - (weeks * 7));

    let query = `
      SELECT
        date_trunc('week', date) as week_start,
        COUNT(DISTINCT date) as days_worked,
        SUM(COALESCE(total_hours, hours_worked, 0)) as total_hours,
        SUM(COALESCE(overtime_hours, 0)) as overtime_hours,
        STRING_AGG(DISTINCT project_name, ', ') as projects
      FROM timesheets
      WHERE date >= $1
    `;

    const params = [weeksAgo];

    if (userId) {
      params.push(userId);
      query += ` AND (worker_id = $${params.length} OR worker_name = (SELECT name FROM users WHERE id = $${params.length}))`;
    }

    query += ` GROUP BY date_trunc('week', date)
               ORDER BY week_start DESC`;

    const result = await pool.query(query, params);

    res.json({
      success: true,
      history: result.rows
    });
  } catch (err) {
    console.error('Error fetching timesheet history:', err);
    res.status(500).json({ error: err.message });
  }
});

// Work Orders endpoints
app.post('/api/work-orders', async (req, res) => {
  const {
    projectId,
    workAreaId,
    foremanId,
    foremanName,
    contractor,
    workType,
    equipmentRental,
    startDate,
    endDate,
    description,
    workers
  } = req.body;

  try {
    // Create work_orders table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS work_orders (
        id SERIAL PRIMARY KEY,
        project_id INTEGER,
        work_area_id INTEGER,
        foreman_id INTEGER,
        foreman_name VARCHAR(255),
        contractor VARCHAR(255),
        work_type VARCHAR(100),
        equipment_rental VARCHAR(100),
        start_date DATE,
        end_date DATE,
        description TEXT,
        workers JSONB,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Insert the work order
    const result = await pool.query(
      `INSERT INTO work_orders
       (project_id, work_area_id, foreman_id, foreman_name, contractor, work_type,
        equipment_rental, start_date, end_date, description, workers)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [projectId, workAreaId, foremanId, foremanName, contractor, workType,
       equipmentRental, startDate, endDate, description, JSON.stringify(workers)]
    );

    res.json({
      success: true,
      workOrder: result.rows[0]
    });
  } catch (err) {
    console.error('Error creating work order:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all work orders
app.get('/api/work-orders', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM work_orders
       ORDER BY created_at DESC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching work orders:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get work order by ID
app.get('/api/work-orders/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT * FROM work_orders WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Work order not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching work order:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update work order status
app.put('/api/work-orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    const result = await pool.query(
      `UPDATE work_orders
       SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Work order not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating work order status:', err);
    res.status(500).json({ error: err.message });
  }
});

// Worker Profile endpoints

// Get available workers - MUST BE BEFORE dynamic :workerId route
app.get('/api/workers/available', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, role
       FROM workers
       ORDER BY name`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching available workers:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workers/:workerId', async (req, res) => {
  const { workerId } = req.params;

  // Validate workerId
  if (!workerId || isNaN(parseInt(workerId))) {
    return res.status(400).json({ error: 'Invalid worker ID' });
  }

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

    // Get worker basic info from users table
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [workerId]);

    if (userResult.rows.length === 0) {
      console.log(`Worker not found with ID: ${workerId}`);
      return res.status(404).json({ error: 'Worker not found' });
    }

    const user = userResult.rows[0];

    // Get worker details from worker_details table (may not exist for all workers)
    let detailsResult = { rows: [] };
    try {
      detailsResult = await pool.query(
        'SELECT * FROM worker_details WHERE user_id = $1',
        [workerId]
      );
    } catch (detailsErr) {
      console.log(`No worker_details found for worker ${workerId}:`, detailsErr.message);
    }

    // Get worker info from workers_info table (may not exist for all workers)
    let infoResult = { rows: [] };
    try {
      infoResult = await pool.query('SELECT * FROM workers_info WHERE id = $1', [workerId]);
    } catch (infoErr) {
      console.log(`No workers_info found for worker ${workerId}:`, infoErr.message);
    }

    // Get certifications from worker_certifications (may not exist for all workers)
    let certResult = { rows: [] };
    try {
      certResult = await pool.query(
        'SELECT * FROM worker_certifications WHERE worker_id = $1 ORDER BY issue_date DESC',
        [workerId]
      );
    } catch (certErr) {
      console.log(`No certifications found for worker ${workerId}:`, certErr.message);
    }

    // Combine all data - handle potential null/undefined values
    const workerData = {
      id: user.id,
      name: user.name,
      role: user.role,
      phone: infoResult.rows[0]?.phone || detailsResult.rows[0]?.phone || user.phone || null,
      email: infoResult.rows[0]?.email || detailsResult.rows[0]?.email || user.email || null,
      address: infoResult.rows[0]?.address || detailsResult.rows[0]?.address || null,
      emergencyContact: infoResult.rows[0]?.emergency_contact || detailsResult.rows[0]?.emergency_contact || null,
      emergencyPhone: infoResult.rows[0]?.emergency_phone || detailsResult.rows[0]?.emergency_phone || null,
      position: infoResult.rows[0]?.position || user.position || 'Worker',
      dateOfBirth: detailsResult.rows[0]?.date_of_birth || null,
      language: detailsResult.rows[0]?.language || 'en',
      registrationDate: detailsResult.rows[0]?.created_at || user.created_at || null,
      certifications: certResult.rows,
      certificates: {
        workingAtHeights: detailsResult.rows[0]?.working_at_heights_cert || null,
        whimis: detailsResult.rows[0]?.whimis_cert || null,
        worker4Step: detailsResult.rows[0]?.worker_4step_cert || null
      }
    };

    res.json(workerData);
  } catch (err) {
    console.error('Error fetching worker:', err);
    res.status(500).json({
      error: 'Failed to fetch worker data',
      details: err.message
    });
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
    // Get worker name from ID
    const workerResult = await pool.query(
      'SELECT name FROM users WHERE id = $1',
      [workerId]
    );

    if (workerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Worker not found' });
    }

    const workerName = workerResult.rows[0].name;

    // Get attendance based on worker sign-ins
    const result = await pool.query(
      `SELECT
        ws.signin_date as date,
        CASE
          WHEN ws.signout_time IS NOT NULL THEN 'present'
          WHEN ws.signin_time IS NOT NULL THEN 'present'
          ELSE 'absent'
        END as status,
        CASE
          WHEN ws.signin_time IS NOT NULL AND ws.signout_time IS NOT NULL THEN
            EXTRACT(EPOCH FROM (ws.signout_time - ws.signin_time))/3600
          WHEN ws.signin_time IS NOT NULL THEN
            -- If signed in but not signed out, assume they're still working or worked 9.5 hours
            CASE
              WHEN ws.signin_date = CURRENT_DATE THEN
                EXTRACT(EPOCH FROM (NOW() - ws.signin_time))/3600
              ELSE 9.5 -- Default to 9.5 hours if sign-out missing from previous day
            END
          ELSE 0
        END as hours_worked
       FROM worker_signins ws
       WHERE LOWER(ws.worker_name) = LOWER($1)
       AND ws.signin_date >= $2
       AND ws.signin_date <= $3
       ORDER BY ws.signin_date`,
      [workerName, start_date, end_date]
    );

    // Also check if worker signed in before 6:15 AM and signed out after 4:00 PM for 9.5 hours
    const attendanceWithProperHours = result.rows.map(row => {
      if (row.status === 'present' && row.hours_worked > 0) {
        // If worked more than 9 hours, cap at 9.5 for standard day
        if (row.hours_worked >= 9) {
          row.hours_worked = 9.5;
        }
      }
      return row;
    });

    res.json(attendanceWithProperHours);
  } catch (err) {
    console.error('Error fetching attendance:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workers/:workerId/timesheet-summary', async (req, res) => {
  const { workerId } = req.params;

  try {
    // Get worker name from ID
    const workerResult = await pool.query(
      'SELECT name FROM users WHERE id = $1',
      [workerId]
    );

    if (workerResult.rows.length === 0) {
      return res.json([{ week: 0, regular_hours: 0, overtime_hours: 0, total_hours: 0 }]);
    }

    const workerName = workerResult.rows[0].name;

    // Calculate weekly hours from worker_signins
    const result = await pool.query(
      `SELECT
        EXTRACT(WEEK FROM signin_date) as week,
        SUM(
          CASE
            WHEN signin_time IS NOT NULL AND signout_time IS NOT NULL THEN
              LEAST(EXTRACT(EPOCH FROM (signout_time - signin_time))/3600, 9.5)
            WHEN signin_time IS NOT NULL THEN 9.5 -- Default to 9.5 hours if no sign-out
            ELSE 0
          END
        ) as total_hours
       FROM worker_signins
       WHERE LOWER(worker_name) = LOWER($1)
       AND signin_date >= CURRENT_DATE - INTERVAL '12 weeks'
       GROUP BY EXTRACT(WEEK FROM signin_date)
       ORDER BY week DESC
       LIMIT 12`,
      [workerName]
    );

    // Format the response to include regular and overtime hours
    const formattedResult = result.rows.map(row => ({
      week: parseInt(row.week),
      regular_hours: Math.min(parseFloat(row.total_hours) || 0, 40),
      overtime_hours: Math.max(parseFloat(row.total_hours) - 40 || 0, 0),
      total_hours: parseFloat(row.total_hours) || 0
    }));

    res.json(formattedResult);
  } catch (err) {
    console.error('Error fetching timesheet summary:', err);
    res.status(500).json({ error: err.message });
  }
});

// Concrete Pour Tracking
app.get('/api/concrete-pours', async (req, res) => {
  try {
    // Create table if not exists with consistent structure
    await pool.query(`
      CREATE TABLE IF NOT EXISTS concrete_pours (
        id SERIAL PRIMARY KEY,
        project_name VARCHAR(255),
        pour_date DATE,
        area VARCHAR(255),
        location TEXT,
        planned_volume DECIMAL(10,2),
        actual_volume DECIMAL(10,2),
        planned_start TIMESTAMP,
        planned_end TIMESTAMP,
        actual_start TIMESTAMP,
        actual_end TIMESTAMP,
        concrete_type VARCHAR(100),
        mix_type TEXT,
        supplier VARCHAR(255),
        supervisor VARCHAR(255),
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
// ====================
// Foreman Location Management Endpoints
// ====================

// Get locations for a foreman
app.get('/api/foreman/locations/:foremanId', async (req, res) => {
  const { foremanId } = req.params;

  try {
    // Get all projects and their current status
    const result = await pool.query(`
      SELECT
        p.id,
        p.name,
        p.address,
        p.id as project_id,
        p.name as project_name,
        true as active,
        COUNT(DISTINCT ws.worker_name) as workers_present,
        p.created_at
      FROM projects p
      LEFT JOIN worker_signins ws ON p.id = ws.project_id
        AND DATE(ws.signin_date) = CURRENT_DATE
        AND ws.signout_time IS NULL
      GROUP BY p.id, p.name, p.address, p.created_at
      ORDER BY p.name
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching locations:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get worker locations for today
app.get('/api/foreman/worker-locations', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        ws.worker_name,
        u.id as worker_id,
        ws.signin_time as check_in_time,
        ws.signout_time as check_out_time,
        p.name as location,
        p.address as address,
        CASE
          WHEN ws.signout_time IS NULL THEN 'present'
          ELSE 'checked_out'
        END as status
      FROM worker_signins ws
      JOIN projects p ON ws.project_id = p.id
      LEFT JOIN users u ON LOWER(u.name) = LOWER(ws.worker_name)
      WHERE DATE(ws.signin_date) = CURRENT_DATE
      ORDER BY ws.signin_time DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching worker locations:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get attendance data with location info
app.get('/api/foreman/attendance-locations', async (req, res) => {
  const { date } = req.query;
  const targetDate = date || new Date().toISOString().split('T')[0];

  try {
    const result = await pool.query(`
      SELECT
        a.worker_name,
        a.check_in_time,
        a.check_out_time,
        a.sign_in_latitude,
        a.sign_in_longitude,
        a.sign_in_address,
        a.sign_out_latitude,
        a.sign_out_longitude,
        a.sign_out_address,
        a.status
      FROM attendance a
      WHERE DATE(a.date) = $1
      ORDER BY a.check_in_time DESC
    `, [targetDate]);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching attendance locations:', err);
    res.status(500).json({ error: err.message });
  }
});

// ====================
// Safety Certificates Endpoints
// ====================

// Create safety certificates table if not exists
app.get('/api/safety-certificates/init', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS safety_certificates (
        id SERIAL PRIMARY KEY,
        worker_id INTEGER,
        worker_name TEXT NOT NULL,
        certificate_type TEXT NOT NULL,
        certificate_name TEXT NOT NULL,
        issuing_organization TEXT,
        issue_date DATE NOT NULL,
        expiry_date DATE NOT NULL,
        certificate_number TEXT,
        file_url TEXT,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_safety_certificates_worker_id ON safety_certificates(worker_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_safety_certificates_expiry_date ON safety_certificates(expiry_date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_safety_certificates_status ON safety_certificates(status)`);

    res.json({ message: 'Safety certificates table initialized' });
  } catch (err) {
    console.error('Error initializing safety certificates table:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get certificates for a worker
app.get('/api/safety-certificates/worker/:workerId', async (req, res) => {
  const { workerId } = req.params;

  try {
    // First ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS safety_certificates (
        id SERIAL PRIMARY KEY,
        worker_id INTEGER,
        worker_name TEXT NOT NULL,
        certificate_type TEXT NOT NULL,
        certificate_name TEXT NOT NULL,
        issuing_organization TEXT,
        issue_date DATE NOT NULL,
        expiry_date DATE NOT NULL,
        certificate_number TEXT,
        file_url TEXT,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).catch(() => {});

    // Update status based on expiry dates
    await pool.query(`
      UPDATE safety_certificates
      SET status = CASE
        WHEN expiry_date < CURRENT_DATE THEN 'expired'
        WHEN expiry_date <= CURRENT_DATE + INTERVAL '30 days' THEN 'expiring_soon'
        ELSE 'active'
      END
      WHERE worker_id = $1
    `, [workerId]);

    // Fetch certificates
    const result = await pool.query(
      `SELECT * FROM safety_certificates
       WHERE worker_id = $1
       ORDER BY
         CASE status
           WHEN 'expired' THEN 1
           WHEN 'expiring_soon' THEN 2
           ELSE 3
         END,
         expiry_date ASC`,
      [workerId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching safety certificates:', err);
    res.status(500).json({ error: err.message });
  }
});

// Add sample certificates for testing
app.post('/api/safety-certificates/add-samples/:workerId', async (req, res) => {
  const { workerId } = req.params;

  try {
    // First ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS safety_certificates (
        id SERIAL PRIMARY KEY,
        worker_id INTEGER,
        worker_name TEXT NOT NULL,
        certificate_type TEXT NOT NULL,
        certificate_name TEXT NOT NULL,
        issuing_organization TEXT,
        issue_date DATE NOT NULL,
        expiry_date DATE NOT NULL,
        certificate_number TEXT,
        file_url TEXT,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).catch(() => {});

    // Get worker name
    const userResult = await pool.query('SELECT name FROM users WHERE id = $1', [workerId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Worker not found' });
    }
    const workerName = userResult.rows[0].name;

    // Sample certificates
    const samples = [
      {
        certificate_type: 'Safety Training',
        certificate_name: 'OSHA 30-Hour Construction',
        issuing_organization: 'OSHA',
        issue_date: '2024-01-15',
        expiry_date: '2026-01-15',
        certificate_number: 'OSHA-2024-' + Math.random().toString(36).substr(2, 9).toUpperCase()
      },
      {
        certificate_type: 'Medical',
        certificate_name: 'First Aid & CPR',
        issuing_organization: 'American Red Cross',
        issue_date: '2024-06-01',
        expiry_date: '2025-02-01', // Expiring soon
        certificate_number: 'ARC-' + Math.random().toString(36).substr(2, 9).toUpperCase()
      },
      {
        certificate_type: 'Equipment',
        certificate_name: 'Forklift Operation',
        issuing_organization: 'National Safety Council',
        issue_date: '2023-03-15',
        expiry_date: '2024-03-15', // Expired
        certificate_number: 'NSC-FL-' + Math.random().toString(36).substr(2, 9).toUpperCase()
      },
      {
        certificate_type: 'Safety Training',
        certificate_name: 'Fall Protection',
        issuing_organization: 'Construction Safety Institute',
        issue_date: '2024-08-01',
        expiry_date: '2025-08-01',
        certificate_number: 'CSI-FP-' + Math.random().toString(36).substr(2, 9).toUpperCase()
      }
    ];

    const inserted = [];
    for (const cert of samples) {
      const status = new Date(cert.expiry_date) < new Date() ? 'expired' :
                    new Date(cert.expiry_date) <= new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) ? 'expiring_soon' :
                    'active';

      const result = await pool.query(
        `INSERT INTO safety_certificates
         (worker_id, worker_name, certificate_type, certificate_name, issuing_organization,
          issue_date, expiry_date, certificate_number, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [workerId, workerName, cert.certificate_type, cert.certificate_name, cert.issuing_organization,
         cert.issue_date, cert.expiry_date, cert.certificate_number, status]
      );
      if (result.rows.length > 0) {
        inserted.push(result.rows[0]);
      }
    }

    res.json({ message: 'Sample certificates added', certificates: inserted });
  } catch (err) {
    console.error('Error adding sample certificates:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workers/:workerId/certifications', async (req, res) => {
  const { workerId } = req.params;
  const { name, issuer, issue_date, expiry_date } = req.body;

  // Validate workerId
  if (!workerId || isNaN(parseInt(workerId))) {
    return res.status(400).json({ error: 'Invalid worker ID' });
  }

  // Validate required fields
  if (!name || !issuer || !issue_date) {
    return res.status(400).json({
      error: 'Missing required fields',
      details: 'name, issuer, and issue_date are required'
    });
  }

  try {
    // Create table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS worker_certifications (
        id SERIAL PRIMARY KEY,
        worker_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        issuer TEXT NOT NULL,
        issue_date DATE NOT NULL,
        expiry_date DATE,
        file_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).catch((err) => {
      console.log('Table worker_certifications might already exist:', err.message);
    });

    // Validate dates
    const issueDateObj = new Date(issue_date);
    const expiryDateObj = expiry_date ? new Date(expiry_date) : null;

    if (isNaN(issueDateObj.getTime())) {
      return res.status(400).json({ error: 'Invalid issue date format' });
    }

    if (expiryDateObj && isNaN(expiryDateObj.getTime())) {
      return res.status(400).json({ error: 'Invalid expiry date format' });
    }

    // Check if worker exists
    const workerCheck = await pool.query('SELECT id FROM users WHERE id = $1', [workerId]);
    if (workerCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Worker not found' });
    }

    const result = await pool.query(
      `INSERT INTO worker_certifications (worker_id, name, issuer, issue_date, expiry_date)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [workerId, name, issuer, issue_date, expiry_date || null]
    );

    console.log(`Added certification for worker ${workerId}: ${name}`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error adding certification:', err);
    res.status(500).json({
      error: 'Failed to add certification',
      details: err.message
    });
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

// Photo endpoints
app.get('/api/photos/work-area/:workAreaId', async (req, res) => {
  const { workAreaId } = req.params;

  try {
    const result = await pool.query(
      `SELECT * FROM area_photos
       WHERE work_area_id = $1
       ORDER BY taken_at DESC`,
      [workAreaId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching work area photos:', err);
    res.status(500).json({ error: err.message });
  }
});

// New endpoint for EnhancedPhotoManager component
app.post('/api/photos/upload', upload.array('photos', 10), async (req, res) => {
  try {
    const { workAreaId, workAreaName, projectId, userId, userName, category, latitude, longitude, address } = req.body;

    if (!workAreaId) {
      return res.status(400).json({ error: 'Work area ID is required' });
    }

    const uploadedPhotos = [];

    // Process each uploaded file
    for (const file of req.files || []) {
      try {
        // Upload to S3
        const s3Result = await uploadToS3(file.buffer, file.originalname, file.mimetype, `work-areas/${workAreaId}`);

        // Save to database
        const dbResult = await pool.query(`
          INSERT INTO area_photos
          (work_area_id, photo_url, thumbnail_url, caption, taken_by_name, taken_at, category, latitude, longitude, location_address)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING *
        `, [
          workAreaId,
          s3Result.fileUrl,
          s3Result.fileUrl, // Use same URL for thumbnail for now
          `${category || 'general'} photo from ${workAreaName}`,
          userName || 'Field Worker',
          new Date(),
          category || 'general',
          latitude || null,
          longitude || null,
          address || null
        ]);

        uploadedPhotos.push({
          id: dbResult.rows[0].id,
          url: s3Result.fileUrl,
          thumbnailUrl: s3Result.fileUrl,
          category: category || 'general',
          tags: [],
          description: dbResult.rows[0].caption,
          location: latitude && longitude ? { latitude, longitude, address } : null,
          timestamp: dbResult.rows[0].taken_at,
          workAreaId,
          workAreaName,
          uploadedBy: userName || 'Field Worker'
        });

        // Auto-post to community feed if category is 'progress'
        if (category === 'progress') {
          try {
            await pool.query(`
              INSERT INTO community_feed_posts
              (foreman_id, foreman_name, work_area_id, work_area_name, photo_url, caption, post_type)
              VALUES ($1, $2, $3, $4, $5, $6, 'work_area_progress')
            `, [
              userId,
              userName,
              workAreaId,
              workAreaName,
              s3Result.fileUrl,
              `Progress update from ${workAreaName}`
            ]);
            console.log('Auto-posted to community feed');
          } catch (feedErr) {
            console.error('Error posting to community feed:', feedErr);
            // Don't fail the photo upload if feed posting fails
          }
        }
      } catch (uploadErr) {
        console.error('Error uploading individual photo:', uploadErr);
      }
    }

    // If no files but base64 data is provided (fallback)
    if ((!req.files || req.files.length === 0) && req.body.photoData) {
      const photoData = req.body.photoData;
      const base64Data = photoData.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');

      const s3Result = await uploadToS3(buffer, 'photo.jpg', 'image/jpeg', `work-areas/${workAreaId}`);

      const dbResult = await pool.query(`
        INSERT INTO area_photos
        (work_area_id, photo_url, thumbnail_url, caption, taken_by_name, taken_at, category)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [
        workAreaId,
        s3Result.fileUrl,
        s3Result.fileUrl,
        `${category || 'general'} photo from ${workAreaName}`,
        userName || 'Field Worker',
        new Date(),
        category || 'general'
      ]);

      uploadedPhotos.push({
        id: dbResult.rows[0].id,
        url: s3Result.fileUrl,
        thumbnailUrl: s3Result.fileUrl,
        category: category || 'general',
        tags: [],
        description: dbResult.rows[0].caption,
        timestamp: dbResult.rows[0].taken_at,
        workAreaId,
        workAreaName,
        uploadedBy: userName || 'Field Worker'
      });
    }

    res.json(uploadedPhotos);
  } catch (err) {
    console.error('Error in photo upload:', err);

    // Create table if it doesn't exist
    if (err.code === '42P01') {
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS area_photos (
            id SERIAL PRIMARY KEY,
            work_area_id UUID REFERENCES work_areas(id) ON DELETE CASCADE,
            photo_url TEXT NOT NULL,
            thumbnail_url TEXT,
            caption TEXT,
            taken_by_name VARCHAR(255),
            taken_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            category VARCHAR(50) DEFAULT 'general',
            latitude DECIMAL(10, 8),
            longitude DECIMAL(11, 8),
            location_address TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Retry the request
        return app._router.handle(req, res);
      } catch (createErr) {
        console.error('Error creating table:', createErr);
      }
    }

    res.status(500).json({ error: err.message });
  }
});

// Get all photos for a specific area
app.get('/api/area-photos/:areaId', async (req, res) => {
  const { areaId } = req.params;

  try {
    const result = await pool.query(
      `SELECT * FROM area_photos
       WHERE work_area_id = $1
       ORDER BY taken_at DESC`,
      [areaId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching area photos:', err);
    res.status(500).json({ error: err.message });
  }
});

// Safety Procedures endpoints
app.get('/api/safety-procedures', async (req, res) => {
  const { project_id, work_area_id, category } = req.query;

  try {
    let query = `
      SELECT * FROM safety_procedures
      WHERE is_active = true
    `;
    const params = [];

    if (project_id) {
      params.push(project_id);
      query += ` AND project_id = $${params.length}`;
    }

    if (work_area_id) {
      params.push(work_area_id);
      query += ` AND work_area_id = $${params.length}`;
    }

    if (category && category !== 'all') {
      params.push(category);
      query += ` AND category = $${params.length}`;
    }

    query += ` ORDER BY uploaded_at DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching safety procedures:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get presigned URL for safety procedure upload
app.post('/api/safety-procedures/presigned-url', async (req, res) => {
  const { fileName, fileType } = req.body;

  if (!fileName || !fileType) {
    return res.status(400).json({ error: 'File name and type are required' });
  }

  if (fileType !== 'application/pdf') {
    return res.status(400).json({ error: 'Only PDF files are allowed' });
  }

  try {
    // Use the existing generatePresignedUrl function from s3-upload module
    const result = await generatePresignedUrl(fileName, fileType, 'safety-procedures');
    res.json(result);
  } catch (err) {
    console.error('Error generating presigned URL:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create safety procedure
app.post('/api/safety-procedures', async (req, res) => {
  const {
    title,
    description,
    category,
    file_url,
    file_name,
    file_size,
    version,
    tags,
    project_id,
    work_area_id,
    uploaded_by
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO safety_procedures (
        title, description, category, file_url, file_name,
        file_size, version, tags, project_id, work_area_id,
        uploaded_by, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
      RETURNING *`,
      [
        title, description, category, file_url, file_name,
        file_size, version, tags, project_id, work_area_id,
        uploaded_by || 'Foreman'
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error creating safety procedure:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete safety procedure
app.delete('/api/safety-procedures/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `UPDATE safety_procedures
       SET is_active = false, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Safety procedure not found' });
    }

    res.json({ message: 'Safety procedure deleted successfully' });
  } catch (err) {
    console.error('Error deleting safety procedure:', err);
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

// Get work area activities for calendar
app.get('/api/work-areas/:workAreaId/activities', async (req, res) => {
  const { workAreaId } = req.params;
  const { start, end } = req.query;

  try {
    // Get daily activities for the work area in the date range
    // Since worker_signins doesn't have work_area_id, we'll use work_area_workers table
    const query = `
      WITH daily_workers AS (
        SELECT
          waw.work_date as date,
          COUNT(DISTINCT waw.worker_id) as workers_count
        FROM work_area_workers waw
        WHERE waw.work_area_id = $1
          AND waw.work_date BETWEEN $2 AND $3
        GROUP BY waw.work_date
      ),
      daily_signins AS (
        SELECT
          ws.signin_date as date,
          COUNT(DISTINCT ws.worker_id) as workers_signed_in,
          COALESCE(SUM(
            CASE
              WHEN ws.signout_time IS NOT NULL THEN
                EXTRACT(EPOCH FROM (ws.signout_time - ws.signin_time)) / 3600
              ELSE 0
            END
          ), 0) as hours_worked
        FROM worker_signins ws
        WHERE ws.signin_date BETWEEN $2 AND $3
          AND EXISTS (
            SELECT 1 FROM work_area_workers waw
            WHERE waw.worker_id = ws.worker_id
              AND waw.work_area_id = $1
              AND waw.work_date = ws.signin_date
          )
        GROUP BY ws.signin_date
      ),
      photo_data AS (
        SELECT
          DATE(taken_at) as date,
          COUNT(*) as photos_count
        FROM area_photos
        WHERE work_area_id::varchar = $1
          AND DATE(taken_at) BETWEEN $2 AND $3
        GROUP BY DATE(taken_at)
      ),
      all_dates AS (
        SELECT generate_series($2::date, $3::date, '1 day'::interval)::date as date
      )
      SELECT
        to_char(ad.date, 'YYYY-MM-DD') as date,
        COALESCE(ds.workers_signed_in, dw.workers_count, 0) as workers_count,
        ROUND(COALESCE(ds.hours_worked, 0)::numeric, 1) as hours_worked,
        COALESCE(pd.photos_count, 0) as photos_count,
        (COALESCE(ds.workers_signed_in, dw.workers_count, 0) > 0 OR COALESCE(pd.photos_count, 0) > 0) as has_activity
      FROM all_dates ad
      LEFT JOIN daily_workers dw ON ad.date = dw.date
      LEFT JOIN daily_signins ds ON ad.date = ds.date
      LEFT JOIN photo_data pd ON ad.date = pd.date
      ORDER BY ad.date
    `;

    const result = await pool.query(query, [workAreaId, start, end]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching work area activities:', err);
    res.status(500).json({ error: err.message });
  }
});

// Daily tasks endpoints
app.get('/api/work-areas/:workAreaId/daily-tasks', async (req, res) => {
  const { workAreaId } = req.params;
  const { date } = req.query;

  try {
    const result = await pool.query(
      `SELECT * FROM daily_tasks
       WHERE work_area_id = $1 AND task_date = $2
       ORDER BY updated_at DESC, created_at DESC`,
      [workAreaId, date]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching daily tasks:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get timeline of tasks for date range
app.get('/api/work-areas/:workAreaId/timeline', async (req, res) => {
  const { workAreaId } = req.params;
  const { start, end } = req.query;

  try {
    const result = await pool.query(
      `SELECT
        dt.*,
        dt.task_date as start_date,
        CASE
          WHEN dt.status = 'completed' THEN dt.task_date
          WHEN dt.status = 'in_progress' THEN CURRENT_DATE
          ELSE dt.task_date + INTERVAL '1 day'
        END as end_date,
        CASE
          WHEN dt.status = 'completed' THEN 1
          WHEN dt.status = 'in_progress' THEN
            GREATEST(1, (CURRENT_DATE - dt.task_date) + 1)
          ELSE 1
        END as duration_days
       FROM daily_tasks dt
       WHERE dt.work_area_id = $1
         AND dt.task_date BETWEEN $2 AND $3
         AND dt.status != 'archived'
       ORDER BY dt.task_date, dt.sequence_order`,
      [workAreaId, start, end]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching timeline:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/work-areas/:workAreaId/daily-tasks', async (req, res) => {
  const { workAreaId } = req.params;
  const { date, task_type, status = 'in_progress', continue_previous } = req.body;

  try {
    // Check if we should continue a previous task
    if (continue_previous) {
      // Find the most recent task of this type
      const previousTask = await pool.query(
        `SELECT * FROM daily_tasks
         WHERE work_area_id = $1 AND task_type = $2 AND status = 'in_progress'
         ORDER BY task_date DESC
         LIMIT 1`,
        [workAreaId, task_type]
      );

      if (previousTask.rows.length > 0) {
        // Task continues from previous day
        res.json(previousTask.rows[0]);
        return;
      }
    }

    // Calculate sequence order for the entire work area timeline
    const sequenceResult = await pool.query(
      `SELECT MAX(sequence_order) as max_order FROM daily_tasks
       WHERE work_area_id = $1`,
      [workAreaId]
    );
    const sequence_order = (sequenceResult.rows[0].max_order || 0) + 1;

    const result = await pool.query(
      `INSERT INTO daily_tasks (work_area_id, task_date, task_type, status, sequence_order)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (work_area_id, task_date, task_type)
       DO UPDATE SET status = $4, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [workAreaId, date, task_type, status, sequence_order]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error creating daily task:', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/daily-tasks/:taskId', async (req, res) => {
  const { taskId } = req.params;
  const { status, end_time, end_date, duration_days } = req.body;

  try {
    let query = 'UPDATE daily_tasks SET updated_at = CURRENT_TIMESTAMP';
    const params = [];
    let paramCount = 1;

    if (status) {
      query += `, status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    if (end_time) {
      query += `, end_time = $${paramCount}`;
      params.push(end_time);
      paramCount++;
    }

    if (end_date) {
      query += `, end_date = $${paramCount}`;
      params.push(end_date);
      paramCount++;
    }

    if (duration_days) {
      query += `, duration_days = $${paramCount}`;
      params.push(duration_days);
      paramCount++;
    }

    // If task is completed, set end_time to current time
    if (status === 'completed' && !end_time) {
      const now = new Date();
      query += `, end_time = $${paramCount}`;
      params.push(`${now.getHours()}:${now.getMinutes()}`);
      paramCount++;
    }

    query += ` WHERE id = $${paramCount} RETURNING *`;
    params.push(taskId);

    const result = await pool.query(query, params);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating task:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete daily task endpoint
app.delete('/api/daily-tasks/:taskId', async (req, res) => {
  const { taskId } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM daily_tasks WHERE id = $1 RETURNING *',
      [taskId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json({ message: 'Task deleted successfully', task: result.rows[0] });
  } catch (err) {
    console.error('Error deleting task:', err);
    res.status(500).json({ error: err.message });
  }
});

// REMOVED DUPLICATE - Using the endpoint at line 3552 instead

// Test endpoint to check database connectivity
app.get('/api/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      status: 'connected',
      time: result.rows[0].now,
      message: 'Database connection successful'
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: err.message,
      detail: 'Database connection failed'
    });
  }
});

// Simplified worker assignment endpoint
app.post('/api/work-areas/:workAreaId/workers/simple', async (req, res) => {
  const { workAreaId } = req.params;
  const { worker_id } = req.body;

  try {
    // Just return success without database operation for now
    res.json({
      success: true,
      work_area_id: workAreaId,
      worker_id: worker_id,
      message: 'Worker assignment recorded (simplified)',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error' });
  }
});

app.post('/api/work-areas/:workAreaId/workers', async (req, res) => {
  const { workAreaId } = req.params;
  const { worker_id, work_date } = req.body;

  console.log('Adding worker to work area:', { workAreaId, worker_id, work_date });

  try {
    // Convert worker_id to integer if it's a string
    const workerId = parseInt(worker_id, 10);

    if (isNaN(workerId)) {
      console.error('Invalid worker_id:', worker_id);
      return res.status(400).json({ error: 'Invalid worker_id - must be a number' });
    }

    // Get worker name from users table
    let workerName = null;
    try {
      const workerResult = await pool.query(
        'SELECT name FROM users WHERE id = $1',
        [workerId]
      );
      if (workerResult.rows.length > 0) {
        workerName = workerResult.rows[0].name;
      }
    } catch (e) {
      console.log('Error looking up worker name:', e.message);
    }

    // Use current date if not provided
    const assignmentDate = work_date || new Date().toISOString().split('T')[0];

    // Try to insert into database
    try {
      const result = await pool.query(
        `INSERT INTO work_area_workers (work_area_id, worker_id, work_date, worker_name)
         VALUES ($1::uuid, $2, $3, $4)
         ON CONFLICT (work_area_id, worker_id, work_date)
         DO UPDATE SET
           worker_name = EXCLUDED.worker_name,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [workAreaId, workerId, assignmentDate, workerName]
      );

      console.log('Worker assigned successfully:', result.rows[0]);
      res.json(result.rows[0]);
    } catch (dbErr) {
      console.error('Database error:', dbErr.message);
      console.error('Error code:', dbErr.code);

      // If table doesn't exist, create it
      if (dbErr.code === '42P01') { // undefined_table
        console.log('Table does not exist, attempting to create...');

        try {
          // Create the table
          await pool.query(`
            CREATE TABLE work_area_workers (
              id SERIAL PRIMARY KEY,
              work_area_id UUID NOT NULL,
              worker_id INTEGER NOT NULL,
              work_date DATE DEFAULT CURRENT_DATE,
              worker_name VARCHAR(255),
              assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              hours_worked DECIMAL(4,2),
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `);

          // Create unique constraint
          await pool.query(`
            CREATE UNIQUE INDEX unique_work_area_worker_date
            ON work_area_workers(work_area_id, worker_id, work_date)
          `);

          console.log('Table created successfully, retrying insert...');

          // Retry the insert
          const retryResult = await pool.query(
            `INSERT INTO work_area_workers (work_area_id, worker_id, work_date, worker_name)
             VALUES ($1::uuid, $2, $3, $4)
             RETURNING *`,
            [workAreaId, workerId, assignmentDate, workerName]
          );

          res.json(retryResult.rows[0]);
        } catch (createErr) {
          console.error('Failed to create table:', createErr);
          res.status(500).json({
            error: 'Database table creation failed',
            detail: createErr.message,
            hint: 'Please run the SQL migration script manually in Supabase'
          });
        }
      } else {
        // Other database errors
        res.status(500).json({
          error: 'Database operation failed',
          code: dbErr.code,
          detail: dbErr.message,
          hint: 'Check if work_area_id exists and is valid UUID'
        });
      }
    }

  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({
      error: 'Server error',
      message: err.message
    });
  }
});

app.delete('/api/work-areas/:workAreaId/workers/:workerId', async (req, res) => {
  const { workAreaId, workerId } = req.params;
  const { date } = req.query;

  // Validate workerId
  if (!workerId || workerId === 'undefined' || workerId === 'null') {
    console.error('Invalid workerId in DELETE request:', workerId);
    // Return success even if workerId is invalid to prevent UI errors
    return res.json({ success: true, message: 'Worker ID was invalid, no deletion performed' });
  }

  // Convert workerId to integer
  const workerIdInt = parseInt(workerId, 10);
  if (isNaN(workerIdInt)) {
    console.error('WorkerId is not a valid number:', workerId);
    // Return success even if workerId is invalid to prevent UI errors
    return res.json({ success: true, message: 'Worker ID was not a number, no deletion performed' });
  }

  try {
    const result = await pool.query(
      `DELETE FROM work_area_workers
       WHERE work_area_id = $1 AND worker_id = $2 AND work_date = $3`,
      [workAreaId, workerIdInt, date]
    );

    console.log(`Removed worker ${workerIdInt} from work area ${workAreaId} for date ${date}`);
    res.json({ success: true, rowsDeleted: result.rowCount });
  } catch (err) {
    console.error('Error removing worker:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a photo
app.delete('/api/work-areas/:workAreaId/photos/:photoId', async (req, res) => {
  const { workAreaId, photoId } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM area_photos WHERE id = $1 AND work_area_id::text = $2 RETURNING *',
      [photoId, workAreaId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    console.log(`Deleted photo ${photoId} from work area ${workAreaId}`);
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('Error deleting photo:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get photos for work area with flexible date filtering
app.get('/api/work-areas/:workAreaId/photos', async (req, res) => {
  const { workAreaId } = req.params;
  const { date, start_date, end_date, all } = req.query;

  console.log('Photo fetch request:', { workAreaId, date, start_date, end_date, all });

  try {
    let query;
    let params = [workAreaId];

    if (all === 'true') {
      // Return all photos for debugging
      query = `SELECT * FROM area_photos WHERE work_area_id = $1 ORDER BY taken_at DESC`;
    } else if (start_date && end_date) {
      // Date range query
      query = `SELECT * FROM area_photos
               WHERE work_area_id = $1
               AND DATE(taken_at) >= $2
               AND DATE(taken_at) <= $3
               ORDER BY taken_at DESC`;
      params.push(start_date, end_date);
    } else if (date) {
      // Single date query
      query = `SELECT * FROM area_photos
               WHERE work_area_id = $1
               AND DATE(taken_at) = $2
               ORDER BY taken_at DESC`;
      params.push(date);
    } else {
      // Default: return all photos
      query = `SELECT * FROM area_photos WHERE work_area_id = $1 ORDER BY taken_at DESC LIMIT 100`;
    }

    const result = await pool.query(query, params);
    console.log(`Returning ${result.rows.length} photos for work area ${workAreaId}`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching photos:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============= DRAWINGS ENDPOINTS =============

// Get presigned URL for uploading drawings
app.post('/api/work-areas/:workAreaId/drawings/presigned-url', async (req, res) => {
  const { workAreaId } = req.params;
  const { fileName, fileType } = req.body;

  try {
    const result = await generatePresignedUrl(fileName, fileType, `work-areas/${workAreaId}/drawings`);
    res.json(result);
  } catch (err) {
    console.error('Error generating presigned URL for drawing:', err);
    res.status(500).json({ error: err.message });
  }
});

// Save drawing metadata
app.post('/api/work-areas/:workAreaId/drawings', async (req, res) => {
  const { workAreaId } = req.params;
  const { title, revision, file_url, description, uploaded_by } = req.body;

  try {
    // Create drawings table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS drawings (
        id SERIAL PRIMARY KEY,
        work_area_id UUID NOT NULL,
        title VARCHAR(255) NOT NULL,
        revision VARCHAR(50),
        file_url TEXT NOT NULL,
        description TEXT,
        uploaded_by VARCHAR(255),
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        file_size BIGINT,
        file_type VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Insert drawing metadata
    const result = await pool.query(
      `INSERT INTO drawings
       (work_area_id, title, revision, file_url, description, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [workAreaId, title, revision, file_url, description, uploaded_by]
    );

    console.log(`Drawing saved for work area ${workAreaId}:`, result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error saving drawing:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get drawings for a work area
app.get('/api/work-areas/:workAreaId/drawings', async (req, res) => {
  const { workAreaId } = req.params;

  try {
    // Check if drawings table exists
    const tableExists = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'drawings'
      )
    `);

    if (!tableExists.rows[0].exists) {
      return res.json([]);
    }

    const result = await pool.query(
      'SELECT * FROM drawings WHERE work_area_id = $1 ORDER BY uploaded_at DESC',
      [workAreaId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching drawings:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a drawing
app.delete('/api/work-areas/:workAreaId/drawings/:drawingId', async (req, res) => {
  const { workAreaId, drawingId } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM drawings WHERE id = $1 AND work_area_id = $2 RETURNING *',
      [drawingId, workAreaId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Drawing not found' });
    }

    console.log(`Deleted drawing ${drawingId} from work area ${workAreaId}`);
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('Error deleting drawing:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============= RFI ENDPOINTS =============

// Get RFIs for a work area
app.get('/api/work-areas/:workAreaId/rfis', async (req, res) => {
  const { workAreaId } = req.params;

  try {
    // Create RFI table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rfis (
        id SERIAL PRIMARY KEY,
        work_area_id UUID NOT NULL,
        question TEXT NOT NULL,
        answer TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        answered_by VARCHAR(255),
        answered_at TIMESTAMP,
        attachments TEXT[],
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const result = await pool.query(
      'SELECT * FROM rfis WHERE work_area_id = $1 ORDER BY created_at DESC',
      [workAreaId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching RFIs:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create new RFI
app.post('/api/work-areas/:workAreaId/rfis', async (req, res) => {
  const { workAreaId } = req.params;
  const { question, created_by } = req.body;

  try {
    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rfis (
        id SERIAL PRIMARY KEY,
        work_area_id UUID NOT NULL,
        question TEXT NOT NULL,
        answer TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        answered_by VARCHAR(255),
        answered_at TIMESTAMP,
        attachments TEXT[],
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const result = await pool.query(
      `INSERT INTO rfis (work_area_id, question, created_by, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING *`,
      [workAreaId, question, created_by]
    );

    console.log(`RFI created for work area ${workAreaId}:`, result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error creating RFI:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update RFI (answer)
app.put('/api/work-areas/:workAreaId/rfis/:rfiId', async (req, res) => {
  const { workAreaId, rfiId } = req.params;
  const { answer, answered_by, status } = req.body;

  try {
    const result = await pool.query(
      `UPDATE rfis
       SET answer = $1, answered_by = $2, status = $3, answered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND work_area_id = $5
       RETURNING *`,
      [answer, answered_by, status || 'answered', rfiId, workAreaId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'RFI not found' });
    }

    console.log(`RFI ${rfiId} updated for work area ${workAreaId}`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating RFI:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete RFI
app.delete('/api/work-areas/:workAreaId/rfis/:rfiId', async (req, res) => {
  const { workAreaId, rfiId } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM rfis WHERE id = $1 AND work_area_id = $2 RETURNING *',
      [rfiId, workAreaId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'RFI not found' });
    }

    console.log(`Deleted RFI ${rfiId} from work area ${workAreaId}`);
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('Error deleting RFI:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============= SITE INSTRUCTIONS ENDPOINTS =============

// Get instructions for a work area
app.get('/api/work-areas/:workAreaId/instructions', async (req, res) => {
  const { workAreaId } = req.params;

  try {
    // Create instructions table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS site_instructions (
        id SERIAL PRIMARY KEY,
        work_area_id UUID NOT NULL,
        title VARCHAR(255) NOT NULL,
        instruction TEXT NOT NULL,
        issued_by VARCHAR(255),
        issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        acknowledged BOOLEAN DEFAULT false,
        acknowledged_by VARCHAR(255),
        acknowledged_at TIMESTAMP,
        attachments TEXT[],
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const result = await pool.query(
      'SELECT * FROM site_instructions WHERE work_area_id = $1 ORDER BY issued_at DESC',
      [workAreaId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching instructions:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create new instruction
app.post('/api/work-areas/:workAreaId/instructions', async (req, res) => {
  const { workAreaId } = req.params;
  const { title, instruction, issued_by } = req.body;

  try {
    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS site_instructions (
        id SERIAL PRIMARY KEY,
        work_area_id UUID NOT NULL,
        title VARCHAR(255) NOT NULL,
        instruction TEXT NOT NULL,
        issued_by VARCHAR(255),
        issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        acknowledged BOOLEAN DEFAULT false,
        acknowledged_by VARCHAR(255),
        acknowledged_at TIMESTAMP,
        attachments TEXT[],
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const result = await pool.query(
      `INSERT INTO site_instructions (work_area_id, title, instruction, issued_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [workAreaId, title, instruction, issued_by]
    );

    console.log(`Instruction created for work area ${workAreaId}:`, result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error creating instruction:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete instruction
app.delete('/api/work-areas/:workAreaId/instructions/:instructionId', async (req, res) => {
  const { workAreaId, instructionId } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM site_instructions WHERE id = $1 AND work_area_id = $2 RETURNING *',
      [instructionId, workAreaId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Instruction not found' });
    }

    console.log(`Deleted instruction ${instructionId} from work area ${workAreaId}`);
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('Error deleting instruction:', err);
    res.status(500).json({ error: err.message });
  }
});

// Test endpoint for deployment verification
app.get('/api/deployment-test', (req, res) => {
  res.json({
    deployed: true,
    timestamp: new Date().toISOString(),
    version: 'photo-fix-v3'
  });
});

// Export for Vercel
module.exports = app;