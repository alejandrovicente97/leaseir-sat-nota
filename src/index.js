// Escribe una NOTA INTERNA en un ticket de Jira desde el panel del SAT de Leaseir,
// y opcionalmente reasigna el ticket a otro compañero.
//
// Por qué existe: el conector de Atlassian no sabe crear notas internas. Solo expone
// commentVisibility, que es una restricción de rol y deja el comentario con jsdPublic:true,
// o sea visible para el cliente en el portal. Lo único que crea una nota interna de verdad
// es servicedeskapi con public:false. Comprobado el 04/09/2026 en LEAS-7455 y LEAS-7466.
//
// Variables (las de texto en wrangler.toml, los SECRETOS en el panel de Cloudflare):
//   JIRA_EMAIL   avicente@leaseir.com          (texto)
//   PANEL_GENTE  nombres autorizados           (texto)
//   PANEL_IDS    {"Nombre":"accountId", ...}   (texto)  -> para reasignar
//   JIRA_TOKEN   token de api.atlassian.com    (SECRETO)
//   PANEL_CLAVE  cadena que el panel manda     (SECRETO)
//   TELEGRAM_TOKEN token del bot @leaseir_sat_monitor_bot (SECRETO)  -> puntos sin ticket
//   TG_GRUPO     chat_id del grupo «SAT Leaseir - Herramienta Control Diario» (texto, -5461993276)
//
// Puntos SIN ticket (09/09/2026): el panel manda {sin_ticket:true, linea, quien, clave} y el worker
// publica la línea en el grupo de la herramienta con el bot. Antes el técnico tenía que copiarla y
// pegarla a mano, y si no lo hacía el punto volvía al día siguiente. Cloudflare sí llega a
// api.telegram.org (desde la red de Leaseir está bloqueado).

const BASE   = 'https://leaseir.atlassian.net';
const ORIGEN = 'https://alejandrovicente97.github.io';

const cors = {
  'Access-Control-Allow-Origin': ORIGEN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary': 'Origin'
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// ── Lectura en vivo (09/09/2026) ─────────────────────────────────────────────────────────────
// GET /cola?clave=…      → estado de todas las abiertas + última nota de las tocadas en 36 h. Cacheado 60 s.
// GET /ticket/LEAS-x?clave=… → un ticket con sus últimos comentarios (buscador del panel).
// Solo campos de estado: nada de direcciones, series ni importes. Lo gordo (/cola completa para calcular las
// reglas en el navegador) espera a que el panel tenga Cloudflare Access o clave por persona.
const CAMPOS_ESTADO = ['status', 'assignee', 'updated', 'statuscategorychangedate', 'issuetype', 'parent',
  'customfield_10143', 'customfield_10144', 'customfield_10141'];   // técnico externo, cita estimada, cita agendada
async function jql(H, q, fields, max = 100) {
  const out = []; let token = null;
  for (let i = 0; i < 8; i++) {
    const body = { jql: q, fields, maxResults: max };
    if (token) body.nextPageToken = token;
    const r = await fetch(`${BASE}/rest/api/3/search/jql`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('jira ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    out.push(...(j.issues || []));
    token = j.nextPageToken; if (!token || j.isLast) break;
  }
  return out;
}
function textoADF(b) {
  if (!b) return ''; if (typeof b === 'string') return b;
  const t = []; (function w(n) { if (!n) return; if (n.type === 'text') t.push(n.text || ''); (n.content || []).forEach(w); })(b);
  return t.join('').replace(/\s+/g, ' ').trim();
}
function ultimaNota(cs) {
  const c = (cs || []).slice().sort((a, b) => (a.created < b.created ? 1 : -1))[0];
  if (!c) return null;
  const tx = textoADF(c.body);
  const m = tx.match(/^([A-Za-zÁÉÍÓÚÑáéíóúñ]+) \(vía panel, \d\d:\d\d\): /);
  return { h: c.created, quien: m ? m[1] : (c.author && c.author.displayName) || '', txt: tx.slice(0, 120), panel: !!m };
}
async function cola(env) {
  const auth = btoa(`${env.JIRA_EMAIL}:${env.JIRA_TOKEN}`);
  const H = { Authorization: `Basic ${auth}`, Accept: 'application/json' };
  const abiertas = await jql(H, 'project = LEAS AND statusCategory != Done', CAMPOS_ESTADO);
  const tocadas  = await jql(H, 'project = LEAS AND updated >= -36h', ['comment', 'status'], 50);
  const T = {};
  for (const i of abiertas) {
    const f = i.fields || {};
    T[i.key] = { e: f.status && f.status.name, cat: f.status && f.status.statusCategory && f.status.statusCategory.key,
      resp: f.assignee ? f.assignee.displayName : null, upd: f.updated, cambio: f.statuscategorychangedate,
      sub: !!(f.issuetype && f.issuetype.subtask), padre: f.parent ? f.parent.key : null,
      tec: f.customfield_10143 ? f.customfield_10143.value : null, cita: f.customfield_10144 || null, agenda: f.customfield_10141 || null };
  }
  for (const i of tocadas) {
    const f = i.fields || {};
    const n = ultimaNota(f.comment && f.comment.comments);
    if (!T[i.key]) T[i.key] = { e: f.status && f.status.name, cat: f.status && f.status.statusCategory && f.status.statusCategory.key, cerrado: true };
    if (n) T[i.key].nota = n;
  }
  return { ok: true, hora: new Date().toISOString(), n: Object.keys(T).length, t: T };
}
async function ticket(env, key) {
  const auth = btoa(`${env.JIRA_EMAIL}:${env.JIRA_TOKEN}`);
  const H = { Authorization: `Basic ${auth}`, Accept: 'application/json' };
  const r = await fetch(`${BASE}/rest/api/3/issue/${key}?fields=summary,status,assignee,created,updated,customfield_10211,customfield_10171,customfield_10150,customfield_10210,customfield_10143,comment,parent,subtasks`, { headers: H });
  if (r.status === 404) return { ok: false, error: 'no_existe' };
  if (!r.ok) throw new Error('jira ' + r.status);
  const j = await r.json(); const f = j.fields || {};
  const cs = (f.comment && f.comment.comments || []).slice(-5).reverse().map(c => ({ h: c.created, quien: (c.author && c.author.displayName) || '', txt: textoADF(c.body).slice(0, 300) }));
  return { ok: true, key: j.key, estado: f.status && f.status.name, cat: f.status && f.status.statusCategory && f.status.statusCategory.key,
    resp: f.assignee ? f.assignee.displayName : null, creado: f.created, upd: f.updated, centro: f.customfield_10211, consola: f.customfield_10171,
    pistola: f.customfield_10150, averia: f.customfield_10210, tecnico: f.customfield_10143 && f.customfield_10143.value,
    padre: f.parent ? f.parent.key : null, subtareas: (f.subtasks || []).map(x => x.key + ' ' + (x.fields && x.fields.status && x.fields.status.name || '')), notas: cs };
}

// ── /explica/LEAS-x (09/09/2026): expediente en vivo + explicación con criterio ─────────────────────
// Monta el expediente (ticket + historial + comentarios + tickets del mismo centro y de la misma consola) y se lo pasa
// a un modelo con las reglas de la casa. Devuelve {ok, expediente, explicacion}. Caché 10 min. Secretos: ANTHROPIC_API_KEY.
// Variable opcional ANTHROPIC_MODEL (por defecto claude-sonnet-4-5).
const REGLAS = `Eres el controller del SAT de Leaseir (láseres de diodo en alquiler a centros de depilación en España, Italia,
Francia y otros). Te dan el expediente de un ticket de Jira (proyecto LEAS) y tienes que explicar, en español y en 6-10
líneas de prosa sin listas, qué está pasando, qué no cuadra y qué habría que pedir hoy en el ticket. Con hechos, fechas y
horas del expediente; nunca inventes. Si algo no se puede saber con lo que hay, dilo.
Reglas de la casa:
- Estados que son CERRADO: Resuelto, Finalizada, Cancelado, Devuelto a fábrica, Finalizado técnico externo. Siguen abiertos:
  Equipo devuelto, Devuelto a cliente, Inspección de salida. Desde «Resuelto» no se puede pasar a «Finalizada».
- Principal = Tarea/Material. Subtareas: máquina de sustitución, queja de calidad (NO es trabajo del SAT), cobro
  (administrativo). Las subtareas heredan ubicación y tracking del padre. Un principal puede tener varias hermanas.
- No se recoge la averiada hasta que llega la sustitución al centro. Una serie en dos tickets no es duplicación si el
  primer préstamo volvió («Equipo devuelto»).
- Una máquina alquilada a un cliente (Traditional Renting / Renting S&L / Sold en el inventario) no puede salir como
  préstamo a otro; al reparar vuelve a su dueño y se recupera la de sustitución.
- SLA: recepción 4 h; reparación cliente (11122) 80 h; técnico externo (11056) 16 h desde «Enviado a técnico externo» —
  si el ticket tiene técnico externo pero no está en ese estado, el reloj no corre y el panel no lo vigila.
- La cita del técnico externo vive en «Fecha y hora estimada técnico externo» (ojo: a veces es transición + 24 h por
  defecto), en «Fecha y hora agendada» o en un comentario («va hoy a las 15:30»). Si existe, no digas que falta.
- Transporte medido: mediana 5,8 días, p90 26; Centri Unico p90 54 días. Un ticket parado en aduanas no es fallo del equipo.
- Presupuestos y facturas se comprueban en Holded, no se deducen de Jira. No propongas facturar sin leer los comentarios.
- Los chats (Telegram/WhatsApp) NO están en el expediente salvo lo volcado a Jira como «(por <grupo>, hh:mm)». Dilo.
- Reincidencia: si la misma consola o el mismo centro repite síntoma, dilo con los tickets y fechas, y cuestiona repetir el
  mismo arreglo. Distingue lo que depende del cliente (presupuesto sin firmar) de lo que depende del SAT.
Estructura: primero qué pasa (una frase con el estado real), luego lo que no cuadra o se está ocultando, luego qué pedir
hoy (concreto: a quién y qué). Tono: directo, sin adornos, sin nombres propios innecesarios del equipo.`;

function adfTexto(b) { return textoADF(b); }
async function expediente(env, key) {
  const auth = btoa(`${env.JIRA_EMAIL}:${env.JIRA_TOKEN}`);
  const H = { Authorization: `Basic ${auth}`, Accept: 'application/json' };
  const F = 'summary,issuetype,status,created,updated,resolutiondate,assignee,reporter,parent,subtasks,labels,customfield_10211,customfield_10130,customfield_10138,customfield_10171,customfield_10150,customfield_10199,customfield_10200,customfield_10210,customfield_10140,customfield_10143,customfield_10144,customfield_10141,customfield_10182,customfield_10183,customfield_10184,customfield_10301,customfield_10128,customfield_11255,customfield_11288,customfield_11420,comment';
  const r = await fetch(`${BASE}/rest/api/3/issue/${key}?fields=${F}&expand=changelog`, { headers: H });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('jira ' + r.status);
  const j = await r.json(); const f = j.fields || {};
  const v = x => x == null ? null : (typeof x === 'object' ? (x.value || x.name || x.displayName || x.key || null) : x);
  const hist = (j.changelog && j.changelog.histories || []).flatMap(h => (h.items || [])
    .filter(i => ['status', 'assignee', 'Nombre técnico externo', 'Fecha y hora estimada técnico externo', 'Fecha y hora agendada', 'Número de referencia de consola prestada', 'Número de referencia de handpiece prestado', 'Tracking ID recogida'].includes(i.field))
    .map(i => ({ h: h.created.slice(0, 16).replace('T', ' '), quien: (h.author && h.author.displayName) || '', campo: i.field, de: i.fromString || '', a: i.toString || '' })))
    .sort((a, b) => a.h < b.h ? -1 : 1);
  const notas = (f.comment && f.comment.comments || []).map(c => ({ h: c.created.slice(0, 16).replace('T', ' '), quien: (c.author && c.author.displayName) || '', txt: adfTexto(c.body).slice(0, 400) }));
  const centro = (f.customfield_10211 || '').trim(), consola = (f.customfield_10171 || '').trim();
  let rel = [];
  try {
    const partes = [];
    if (consola && consola.length >= 4) partes.push(`cf[10171] ~ "${consola.replace(/"/g, '')}"`);
    if (centro) partes.push(`cf[10211] ~ "\\"${centro.replace(/"/g, '').replace(/\s+/g, ' ')}\\""`);
    if (partes.length) {
      const rr = await jql(H, `project = LEAS AND key != ${key} AND issuetype in standardIssueTypes() AND (${partes.join(' OR ')}) ORDER BY created DESC`,
        ['status', 'created', 'resolutiondate', 'customfield_10210', 'customfield_10171', 'customfield_10143', 'customfield_10211'], 20);
      rel = rr.slice(0, 15).map(i => ({ key: i.key, estado: v(i.fields.status), creado: i.fields.created.slice(0, 10), cerrado: (i.fields.resolutiondate || '').slice(0, 10) || null,
        averia: (i.fields.customfield_10210 || '').slice(0, 120), consola: i.fields.customfield_10171 || '', tecnico: v(i.fields.customfield_10143), centro: i.fields.customfield_10211 || '' }));
    }
  } catch (e) { rel = [{ error: String(e.message || e) }]; }
  return {
    key: j.key, tipo: v(f.issuetype), estado: v(f.status), cat: f.status && f.status.statusCategory && f.status.statusCategory.key,
    creado: f.created.slice(0, 16).replace('T', ' '), actualizado: f.updated.slice(0, 16).replace('T', ' '), cerrado: f.resolutiondate ? f.resolutiondate.slice(0, 16).replace('T', ' ') : null,
    resp: v(f.assignee), abierto_por: v(f.reporter), padre: f.parent ? f.parent.key : null,
    subtareas: (f.subtasks || []).map(x => `${x.key} ${(x.fields && x.fields.summary) || ''} · ${(x.fields && x.fields.status && x.fields.status.name) || ''}`),
    etiquetas: f.labels || [], centro, propietario: f.customfield_10130 || '', direccion: f.customfield_10138 || '',
    consola, pistola: f.customfield_10150 || '', prestada_consola: f.customfield_10199 || '', prestada_pistola: f.customfield_10200 || '',
    averia: f.customfield_10210 || '', tipo_averia: v(f.customfield_10140), tecnico_externo: v(f.customfield_10143),
    cita_estimada: f.customfield_10144 || null, cita_agendada: f.customfield_10141 || null,
    garantia: v(f.customfield_10182), contrato: v(f.customfield_10183), requiere_pago: v(f.customfield_10184), importe: f.customfield_10301 || null,
    forma_resolucion: v(f.customfield_10128), incidencias_previas_consola: f.customfield_11255, incidencias_previas_pistola: f.customfield_11288,
    tracking: f.customfield_11420 || null, historial: hist, notas, relacionados: rel
  };
}
async function explica(env, key) {
  const ex = await expediente(env, key);
  if (!ex) return { ok: false, error: 'no_existe' };
  if (!env.ANTHROPIC_API_KEY) return { ok: true, expediente: ex, explicacion: null, aviso: 'sin_modelo' };
  const hoy = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'full', timeStyle: 'short' }).format(new Date());
  const cuerpo = `Hoy es ${hoy}.\n\nEXPEDIENTE DE ${key} (JSON):\n${JSON.stringify(ex, null, 1)}\n\nExplica qué pasa con este ticket.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-5', max_tokens: 900, system: REGLAS, messages: [{ role: 'user', content: cuerpo }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: true, expediente: ex, explicacion: null, aviso: 'modelo', detalle: (j.error && j.error.message) || r.status };
  const texto = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  return { ok: true, expediente: ex, explicacion: texto, modelo: j.model, hora: new Date().toISOString() };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (request.method === 'GET') {
      const u = new URL(request.url);
      if (u.searchParams.get('clave') !== env.PANEL_CLAVE) return json({ error: 'clave' }, 401);
      try {
        if (u.pathname === '/cola') {
          const cache = caches.default; const ck = new Request(u.origin + '/cola', { method: 'GET' });
          const hit = await cache.match(ck);
          if (hit) return new Response(hit.body, { headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'hit' } });
          const c = await cola(env);
          const resp = new Response(JSON.stringify(c), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });
          await cache.put(ck, resp.clone());
          return new Response(JSON.stringify(c), { headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'miss' } });
        }
        const m = u.pathname.match(/^\/ticket\/(LEAS-\d{3,5})$/);
        if (m) return json(await ticket(env, m[1]));
        if (u.pathname === '/notas') {
          if (!env.NOTAS) return json({ ok: false, error: 'sin_kv' }, 503);
          const dia = (u.searchParams.get('dia') || new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date())).slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return json({ error: 'dia' }, 400);
          const out = []; let cursor = undefined;
          do {
            const page = await env.NOTAS.list({ prefix: 'n:' + dia + ':', cursor, limit: 1000 });
            for (const k of page.keys) { const v = await env.NOTAS.get(k.name); if (v) { try { out.push(JSON.parse(v)); } catch (e) {} } }
            cursor = page.list_complete ? undefined : page.cursor;
          } while (cursor);
          out.sort((a, b) => a.h < b.h ? -1 : 1);
          return json({ ok: true, dia, n: out.length, notas: out });
        }
        const mx = u.pathname.match(/^\/explica\/(LEAS-\d{3,5})$/);
        if (mx) {
          const cache = caches.default; const ck = new Request(u.origin + '/explica/' + mx[1] + (u.searchParams.get('fresco') ? '?f=' + Date.now() : ''), { method: 'GET' });
          const hit = u.searchParams.get('fresco') ? null : await cache.match(ck);
          if (hit) return new Response(hit.body, { headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'hit' } });
          const c = await explica(env, mx[1]);
          if (c.ok && c.explicacion) {
            const resp = new Response(JSON.stringify(c), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' } });
            await cache.put(ck, resp.clone());
          }
          return json(c);
        }
        return json({ error: 'ruta' }, 404);
      } catch (e) { return json({ error: 'fallo', detalle: String((e && e.message) || e) }, 502); }
    }

    if (request.method !== 'POST')    return json({ error: 'metodo' }, 405);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'json' }, 400); }
    const { leas, quien, texto, clave, para, sin_ticket, linea } = body || {};

    if (clave !== env.PANEL_CLAVE)          return json({ error: 'clave' }, 401);

    // Punto sin ticket: al grupo de la herramienta por el bot, y fuera.
    if (sin_ticket) {
      const genteST = String(env.PANEL_GENTE || '').split(',').map(x => x.trim()).filter(Boolean);
      if (!genteST.includes(quien))                 return json({ error: 'quien' }, 400);
      const l = String(linea || '').trim();
      if (!l || l.length > 600)                     return json({ error: 'linea' }, 400);
      // 1) Guardar en KV (binding NOTAS). Es lo que hace que la nota no se pierda aunque no haya bot.
      let guardado = false, clave = null;
      if (env.NOTAS) {
        try {
          const ahora = new Date();
          const dia = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(ahora);   // AAAA-MM-DD
          clave = `n:${dia}:${ahora.toISOString()}:${Math.random().toString(36).slice(2, 8)}`;
          await env.NOTAS.put(clave, JSON.stringify({ h: ahora.toISOString(), quien, linea: l, id: String(body.id || '').slice(0, 200), tipo: String(body.tipo || '').slice(0, 20) }),
            { expirationTtl: 60 * 60 * 24 * 120 });
          guardado = true;
        } catch (e) { guardado = false; }
      }
      // 2) Telegram, si hay bot. Si falla pero está guardado, sigue siendo ok.
      let telegram = false, detalle = null;
      if (env.TELEGRAM_TOKEN && env.TG_GRUPO) {
        try {
          const tg = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: env.TG_GRUPO, text: l + ' (vía panel)', disable_web_page_preview: true })
          });
          const tj = await tg.json().catch(() => ({}));
          telegram = !!(tg.ok && tj.ok); if (!telegram) detalle = tj.description || tg.status;
        } catch (e) { detalle = String((e && e.message) || e); }
      } else detalle = 'sin_bot';
      if (!guardado && !telegram) return json({ error: detalle === 'sin_bot' ? 'sin_bot' : 'telegram', detalle }, detalle === 'sin_bot' ? 503 : 502);
      return json({ ok: true, via: (guardado ? 'kv' : '') + (telegram ? (guardado ? '+telegram' : 'telegram') : ''), guardado, telegram, detalle, clave });
    }
    if (!/^LEAS-\d{3,5}$/.test(leas || '')) return json({ error: 'leas' }, 400);
    const gente = String(env.PANEL_GENTE || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!gente.length || !gente.includes(quien)) return json({ error: 'quien' }, 400);

    // Traspaso opcional
    let ids = {};
    try { ids = JSON.parse(env.PANEL_IDS || '{}'); } catch { ids = {}; }
    let destino = null;
    if (para) {
      if (!gente.includes(para))  return json({ error: 'para' }, 400);
      if (para === quien)         return json({ error: 'para_mismo' }, 400);
      destino = ids[para] || null;
      if (!destino)               return json({ error: 'para_sin_id', detalle: para }, 400);
    }

    const t = (texto || '').trim();
    if (!t && !para)         return json({ error: 'texto' }, 400);
    if (t.length > 1500)     return json({ error: 'largo' }, 400);

    const auth = btoa(`${env.JIRA_EMAIL}:${env.JIRA_TOKEN}`);
    const H = { Authorization: `Basic ${auth}`, Accept: 'application/json' };
    const hora = new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit'
    }).format(new Date());
    const partes = [];
    if (para) partes.push(`se lo paso a ${para}`);
    if (t)    partes.push(t);
    const cuerpo = `${quien} (vía panel, ${hora}): ${partes.join('. ')}`;

    try {
      // ¿Es petición del portal? Si lo es, el cliente tiene vista del ticket
      // y hay que usar servicedeskapi con public:false.
      const esPortal = (await fetch(`${BASE}/rest/servicedeskapi/request/${leas}`, { headers: H })).ok;

      let r, via;
      if (esPortal) {
        via = 'nota interna';
        r = await fetch(`${BASE}/rest/servicedeskapi/request/${leas}/comment`, {
          method: 'POST',
          headers: { ...H, 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' },
          body: JSON.stringify({ body: cuerpo, public: false })
        });
      } else {
        via = 'comentario (el ticket no es del portal: no tiene vista de cliente)';
        r = await fetch(`${BASE}/rest/api/3/issue/${leas}/comment`, {
          method: 'POST',
          headers: { ...H, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: cuerpo }] }] }
          })
        });
      }

      const j = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: 'jira', status: r.status, detalle: j.errorMessages || j.errors || j }, 502);

      // No fiarse del POST: releer y confirmar que ha quedado como interna.
      let interna = null;
      if (esPortal) {
        const v = await fetch(`${BASE}/rest/servicedeskapi/request/${leas}/comment?limit=50`, { headers: H });
        if (v.ok) {
          const vj = await v.json();
          const mio = (vj.values || []).find(c => String(c.id) === String(j.id));
          interna = mio ? mio.public === false : null;
        }
      }

      // Traspaso: cambiar el responsable y volver a leerlo para confirmarlo.
      let asignado = null, asignadoA = null;
      if (destino) {
        const a = await fetch(`${BASE}/rest/api/3/issue/${leas}/assignee`, {
          method: 'PUT',
          headers: { ...H, 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: destino })
        });
        if (a.ok || a.status === 204) {
          const c = await fetch(`${BASE}/rest/api/3/issue/${leas}?fields=assignee`, { headers: H });
          if (c.ok) {
            const cj = await c.json();
            asignadoA = cj && cj.fields && cj.fields.assignee ? cj.fields.assignee.displayName : null;
            asignado = !!(cj && cj.fields && cj.fields.assignee && cj.fields.assignee.accountId === destino);
          } else { asignado = true; }
        } else {
          const aj = await a.json().catch(() => ({}));
          asignado = false;
          return json({ ok: true, via, id: j.id, interna, asignado: false,
                        avisoAsignar: aj.errorMessages || aj.errors || ('HTTP ' + a.status) });
        }
      }

      return json({ ok: true, via, id: j.id, interna, asignado, asignadoA });
    } catch (e) {
      return json({ error: 'fallo', detalle: String((e && e.message) || e) }, 500);
    }
  }
};
