import { describe, expect, it, vi } from 'vitest';
import type { CustomerGradeSummary } from '../src/grade-contract';
import { createCustomerGradeLoader } from '../src/customer-grade-loader';

const current = (customerId: string): CustomerGradeSummary => ({
  customerId,
  grade: 'A',
  status: 'current',
  source: 'assessment',
  asOf: null,
  reason: null,
});

describe('customer grade batch loader', () => {
  it('coalesces one turn and resolves every duplicate waiter or omitted ID', async () => {
    const fetchGrades = vi.fn(async () => ({ items: [current('one')] }));
    const load = createCustomerGradeLoader(fetchGrades);
    const pending = [load('one'), load('two'), load('one')];
    expect(fetchGrades).not.toHaveBeenCalled();
    expect(await Promise.all(pending)).toEqual([current('one'), null, current('one')]);
    expect(fetchGrades).toHaveBeenCalledExactlyOnceWith(['one', 'two']);
  });

  it('chunks large mounts at 100 unique IDs and preserves results across chunks', async () => {
    const fetchGrades = vi.fn(async (ids: string[]) => ({ items: ids.map(current) }));
    const load = createCustomerGradeLoader(fetchGrades);
    const ids = Array.from({ length: 205 }, (_, index) => `customer-${index}`);
    const result = await Promise.all([...ids, ids[0]!].map(load));
    expect(fetchGrades.mock.calls.map(([chunk]) => chunk.length)).toEqual([100, 100, 5]);
    expect(fetchGrades.mock.calls.flatMap(([chunk]) => chunk)).toEqual(ids);
    expect(result.map((item) => item?.customerId)).toEqual([...ids, ids[0]]);
  });

  it('settles a rejected chunk without hanging duplicate waiters or unrelated chunks, then recovers', async () => {
    const failure = new Error('grade read unavailable');
    const fetchGrades = vi.fn(async (ids: string[]) => {
      if (ids.includes('customer-0')) throw failure;
      return { items: ids.map(current) };
    });
    const load = createCustomerGradeLoader(fetchGrades);
    const ids = Array.from({ length: 101 }, (_, index) => `customer-${index}`);
    const results = await Promise.allSettled([...ids, ids[0]!].map(load));
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(101);
    expect(results[100]).toEqual({ status: 'fulfilled', value: current('customer-100') });
    expect(results[101]).toEqual({ status: 'rejected', reason: failure });
    fetchGrades.mockImplementation(async (chunk) => ({ items: chunk.map(current) }));
    await expect(load('customer-0')).resolves.toEqual(current('customer-0'));
  });

  it('turns synchronous fetch exceptions into rejected promises and keeps actor loaders independent', async () => {
    const error = new Error('synchronous adapter failure');
    const first = createCustomerGradeLoader(() => {
      throw error;
    });
    const secondFetch = vi.fn(async (ids: string[]) => ({ items: ids.map(current) }));
    const second = createCustomerGradeLoader(secondFetch);
    await expect(first('same')).rejects.toBe(error);
    await expect(second('same')).resolves.toEqual(current('same'));
    expect(secondFetch).toHaveBeenCalledExactlyOnceWith(['same']);
  });
});
