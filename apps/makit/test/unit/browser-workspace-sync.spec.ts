import { requirementUpdateQueues, waitForRequirementUpdates } from '../../client/src/lib/requirement-update-queues';

describe('browser snapshot read/write ordering', () => {
  afterEach(() => requirementUpdateQueues.clear());
  it('waits for all pending writes, including a successor added while waiting', async () => {
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = new Promise<void>((resolve) => { finishFirst = resolve; });
    const second = new Promise<void>((resolve) => { finishSecond = resolve; });
    requirementUpdateQueues.set('first', first);
    let readStarted = false;
    const read = waitForRequirementUpdates(new AbortController().signal).then(() => { readStarted = true; });
    requirementUpdateQueues.set('second', second);
    requirementUpdateQueues.delete('first');
    finishFirst();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readStarted).toBe(false);
    requirementUpdateQueues.delete('second');
    finishSecond();
    await read;
    expect(readStarted).toBe(true);
  });
  it('cancels a waiting read without cancelling the durable write', async () => {
    let finish!: () => void;
    const write = new Promise<void>((resolve) => { finish = resolve; });
    requirementUpdateQueues.set('write', write);
    const controller = new AbortController();
    const read = waitForRequirementUpdates(controller.signal);
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    expect(requirementUpdateQueues.get('write')).toBe(write);
    requirementUpdateQueues.delete('write');
    finish();
  });
});
