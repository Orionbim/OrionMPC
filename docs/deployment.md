# Railway y modo local

Repositorio solicitado: `git@github.com:yosoyjavieruiz/OrionMPC.git`.
El nombre del repositorio conserva OrionMPC; el producto / identificador es ORIONMCP / orionmcp.

## Railway

Seleccionar este repositorio como servicio, root directory `/`, Dockerfile incluido.
Railway inyecta PORT; el health check es `/healthz`. Generar el dominio público
HTTPS y configurar ORIONMCP_PUBLIC_URL con esa base, sin `/mcp` ni secretos.
El endpoint de cliente es `https://<dominio-generado>/mcp`.

Configurar issuer OAuth y JWKS en ORIONMCP_OAUTH_ISSUER /
ORIONMCP_OAUTH_JWKS_URL. El access token debe incluir `exp`, `iat`, `sub`, audience
igual al endpoint MCP y scope `orion:read`; firmas RS256 / ES256 / EdDSA.
`/.well-known/oauth-protected-resource/mcp` anuncia resource, issuer y scope.
El issuer debe proveer su metadata y el flujo OAuth compatible con el cliente.
Sin configuración, `/mcp` rechaza con 503; no hay modo público sin autenticación.
`/healthz` es liveness, `/readyz` comprueba configuración básica. No prueban Revit.

**Este incremento remoto solo expone estado de transporte.** El canal saliente
Windows, pairing / revocación, jobs durables y ejecución remota están pendientes.
Una URL de Railway activa no completa el recorrido hasta Revit. No presentar
este servidor como producto remoto final, no bajar autorización para aparentar
conexión. MCP baseline SDK 1.27.1 / negociación era 2025; conformidad 2026 pendiente.

No se crearon servicios Railway ni se usaron credenciales del propietario. El
propietario indicó que realizará el despliegue y proporcionará la URL.

## Desarrollo local real Windows

```powershell
npm ci
npm run build
dotnet build src/revit/OrionMcp.Revit2024.csproj -c Release
powershell -File scripts/install-dev-addin.ps1
```

El instalador de desarrollo exige Revit cerrado normalmente; no lo mata. Solo
crea ORIONMCP.addin y conserva backup si ya existe. Apunta al build local, verifica
DLL / assets / manifiesto; el instalador distribuible aún está pendiente.

Abrir Revit 2024 y su pestaña ORIONMCP. La pane usa assets Vite empaquetados:
no requiere npm ni devserver durante uso. El puente WebView acepta su origen exacto
y operaciones enumeradas, no APIs nativas genéricas. El host registra instancia
y named pipe con ACL del usuario; token efímero local, límites y cola ExternalEvent.

Servidor MCP local: `node dist/server/local.js` (stdio). Para otros clientes:
executable Node instalado + argumento absoluto a ese archivo. Shell no requerido.
Este launcher de desarrollo no es todavía el companion exe distribuible.

Shelra: `node scripts/configure-shelra-dev.mjs` previsualiza, `--apply` respalda y
combina únicamente ORIONMCP. `shelra mcp orionmcp test` descubre herramientas y
`shelra mcp orionmcp inspect` invoca lecturas reales de versión/documentos en el
build nuevo. El binario anterior puede consumir la entrada MCP escrita, aunque
no contiene estos nuevos comandos CLI.

`node scripts/check-local-revit.mjs` verifica API read-only y guarda datos privados
en `.local/evidence/`. Escritura de texto pide aprobación en Revit, comprueba
documento / valor previo / plazo / commit / valor final. No suprime advertencias.
Identificadores Int64 como strings. Un requestId repetido con argumentos distintos
se rechaza; la deduplicación actual vive en la sesión. Journal de escritura local
ayuda a diagnóstico, pero no es aún reconciliación durable completa. No repetir
una escritura tras timeout. Edición de grafos Dynamo pendiente; su diagnóstico
no equivale a ejecución del motor.
