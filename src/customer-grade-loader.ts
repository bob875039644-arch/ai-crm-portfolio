import { CUSTOMER_GRADE_SUMMARY_MAX_IDS, type CustomerGradeSummariesResponse, type CustomerGradeSummary } from './grade-contract';

export type FetchCustomerGrades = (ids: string[]) => Promise<CustomerGradeSummariesResponse>;

/** One loader per authenticated actor. Coalesce cards mounted in the same turn. */
export function createCustomerGradeLoader(fetchGrades: FetchCustomerGrades) {
  type Waiter = {
    resolve: (value: CustomerGradeSummary | null) => void;
    reject: (error: unknown) => void;
  };
  let pending = new Map<string, Waiter[]>();
  let scheduled = false;

  function flush() {
    const batch = pending;
    pending = new Map();
    scheduled = false;
    const ids = [...batch.keys()];
    for (let start = 0; start < ids.length; start += CUSTOMER_GRADE_SUMMARY_MAX_IDS) {
      const chunk = ids.slice(start, start + CUSTOMER_GRADE_SUMMARY_MAX_IDS);
      void Promise.resolve()
        .then(() => fetchGrades(chunk))
        .then(({ items }) => {
          const summaries = new Map(items.map((item) => [item.customerId, item]));
          for (const id of chunk) {
            for (const waiter of batch.get(id)!) waiter.resolve(summaries.get(id) ?? null);
          }
        })
        .catch((error: unknown) => {
          for (const id of chunk) {
            for (const waiter of batch.get(id)!) waiter.reject(error);
          }
        });
    }
  }

  return (customerId: string): Promise<CustomerGradeSummary | null> =>
    new Promise((resolve, reject) => {
      const waiters = pending.get(customerId) ?? [];
      waiters.push({ resolve, reject });
      pending.set(customerId, waiters);
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    });
}
