@echo off
echo Generando imagen...
npm run build
echo -----------------------------------
pause 2
echo generando Docker container...
docker-compose up -d --build 
echo -----------------------------------
pause 1
