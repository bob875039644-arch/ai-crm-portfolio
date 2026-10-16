// Extracted from MAX progress control; the evidence revision callback is server-owned.
const AGENT_NO_PROGRESS_ROUND_LIMIT = 2;
const ASSISTANT_AGENT_TOOL_ROUND_LIMIT = 8;
const ASSISTANT_AGENT_MODEL_CALL_LIMIT = 9;
export type AssistantAgentForceFinalReason = 'NO_NEW_EVIDENCE' | 'TOOL_DECISION_ROUND_LIMIT';
export type AssistantAgentProgressTracker = Readonly<{
  count: () => number;
  next: () => Readonly<{
    modelCallCount: number;
    forceFinal: boolean;
    terminationReason: AssistantAgentForceFinalReason | null;
  }>;
}>;

export function createAssistantAgentProgressTracker(
  getEvidenceRevision: () => number,
): AssistantAgentProgressTracker {
  let modelCallCount = 0;
  let previousEvidenceRevision: number | null = null;
  let noProgressRounds = 0;
  let finalizing = false;
  let terminationReason: AssistantAgentForceFinalReason | null = null;

  return {
    count: () => modelCallCount,
    next: () => {
      modelCallCount += 1;
      if (modelCallCount > ASSISTANT_AGENT_MODEL_CALL_LIMIT) {
        throw new Error('ASSISTANT_AGENT_MODEL_CALL_SAFETY_LIMIT_EXCEEDED');
      }

      const evidenceRevision = getEvidenceRevision();
      if (!Number.isSafeInteger(evidenceRevision) || evidenceRevision < 0) {
        throw new Error('ASSISTANT_AGENT_EVIDENCE_REVISION_INVALID');
      }
      if (previousEvidenceRevision !== null) {
        noProgressRounds = evidenceRevision > previousEvidenceRevision ? 0 : noProgressRounds + 1;
      }
      previousEvidenceRevision = evidenceRevision;

      if (!finalizing && noProgressRounds >= AGENT_NO_PROGRESS_ROUND_LIMIT) {
        finalizing = true;
        terminationReason = 'NO_NEW_EVIDENCE';
      } else if (!finalizing && modelCallCount > ASSISTANT_AGENT_TOOL_ROUND_LIMIT) {
        finalizing = true;
        terminationReason = 'TOOL_DECISION_ROUND_LIMIT';
      }
      return { modelCallCount, forceFinal: finalizing, terminationReason };
    },
  };
}
