@echo off
cls
echo GENERANDO IMAGEN DOCKER...
echo -----------------------------------
docker-compose up -d --build 
echo -----------------------------------
echo FINALIZADO.
@timeout 1
