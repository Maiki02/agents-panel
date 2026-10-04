import type { AgentEvent, AgentRunner, RunParams } from '../src/agent/runner.js';

export class FakeRunner implements AgentRunner {
  readonly calls: RunParams[] = [];
  gate: Promise<void> = Promise.resolve();
  script: (params: RunParams) => AgentEvent[] = () => [
    { type: 'system:init', payload: { session_id: 'sess-1' }, sessionId: 'sess-1' },
    { type: 'assistant', payload: { text: 'hello' } },
    { type: 'result:success', payload: { result: 'ok' } },
  ];

  async *run(params: RunParams): AsyncGenerator<AgentEvent> {
    this.calls.push(params);
    await this.gate;
    for (const event of this.script(params)) {
      if (params.signal.aborted) throw new Error('aborted');
      yield event;
    }
  }
}
