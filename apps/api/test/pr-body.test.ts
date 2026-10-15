import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KyroReader } from '../src/kyro/reader.js';
import { parseWorkPrData, type PrData } from '../src/kyro/state.js';
import { PR_BODY_MAX, PR_FOOTER, buildPrText } from '../src/pilot/pr-body.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pr-body-'));
  dirs.push(dir);
  return dir;
}

function put(path: string, content: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
}

describe('buildPrText: work', () => {
  const work = {
    title: 'Mi work',
    objective: 'Hacer algo útil',
    tasks: [
      {
        id: 'W1',
        title: 'Primera',
        description: 'desc 1',
        evidence: { summary: 'Hecho y probado' },
      },
      { id: 'W2', title: 'Segunda', description: 'solo descripción' },
      {
        id: 'W3',
        title: 'Tercera',
        description: 'x',
        disposition: { kind: 'cancelled', reason: 'ya no hace falta' },
      },
    ],
  };

  it('trae objetivo, tareas con resumen o descripción y pie', () => {
    const { title, body } = buildPrText(parseWorkPrData(work, 'mi-work'));
    expect(title).toBe('Mi work');
    expect(body).toContain('Hacer algo útil');
    expect(body).toContain('## Tareas');
    expect(body).toContain('- **W1** — Primera: Hecho y probado');
    expect(body).toContain('- **W2** — Segunda: solo descripción');
    expect(body.endsWith(PR_FOOTER)).toBe(true);
  });

  it('marca la tarea descartada con su motivo', () => {
    const { body } = buildPrText(parseWorkPrData(work, 'mi-work'));
    expect(body).toContain('- ~~**W3** — Tercera~~ _(descartada: ya no hace falta)_');
  });

  it('sangra el resumen de varias líneas dentro de su ítem', () => {
    const data = parseWorkPrData(
      { tasks: [{ id: 'W1', title: 'T', evidence: { summary: 'a\nb' } }] },
      's',
    );
    expect(buildPrText(data).body).toContain('- **W1** — T: a\n  b');
  });
});

describe('buildPrText: datos faltantes', () => {
  it('degrada con work.json ilegible o vacío', () => {
    for (const json of [undefined, null, 'texto', [], {}, { tasks: 'x' }, { tasks: [null, 3] }]) {
      const { title, body } = buildPrText(parseWorkPrData(json, 'slug-x'));
      expect(title).toBe('Work slug-x');
      expect(body).toContain('Work `slug-x`.');
      expect(body.endsWith(PR_FOOTER)).toBe(true);
    }
  });

  it('el lector no tira si no existe work.json', async () => {
    const data = await new KyroReader().workPrData(tmp(), 'nada');
    expect(buildPrText(data).title).toBe('Work nada');
  });

  it('el lector no tira si no existe sprint.json', async () => {
    const data = await new KyroReader().scopePrData(tmp(), 'nada');
    const { title, body } = buildPrText(data);
    expect(title).toBe('Scope nada');
    expect(body).toContain('- ninguno');
  });
});

describe('buildPrText: scope', () => {
  it('lee las tareas de los snapshots del archivo', async () => {
    const cwd = tmp();
    const scopeDir = join(cwd, '.agents', 'kyro', 'scopes', 'mi-scope');
    put(join(scopeDir, 'sprint.json'), {
      title: 'Mi scope',
      objective: 'Objetivo del scope',
      ledger: [
        { n: 1, slug: 'uno', snapshot: 'archive/sprint-001-uno.json' },
        { n: 2, slug: 'dos', snapshot: 'archive/sprint-002-dos.json' },
        { n: 3, slug: 'tres', snapshot: 'archive/no-existe.json' },
        { n: 4, slug: 'fuera', snapshot: '../../../../../etc/passwd' },
      ],
    });
    put(join(scopeDir, 'archive', 'sprint-001-uno.json'), {
      title: 'Sprint uno',
      phases: [
        {
          tasks: [
            { id: 'T1.1', title: 'Tarea', evidence: { summary: 'Resumen 1' } },
            { id: 'T1.2', title: 'Otra', description: 'Descripción 2' },
          ],
        },
      ],
    });
    put(join(scopeDir, 'archive', 'sprint-002-dos.json'), '{ roto');

    const data = await new KyroReader().scopePrData(cwd, 'mi-scope');
    const { title, body } = buildPrText(data);
    expect(title).toBe('Mi scope');
    expect(body).toContain('Objetivo del scope');
    expect(body).toContain('### Sprint 1: uno');
    expect(body).toContain('- **T1.1** — Tarea: Resumen 1');
    expect(body).toContain('- **T1.2** — Otra: Descripción 2');
    expect(body).toContain('### Sprint 2: dos');
    expect(body).toContain('### Sprint 4: fuera');
    expect(body.endsWith(PR_FOOTER)).toBe(true);
  });

  it('con sprint.json que no es JSON devuelve un cuerpo válido', async () => {
    const cwd = tmp();
    put(join(cwd, '.agents', 'kyro', 'scopes', 's', 'sprint.json'), 'no json');
    const { title, body } = buildPrText(await new KyroReader().scopePrData(cwd, 's'));
    expect(title).toBe('Scope s');
    expect(body.endsWith(PR_FOOTER)).toBe(true);
  });
});

describe('buildPrText: recorte', () => {
  it('nunca pasa el límite y conserva el pie', () => {
    const tasks = Array.from({ length: 200 }, (_, i) => ({
      id: `W${String(i)}`,
      title: 'Tarea',
      evidence: { summary: 'x'.repeat(5000) },
    }));
    const { body } = buildPrText(parseWorkPrData({ title: 't', objective: 'o', tasks }, 's'));
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    expect(body.endsWith(PR_FOOTER)).toBe(true);
    expect(body).toContain('recortado');
  });

  it('recorta un objetivo gigante y cierra un bloque de código abierto', () => {
    const data: PrData = {
      kind: 'scope',
      slug: 's',
      title: 'y'.repeat(1000),
      objective: '```\n' + 'z\n'.repeat(70000),
      tasks: [],
      sprints: [],
    };
    const { title, body } = buildPrText(data);
    expect(title.length).toBeLessThanOrEqual(250);
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    expect((body.match(/^```/gm) ?? []).length % 2).toBe(0);
    expect(body.endsWith(PR_FOOTER)).toBe(true);
  });
});
