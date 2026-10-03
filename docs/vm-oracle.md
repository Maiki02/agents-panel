# Crear la VM en Oracle Cloud

Paso 0 del runbook: cómo se creó `vm-ia` en Oracle. Después de esto sigue [`vm-setup.md`](vm-setup.md).

## Cuenta

1. Alta en Oracle Cloud Free Tier. Home region: **Brazil East (São Paulo)**. No se puede cambiar después.
2. **Upgrade a Pay As You Go** (requiere tarjeta). Con la cuenta gratis, la creación daba *Out of capacity*; con PAYG salió al primer intento. Lo Always Free sigue sin costo.
3. Verificación en dos pasos activada.
4. **Alerta de presupuesto** `budget-ia-vm`: compartment root, mensual, US$1, aviso por email al 100 % del gasto real.

## Instancia

| Campo | Valor |
|---|---|
| Nombre | `vm-ia` |
| Availability domain | AD-1 (única en São Paulo) |
| Imagen | Ubuntu 26.04 LTS |
| Shape | VM.Standard.A1.Flex (Ampere, ARM64), **2 OCPU / 12 GB**. Es el tope Always Free desde el 15/06/2026 |
| Disco | Boot volume de **200 GB**, 10 VPU (Balanced). Usa todo el cupo gratis de almacenamiento |
| Red | VCN nueva + subred pública `10.0.0.0/24`. Security list: solo **TCP 22** de entrada |
| Clave SSH | Generada por Oracle al crear la instancia. Privada en la PC: `C:\Users\<usuario>\.ssh\oracle-vm.key` (permisos ajustados con `icacls`), con backup fuera de la PC |

**IP pública:** en el asistente, el interruptor de IP pública aparecía gris con una VCN nueva. Se asignó después: instancia → VNIC → *IP administration* → *Edit* → *Ephemeral public IP*. La IP efímera se mantiene mientras exista la instancia; si se termina y se vuelve a crear, cambia y hay que actualizar el `~/.ssh/config`.

## Acceso desde la PC

`C:\Users\<usuario>\.ssh\config`:

```
Host oracle-vm
    HostName <IP pública>
    User ubuntu
    IdentityFile C:\Users\<usuario>\.ssh\oracle-vm.key
```

Prueba: `ssh oracle-vm`. En VS Code: Remote - SSH → Connect to Host → `oracle-vm`.

## Endurecimiento inicial (en la VM)

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y fail2ban unattended-upgrades
sudo dpkg-reconfigure -f noninteractive unattended-upgrades
```

- Login solo con clave SSH (sin contraseña), que es lo que trae la imagen de Oracle.
- fail2ban protege el SSH contra fuerza bruta.

## A tener en cuenta

- Oracle puede reclamar instancias Always Free ociosas (menos de 20 % de CPU, red y RAM durante 7 días).
- Para abrir un puerto haría falta tocar la security list de la subred y el firewall de Ubuntu (iptables). Con Tailscale Funnel no hace falta abrir nada más.
- El stack de Resource Manager "VM - Always Free" del primer intento quedó sin usar; se puede borrar.
