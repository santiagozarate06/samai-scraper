# Imagen oficial de Playwright: ya trae Chromium + todas las librerías del sistema
# que el navegador necesita (evita el dolor de instalarlas a mano en Linux).
# Forzamos linux/amd64 (arquitectura estándar de servidores) para evitar
# problemas de manifest multi-plataforma al arrancar en EasyPanel.
# La versión de la imagen DEBE coincidir con la de playwright en package.json.
FROM --platform=linux/amd64 mcr.microsoft.com/playwright:v1.48.0-jammy

# Fijamos npm a la misma versión de Playwright que la imagen (evita el desajuste
# "Executable doesn't exist" cuando npm instala una versión más nueva).

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

# Arranque con diagnóstico: levanta un servidor mínimo primero (para no morir),
# verifica Chromium, y luego arranca el servidor real. Si algo falla, expone el
# error en /error en vez de dejar el contenedor muerto sin logs.
CMD ["node", "arranque.js"]
