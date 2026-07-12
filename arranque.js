/**
 * Arranque a prueba de fallos: levanta un servidor HTTP mínimo INMEDIATAMENTE
 * (para que el contenedor NUNCA muera y el health check pase), y solo después
 * intenta cargar el servidor real. Si el servidor real falla, el mínimo sigue
 * vivo y expone el error en /error para poder diagnosticarlo.
 */
import http from 'http';

const PORT = process.env.PORT || 8080;
let estado = { fase: 'iniciando', error: null };

// Servidor mínimo que SIEMPRE responde (mantiene vivo el contenedor)
const servidorMinimo = http.createServer((req, res) => {
  if (req.url === '/salud' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, modo: 'minimo', estado }));
  } else if (req.url === '/error') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ estado }, null, 2));
  } else {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, mensaje: 'Servidor real no cargó', estado }));
  }
});

servidorMinimo.listen(PORT, '0.0.0.0', () => {
  console.log(`[arranque] Servidor mínimo vivo en 0.0.0.0:${PORT}`);
  cargarServidorReal();
});

async function cargarServidorReal() {
  try {
    estado.fase = 'importando express';
    console.log('[arranque] importando express...');
    await import('express');

    estado.fase = 'importando playwright';
    console.log('[arranque] importando playwright...');
    const { chromium } = await import('playwright');

    estado.fase = 'probando lanzar chromium';
    console.log('[arranque] probando lanzar chromium...');
    const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    await b.close();
    console.log('[arranque] ✅ chromium OK');

    // Todo bien → cerrar el mínimo y arrancar el servidor real
    estado.fase = 'cargando servidor real';
    console.log('[arranque] cerrando servidor mínimo y arrancando el real...');
    await new Promise((r) => servidorMinimo.close(r));
    await import('./servidor.js');
    estado.fase = 'servidor real OK';
  } catch (e) {
    estado.fase = 'ERROR';
    estado.error = { mensaje: e.message, stack: (e.stack || '').split('\n').slice(0, 8) };
    console.error('[arranque] ❌ ERROR:', e.message);
    console.error(e.stack);
    // NO salimos: el servidor mínimo sigue vivo para poder leer /error
  }
}
