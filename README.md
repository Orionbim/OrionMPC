# ORIONMCP

ORIONMCP conecta Autodesk Revit 2024 con Shelra y otros clientes compatibles con
Model Context Protocol (MCP). Su objetivo es permitir consultar y modificar modelos,
y trabajar con grafos Dynamo, mediante instrucciones en lenguaje natural.

**Shelra es el cliente recomendado.** ORIONMCP también está diseñado para Claude
Code, Cursor, Claude y ChatGPT. Cada cliente tiene su propio método de autenticación.

El servicio remoto usa HTTPS. El add-in de Revit inicia una conexión saliente al
servicio: no necesitas abrir puertos del router ni publicar Revit en Internet.

## Qué está disponible

Esta versión está en desarrollo. El add-in ya abre una interfaz dentro de Revit y
permite consultar versión, documentos y parámetros. Los cambios de parámetros de
texto solicitan aprobación dentro de Revit. El diagnóstico detecta la versión
Dynamo y si está abierto.

La conexión HTTP incluye autenticación OAuth y emparejamiento con aprobación
en Revit. El acceso remoto inicial permite lecturas. La creación, edición y
ejecución de grafos Dynamo y el instalador para usuarios todavía no están
disponibles. No se declara cobertura completa de Revit o Dynamo.

## Requisitos

- Windows con Autodesk Revit 2024 instalado y una licencia válida.
- Shelra, si deseas utilizar el cliente recomendado.
- Conexión a Internet para el servicio remoto.
- Para compilar esta versión: Node.js 24 y .NET SDK con soporte de compilación net48.

Revit y los productos Autodesk mantienen sus propios requisitos y licencias.

## Instalar la versión de desarrollo

Hasta que exista un instalador publicado, la instalación requiere compilar el
código en Windows. Estos pasos son para desarrolladores:

1. Descarga o clona este repositorio.
2. Abre una terminal en la carpeta del proyecto y ejecuta:

   ```powershell
   npm ci
   npm run build
   dotnet build src/revit/OrionMcp.Revit2024.csproj -c Release
   ```

3. Guarda tus documentos y cierra Revit normalmente.
4. Instala el manifiesto del add-in:

   ```powershell
   powershell -File scripts/install-dev-addin.ps1
   ```

5. Abre Revit 2024. Busca la pestaña **ORIONMCP** y pulsa **ORIONMCP** para abrir
   su panel. Los assets de la interfaz ya están empaquetados; no debes mantener
   una terminal o un servidor Vite abierto para usar el panel.

## Usar el panel de Revit

1. Abre un modelo de prueba.
2. Pulsa **Actualizar estado** y comprueba la instancia Revit mostrada.
3. Selecciona el **Documento objetivo**.
4. Indica el ID del elemento y pulsa **Leer parámetros**.
5. Para un parámetro de texto editable, selecciona el parámetro, escribe el nuevo
   valor y pulsa **Revisar cambio y solicitar aprobación**.
6. Revisa el documento, elemento y valores en el diálogo nativo. Aprueba solamente
   si coinciden con tu intención. ORIONMCP comprobará el commit y el valor final.

Si una operación agota su plazo, consulta su resultado antes de repetir un cambio.
No presupongas que el timeout deshizo la operación.

## Conectar Shelra por HTTP

Endpoint del servicio:

```text
https://orionmpc-production.up.railway.app/mcp
```

Utiliza una versión de Shelra que incluya la integración ORIONMCP y el comando
`mcp orionmcp login`. Si ese comando no aparece en su ayuda, actualiza Shelra.
La integración usa el endpoint anterior por defecto; no tienes que editar JSON.

1. Abre Revit 2024 y el panel **ORIONMCP**.
2. Pulsa **Conectar servidor HTTP**. Conserva la dirección predeterminada,
   salvo que utilices tu propio servidor.
3. El panel mostrará un código temporal válido durante cinco minutos.
4. En Shelra, ejecuta `shelra mcp orionmcp login`. Se abrirá el navegador.
5. Introduce el código del panel en la página de ORIONMCP.
6. Vuelve a Revit y revisa el cliente, servidor e instancia. Aprueba la conexión
   si los datos coinciden. El permiso inicial permite consultar el modelo.
7. En Shelra, ejecuta `shelra mcp orionmcp test` para descubrir herramientas y
   `shelra mcp orionmcp inspect` para consultar la versión y los documentos reales.
8. Empieza una sesión de Shelra y pide una primera consulta de lectura.

El estado «Equipo conectado» indica que existe un canal al servidor. Una respuesta
real de versión o documentos desde Shelra comprueba que la solicitud llegó a Revit.
Las escrituras remotas todavía no están habilitadas en esta versión.

Si elegiste otro servidor anteriormente, puedes preparar su cambio con
`shelra mcp orionmcp connect --url https://orionmpc-production.up.railway.app/mcp`.
Revisa la vista previa y repite con `--apply` para conservar una copia y cambiar
únicamente ORIONMCP. No se reemplazan otros servidores ni preferencias.

Una vez verificada la conexión, comienza con una consulta de lectura: «Indica a
qué instancia de Revit y documento estás conectado». Después inspecciona elementos
y prepara cambios con aprobación. Las credenciales de ORIONMCP son independientes
de las credenciales del proveedor de modelos de Shelra.

## Resolver problemas de conexión

- **Código caducado:** desconecta el equipo, genera otro código y repite el login.
- **Autenticación pendiente:** completa la página del navegador y la aprobación
  en Revit; escribir una configuración no autoriza al cliente.
- **Sin instancias Revit:** comprueba que Revit está abierto, que el complemento
  cargó y que su panel muestra el equipo conectado.
- **Sin documentos:** abre un modelo y vuelve a consultar los documentos.
- **Conexión interrumpida:** el add-in intenta reconectar. Consulta el estado
  actual antes de repetir una tarea. El complemento renueva la autorización del
  equipo; si fue revocada o caducó, vuelve a emparejar desde el panel.

## Desplegar tu propio servidor

El repositorio incluye un Dockerfile y configuración de Railway. Consulta la
[guía de despliegue](docs/deployment.md) para configurar una instancia propia.
ORIONMCP admite desarrollo local y no requiere utilizar una cuenta privada del autor.

## Licencia

El código propio de ORIONMCP se publica con [Apache-2.0](LICENSE). Las dependencias
conservan sus licencias. Este repositorio no incluye binarios Autodesk ni modelos
de usuarios.
