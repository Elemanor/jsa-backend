const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Open database
const db = new sqlite3.Database(path.join(__dirname, 'jsa_database.db'), (err) => {
  if (err) {
    console.error('Error opening database:', err);
    process.exit(1);
  }
  console.log('Connected to the SQLite database.');
});

// Add supervisor_signature column to jsa_forms table
db.run(`
  ALTER TABLE jsa_forms
  ADD COLUMN supervisor_signature TEXT
`, (err) => {
  if (err) {
    if (err.message.includes('duplicate column name')) {
      console.log('✓ supervisor_signature column already exists');
    } else {
      console.error('Error adding supervisor_signature column:', err);
    }
  } else {
    console.log('✓ Added supervisor_signature column to jsa_forms table');
  }

  // Close database
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err);
    } else {
      console.log('Database connection closed.');
    }
  });
});