# sat-nota

Worker de Cloudflare que escribe notas internas en Jira desde el panel del SAT.

## Secretos que hay que poner en Cloudflare (Settings -> Variables and Secrets)

- `JIRA_EMAIL`  = avicente@leaseir.com
- `JIRA_TOKEN`  = token de https://id.atlassian.com/manage-profile/security/api-tokens
- `PANEL_CLAVE` = la cadena que el panel envia en cada peticion

Los tres van como **Secret**, no como variable de texto plano.

## Probar

curl -X POST https://sat-nota.<subdominio>.workers.dev \
  -H 'Content-Type: application/json' \
  -d '{"leas":"LEAS-7455","quien":"Alejandro","texto":"prueba","clave":"..."}'

Devuelve `{"ok":true,"via":"nota interna","id":"...","interna":true}`.
`interna:true` significa que se ha releido el ticket y el comentario esta como `public:false`.
