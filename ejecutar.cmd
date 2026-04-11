@echo off
cls
echo GENERANDO IMAGEN DOCKER...
echo -----------------------------------
docker-compose up -d --build --force-recreate
echo -----------------------------------
echo FINALIZADO.
@timeout 3
exit
