@echo off
echo Adding environment variables to Vercel...

echo DATABASE_URL=postgresql://postgres.jjtgflhthmbbeceucppi:IIapadokc92!@aws-1-us-east-2.pooler.supabase.com:6543/postgres | vercel env add DATABASE_URL production
echo FRONTEND_URL=https://mjr-jsa-app.netlify.app | vercel env add FRONTEND_URL production  
echo NODE_ENV=production | vercel env add NODE_ENV production

echo.
echo Environment variables added!
echo Now redeploy with: vercel --prod