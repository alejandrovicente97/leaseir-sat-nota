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
      if (!env.TELEGRAM_TOKEN || !env.TG_GRUPO)     return json({ error: 'sin_bot' }, 503);
      try {
        const tg = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: env.TG_GRUPO, text: l + ' (vía panel)', disable_web_page_preview: true })
        });
        const tj = await tg.json().catch(() => ({}));
        if (!tg.ok || !tj.ok) return json({ error: 'telegram', detalle: tj.description || tg.status }, 502);
        return json({ ok: true, via: 'telegram', message_id: tj.result && tj.result.message_id });
      } catch (e) {
        return json({ error: 'fallo', detalle: String((e && e.message) || e) }, 500);
      }
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
