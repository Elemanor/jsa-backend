# JSA Backend Deployment Guide

## 🚀 Quick Deploy to Render (Recommended - Free)

### Step 1: Prepare GitHub Repository

1. Create a new GitHub repository for the backend:
```bash
cd jsa-backend
git init
git add .
git commit -m "Initial backend commit"
git remote add origin YOUR_GITHUB_REPO_URL
git push -u origin main
```

### Step 2: Deploy to Render

1. Go to [render.com](https://render.com) and sign up/login
2. Click "New +" → "Web Service"
3. Connect your GitHub account
4. Select your backend repository
5. Configure the service:
   - **Name**: `jsa-backend` (or your preferred name)
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free

### Step 3: Set Environment Variables

In Render Dashboard → Environment:

```
FRONTEND_URL=https://mjr-jsa-app.netlify.app
PORT=3001
DATABASE_PATH=./jsa_database.db
```

Optional (for email features):
```
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password
```

### Step 4: Deploy

Click "Create Web Service" and wait for deployment (takes ~5 minutes)

Your backend URL will be: `https://jsa-backend.onrender.com`

---

## 🔧 Alternative: Deploy to Railway

1. Go to [railway.app](https://railway.app)
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your backend repository
4. Railway will auto-detect Node.js
5. Add environment variables in Settings → Variables
6. Your app will deploy automatically

Railway URL format: `https://jsa-backend.up.railway.app`

---

## 🔧 Alternative: Deploy to Heroku

### Prerequisites
- Heroku CLI installed
- Heroku account (free tier available)

### Create Procfile
```
web: node server.cjs
```

### Deploy Steps
```bash
cd jsa-backend
heroku create jsa-backend
git init
git add .
git commit -m "Initial commit"
heroku git:remote -a jsa-backend
git push heroku main
```

### Set Environment Variables
```bash
heroku config:set FRONTEND_URL=https://mjr-jsa-app.netlify.app
heroku config:set DATABASE_PATH=./jsa_database.db
```

---

## 📝 Update Frontend

After deploying the backend, update your frontend:

1. Go to Netlify Dashboard
2. Site settings → Environment variables
3. Add: `VITE_API_URL` = `https://your-backend-url.com`
4. Redeploy the frontend

---

## 🗄️ Database Considerations

### Current Setup (SQLite)
- Works fine for small-medium apps
- Database is stored as a file
- Will reset on free tier restarts (Render/Heroku)

### Production Recommendation (PostgreSQL)
For persistent data, migrate to PostgreSQL:

1. **Supabase** (Free tier): https://supabase.com
2. **Neon** (Free tier): https://neon.tech
3. **Railway PostgreSQL**: Built-in database option

### Migration Steps
1. Create PostgreSQL database
2. Update backend to use `pg` instead of `sqlite3`
3. Update connection string in environment variables

---

## 🧪 Test Your Deployment

1. Check API health:
```
curl https://your-backend-url.com/api/projects
```

2. Test from frontend:
- Update VITE_API_URL
- Try logging in
- Create a JSA form

---

## 🔒 Security Notes

1. **Never commit .env files** - Use .gitignore
2. **Use environment variables** for all secrets
3. **Enable CORS** only for your frontend domain
4. **Use HTTPS** in production (automatic on Render/Railway/Heroku)

---

## 📊 Monitoring

- **Render**: Built-in logs and metrics
- **Railway**: Real-time logs in dashboard
- **Heroku**: `heroku logs --tail`

---

## 🆘 Troubleshooting

### CORS Issues
- Ensure FRONTEND_URL is set correctly
- Check that credentials: true is set

### Database Issues
- For SQLite: Ensure write permissions
- Consider switching to PostgreSQL for production

### Port Issues
- Use `process.env.PORT || 3001`
- Don't hardcode ports

---

## 📦 Required Files

✅ package.json
✅ server.cjs
✅ emailConfig.cjs
✅ .env.example
✅ .gitignore
✅ README.md

---

## 🚀 Quick Start Commands

```bash
# Install dependencies
npm install

# Run locally
npm start

# Run with nodemon (dev)
npm run dev
```

---

## 📧 Support

For issues or questions about deployment, check the service documentation:
- [Render Docs](https://render.com/docs)
- [Railway Docs](https://docs.railway.app)
- [Heroku Docs](https://devcenter.heroku.com)