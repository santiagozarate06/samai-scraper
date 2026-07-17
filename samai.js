/**
 * ============================================================================
 *  SAMAI — módulo que consulta la última actuación de un proceso administrativo
 *  (Consejo de Estado) y descarga su PDF si tiene documento. Producto emersai.com.
 * ----------------------------------------------------------------------------
 *  Exporta: consultarSamai(radicado, opciones) → objeto con el resultado.
 *  También se puede correr suelto:  node samai.js <RADICADO_23_DIGITOS>
 *
 *  FLUJO (mapeado con el abogado):
 *   1. Abre SAMAI con navegador headless (Playwright).
 *   2. GUID = radicado(23) + código juzgado (7 primeros dígitos).
 *   3. Pasa el captcha (los 4núm+2letras están en TEXTO en 3 spans → sin OCR).
 *   4. Lee el "Historial de actuaciones".
 *   5. Mira SOLO la última actuación (la más reciente). Si tiene anexo → baja el PDF.
 *      Si no tiene anexo → no descarga nada.
 * ============================================================================
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SALIDA = path.join(__dirname, 'salida');
const BASE = 'https://samai.consejodeestado.gov.co';
const MAX_INTENTOS_CAPTCHA = 6;

function log(...args) {
  const t = new Date().toISOString().substring(11, 19);
  console.log(`[${t}]`, ...args);
}

/**
 * Consulta SAMAI para un radicado administrativo.
 * @param {string} radicadoRaw - radicado (se limpia a solo dígitos)
 * @param {object} opts - { headless=true, dirSalida=SALIDA, forzarConAnexo=false }
 * @returns {Promise<object>} resultado:
 *   { ok, radicado, encontrado, ultimaActuacion:{fecha,tipo,anotacion,estado,anexos,indice},
 *     tienePdf, pdfPath, error }
 */
export async function consultarSamai(radicadoRaw, opts = {}) {
  const headless = opts.headless !== false; // por defecto headless (servidor)
  const dirSalida = opts.dirSalida || SALIDA;
  const forzarConAnexo = !!opts.forzarConAnexo;

  const radicado = String(radicadoRaw || '').replace(/\D/g, '');
  const resultado = {
    ok: false,
    radicado,
    encontrado: false,
    ultimaActuacion: null,
    tienePdf: false,
    pdfReservado: false, // true si el documento existe pero es reservado/clasificado
    pdfPath: null,
    error: null,
  };

  if (!/^\d{23}$/.test(radicado)) {
    resultado.error = 'El radicado debe tener 23 dígitos.';
    return resultado;
  }

  const codJuzgado = radicado.substring(0, 7);
  const guid = radicado + codJuzgado;
  if (!fs.existsSync(dirSalida)) fs.mkdirSync(dirSalida, { recursive: true });

  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage'], // necesarios en contenedores
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    acceptDownloads: true,
  });
  const page = await context.newPage();

  try {
    const urlDetalle = `${BASE}/Vistas/Casos/list_procesos.aspx?guid=${guid}`;
    await page.goto(urlDetalle, { waitUntil: 'networkidle', timeout: 60000 });

    // --- Pasar el captcha (leyendo los 3 spans de texto) ---
    let captchaOk = false;
    for (let intento = 1; intento <= MAX_INTENTOS_CAPTCHA && !captchaOk; intento++) {
      const inputCaptcha = page.locator('#MainContent_TxtCaptcha2');
      if (!(await inputCaptcha.count())) { captchaOk = true; break; }

      const partes = [];
      for (const id of ['#MainContent_Lbldato1', '#MainContent_Lbldato2', '#MainContent_Lbldato3']) {
        const loc = page.locator(id);
        if (await loc.count()) partes.push((await loc.innerText()).replace(/\s+/g, ''));
      }
      const codigo = partes.join('').toUpperCase().replace(/[^A-Z0-9]/g, '');
      log(`Captcha intento #${intento}: "${codigo}"`);
      if (codigo.length < 5) { await page.reload({ waitUntil: 'networkidle' }); continue; }

      await inputCaptcha.fill(codigo);
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
        page.locator('#MainContent_CmdNoRobot').click(),
      ]);
      await page.waitForTimeout(2000);

      const hayHistorial = await page.locator('text=Historial de actuaciones').count();
      const sigueCaptcha = await page.locator('#MainContent_TxtCaptcha2').count();
      if (hayHistorial || !sigueCaptcha) captchaOk = true;
    }
    if (!captchaOk) throw new Error('No se pudo pasar el captcha.');

    // --- Leer historial de actuaciones ---
    await page.waitForTimeout(2500);
    const filas = await page.$$eval('table tbody tr', (trs) =>
      trs.map((tr, idx) => ({
        idx,
        celdas: Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.trim()),
      })).filter((f) => f.celdas.length >= 5)
    );

    if (!filas.length) {
      resultado.error = 'No se encontraron actuaciones (¿radicado válido en SAMAI?).';
      return resultado;
    }
    resultado.encontrado = true;

    // Elegir la última actuación (fila 0 = más reciente). En producción SIEMPRE es esta.
    let objetivo = filas[0];
    if (forzarConAnexo) {
      // Solo para diagnóstico (PRUEBA_PDF): forzar una actuación CON anexo aunque no sea
      // la última, para poder ejercitar la descarga. En producción no se usa.
      const tieneAnexo = (f) => f.celdas.some((c) => /^\d+$/.test(c) && +c >= 1 && +c <= 20);
      const cand = filas.find(tieneAnexo);
      if (cand) objetivo = cand;
    }

    // Parsear celdas: [_, fechaReg, fechaAct, tipo, anotacion, estado, anexos, indice]
    const c = objetivo.celdas;
    const anexos = parseInt((c.find((x) => /^\d+$/.test(x) && +x <= 20)) || '0', 10) || 0;
    resultado.ultimaActuacion = {
      fechaRegistro: c[1] || '',
      fechaActuacion: c[2] || '',
      tipo: c[3] || '',
      anotacion: c[4] || '',
      estado: c[5] || '',
      anexos,
      indice: c[c.length - 1] || '',
    };

    if (anexos < 1) {
      // La última actuación no tiene documento → nada que descargar (correcto)
      resultado.ok = true;
      resultado.tienePdf = false;
      log('Última actuación sin anexo: no hay PDF.');
      return resultado;
    }

    // --- Abrir la actuación (clic en su botón "Ver") para que carguen los adjuntos ---
    resultado.tienePdf = true;
    const destino = path.join(dirSalida, `${radicado}_${resultado.ultimaActuacion.indice}.pdf`);
    let diag = '';

    // Capturamos CUALQUIER request a samaicore para obtener el token FRESCO en el
    // momento exacto en que la página lo genera (el JWT expira rápido).
    let urlPdfInterceptada = null;
    const onReq = (req) => {
      const u = req.url();
      if (u.includes('DescargarProvidenciaSAMAI')) urlPdfInterceptada = u;
    };
    context.on('request', onReq);
    // Y capturamos la RESPUESTA que ve el navegador en ESA misma petición (para saber
    // si el propio navegador recibe 403 → sería bloqueo por IP/entorno, no por token).
    const onResp = async (resp) => {
      const u = resp.url();
      if (u.includes('DescargarProvidenciaSAMAI')) {
        diag += `navResp status:${resp.status()} ct:${resp.headers()['content-type'] || ''}; `;
      }
    };
    context.on('response', onResp);

    // Preparamos captura del evento download (por si samaicore responde con attachment).
    let descargado = false;
    const capturarDownload = async (d) => {
      try { await d.saveAs(destino); descargado = true; diag += 'via:download-event; '; }
      catch (e) { diag += `dl-save:${e.message}; `; }
    };
    page.on('download', capturarDownload);

    // Clic en "Ver" de la actuación objetivo (abre la sección de archivos adjuntos)
    await page.locator('table tbody tr').nth(objetivo.idx).locator('button, a').first().click().catch(() => {});
    await page.waitForTimeout(3000);

    // Leer la tabla de "Archivos adjuntos": para cada adjunto, su descripción, su
    // tipo de publicidad (Público/Reservado/Clasificado) y su link de descarga.
    // SAMAI SOLO deja descargar los PÚBLICOS sin login; los clasificados/reservados
    // dan 403 incluso para un usuario logueado sin permisos (confirmado en pantalla).
    const adjuntos = await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const out = [];
      for (const tr of document.querySelectorAll('table tr')) {
        const filaTxt = norm(tr.innerText).toLowerCase();
        // buscar el link de descarga dentro de la fila
        let link = null;
        for (const el of tr.querySelectorAll('*')) {
          for (const attr of el.attributes || []) {
            if (attr.value && attr.value.includes('DescargarProvidenciaSAMAI')) {
              const m = attr.value.match(/https?:\/\/[^"'\s)]*DescargarProvidenciaSAMAI[^"'\s)]*/);
              if (m) { link = m[0]; break; }
            }
          }
          if (link) break;
        }
        if (!link) continue; // solo filas que son un adjunto real
        // detectar publicidad por el texto de la fila
        let publicidad = 'desconocido';
        if (/clasificad/.test(filaTxt)) publicidad = 'clasificado';
        else if (/reservad/.test(filaTxt)) publicidad = 'reservado';
        else if (/p[uú]blic/.test(filaTxt)) publicidad = 'publico';
        out.push({ publicidad, link, texto: norm(tr.innerText).slice(0, 120) });
      }
      return out;
    });
    diag += `adjuntos:${adjuntos.length}(${adjuntos.map(a => a.publicidad).join(',')}); `;

    // Elegir el primer adjunto PÚBLICO (los otros no se pueden bajar sin permisos)
    const publico = adjuntos.find((a) => a.publicidad === 'publico');
    const urlPdf = publico ? publico.link : (adjuntos[0] ? adjuntos[0].link : urlPdfInterceptada);

    // Si hay adjuntos pero NINGUNO es público → documento reservado/clasificado.
    if (adjuntos.length && !publico) {
      context.off('request', onReq); context.off('response', onResp); page.off('download', capturarDownload);
      resultado.ok = true;               // no es error: es el comportamiento esperado
      resultado.tienePdf = false;        // no hay PDF descargable
      resultado.pdfReservado = true;     // marca para que n8n avise "míralo con tu cuenta"
      resultado.ultimaActuacion.publicidad = adjuntos[0].publicidad;
      log(`Documento ${adjuntos[0].publicidad}: no descargable sin permisos.`);
      return resultado;
    }

    if (!urlPdf) {
      context.off('request', onReq); context.off('response', onResp); page.off('download', capturarDownload);
      resultado.error = `Anexo presente pero no se halló el link del PDF. [${diag}]`;
      return resultado;
    }
    resultado.ultimaActuacion.publicidad = publico ? 'publico' : 'desconocido';

    // Descargar el PDF público: navegación real (Sec-Fetch:navigate + cookies de sesión).
    if (!descargado) {
      try {
        const respNav = await page.goto(urlPdf, { waitUntil: 'commit', timeout: 40000 }).catch((e) => { diag += `goto:${e.message}; `; return null; });
        await page.waitForTimeout(1500);
        if (!descargado && respNav) {
          const ct = respNav.headers()['content-type'] || '';
          diag += `goto-status:${respNav.status()} ct:${ct}; `;
          if (respNav.ok() && /pdf|octet-stream/i.test(ct)) {
            fs.writeFileSync(destino, await respNav.body());
            descargado = true; diag += 'via:goto; ';
          }
        }
      } catch (e) { diag += `nav-error:${e.message}; `; }
    }

    // Respaldo: context.request con headers de navegación (reusa cookies de sesión)
    if (!descargado) {
      try {
        const resp = await context.request.get(urlPdf, {
          timeout: 40000, maxRedirects: 5,
          headers: {
            Referer: BASE + '/',
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document',
          },
        });
        diag += `apiget status:${resp.status()} ct:${resp.headers()['content-type'] || ''}; `;
        if (resp.ok()) {
          const buf = await resp.body();
          if (buf.slice(0, 4).toString() === '%PDF') { fs.writeFileSync(destino, buf); descargado = true; diag += 'via:apiget; '; }
          else diag += `nopdf-head:${buf.slice(0, 16).toString('hex')}; `;
        } else {
          const b = await resp.body().catch(() => Buffer.from(''));
          diag += `body:${b.slice(0, 80).toString()}; `;
        }
      } catch (e) { diag += `apiget-error:${e.message}; `; }
    }

    context.off('request', onReq);
    context.off('response', onResp);
    page.off('download', capturarDownload);

    if (descargado && fs.existsSync(destino) && fs.readFileSync(destino).slice(0, 4).toString() === '%PDF') {
      resultado.ok = true;
      resultado.pdfPath = destino;
      log(`PDF descargado: ${destino}`);
    } else {
      resultado.error = `No se pudo descargar el PDF público. [${diag || 'sin diagnóstico'}]`;
    }
    return resultado;
  } catch (e) {
    resultado.error = e.message;
    return resultado;
  } finally {
    await browser.close();
  }
}

// --- Ejecución directa desde la línea de comandos (para pruebas) ---
if (process.argv[1] && process.argv[1].endsWith('samai.js')) {
  const rad = process.argv[2];
  const forzar = process.env.PRUEBA_PDF === '1';
  const verNavegador = process.env.VER === '1';
  consultarSamai(rad, { headless: !verNavegador, forzarConAnexo: forzar }).then((r) => {
    console.log('\n=== RESULTADO ===');
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  });
}
