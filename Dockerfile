# 1. Base image
FROM node:20-alpine AS base

# 2. Repertoio de trabajo
WORKDIR /app

# 3. Instalación de librerías para Prisma en Alpine
RUN apk add --no-cache openssl libc6-compat

# 3. Instalación de dependencias
COPY package*.json ./
COPY prisma ./prisma/

# 4. Instalamos dependencias y generamos el cliente de Prisma
RUN npm install
RUN npx prisma generate

# 5. Copiamos el resto de los archivos del proyecto
COPY . .

# 6. Construimos la aplicación para producción
RUN npm run build

# 7. Exponemos el puerto 3000
EXPOSE 3000

# 8. Comando para arrancar la aplicación
CMD ["npm", "start"]
