// Escribe una NOTA INTERNA en un ticket de Jira desde el panel del SAT de Leaseir.
//
// Por qué existe: el conector de Atlassian no sabe crear notas internas. Solo expone
// commentVisibility, que es una restricción de rol y deja el comentario con jsdPublic:true,
// o sea visible para el cliente en el portal. Lo único que crea una nota interna de verdad
// es servicedeskapi con public:false. Comprobado el 04/09/2026 en LEAS-7455 y LEAS-7466.
//
// Secretos (se ponen en Cloudflare, nunca en el código):
//   JIRA_EMAIL   avicente@leaseir.com
//   JIRA_TOKEN   token de api.atlassian.com
//   PANEL_CLAVE  cadena que el panel manda en cada peticion
//   PANEL_GENTE  nombres autorizados, separados por comas

const BASE   = 'https://leaseir.atlassian.net';
const ORIGEN = 'https://alejandrovicente97.github.io';

const cors = {
  'Access-Control-Allow-Origin': ORIGEN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary': 'Origin'
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST')    return json({ error: 'metodo' }, 405);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'json' }, 400); }
    const { leas, quien, texto, clave } = body || {};

    if (clave !== env.PANEL_CLAVE)          return json({ error: 'clave' }, 401);
    if (!/^LEAS-\d{3,5}$/.test(leas || '')) return json({ error: 'leas' }, 400);
    const gente = String(env.PANEL_GENTE || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!gente.length || !gente.includes(quien)) return json({ error: 'quien' }, 400);
    if (!texto || !texto.trim())            return json({ error: 'texto' }, 400);
    if (texto.length > 1500)                return json({ error: 'largo' }, 400);

    const auth = btoa(`${env.JIRA_EMAIL}:${env.JIRA_TOKEN}`);
    const H = { Authorization: `Basic ${auth}`, Accept: 'application/json' };
    const hora = new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit'
    }).format(new Date());
    const cuerpo = `${quien} (vía panel, ${hora}): ${texto.trim()}`;

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
      return json({ ok: true, via, id: j.id, interna });
    } catch (e) {
      return json({ error: 'fallo', detalle: String((e && e.message) || e) }, 500);
    }
  }
};
