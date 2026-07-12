# Imagen oficial de Playwright: ya trae Chromium + todas las librerías del sistema
# que el navegador necesita (evita el dolor de instalarlas a mano en Linux).
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Instalar solo las dependencias primero (aprovecha la caché de Docker)
COPY package.json ./
RUN npm install --omit=dev

# Copiar el resto del código
COPY . .

# El navegador (Chromium) YA viene en la imagen de Playwright, en la ruta que
# el SDK espera. NO reinstalamos (eso causaría rutas/permisos incorrectos).

# Crear la carpeta de salida con permisos de escritura (el PDF temporal se guarda ahí)
RUN mkdir -p /app/salida && chmod -R 777 /app/salida

# Puerto del servicio (EasyPanel lo mapea)
ENV PORT=8080
EXPOSE 8080

CMD ["node", "servidor.js"]
