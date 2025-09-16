-- Production Database Update Script for Supabase PostgreSQL
-- Run this in Supabase SQL Editor to add foreman functionality

-- Step 1: Update users table to support foreman role
ALTER TABLE users 
DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users 
ADD CONSTRAINT users_role_check 
CHECK(role IN ('supervisor', 'worker', 'foreman'));

-- Step 2: Add Sergio Araujo as a foreman
INSERT INTO users (name, email, pin, role) VALUES 
  ('Sergio Araujo', 'sergio@mjr.com', '1234', 'foreman')
ON CONFLICT (email) DO UPDATE 
SET pin = '1234', role = 'foreman', name = 'Sergio Araujo';

-- Step 3: Create foreman_signins table for daily sign-ins
CREATE TABLE IF NOT EXISTS foreman_signins (
  id SERIAL PRIMARY KEY,
  foreman_id INTEGER REFERENCES users(id),
  foreman_name TEXT NOT NULL,
  project_id INTEGER REFERENCES projects(id),
  project_name TEXT,
  form_id TEXT REFERENCES jsa_forms(form_id),
  signin_date DATE,
  signin_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 4: Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_foreman_signins_date ON foreman_signins(signin_date);
CREATE INDEX IF NOT EXISTS idx_foreman_signins_foreman ON foreman_signins(foreman_id);
CREATE INDEX IF NOT EXISTS idx_foreman_signins_project ON foreman_signins(project_id);
CREATE INDEX IF NOT EXISTS idx_foreman_signins_form ON foreman_signins(form_id);

-- Step 5: Enable Row Level Security
ALTER TABLE foreman_signins ENABLE ROW LEVEL SECURITY;

-- Step 6: Create policy to allow all operations (adjust based on your security needs)
CREATE POLICY "Allow all operations on foreman_signins" ON foreman_signins 
FOR ALL USING (true);

-- Step 7: Grant necessary permissions
GRANT ALL ON foreman_signins TO authenticated;
GRANT ALL ON foreman_signins TO anon;

-- Step 8: Verify the changes
SELECT 'Foreman role setup complete!' as status;

-- Check if Sergio was added successfully
SELECT id, name, email, role, pin 
FROM users 
WHERE name = 'Sergio Araujo';

-- Check if foreman_signins table was created
SELECT table_name 
FROM information_schema.tables 
WHERE table_name = 'foreman_signins';

-- List all users with their roles
SELECT name, role, email 
FROM users 
ORDER BY role, name;