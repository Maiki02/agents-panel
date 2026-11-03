# Kyro sin ramas e historial por card en Versiones

## Pedido del usuario (textual)

> Necesito que actualizar Kyro, actualice en todos los repositorios pero sin crear una nueva rama que tenga que mergear y aprobar. Hacer eso, me retrasa mucho. Mejor que se actualicen todos los proyectos. Si es necesario validar que no esté corriendo nada, podemos hacerlo, pero no quiero ramas.
>
> Por otro lado, en /versions, debemos quitar la card de historial. En la card de "Panel", debemos agregar un span azul de: "Ver historial". Que el hover subraye.
> Al presionarlo, se muestran todas los despliegues como ahora. Que se muestren de a 10 y al final, se muestre un "Ver más".
> Achiquemos un poco las letras y cambiemos el diseño de: "10/31/26, 2:52 PM · Panel 4be7d65 → d1578f5 ·"

## Decisiones del usuario (AskUserQuestion, 2026-11-03)

1. **Commit directo a la base.** Después de `kyro update`, el panel commitea los cambios de `.agents/kyro/` en el clon base de cada proyecto y los pushea directo a la rama base (sin rama nueva ni PR). Se acepta que rompe la regla de "no commitear en el clon base" solo para este caso y que falla si la rama base está protegida.
2. **"Ver historial" en las dos cards**: la card Kyro muestra sus actualizaciones y la card Panel sus despliegues. Se quita la card Historial.
3. **Fila en dos líneas**: arriba `4be7d65 → d1578f5` en monoespaciada con el badge de estado a la derecha; abajo, gris y chica, la fecha (ej. «31 oct 2026, 14:52»). Sin los «·» ni la palabra Panel/Kyro (ya la da la card).

## Alcance

### A. Actualizar Kyro sin ramas (API + docs)

- Al terminar el script `scripts/vm/08-kyro-update.sh`, por cada proyecto `ready` con Kyro que no fue salteado y que quedó con cambios en `.agents/kyro/`: verificar que el clon esté en su rama base, traer origin por fast-forward, commitear solo `.agents/kyro/` (`chore(kyro): actualizar Kyro a <versión>`) y hacer `git push origin <base>` sin `--force`, con las credenciales de la cuenta de git del proyecto (mismo mecanismo `GIT_ASKPASS`).
- Si algo falla en un proyecto (otra rama, divergencia, push rechazado por protección), no se deja un commit local sin pushear: se deshace el commit propio y los cambios quedan como estaban; la corrida informa el proyecto y el motivo. Los demás proyectos siguen.
- Se sigue exigiendo que no haya sesiones corriendo (ya lo hace el candado de mantenimiento).
- La corrida muestra por proyecto si se commiteó/pusheó o por qué no.
- El aviso «hay cambios por commitear… con un work» deja de pedir un work: si quedó algo pendiente, se reintenta en la próxima actualización.
- Docs: `CLAUDE.md` (excepción explícita en Operaciones), `docs/plan.md`, `docs/panel-desarrollo.md`, `docs/vm-setup.md` (paso 14 y bitácora).

### B. Pantalla Versiones (web + API de corridas)

- Quitar la card Historial.
- En las cards Kyro y Panel, un texto azul «Ver historial» (hover subraya, accesible por teclado) que despliega las corridas de ese tipo, de a 10, con «Ver más» al final mientras haya más.
- `GET /api/maintenance-runs` respeta `kind` (hoy lo ignora) y admite paginación.
- Fila nueva en dos líneas con letra más chica, como en la decisión 3. La salida sigue desplegable.

## Fuera de alcance

- Cambiar el script de bash o el paso de `kyro update` en sí.
- Desplegar otros proyectos.
