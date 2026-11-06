# Modo red: varios puestos a la vez

Por defecto Tekkadon funciona como siempre: un solo equipo, sin abrir ningún puerto de red.
El **modo servidor** es opcional y permite que otras computadoras de la misma red local usen el
sistema desde su navegador, al mismo tiempo, cada una con su propio usuario.

## Cómo funciona

```
Equipo principal (Tekkadon abierto)            Otros puestos
┌───────────────────────────────────┐         ┌──────────────┐
│ Base de datos cifrada (SQLite)    │         │ Navegador    │
│ Servidor HTTPS (puerto 8787)      │◄────────│https://IP:8787│
│ Ventana de Tekkadon (también usa  │         └──────────────┘
│ el servidor, por 127.0.0.1)            │         ┌──────────────┐
└───────────────────────────────────┘◄────────│ Navegador    │
                                              └──────────────┘
```

- Los datos siguen en **un solo archivo en el equipo principal**. Los demás puestos no guardan nada.
- La interfaz de los demás puestos es la misma que la del programa: se la entrega el propio equipo principal.
- Cada puesto tiene su **sesión propia** (un token en memoria). Los roles (administrador, cajero, almacén)
  funcionan igual: cada persona ve solo lo que le corresponde.
- Las operaciones se ejecutan **de una en una** en el equipo principal. Dos cajeros no pueden vender la
  misma última unidad: el segundo recibe «stock insuficiente».
- Con el modo servidor activo, la ventana del equipo principal también habla con el servidor
  (por `127.0.0.1`), así todos los puestos usan el mismo camino.

## Activarlo (en el equipo principal)

1. Entra como administrador → **Sistema → Configuración** → sección **Varios puestos en la red local**.
2. Elige **Servidor para varios puestos**, deja el puerto 8787 (o cambia a otro libre) y guarda.
3. **Cierra el programa por completo y ábrelo de nuevo.**
4. Si Windows pregunta por el firewall, permite el acceso en **redes privadas**.
5. En la misma pantalla aparece la dirección para los demás, por ejemplo `https://192.168.1.20:8787`.
6. En el navegador de cada puesto escribe esa dirección. **La primera vez el navegador avisa «La conexión no es privada»**
   (el certificado lo creó el propio programa). Compara la huella que muestra Configuración con la del certificado en el
   navegador y elige **Avanzado → Continuar**. Después inicia sesión.

Para volver a un solo puesto: elige **Un solo puesto**, guarda y reinicia.

## Qué solo se puede hacer en el equipo principal

- El primer registro de la empresa (configuración inicial) y la recuperación del administrador.
- Restaurar un respaldo y cambiar la carpeta externa de respaldos.
- Cambiar el modo de red.

Los respaldos automáticos siguen haciéndose en el equipo principal.

## Archivos de exportación

Desde un puesto remoto, «Exportar CSV», la plantilla de productos y los informes se **descargan en el
navegador** de ese puesto (no quedan en el equipo principal). En el equipo principal se guardan en
Descargas, como siempre.

## Seguridad (léelo)

**Qué hace el sistema para protegerse**

- **Solo red local.** El servidor rechaza cualquier equipo que no sea de una red privada
  (10.x, 172.16–31.x, 192.168.x), de enlace local o el propio equipo. Si alguien abre el puerto en el router,
  las conexiones desde internet se rechazan igual.
- **Dirección de escucha (opcional).** En Configuración puedes indicar la IP de la red del negocio (por ejemplo
  `192.168.1.20`); así el servidor no escucha en otras conexiones del equipo (otro Wi-Fi, VPN…).
  Vacío = todas.
- **Bloqueo por equipo.** Tras 4 intentos fallidos de contraseña desde un mismo equipo, ese equipo no puede iniciar
  sesión durante 15 minutos. Se activa antes que el bloqueo de cuenta (5 intentos), así que nadie desde la red
  puede dejar bloqueada la cuenta del administrador. El propio equipo principal nunca se bloquea.
- **Límite de solicitudes.** Máximo 300 por minuto por equipo; el exceso recibe un aviso.
- **Orígenes.** Un navegador solo puede usar la API desde la página de Tekkadon servida por este equipo o desde
  la ventana del programa. Una página web cualquiera abierta en la red no puede llamar al sistema.
- **Sesión ligada al equipo.** El token de sesión solo vale desde el equipo donde se inició. Copiarlo a otro
  equipo no sirve, y un intento así no cierra la sesión del dueño.
- **Cifrado HTTPS** con certificado propio (se crea solo, ~800 días, se rehace si cambia la IP del equipo). La ventana del
  programa usa una entrada local aparte (127.0.0.1, puerto siguiente) que nunca sale del equipo.
- **Hilos y tamaño acotados.** 8 hilos fijos (las demás conexiones esperan su turno) y tamaño máximo de solicitud
  de 32 MB; una avalancha de conexiones no agota el equipo.
- **Encabezados** `X-Content-Type-Options`, `X-Frame-Options: DENY` y `Referrer-Policy` en todas las respuestas.
- **Acciones solo en el equipo principal:** configuración inicial, recuperar administrador, restaurar respaldo,
  carpeta externa de respaldos y cambiar el modo de red.
- **Revisión de integridad.** Al abrir, el programa revisa la base de datos (`PRAGMA quick_check`). Si hay daño,
  lo anota en Auditoría (`integrity_check_failed`) y deja `ALERTA_INTEGRIDAD.txt` junto a la base; el programa
  abre igual para que puedas restaurar un respaldo.

**Lo que NO cubre (sé consciente)**

- El certificado es **autofirmado**: el cifrado protege contra quien escuche la red, pero nadie avala quién es el
  servidor, así que el navegador avisa la primera vez. Verifica la huella; si algún día aparece una huella distinta
  sin que hayas reinstalado nada, no continúes. La variante con autoridad propia (carpeta s9) evita el aviso.
- La clave privada del certificado vive en el equipo principal (carpeta `tls/` de los datos).
- Si desactivas HTTPS en Configuración, la conexión queda sin cifrar y usuarios y contraseñas viajan en claro.
- Una conexión lenta a propósito (que envía el cuerpo de la solicitud muy despacio) puede ocupar un hilo.
- No protege contra malware en el equipo principal ni contra alguien con acceso físico y la llave.
- Los respaldos viven en el mismo disco salvo que actives la carpeta externa: configúrala en Respaldos.
- Un token de sesión solo vive en memoria del equipo principal: al cerrar el programa, todas las sesiones se cierran.

## Límites conocidos

- El equipo principal debe estar **encendido, con el programa abierto**. Si se apaga, los demás puestos se quedan sin sistema.
- Pensado para pocos puestos (2 a 6). Es un solo archivo de datos atendido por un solo equipo.
- Los borradores de venta y las ventas en espera se guardan en cada navegador (no se comparten entre puestos).
- Las llamadas tardan unos milisegundos más que en modo normal (viajan por red).

## Para desarrolladores

- `src-tauri/src/lan.rs`: servidor HTTP (`tiny_http`), sesiones por token y turnos.
- `src-tauri/src/lan_guard.rs`: reglas de seguridad sin dependencias (red local, orígenes, límites, bloqueo) con pruebas:
  `cargo test lan_guard` dentro de `src-tauri`.
- `src-tauri/src/tls.rs`: crea y renueva el certificado (`rcgen`).
- `src-tauri/src/lan_dispatch.rs`: **archivo generado**; llama a cada `#[tauri::command]` desde el servidor.
  Después de agregar o cambiar un comando ejecuta:

  ```
  node gen-dispatch.mjs          (o: npm run gen:dispatch)
  node gen-dispatch.mjs --check  (comprueba que esté al día)
  ```

  `node verificar-proyecto.mjs` también avisa si falta algún comando.
- `src/services/transport.js`: decide si la interfaz usa `invoke` (un puesto) o `fetch` (modo red).
- Configuración guardada en `%APPDATA%\com.tekaddon.app\red.json`.
- En `tauri dev` el servidor atiende la API pero **no** sirve la interfaz (no está incluida en el binario de desarrollo).
  Para probar con un navegador en desarrollo: `http://127.0.0.1:1420/?api=http://127.0.0.1:8787`.
