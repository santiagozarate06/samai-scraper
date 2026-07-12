# Servicio SAMAI — scraper de procesos administrativos (Consejo de Estado)

Servicio HTTP que, dado un radicado administrativo, consulta SAMAI, mira la **última actuación**, y si tiene documento **descarga el PDF y lo devuelve en base64**. Luego **n8n** sube ese PDF a Google Drive (con su propia credencial) y pone el link en el Sheet.

> Diseño: el servicio NO sube a Drive (las cuentas de servicio de Google no tienen cuota de almacenamiento). Solo descarga el PDF y lo entrega; n8n hace la subida con su credencial OAuth de usuario, que sí tiene cuota.

## Archivos
- `samai.js` — el scraper (Playwright). Función `consultarSamai(radicado)`.
- `servidor.js` — API HTTP (Express). **Esto es lo que corre en el servidor.**
- `Dockerfile` — para desplegar en EasyPanel.

## Probar en local
```bash
npm install
npx playwright install chromium

# probar el scraper suelto (VER=1 muestra el navegador)
PRUEBA_PDF=1 VER=1 node samai.js 25899333300120250018000

# probar el servidor
node servidor.js
# en otra terminal:
curl -X POST http://localhost:8080/consultar -H "Content-Type: application/json" -d '{"radicado":"25899333300120250018000"}'
```

## API
- `GET /salud` → `{ ok: true }`
- `POST /consultar` body `{ "radicado": "25899333300120250018000" }` →
  ```json
  {
    "ok": true,
    "encontrado": true,
    "ultimaActuacion": { "fechaActuacion": "...", "tipo": "...", "anotacion": "...", "anexos": 1, "indice": "00104" },
    "tienePdf": true,
    "pdfNombre": "25899333300120250018000_00104.pdf",
    "pdfBase64": "JVBERi0xLjU...",   // n8n lo convierte a archivo y lo sube a Drive
    "error": null
  }
  ```
  Si la última actuación no tiene documento: `tienePdf:false`, `pdfBase64:null`.

## Variables de entorno
| Variable | Para qué |
|---|---|
| `PORT` | Puerto (default 8080) |
| `API_TOKEN` | Si se define, exige header `x-api-token` en cada request (seguridad) |

El servicio NO necesita credenciales de Google. La subida a Drive la hace n8n.

## Desplegar en EasyPanel (resumen)
1. Subir esta carpeta a un repo Git (o usar la opción de EasyPanel para código).
2. En EasyPanel: crear una **App** → tipo **Dockerfile** → apuntar a este directorio.
3. Configurar la variable `API_TOKEN` (una clave secreta que tú inventes, para que solo tu n8n use el servicio).
4. EasyPanel construye la imagen y expone el servicio.
5. Anotar la URL interna del servicio → esa es la que n8n usará en el nodo HTTP.

## Cómo lo usa n8n (integración)
1. En el workflow, tras detectar que un proceso es **ADMINISTRATIVO** (el despacho lo dice), hacer `POST {url_servicio}/consultar` con `{radicado}` y header `x-api-token`.
2. Si la respuesta trae `pdfBase64`: convertirlo a archivo binario (nodo "Convert to File" / Move Binary Data) → subirlo a **Google Drive** (nodo Google Drive, con la credencial OAuth de n8n) → obtener el link.
3. Escribir el link en una columna del Sheet (ej. `pdf_ultima_actuacion`).
