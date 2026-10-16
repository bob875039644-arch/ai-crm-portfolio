/** Display-only subset for the batching example, not the complete production API schema. */
export const CUSTOMER_GRADE_SUMMARY_MAX_IDS = 100;

export type CustomerGradeSummary = {
  customerId: string;
  grade: 'A' | 'B' | 'C' | 'D';
  status: 'current';
  source: 'assessment';
  asOf: string | null;
  reason: null;
};

export type CustomerGradeSummariesResponse = { items: CustomerGradeSummary[] };
