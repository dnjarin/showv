# Tekkadon

Sistema de escritorio para el control de inventario y la facturación interna (comprobantes sin validez fiscal),
con SQLite cifrado y modo red opcional para usar otros puestos desde el navegador.
Hecho con Tauri 2, React (Vite + Tailwind) y Rust.

## Documentación

- [INSTALADOR.md](INSTALADOR.md): cómo generar el instalador de Windows.
- [MODO_RED.md](MODO_RED.md): varios puestos en la misma red (incluye celulares por navegador).
- [CIFRADO.md](CIFRADO.md): protección de la base de datos y clave de recuperación.

## Desarrollo

    npm install
    npm run tauri dev       # aplicación en modo desarrollo
    npm run build:win64     # instalador de 64 bits
    node verificar-proyecto.mjs   # comprueba que el proyecto esté completo

Los datos de ejemplo para importar están en `ejemplos_qsl/` (todos ficticios).
