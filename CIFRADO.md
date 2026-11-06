# Cifrado de la base de datos

Desde esta versión la base de datos (`inventario.db`) y todos los respaldos se guardan **cifrados** con SQLCipher.

## Dónde está la llave

La llave (64 caracteres) se genera sola la primera vez y se guarda **protegida por el sistema**: en Windows, en el
Administrador de credenciales (DPAPI, ligada a tu cuenta de usuario de Windows); en macOS, en el Llavero. Ya no queda
en un archivo junto a la base. Así, copiar la carpeta de datos (USB, respaldo en la nube, técnico) a otro equipo
no permite leer los datos.

- Si el equipo no ofrece almacén protegido (p. ej. Linux), se sigue usando el archivo `inventario.key` como antes, y
  Configuración lo indica.
- **Llave de recuperación.** En Configuración → «Llave de cifrado de los datos», el administrador la muestra (con su
  contraseña), la **imprime y la guarda en papel**, y pulsa «Ya la guardé». Sin ella no se pueden recuperar los datos
  si se pierde la cuenta de Windows, se reinstala el sistema o se cambia de equipo.
- La llave nunca se sube a Git (`*.key` está en `.gitignore`).

### Instalaciones anteriores (migración automática)

Si existe `inventario.key` (versión anterior), al abrir el programa la llave se pasa al almacén protegido y el archivo se
renombra a `inventario.key.migrado`. Esa copia sigue sin proteger: se elimina (sobrescrita y borrada) cuando el
administrador confirma que guardó su llave de recuperación.

### Abrir los datos en otro equipo

1. Copia la carpeta de datos (la base y `backups`) al equipo nuevo.
2. Crea un archivo de texto `inventario.key` junto a la base y pega dentro la llave de recuperación (con o sin guiones).
3. Abre el programa: guarda la llave en el almacén del equipo nuevo y aparta el archivo como `inventario.key.migrado`.
4. Entra a Configuración y confirma («Ya la guardé») para eliminar esa copia.

### Qué protege y qué no

- Protege contra: copiar la carpeta de datos o un respaldo a otro equipo o a la nube.
- No protege contra: alguien que ya inició sesión en Windows con tu cuenta, ni malware en ese usuario. Para el robo del
  equipo, activa **BitLocker** en el disco.

## Primera vez con una base que ya existe

Al abrir el sistema por primera vez con esta versión:

1. Se genera la llave.
2. Se convierte la base a cifrada. La original se conserva como `inventario.sin-cifrar.db`.
3. Se cifran también los respaldos anteriores de la carpeta `backups`.

Cuando compruebes que todo está bien (inicias sesión y ves tus datos), **borra `inventario.sin-cifrar.db`**: es una copia sin proteger.

## Compilar (una sola vez, en el equipo de desarrollo)

SQLCipher usa OpenSSL, que se compila desde el código fuente la primera vez. En Windows hace falta Perl:

    winget install StrawberryPerl.StrawberryPerl

Cierra y vuelve a abrir la terminal, comprueba con `perl -v` y ejecuta `npm run tauri dev`. La primera compilación
tarda bastante más de lo normal (varios minutos). Las siguientes son rápidas.

## Si hay que mover el sistema a otra computadora

Sigue «Abrir los datos en otro equipo» (arriba): hace falta la llave de recuperación.

## Volver atrás

Si la compilación falla y no puedes resolverlo: `git checkout -- src-tauri` (después de haber hecho commit antes de aplicar este cambio) deja el proyecto como estaba.
