# Cómo generar el instalador de Tekkadon (Windows)

El instalador es un único `.exe` (NSIS) en español, con la licencia de uso y el componente WebView2 incluido,
de modo que instala sin conexión a internet.

## Requisitos (una sola vez, en el equipo donde se compila)

- Node.js y las dependencias del proyecto (`npm install`).
- Rust con el destino de Windows de 64 bits (ya lo tienes si `npm run tauri dev` funciona).
- Para el instalador de 32 bits: `rustup target add i686-pc-windows-msvc` y, en Visual Studio Build Tools,
  el componente «Herramientas de compilación de C++ para x86».
- Conexión a internet **durante la compilación** (descarga NSIS y el instalador de WebView2).

## Generar

64 bits (equipos actuales):

    npm run build:win64

32 bits (equipos antiguos):

    npm run build:win32

El instalador queda en:

    src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\      (64 bits)
    src-tauri\target\i686-pc-windows-msvc\release\bundle\nsis\        (32 bits)

La primera compilación tarda varios minutos.

## Qué hace el instalador

- Se instala solo para el usuario actual (no pide permisos de administrador).
- Muestra la licencia de uso (`src-tauri/LICENCIA.txt`) y exige aceptarla.
- Instala WebView2 si el equipo no lo tiene.
- Al desinstalar, el desinstalador ofrece una casilla para borrar los datos de la aplicación; déjala sin marcar si quieres conservar la base de datos y los respaldos.

## Antes de entregar un instalador

1. Instálalo en un equipo limpio (o una máquina virtual) y abre el sistema.
2. Crea el usuario administrador, registra una tasa y emite una venta de prueba.
3. Cierra, vuelve a abrir y comprueba que los datos siguen.
4. Haz un respaldo desde Sistema → Respaldos.

Si cambias la versión, edítala en `src-tauri/tauri.conf.json` (`version`) y en `package.json`.
