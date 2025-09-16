require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cron = require('node-cron');
const { sendJSAEmail } = require('./emailConfig.cjs');

const app = express();
const server = http.createServer(app);

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

// Create or open database - use absolute path to ensure consistency
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'jsa_database.db');
console.log('Database path:', dbPath);
const db = new sqlite3.Database(dbPath);

// Initialize database tables
db.serialize(() => {
  // JSA Forms table
  db.run(`
    CREATE TABLE IF NOT EXISTS jsa_forms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      form_id TEXT UNIQUE,
      crew_supervisor TEXT,
      crew_safety_rep TEXT,
      site_address TEXT,
      company TEXT,
      project_name TEXT,
      date TEXT,
      weather TEXT,
      formwork TEXT,
      status TEXT DEFAULT 'draft',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Add project_name column if it doesn't exist (for existing databases)
  db.run(`ALTER TABLE jsa_forms ADD COLUMN project_name TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.log('Column project_name already exists or error:', err.message);
    }
  });

  // Job Steps table
  db.run(`
    CREATE TABLE IF NOT EXISTS job_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      form_id TEXT,
      sequence INTEGER,
      operation TEXT,
      hazards TEXT,
      safety_controls TEXT,
      risk_level TEXT,
      FOREIGN KEY (form_id) REFERENCES jsa_forms(form_id)
    )
  `);

  // Tools table
  db.run(`
    CREATE TABLE IF NOT EXISTS tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      form_id TEXT,
      tool_name TEXT,
      FOREIGN KEY (form_id) REFERENCES jsa_forms(form_id)
    )
  `);

  // PPE table
  db.run(`
    CREATE TABLE IF NOT EXISTS ppe (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      form_id TEXT,
      ppe_name TEXT,
      FOREIGN KEY (form_id) REFERENCES jsa_forms(form_id)
    )
  `);

  // Crew Members table
  db.run(`
    CREATE TABLE IF NOT EXISTS crew_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      form_id TEXT,
      name TEXT,
      signed BOOLEAN DEFAULT 0,
      is_mobile BOOLEAN DEFAULT 0,
      FOREIGN KEY (form_id) REFERENCES jsa_forms(form_id)
    )
  `);
  
  // Add is_mobile column if it doesn't exist (for existing databases)
  db.run(`ALTER TABLE crew_members ADD COLUMN is_mobile BOOLEAN DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.log('Column is_mobile already exists or error:', err.message);
    }
  });

  // Auto-save table for tracking changes
  db.run(`
    CREATE TABLE IF NOT EXISTS auto_saves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      form_id TEXT,
      field_name TEXT,
      field_value TEXT,
      saved_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Projects table with address
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      description TEXT,
      address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Add address column if it doesn't exist (for existing databases)
  db.run(`ALTER TABLE projects ADD COLUMN address TEXT`, (err) => {
    // Ignore error if column already exists
  });
  
  // Insert default projects with addresses
  db.run(`INSERT OR IGNORE INTO projects (name, description, address) VALUES (?, ?, ?)`, 
    ['GEBOOTH WasteWater Treatment Plant', 'Wastewater treatment facility construction', '1300 Lakeshore East, Mississauga, ON']);
  db.run(`INSERT OR IGNORE INTO projects (name, description, address) VALUES (?, ?, ?)`, 
    ['Victoria', 'Victoria construction project', '5678 Construction Blvd, Victoria, BC']);
  db.run(`INSERT OR IGNORE INTO projects (name, description, address) VALUES (?, ?, ?)`, 
    ['Reservoir and Pump Station', 'Water infrastructure project', '3121 King St. Inglewood, ON. L7C 0R4']);
  
  // Worker sign-ins table
  db.run(`
    CREATE TABLE IF NOT EXISTS worker_signins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_name TEXT NOT NULL,
      project_id INTEGER,
      project_name TEXT,
      site_address TEXT,
      signin_date DATE,
      signin_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      signout_time DATETIME,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    )
  `);
  
  // Users table for authentication
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      pin TEXT NOT NULL,
      role TEXT CHECK(role IN ('supervisor', 'worker')) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Insert default supervisor
  db.run(`INSERT OR IGNORE INTO users (name, email, pin, role) VALUES (?, ?, ?, ?)`,
    ['Admin Supervisor', 'admin@mjr.com', '1234', 'supervisor']);
  
  // Insert default workers with PIN 1111
  const defaultWorkers = [
    'Augusto Duarte',
    'Cesar Duarte', 
    'David Peniche',
    'Migel Sanchez',
    'Armando Hernandez',
    'Luis Mendoza',
    'Francisco Acosta',
    'Luis Gustavo',
    'George',
    'Kevin Fuentes'
  ];
  
  defaultWorkers.forEach(workerName => {
    db.run(
      `INSERT OR IGNORE INTO users (name, pin, role) VALUES (?, ?, ?)`,
      [workerName, '1111', 'worker'],
      (err) => {
        if (err && !err.message.includes('UNIQUE constraint failed')) {
          console.error(`Error inserting worker ${workerName}:`, err);
        } else if (!err) {
          console.log(`Added worker ${workerName} to users table`);
        }
      }
    );
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Join a form room for real-time updates
  socket.on('join-form', (formId) => {
    socket.join(formId);
    console.log(`Socket ${socket.id} joined form ${formId}`);
  });

  // Handle auto-save
  socket.on('auto-save', (data) => {
    const { formId, updates } = data;
    
    // Save to database
    saveFormUpdates(formId, updates, (err) => {
      if (!err) {
        // Broadcast to other clients viewing the same form
        socket.to(formId).emit('form-updated', updates);
      }
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Helper function to save form updates
function saveFormUpdates(formId, updates, callback) {
  const timestamp = new Date().toISOString();
  let hasError = false;
  let pendingOperations = 0;
  
  console.log('saveFormUpdates called with:', { formId, updates: JSON.stringify(updates, null, 2) });
  
  // Function to track completion
  const checkComplete = () => {
    pendingOperations--;
    if (pendingOperations === 0 && callback) {
      const cb = callback;
      callback = null; // Prevent double-calling
      cb(hasError ? new Error('Some updates failed') : null);
    }
  };
  
  // Update main form data
  if (updates.formData) {
    pendingOperations++;
    
    // Map camelCase to snake_case for database columns
    const fieldMapping = {
      crewSupervisor: 'crew_supervisor',
      crewSafetyRep: 'crew_safety_rep',
      siteAddress: 'site_address',
      company: 'company',
      projectName: 'project_name',
      date: 'date',
      weather: 'weather',
      formwork: 'formwork',
      supervisorSignature: 'supervisor_signature'
    };
    
    const fields = Object.keys(updates.formData);
    const mappedFields = fields.filter(field => fieldMapping[field]);
    
    if (mappedFields.length > 0) {
      const setClause = mappedFields
        .map(field => `${fieldMapping[field]} = ?`)
        .join(', ');
      const values = mappedFields
        .map(field => updates.formData[field]);
      values.push(timestamp, formId);
      
      const query = `UPDATE jsa_forms SET ${setClause}, updated_at = ? WHERE form_id = ?`;
      console.log('Executing query:', query);
      console.log('With values:', values);
      
      db.run(query, values, (err) => {
        if (err) {
          console.error('Error updating form data:', err);
          hasError = true;
        } else {
          console.log('Form data updated successfully');
        }
        checkComplete();
      });
    } else {
      console.log('No valid fields to update in formData');
      checkComplete();
    }
  }
  
  // Update job steps
  if (updates.jobSteps) {
    pendingOperations++;
    db.run(`DELETE FROM job_steps WHERE form_id = ?`, [formId], (err) => {
      if (err) {
        hasError = true;
        checkComplete();
        return;
      }
      
      const stmt = db.prepare(`
        INSERT INTO job_steps (form_id, sequence, operation, hazards, safety_controls, risk_level)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      
      updates.jobSteps.forEach(step => {
        stmt.run(
          formId,
          step.sequence,
          step.operation,
          JSON.stringify(step.hazards),
          JSON.stringify(step.safetyControls),
          step.riskLevel
        );
      });
      
      stmt.finalize(() => checkComplete());
    });
  }
  
  // Update tools
  if (updates.tools) {
    pendingOperations++;
    db.run(`DELETE FROM tools WHERE form_id = ?`, [formId], (err) => {
      if (err) {
        hasError = true;
        checkComplete();
        return;
      }
      
      const stmt = db.prepare(`INSERT INTO tools (form_id, tool_name) VALUES (?, ?)`);
      updates.tools.forEach(tool => stmt.run(formId, tool));
      stmt.finalize(() => checkComplete());
    });
  }
  
  // Update PPE
  if (updates.ppe) {
    pendingOperations++;
    db.run(`DELETE FROM ppe WHERE form_id = ?`, [formId], (err) => {
      if (err) {
        hasError = true;
        checkComplete();
        return;
      }
      
      const stmt = db.prepare(`INSERT INTO ppe (form_id, ppe_name) VALUES (?, ?)`);
      updates.ppe.forEach(item => stmt.run(formId, item));
      stmt.finalize(() => checkComplete());
    });
  }
  
  // Update crew members
  if (updates.crew) {
    pendingOperations++;
    db.run(`DELETE FROM crew_members WHERE form_id = ?`, [formId], (err) => {
      if (err) {
        hasError = true;
        checkComplete();
        return;
      }
      
      const stmt = db.prepare(`INSERT INTO crew_members (form_id, name, signed, is_mobile) VALUES (?, ?, ?, ?)`);
      updates.crew.forEach(member => stmt.run(formId, member.name, member.signed, member.isMobile || 0));
      stmt.finalize(() => checkComplete());
    });
  }
  
  // If no operations were queued, call callback immediately
  if (pendingOperations === 0 && callback) {
    callback(null);
  }
}

// REST API endpoints

// Get all projects
app.get('/api/projects', (req, res) => {
  db.all('SELECT * FROM projects ORDER BY name', (err, projects) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(projects);
  });
});

// Add new project with address
app.post('/api/projects', (req, res) => {
  const { name, description, address } = req.body;
  
  db.run(
    'INSERT INTO projects (name, description, address) VALUES (?, ?, ?)',
    [name, description || '', address || ''],
    function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.json({ id: this.lastID, name, description, address });
    }
  );
});

// Get all forms for a specific date
app.get('/api/forms', (req, res) => {
  const { date } = req.query;
  const query = date 
    ? `SELECT * FROM jsa_forms WHERE date = ? ORDER BY updated_at DESC`
    : `SELECT * FROM jsa_forms ORDER BY updated_at DESC LIMIT 50`;
  
  db.all(query, date ? [date] : [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      res.json(rows);
    }
  });
});

// Get a specific form with all details
app.get('/api/forms/:formId', (req, res) => {
  const { formId } = req.params;
  const result = {};
  
  // Get form data
  db.get(`SELECT * FROM jsa_forms WHERE form_id = ?`, [formId], (err, form) => {
    if (err || !form) {
      return res.status(404).json({ error: 'Form not found' });
    }
    
    result.form = form;
    
    // Get job steps
    db.all(`SELECT * FROM job_steps WHERE form_id = ? ORDER BY sequence`, [formId], (err, steps) => {
      result.jobSteps = steps.map(step => ({
        ...step,
        hazards: JSON.parse(step.hazards || '[]'),
        safetyControls: JSON.parse(step.safety_controls || '[]')
      }));
      
      // Get tools
      db.all(`SELECT tool_name FROM tools WHERE form_id = ?`, [formId], (err, tools) => {
        result.tools = tools.map(t => t.tool_name);
        
        // Get PPE
        db.all(`SELECT ppe_name FROM ppe WHERE form_id = ?`, [formId], (err, ppe) => {
          result.ppe = ppe.map(p => p.ppe_name);
          
          // Get crew members
          db.all(`SELECT name, signed, is_mobile FROM crew_members WHERE form_id = ?`, [formId], (err, crew) => {
            result.crew = crew.map(c => ({
              name: c.name,
              signed: c.signed,
              isMobile: c.is_mobile || false
            }));
            res.json(result);
          });
        });
      });
    });
  });
});

// Create new form
app.post('/api/forms', (req, res) => {
  const formId = `JSA-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const { date, company, siteAddress } = req.body;
  
  db.run(
    `INSERT INTO jsa_forms (form_id, date, company, site_address) VALUES (?, ?, ?, ?)`,
    [formId, date, company || 'MJR Contractors Ltd', siteAddress || ''],
    function(err) {
      if (err) {
        console.error('Error creating form:', err.message);
        res.status(500).json({ error: err.message });
      } else {
        console.log('Form created successfully:', formId);
        res.json({ formId, id: this.lastID });
      }
    }
  );
});

// Update form (used for manual save)
app.put('/api/forms/:formId', (req, res) => {
  const { formId } = req.params;
  const updates = req.body;
  
  saveFormUpdates(formId, updates, (err) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      io.to(formId).emit('form-updated', updates);
      res.json({ success: true });
    }
  });
});

// Delete form
app.delete('/api/forms/:formId', (req, res) => {
  const { formId } = req.params;
  
  db.serialize(() => {
    db.run(`DELETE FROM crew_members WHERE form_id = ?`, [formId]);
    db.run(`DELETE FROM ppe WHERE form_id = ?`, [formId]);
    db.run(`DELETE FROM tools WHERE form_id = ?`, [formId]);
    db.run(`DELETE FROM job_steps WHERE form_id = ?`, [formId]);
    db.run(`DELETE FROM jsa_forms WHERE form_id = ?`, [formId], (err) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json({ success: true });
      }
    });
  });
});

// Get forms by date range (for calendar view)
app.get('/api/forms/calendar/:year/:month', (req, res) => {
  const { year, month } = req.params;
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = `${year}-${String(month).padStart(2, '0')}-31`;
  
  db.all(
    `SELECT form_id, date, status, crew_supervisor FROM jsa_forms 
     WHERE date >= ? AND date <= ? 
     ORDER BY date`,
    [startDate, endDate],
    (err, rows) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        // Group by date for calendar display
        const groupedByDate = rows.reduce((acc, row) => {
          if (!acc[row.date]) {
            acc[row.date] = [];
          }
          acc[row.date].push(row);
          return acc;
        }, {});
        res.json(groupedByDate);
      }
    }
  );
});

// Authentication endpoint
app.post('/api/auth/login', (req, res) => {
  const { name, pin } = req.body;
  
  db.get(
    'SELECT id, name, role FROM users WHERE name = ? AND pin = ?',
    [name, pin],
    (err, user) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else if (!user) {
        res.status(401).json({ error: 'Invalid credentials' });
      } else {
        res.json({ user });
      }
    }
  );
});

// Register new worker
app.post('/api/auth/register', (req, res) => {
  const { name, pin, role = 'worker' } = req.body;
  
  db.run(
    'INSERT INTO users (name, pin, role) VALUES (?, ?, ?)',
    [name, pin, role],
    function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json({ 
          user: { 
            id: this.lastID, 
            name, 
            role 
          } 
        });
      }
    }
  );
});

// Function to ensure worker exists in users table
function ensureWorkerExists(workerName, callback) {
  // Check if user already exists
  db.get(
    `SELECT id FROM users WHERE name = ?`,
    [workerName],
    (err, user) => {
      if (err) {
        callback(err);
      } else if (!user) {
        // Create new user with default PIN 1111
        db.run(
          `INSERT INTO users (name, pin, role) VALUES (?, ?, ?)`,
          [workerName, '1111', 'worker'],
          function(err) {
            if (err && !err.message.includes('UNIQUE constraint failed')) {
              callback(err);
            } else {
              console.log(`Created new user account for ${workerName} with default PIN 1111`);
              callback(null);
            }
          }
        );
      } else {
        callback(null);
      }
    }
  );
}

// Worker sign-in
app.post('/api/worker/signin', (req, res) => {
  const { workerName, projectId, projectName, siteAddress } = req.body;
  const signinDate = new Date().toISOString().split('T')[0];
  
  // First ensure the worker exists in the users table
  ensureWorkerExists(workerName, (err) => {
    if (err) {
      console.error('Error ensuring worker exists:', err);
    }
    
    // Check if worker already signed in today
    db.get(
      `SELECT id FROM worker_signins 
       WHERE worker_name = ? AND signin_date = ? AND signout_time IS NULL`,
      [workerName, signinDate],
      (err, existing) => {
        if (existing) {
          res.status(400).json({ error: 'Already signed in today' });
          return;
        }
        
        db.run(
          `INSERT INTO worker_signins (worker_name, project_id, project_name, site_address, signin_date) 
           VALUES (?, ?, ?, ?, ?)`,
          [workerName, projectId, projectName, siteAddress, signinDate],
          function(err) {
            if (err) {
              res.status(500).json({ error: err.message });
            } else {
              // Automatically add worker to today's JSA crew for this project
              addWorkerToTodaysJSA(workerName, projectName, signinDate);
              res.json({ success: true, id: this.lastID });
            }
          }
        );
      }
    );
  });
});

// Worker sign-out
app.post('/api/worker/signout', (req, res) => {
  const { workerName } = req.body;
  const signinDate = new Date().toISOString().split('T')[0];
  
  db.run(
    `UPDATE worker_signins SET signout_time = CURRENT_TIMESTAMP 
     WHERE worker_name = ? AND signin_date = ? AND signout_time IS NULL`,
    [workerName, signinDate],
    (err) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json({ success: true });
      }
    }
  );
});

// Get today's signed-in workers for a project (unique workers only)
app.get('/api/worker/today/:projectName', (req, res) => {
  const { projectName } = req.params;
  const today = new Date().toISOString().split('T')[0];
  
  db.all(
    `SELECT DISTINCT worker_name, 
            MIN(signin_time) as signin_time, 
            MAX(signout_time) as signout_time 
     FROM worker_signins 
     WHERE project_name = ? AND signin_date = ?
     GROUP BY worker_name
     ORDER BY MIN(signin_time)`,
    [projectName, today],
    (err, workers) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json(workers);
      }
    }
  );
});

// Get all today's signed-in workers (for JSA form)
app.get('/api/worker/today', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  
  db.all(
    `SELECT DISTINCT worker_name, project_name, signin_time 
     FROM worker_signins 
     WHERE signin_date = ? AND signout_time IS NULL
     ORDER BY signin_time`,
    [today],
    (err, workers) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json(workers);
      }
    }
  );
});

// Helper function to add worker to today's JSA
function addWorkerToTodaysJSA(workerName, projectName, date) {
  // Find today's JSA for the project
  db.get(
    `SELECT form_id FROM jsa_forms 
     WHERE date = ? AND site_address LIKE ?
     ORDER BY created_at DESC LIMIT 1`,
    [date, `%${projectName}%`],
    (err, form) => {
      if (form) {
        // Check if worker already in crew
        db.get(
          `SELECT id FROM crew_members WHERE form_id = ? AND name = ?`,
          [form.form_id, workerName],
          (err, existing) => {
            if (!existing) {
              // Add worker to crew (mark as mobile since they signed in via mobile app)
              db.run(
                `INSERT INTO crew_members (form_id, name, signed, is_mobile) VALUES (?, ?, ?, ?)`,
                [form.form_id, workerName, 0, 1]
              );
            }
          }
        );
      }
    }
  );
}

// Email endpoints
app.post('/api/email/send', async (req, res) => {
  const { to, formId } = req.body;
  
  // Get JSA data from database
  db.get(
    `SELECT * FROM jsa_forms WHERE form_id = ?`,
    [formId],
    async (err, form) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      
      if (!form) {
        res.status(404).json({ error: 'Form not found' });
        return;
      }
      
      // Get job steps and crew
      db.all(
        `SELECT * FROM job_steps WHERE form_id = ? ORDER BY sequence`,
        [formId],
        async (err, jobSteps) => {
          if (err) {
            res.status(500).json({ error: err.message });
            return;
          }
          
          db.all(
            `SELECT * FROM crew_members WHERE form_id = ?`,
            [formId],
            async (err, crew) => {
              if (err) {
                res.status(500).json({ error: err.message });
                return;
              }
              
              // Prepare JSA data
              const jsaData = {
                ...form,
                jobSteps: jobSteps.map(step => ({
                  ...step,
                  hazards: JSON.parse(step.hazards || '[]'),
                  safetyControls: JSON.parse(step.safety_controls || '[]')
                })),
                crew: crew.map(c => ({ name: c.member_name, signed: c.signed }))
              };
              
              // Send email
              const result = await sendJSAEmail(to, jsaData);
              
              if (result.success) {
                res.json({ success: true, message: 'Email sent successfully' });
              } else {
                res.status(500).json({ error: result.error });
              }
            }
          );
        }
      );
    }
  );
});

// Schedule email - stores schedule in database
app.post('/api/email/schedule', (req, res) => {
  const { formId, email, scheduleTime, cronExpression } = req.body;
  
  // Store schedule in database
  db.run(
    `INSERT INTO email_schedules (form_id, email, schedule_time, cron_expression, created_at) 
     VALUES (?, ?, ?, ?, datetime('now'))`,
    [formId, email, scheduleTime, cronExpression],
    function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      
      // Set up cron job if cronExpression provided
      if (cronExpression) {
        const task = cron.schedule(cronExpression, async () => {
          // Send email logic here (similar to /api/email/send)
          console.log(`Sending scheduled email for form ${formId} to ${email}`);
        });
        
        task.start();
      }
      
      res.json({ success: true, scheduleId: this.lastID });
    }
  );
});

// Create email_schedules table if it doesn't exist
db.run(`
  CREATE TABLE IF NOT EXISTS email_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form_id TEXT NOT NULL,
    email TEXT NOT NULL,
    schedule_time TEXT,
    cron_expression TEXT,
    sent_at TEXT,
    created_at TEXT,
    FOREIGN KEY (form_id) REFERENCES jsa_forms(form_id)
  )
`);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});