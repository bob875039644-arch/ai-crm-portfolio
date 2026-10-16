import { describe, expect, it } from 'vitest';
import { semanticObservationV1Schema } from '../src/semantic-observation';

// Entirely synthetic evidence; no CRM records or provider requests.
const observation = () => ({
  summary: '演示客户询问规格，采购时间尚未确认。',
  factors: [{ direction: 'support', claim: '明确询问产品规格',
    evidence: [{ sourceKind: 'message', sourceId: 'demo-message-1' }] }],
  missingInformation: ['采购时间'], contradictions: [],
});

describe('model observation boundary', () => {
  it('accepts a structured observation with evidence references', () => {
    expect(semanticObservationV1Schema.parse(observation())).toEqual(observation());
  });
  it.each(['score', 'grade', 'impact', 'schemaVersion', 'programCoverageFingerprint'])(
    'rejects model-authored system field %s', (field) => {
      expect(semanticObservationV1Schema.safeParse({ ...observation(), [field]: 10 }).success).toBe(false);
    },
  );
  it('rejects an unsupported direction or a factor with no evidence', () => {
    for (const change of [{ direction: 'certain_purchase' }, { evidence: [] }]) {
      const value = observation();
      value.factors = [{ ...value.factors[0]!, ...change }];
      expect(semanticObservationV1Schema.safeParse(value).success).toBe(false);
    }
  });
  it('rejects duplicate evidence within one factor', () => {
    const value = observation();
    value.factors[0]!.evidence.push({ ...value.factors[0]!.evidence[0]! });
    expect(semanticObservationV1Schema.safeParse(value).success).toBe(false);
  });
  it('rejects duplicate missing-information entries', () => {
    expect(semanticObservationV1Schema.safeParse({ ...observation(), missingInformation: ['采购时间', '采购时间'] }).success).toBe(false);
  });
  it('rejects unknown nested fields and oversized factor lists', () => {
    const value = observation();
    expect(semanticObservationV1Schema.safeParse({ ...value, factors: [{ ...value.factors[0], points: 3 }] }).success).toBe(false);
    expect(semanticObservationV1Schema.safeParse({ ...value, factors: Array.from({ length: 21 }, () => value.factors[0]) }).success).toBe(false);
  });
  it('does not pretend that schema validation verifies source existence or access', () => {
    const value = observation();
    value.factors[0]!.evidence[0]!.sourceId = 'demo-nonexistent';
    expect(semanticObservationV1Schema.safeParse(value).success).toBe(true);
    // Source lookup, actor scope and factual verification belong to domain services.
  });
});
