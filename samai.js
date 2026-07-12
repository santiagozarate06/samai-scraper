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

    // Elegir la última actuación (fila 0 = más reciente)
    let objetivo = filas[0];
    if (forzarConAnexo) {
      const conAnexo = filas.find((f) => f.celdas.some((c) => /^\d+$/.test(c) && +c >= 1 && +c <= 20));
      if (conAnexo) objetivo = conAnexo;
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

    // --- Abrir la actuación y hallar el link del PDF ---
    resultado.tienePdf = true;
    await page.locator('table tbody tr').nth(objetivo.idx).locator('button, a').first().click().catch(() => {});

    // Buscar el link del PDF, reintentando (a veces los adjuntos tardan en cargar)
    const buscarLink = () => page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        for (const attr of el.attributes || []) {
          if (attr.value && attr.value.includes('DescargarProvidenciaSAMAI')) {
            const m = attr.value.match(/https?:\/\/[^"'\s)]*DescargarProvidenciaSAMAI[^"'\s)]*/);
            if (m) return m[0];
          }
        }
      }
      const m = document.documentElement.innerHTML.match(/https?:\/\/[^"'\s)]*DescargarProvidenciaSAMAI[^"'\s)]*/);
      return m ? m[0] : null;
    });

    let urlPdf = null;
    for (let i = 0; i < 6 && !urlPdf; i++) {
      await page.waitForTimeout(1500);
      urlPdf = await buscarLink();
    }

    if (!urlPdf) {
      resultado.error = 'La actuación tiene anexo pero no se halló el link del PDF (¿reservado/clasificado?).';
      return resultado;
    }

    // --- Descargar el PDF (navegando, por el CORS de samaicore) ---
    const destino = path.join(dirSalida, `${radicado}_${resultado.ultimaActuacion.indice}.pdf`);
    const pagePdf = await context.newPage();
    let descargado = false;
    pagePdf.on('download', async (d) => { await d.saveAs(destino); descargado = true; });
    try {
      const respPdf = await pagePdf.goto(urlPdf, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => null);
      if (!descargado && respPdf) {
        const ct = respPdf.headers()['content-type'] || '';
        if (respPdf.ok() && /pdf|octet-stream/i.test(ct)) {
          fs.writeFileSync(destino, await respPdf.body());
          descargado = true;
        }
      }
      await pagePdf.waitForTimeout(1500);
    } finally {
      await pagePdf.close().catch(() => {});
    }

    if (descargado && fs.existsSync(destino) && fs.readFileSync(destino).slice(0, 4).toString() === '%PDF') {
      resultado.ok = true;
      resultado.pdfPath = destino;
      log(`PDF descargado: ${destino}`);
    } else {
      resultado.error = 'No se pudo descargar el PDF.';
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
