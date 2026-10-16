import type { SemanticObservationV1, SemanticModelEvidenceRefV1 } from './semantic-observation';

// Standalone context subset. Caller must authorize the source context first.
export type EvidenceContext = {
  analysisMode: 'single' | 'map' | 'reduce';
  semanticImpactObserve: { asOf: string };
  messages: { id: string; ts: string }[];
  manualNotes: { id: string; createdAt: string; includeInAi: boolean }[];
  chunkResults: { semanticObservation?: SemanticObservationV1 }[];
};

function semanticObservationEvidenceV1(value: SemanticObservationV1): SemanticModelEvidenceRefV1[] {
  const unique = new Map<string, SemanticModelEvidenceRefV1>();
  for (const item of [...value.factors, ...value.contradictions]) {
    for (const ref of item.evidence) unique.set(evidenceIdentity(ref), ref);
  }
  return [...unique.values()];
}

export function countRejectedEvidence(
  evidence: readonly SemanticModelEvidenceRefV1[], context: EvidenceContext,
): number {
  const allowed = allowedEvidenceIdentities(context);
  return evidence.filter((reference) => !allowed.has(evidenceIdentity(reference))).length;
}
export function allowedEvidenceIdentities(context: EvidenceContext): Set<string> {
  const asOfMillis = Date.parse(context.semanticImpactObserve?.asOf ?? '');
  const allowed = new Set<string>();
  if (context.analysisMode === 'reduce') {
    for (const chunk of context.chunkResults) {
      if (!chunk.semanticObservation) continue;
      for (const reference of semanticObservationEvidenceV1(chunk.semanticObservation)) {
        allowed.add(evidenceIdentity(reference));
      }
    }
  } else {
    for (const message of context.messages) {
      const occurredAt = new Date(message.ts).getTime();
      if (Number.isFinite(occurredAt) && occurredAt <= asOfMillis) {
        allowed.add(evidenceIdentity({ sourceKind: 'message', sourceId: message.id }));
      }
    }
  }
  for (const note of context.manualNotes) {
    const occurredAt = new Date(note.createdAt).getTime();
    if (note.includeInAi && Number.isFinite(occurredAt) && occurredAt <= asOfMillis) {
      allowed.add(evidenceIdentity({ sourceKind: 'note', sourceId: note.id }));
    }
  }
  return allowed;
}

function evidenceIdentity(reference: { sourceKind: string; sourceId: string }): string {
  return `${reference.sourceKind}\u0000${reference.sourceId}`;
}
