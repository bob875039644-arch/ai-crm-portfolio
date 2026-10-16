import { describe, expect, it } from 'vitest';
import { countRejectedEvidence, type EvidenceContext } from '../src/evidence-grounding';
const context = (): EvidenceContext => ({
  analysisMode: 'map', semanticImpactObserve: { asOf: '2026-01-02T00:00:00Z' },
  messages: [{ id: 'demo-message', ts: '2026-01-01T00:00:00Z' }],
  manualNotes: [{ id: 'demo-note', createdAt: '2026-01-01T00:00:00Z', includeInAi: true }], chunkResults: [],
});
const message = (sourceId: string) => ({ sourceKind: 'message' as const, sourceId });
const note = (sourceId: string) => ({ sourceKind: 'note' as const, sourceId });
describe('AI evidence grounding', () => {
  it('accepts only evidence from the permitted frozen context', () => {
    expect(countRejectedEvidence([message('demo-message'), note('demo-note')], context())).toBe(0);
    expect(countRejectedEvidence([message('demo-invented'), note('demo-other')], context())).toBe(2);
  });
  it('does not conflate a note and message with the same identifier', () => {
    expect(countRejectedEvidence([note('demo-message')], context())).toBe(1);
  });
  it('excludes future and invalid timestamps', () => {
    const value = context();
    value.messages[0]!.ts = '2026-01-03T00:00:00Z';
    expect(countRejectedEvidence([message('demo-message')], value)).toBe(1);
    value.messages[0]!.ts = 'invalid';
    expect(countRejectedEvidence([message('demo-message')], value)).toBe(1);
  });
  it('excludes a note that is not permitted for AI', () => {
    const value = context(); value.manualNotes[0]!.includeInAi = false;
    expect(countRejectedEvidence([note('demo-note')], value)).toBe(1);
  });
  it('uses map observation references at reduce stage, not arbitrary raw messages', () => {
    const value = context(); value.analysisMode = 'reduce';
    value.chunkResults = [{ semanticObservation: {
      summary: '合成观察', factors: [{ direction: 'support', claim: '合成因素', evidence: [message('demo-map-result')] }],
      missingInformation: [], contradictions: [],
    } }];
    expect(countRejectedEvidence([message('demo-map-result')], value)).toBe(0);
    expect(countRejectedEvidence([message('demo-message')], value)).toBe(1);
  });
  it('does not admit timestamped source evidence when the cutoff is invalid', () => {
    const value = context(); value.semanticImpactObserve.asOf = 'invalid';
    expect(countRejectedEvidence([message('demo-message'), note('demo-note')], value)).toBe(2);
  });
});
