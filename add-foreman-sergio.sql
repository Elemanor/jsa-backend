-- Add foreman role to users table
ALTER TABLE users 
DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users 
ADD CONSTRAINT users_role_check 
CHECK(role IN ('supervisor', 'worker', 'foreman'));

-- Add Sergio Araujo as a foreman
INSERT INTO users (name, email, pin, role) VALUES 
  ('Sergio Araujo', 'sergio@mjr.com', '1234', 'foreman')
ON CONFLICT (email) DO UPDATE 
SET pin = '1234', role = 'foreman';

-- Create foreman_signins table for daily sign-ins
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

-- Create index for better performance
CREATE INDEX idx_foreman_signins_date ON foreman_signins(signin_date);
CREATE INDEX idx_foreman_signins_foreman ON foreman_signins(foreman_id);

-- Enable Row Level Security
ALTER TABLE foreman_signins ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations" ON foreman_signins FOR ALL USING (true);