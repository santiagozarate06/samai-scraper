/**
 * ============================================================================
 *  SERVIDOR SAMAI — expone el scraper como una API HTTP para que n8n lo llame.
 * ----------------------------------------------------------------------------
 *  Endpoints:
 *    GET  /salud                         → { ok: true }  (para verificar que vive)
 *    POST /consultar  { radicado }       → consulta SAMAI, baja el PDF, lo sube a
 *                                          Drive y devuelve el resultado + link.
 *
 *  Seguridad simple: si se define la variable API_TOKEN, hay que mandar el header
 *    x-api-token: <API_TOKEN>  en cada petición (para que solo tu n8n lo use).
 *
 *  Variables de entorno:
 *    PORT                    puerto (default 8080)
 *    API_TOKEN               token de acceso (opcional pero recomendado)
 *    GOOGLE_SERVICE_ACCOUNT  JSON del service account de Google (para Drive)
 *    GDRIVE_FOLDER_ID        carpeta de Drive donde subir los PDF
 * ============================================================================
 */

import express from 'express';
import fs from 'fs';
// NOTA: samai.js se importa de forma DIFERIDA (dentro del endpoint) para que,
// si Playwright falla al cargar, el servidor igual arranque y responda /salud.

const app = express();
app.use(express.json({ limit: '25mb' })); // el PDF puede ser grande

// Captura de errores no manejados: los imprime en vez de tumbar el proceso.
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

const PORT = process.env.PORT || 8080;
const API_TOKEN = process.env.API_TOKEN || '';

// Middleware de seguridad opcional
app.use((req, res, next) => {
  if (!API_TOKEN) return next(); // sin token configurado → abierto (solo para pruebas)
  if (req.path === '/salud') return next();
  if (req.get('x-api-token') === API_TOKEN) return next();
  return res.status(401).json({ ok: false, error: 'No autorizado' });
});

// Verificar que el servicio está vivo
app.get('/salud', (req, res) => {
  res.json({ ok: true, servicio: 'samai-scraper', ts: new Date().toISOString() });
});

// Consultar un proceso administrativo en SAMAI
app.post('/consultar', async (req, res) => {
  const radicado = String(req.body?.radicado || '').replace(/\D/g, '');
  if (!/^\d{23}$/.test(radicado)) {
    return res.status(400).json({ ok: false, error: 'radicado debe tener 23 dígitos' });
  }

  console.log(`[${new Date().toISOString()}] Consultando ${radicado}...`);
  try {
    // Carga diferida del scraper (así el arranque no depende de Playwright)
    const { consultarSamai } = await import('./samai.js');
    // PRUEBA_PDF=1 fuerza tomar la última actuación CON anexo (solo para diagnóstico;
    // en producción normal debe estar sin definir para mirar la verdadera última).
    const forzarConAnexo = process.env.PRUEBA_PDF === '1';
    // Correr el scraper (headless en el servidor)
    const r = await consultarSamai(radicado, { headless: true, forzarConAnexo });

    // Si hay PDF, lo devolvemos EN BASE64 para que n8n lo suba a Drive
    // (evita el problema de "cuota" de las cuentas de servicio de Google).
    let pdfBase64 = null;
    let pdfNombre = null;
    if (r.ok && r.tienePdf && r.pdfPath && fs.existsSync(r.pdfPath)) {
      pdfBase64 = fs.readFileSync(r.pdfPath).toString('base64');
      pdfNombre = `${radicado}_${r.ultimaActuacion?.indice || 'ultima'}.pdf`;
      // borrar el archivo local ya que lo devolvemos (no acumular basura en el server)
      try { fs.unlinkSync(r.pdfPath); } catch {}
    }

    return res.json({
      ok: r.ok,
      radicado: r.radicado,
      encontrado: r.encontrado,
      ultimaActuacion: r.ultimaActuacion,
      tienePdf: r.tienePdf,
      pdfNombre,        // nombre sugerido del archivo
      pdfBase64,        // ← el PDF en base64; n8n lo convierte y sube a Drive
      error: r.error,
    });
  } catch (e) {
    console.error('Error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Escuchar en 0.0.0.0 (todas las interfaces) — necesario dentro de contenedores
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servicio SAMAI escuchando en 0.0.0.0:${PORT}`);
  console.log(`  GET  /salud`);
  console.log(`  POST /consultar  { "radicado": "..." }`);
});
