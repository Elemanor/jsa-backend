const nodemailer = require('nodemailer');

// Email configuration for MJR Contractors work email
const EMAIL_CONFIG = {
  host: 'mail.mjrcontractors.com', // Your cPanel mail server
  port: 587, // Use 465 if SSL is required
  secure: false, // true for 465, false for 587
  auth: {
    user: 'pavel@mjrcontractors.com',
    pass: 'GEBooth2025'
  },
  tls: {
    rejectUnauthorized: false // Accept self-signed certificates
  }
};

// Create reusable transporter
const transporter = nodemailer.createTransport(EMAIL_CONFIG);

// Generate HTML for JSA email
function generateJSAEmailHTML(jsa) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .header { background: #1e40af; color: white; padding: 20px; border-radius: 5px; }
        .section { margin: 20px 0; padding: 15px; border: 1px solid #ddd; border-radius: 5px; }
        .crew-member { display: inline-block; margin: 5px; padding: 5px 10px; background: #e0e7ff; border-radius: 3px; }
        .job-step { margin: 10px 0; padding: 10px; background: #f9fafb; }
        .hazard { color: #dc2626; margin: 2px 0; }
        .control { color: #059669; margin: 2px 0; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Job Safety Analysis</h1>
        <p>JSA #: ${jsa.jsaNumber || 'N/A'}</p>
        <p>Date: ${jsa.date || new Date().toLocaleDateString()}</p>
      </div>
      
      <div class="section">
        <h2>Project Information</h2>
        <table>
          <tr><th>Project:</th><td>${jsa.projectName || 'N/A'}</td></tr>
          <tr><th>Site Address:</th><td>${jsa.siteAddress || 'N/A'}</td></tr>
          <tr><th>Company:</th><td>${jsa.company || 'MJR Contractors Ltd'}</td></tr>
          <tr><th>Supervisor:</th><td>${jsa.crewSupervisor || 'N/A'}</td></tr>
          <tr><th>Weather:</th><td>${jsa.weather || 'N/A'}</td></tr>
        </table>
      </div>
      
      <div class="section">
        <h2>Crew Members</h2>
        ${jsa.crew && jsa.crew.length > 0 ? 
          jsa.crew.map(member => `<span class="crew-member">${member.name || member}</span>`).join('') 
          : '<p>No crew members listed</p>'}
      </div>
      
      <div class="section">
        <h2>Job Steps</h2>
        ${jsa.jobSteps && jsa.jobSteps.length > 0 ? jsa.jobSteps.map(step => `
          <div class="job-step">
            <h3>Step ${step.sequence}: ${step.operation}</h3>
            <h4>Hazards:</h4>
            ${Array.isArray(step.hazards) ? 
              step.hazards.map(h => `<div class="hazard">• ${h}</div>`).join('') 
              : '<p>No hazards listed</p>'}
            <h4>Safety Controls:</h4>
            ${Array.isArray(step.safetyControls) ? 
              step.safetyControls.map(c => `<div class="control">• ${c}</div>`).join('') 
              : '<p>No controls listed</p>'}
            <p><strong>Risk Level:</strong> ${step.riskLevel || 'N/A'}</p>
          </div>
        `).join('') : '<p>No job steps defined</p>'}
      </div>
      
      <div class="section">
        <p><em>This JSA was automatically generated and sent from the MJR Safety Management System</em></p>
      </div>
    </body>
    </html>
  `;
}

// Send JSA email
async function sendJSAEmail(to, jsa, subject = null) {
  const mailOptions = {
    from: 'pavel@mjrcontractors.com',
    to: to,
    subject: subject || `JSA Report - ${jsa.projectName || 'Project'} - ${new Date().toLocaleDateString()}`,
    html: generateJSAEmailHTML(jsa)
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent:', info.response);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Email error:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  sendJSAEmail,
  EMAIL_CONFIG
};