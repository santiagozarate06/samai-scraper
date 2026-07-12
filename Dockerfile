# Imagen oficial de Playwright: ya trae Chromium + todas las librerías del sistema
# que el navegador necesita (evita el dolor de instalarlas a mano en Linux).
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Instalar solo las dependencias primero (aprovecha la caché de Docker)
COPY package.json ./
RUN npm install --omit=dev

# Copiar el resto del código
COPY . .

# El navegador ya viene en la imagen; aseguramos que Chromium esté disponible
RUN npx playwright install chromium

# Puerto del servicio (EasyPanel lo mapea)
ENV PORT=8080
EXPOSE 8080

CMD ["node", "servidor.js"]
