-- Simple script to add Sergio Araujo to production database
-- Run these commands one by one in Supabase SQL Editor

-- Step 1: First check what roles are currently allowed
SELECT DISTINCT role FROM users;

-- Step 2: Check if Sergio already exists
SELECT * FROM users WHERE name = 'Sergio Araujo';

-- Step 3: Try to add Sergio as a supervisor first (since we know that role works)
INSERT INTO users (name, email, pin, role) 
VALUES ('Sergio Araujo', 'sergio@mjr.com', '1234', 'supervisor')
ON CONFLICT (email) DO UPDATE 
SET name = 'Sergio Araujo', pin = '1234', role = 'supervisor';

-- Step 4: Verify Sergio was added
SELECT id, name, email, pin, role 
FROM users 
WHERE name = 'Sergio Araujo';

-- Step 5: If you want to change him to foreman later (after updating the constraint)
-- First update the constraint to allow 'foreman' role:
/*
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('supervisor', 'worker', 'foreman'));

-- Then update Sergio to foreman:
UPDATE users SET role = 'foreman' WHERE name = 'Sergio Araujo';
*/