# ORIONMCP — conecta tu IA con tu Revit

ORIONMCP permite que una IA (Shelra, Claude, ChatGPT, Cursor…) consulte y trabaje en **tu Revit abierto**, con tu
cuenta de OrionBIM y sin programar nada. Es un servicio alojado por OrionBIM: no hay que instalar un servidor ni abrir
puertos.

> **Este repositorio es el diseño anterior (código de emparejamiento + servidor propio) y ya no es el camino de uso.**
> Se conserva, con su licencia Apache-2.0, en [`docs/LEGACY.md`](docs/LEGACY.md) y en el código de este repositorio.
> El servicio actual lo sirve el backend de OrionBIM y su código **no es público**.

## Qué necesitas

1. **Windows con Autodesk Revit 2024** (hoy solo esa versión).
2. El **complemento de OrionBIM** instalado en Revit y con la sesión iniciada (botón «Conectar IA» en la pestaña
   *Orionbim*).
3. Una **cuenta de OrionBIM**.
4. Un **cliente de IA compatible con MCP remoto**.

Revit y los productos Autodesk mantienen sus propios requisitos y licencias.

## Cómo conectarte

La dirección del servicio está siempre actualizada en la página **«Conectar mi IA»** de OrionBIM
(`https://www.orionbim.com/mcp/conectar`). A fecha de esta guía es:

```
https://backend-orionbim-production.up.railway.app/mcp
```

- **Shelra** *(verificado por OrionBIM)*: viene con la dirección de OrionBIM ya configurada. Pídele algo sobre tu Revit
  («¿cuántos niveles tiene mi modelo?»). La primera vez abre OrionBIM en tu navegador: comprueba que la cuenta es la
  tuya y pulsa **Permitir**.
- **Claude, ChatGPT, Cursor, Claude Code y otros** *(no verificados todavía por OrionBIM)*: el servicio usa MCP por HTTPS
  con OAuth 2.1 (PKCE) y registro dinámico de clientes, así que debería funcionar con cualquier cliente que admita MCP
  remoto con esas características. Añade la dirección de arriba como servidor MCP remoto. Si algo falla, avísanos con una
  *issue*: aún no hemos probado cada cliente.

## Qué puede hacer hoy

El servicio ofrece tres herramientas:

| Herramienta | Para qué sirve |
|---|---|
| `orion_status` | Ver a qué Revit y proyecto estás conectado, y con qué cuenta. |
| `ask_revit` | Pedir un trabajo o una consulta en tu Revit, en lenguaje natural. |
| `revit_task_result` | Recoger el resultado si la petición tardó más de lo que espera tu cliente. |

Todo pasa por el **agente gobernado de OrionBIM**: respeta los permisos de tu proyecto y de tu empresa, deja registro y
pide aprobación donde corresponde. **Hoy el asistente trabaja en modo lectura** salvo que tu empresa conceda
permisos de escritura. El trabajo con grafos de **Dynamo** está en desarrollo y todavía no está disponible.

## Seguridad y privacidad

- Tu contraseña **nunca** llega a la IA: la autorización se da en una pantalla de OrionBIM («Permitir»).
- Una IA solo llega al Revit **de la misma cuenta**; el aislamiento es por empresa y proyecto.
- Puedes cortar todos los accesos cuando quieras con **«Desconectar mis IAs»** en la página «Conectar mi IA».
- El complemento de Revit abre una conexión **saliente** hacia OrionBIM: no se publica tu Revit en Internet.
- Para informar de un problema de seguridad, abre una *issue* **sin incluir datos sensibles** y lo gestionamos con
  más detalle por un canal privado.

## Limitaciones conocidas

- Solo Revit 2024 y solo Windows.
- Revit debe estar abierto y con el complemento conectado a tu cuenta.
- Cada cuenta llega únicamente a su propio Revit; si Revit tiene otra cuenta abierta, la IA no lo verá.
- No declaramos cobertura completa de Revit.

## Licencia

El código de este repositorio (el diseño anterior) se publica bajo Apache License 2.0; ver [`LICENSE`](LICENSE).
Los marcos de OrionBIM y Shelra son de sus respectivos titulares.
