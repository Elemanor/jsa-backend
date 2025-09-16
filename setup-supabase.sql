-- Supabase PostgreSQL Setup Script
-- Run this in Supabase SQL Editor after creating your project

-- JSA Forms table
CREATE TABLE IF NOT EXISTS jsa_forms (
  id SERIAL PRIMARY KEY,
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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Job Steps table
CREATE TABLE IF NOT EXISTS job_steps (
  id SERIAL PRIMARY KEY,
  form_id TEXT REFERENCES jsa_forms(form_id) ON DELETE CASCADE,
  sequence INTEGER,
  operation TEXT,
  hazards JSONB,
  safety_controls JSONB,
  risk_level TEXT
);

-- Tools table
CREATE TABLE IF NOT EXISTS tools (
  id SERIAL PRIMARY KEY,
  form_id TEXT REFERENCES jsa_forms(form_id) ON DELETE CASCADE,
  tool_name TEXT
);

-- PPE table
CREATE TABLE IF NOT EXISTS ppe (
  id SERIAL PRIMARY KEY,
  form_id TEXT REFERENCES jsa_forms(form_id) ON DELETE CASCADE,
  ppe_name TEXT
);

-- Crew Members table
CREATE TABLE IF NOT EXISTS crew_members (
  id SERIAL PRIMARY KEY,
  form_id TEXT REFERENCES jsa_forms(form_id) ON DELETE CASCADE,
  name TEXT,
  signed BOOLEAN DEFAULT false,
  is_mobile BOOLEAN DEFAULT false
);

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE,
  description TEXT,
  address TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default projects
INSERT INTO projects (name, description, address) VALUES
  ('GEBOOTH WasteWater Treatment Plant', 'Wastewater treatment facility construction', '1300 Lakeshore East, Mississauga, ON'),
  ('Victoria Reservoir and Pumping Station', 'Water infrastructure project', '3121 King St. Inglewood, ON. L7C 0R4')
ON CONFLICT (name) DO NOTHING;

-- Worker sign-ins table
CREATE TABLE IF NOT EXISTS worker_signins (
  id SERIAL PRIMARY KEY,
  worker_name TEXT NOT NULL,
  project_id INTEGER REFERENCES projects(id),
  project_name TEXT,
  site_address TEXT,
  signin_date DATE,
  signin_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  signout_time TIMESTAMP
);

-- Users table for authentication
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  pin TEXT NOT NULL,
  role TEXT CHECK(role IN ('supervisor', 'worker')) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default users
INSERT INTO users (name, email, pin, role) VALUES 
  ('Admin Supervisor', 'admin@mjr.com', '1234', 'supervisor')
ON CONFLICT (email) DO NOTHING;

-- Insert default workers
INSERT INTO users (name, pin, role) VALUES 
  ('Augusto Duarte', '1111', 'worker'),
  ('Cesar Duarte', '1111', 'worker'),
  ('David Peniche', '1111', 'worker'),
  ('Migel Sanchez', '1111', 'worker'),
  ('Armando Hernandez', '1111', 'worker'),
  ('Luis Mendoza', '1111', 'worker'),
  ('Francisco Acosta', '1111', 'worker'),
  ('Luis Gustavo', '1111', 'worker'),
  ('George', '1111', 'worker'),
  ('Kevin Fuentes', '1111', 'worker')
ON CONFLICT DO NOTHING;

-- Email schedules table
CREATE TABLE IF NOT EXISTS email_schedules (
  id SERIAL PRIMARY KEY,
  form_id TEXT REFERENCES jsa_forms(form_id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  schedule_time TEXT,
  cron_expression TEXT,
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX idx_jsa_forms_date ON jsa_forms(date);
CREATE INDEX idx_jsa_forms_form_id ON jsa_forms(form_id);
CREATE INDEX idx_worker_signins_date ON worker_signins(signin_date);
CREATE INDEX idx_users_name ON users(name);

-- Enable Row Level Security (optional but recommended)
ALTER TABLE jsa_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE ppe ENABLE ROW LEVEL SECURITY;
ALTER TABLE crew_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_signins ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_schedules ENABLE ROW LEVEL SECURITY;

-- Create policies to allow all operations (adjust based on your needs)
CREATE POLICY "Allow all operations" ON jsa_forms FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON job_steps FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON tools FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON ppe FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON crew_members FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON projects FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON worker_signins FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON users FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON email_schedules FOR ALL USING (true);