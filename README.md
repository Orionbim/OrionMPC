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

La conexión HTTP autenticada y su emparejamiento se están completando. La creación,
edición y ejecución de grafos Dynamo y el instalador para usuarios todavía no
están disponibles. No se declara cobertura completa de Revit o Dynamo.

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

Endpoint previsto del servicio:

```text
https://orionmcp-production.up.railway.app/mcp
```

El flujo principal será iniciar sesión, emparejar el add-in y seleccionar Shelra
desde la interfaz. La integración nativa de Shelra se está preparando para usar
este endpoint por defecto. Ese flujo aún no está completo en esta versión;
no interpretes una respuesta del servidor como prueba de conexión con Revit.

Una vez verificada la conexión, comienza con una consulta de lectura: «Indica a
qué instancia de Revit y documento estás conectado». Después inspecciona elementos
y prepara cambios con aprobación. Las credenciales de ORIONMCP son independientes
de las credenciales del proveedor de modelos de Shelra.

## Desplegar tu propio servidor

El repositorio incluye un Dockerfile y configuración de Railway. Consulta la
[guía de despliegue](docs/deployment.md) para configurar una instancia propia.
ORIONMCP admite desarrollo local y no requiere utilizar una cuenta privada del autor.

## Licencia

El código propio de ORIONMCP se publica con [Apache-2.0](LICENSE). Las dependencias
conservan sus licencias. Este repositorio no incluye binarios Autodesk ni modelos
de usuarios.
