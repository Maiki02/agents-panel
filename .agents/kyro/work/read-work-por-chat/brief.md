# El piloto encuentra el scope o work del chat por su nombre

## Objetivo

Que el piloto pueda llevar un scope o work que **ya existe en el repo** (y los trabajos nuevos de un repo que ya tiene works), sin depender de `local.json` (git-ignorado, vacío en un worktree nuevo) ni de que haya un solo Work en la carpeta.

## Problema

- `KyroReader.readWork` exige exactamente una carpeta en `.agents/kyro/work`. agents-panel tiene dos commiteadas (`capacidad-y-tiempos` y `monorepo-skeleton`): cualquier worktree nuevo las trae y el piloto frena con «Se esperaba un solo Work y hay 2».
- `KyroReader.readScope` solo mira `activeScope` de `local.json`, que no viaja con git: un chat sobre un scope existente, con el piloto encendido desde el inicio, frena con `kyro_bloqueado`.

## Regla nueva

- **Scope:** si existe `.agents/kyro/scopes/<slug del chat>/sprint.json`, ese es el scope del chat; si no, vale `activeScope` de `local.json` como hoy.
- **Work:** si hay una carpeta con el nombre del slug del chat, ese es su Work; si no, entre las carpetas se eligen las **creadas desde que existe el worktree** (`createdAt` de `work.json` mayor o igual al `createdAt` del chat); con exactamente una se usa, con ninguna es «todavía no hay Work en este worktree» y con varias es ambiguo.
- Sin pistas (llamadas sin slug ni fecha) el comportamiento es el de antes.

## Fuera de alcance

- Cambiar cómo se crea un Work o un scope, ni la política del piloto.
