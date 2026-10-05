# Desplegar un servidor ORIONMCP

Esta guía es para quien administra una instancia propia. Los usuarios del
servicio compartido solo necesitan instalar el add-in y conectar su cliente MCP.

El servidor coordina conexiones y autenticación. Revit se ejecuta en Windows;
el add-in inicia la conexión saliente al servidor.

## Railway

1. Crea un servicio desde este repositorio. Usa el Dockerfile incluido y la
   raíz del repositorio como directorio de trabajo.
2. Añade un volumen al servicio con punto de montaje `/data`. Mantén una sola
   réplica: esta versión utiliza SQLite y conexiones de equipos en esa réplica.
3. Genera un dominio público HTTPS. Configura su puerto de destino como `8080`.
4. Añade estas variables en Railway:

   | Variable | Valor |
   | --- | --- |
   | `PORT` | `8080` |
   | `ORIONMCP_PUBLIC_URL` | El origen HTTPS del servicio, sin `/mcp` |
   | `ORIONMCP_DB_PATH` | `/data/auth.sqlite` |
   | `ORIONMCP_STORAGE_KEY` | 32 bytes aleatorios codificados en hexadecimal minúsculo |

5. Para generar y configurar la clave con Railway CLI autenticado, vincula
   primero el servicio correcto y ejecuta `node scripts/provision-storage-key.mjs`.
   La clave no se imprime. Conserva una copia protegida: cambiarla impide leer
   los registros de autenticación existentes.
6. Despliega. Comprueba `/healthz` y `/readyz`. La comprobación de salud indica
   que el servicio funciona; la de disponibilidad comprueba su configuración.
7. Usa `https://<tu-dominio>/mcp` como endpoint MCP y el origen HTTPS sin `/mcp`
   como dirección del servidor en el add-in.

El servicio proporciona descubrimiento OAuth, registro de clientes, PKCE y
revocación. No requiere configurar un proveedor de identidad externo. El
emparejamiento usa un código temporal y requiere aprobación humana en Revit.

## Comprobar una conexión

1. Mantén Revit 2024 abierto con el add-in cargado.
2. Inicia el emparejamiento desde el panel ORIONMCP.
3. Autentica el cliente MCP e introduce el código temporal del panel.
4. Revisa el nombre del cliente y los permisos antes de aprobar en Revit.
5. Consulta las instancias disponibles y pide la versión y los documentos.
   Solo esa respuesta demuestra que la conexión llegó a Revit.

Esta versión del canal remoto admite lecturas. Las escrituras remotas y la
evaluación de grafos Dynamo están pendientes de habilitación y verificación.

## Alojamiento propio

Usa Node.js 24, configura las mismas variables y una ruta persistente y escribible
para `ORIONMCP_DB_PATH`. Ejecuta `npm ci`, `npm run build:server` y `npm start`.
Coloca el servicio detrás de HTTPS con soporte de WebSocket. Para desarrollo
en el mismo equipo se permite HTTP sobre loopback; no publiques ese modo.

El contenedor inicializa los permisos de `/data` y ejecuta Node con el usuario
`node`. Configura el proxy para enviar el tráfico HTTP al puerto `8080`.

## Actualizaciones y recuperación

Conserva el volumen y la clave al actualizar. Haz copias del volumen mediante
las herramientas de tu proveedor, evitando copiar SQLite durante una escritura
sin un mecanismo de backup consistente. Tras un reinicio, los equipos deben
reconectar y consultar de nuevo el contexto de Revit.

Nunca repitas automáticamente una modificación tras perder una respuesta.
Mantén Revit abierto y consulta el resultado antes de decidir el siguiente paso.
