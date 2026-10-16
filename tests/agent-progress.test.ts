import { describe, expect, it } from 'vitest';
import { createAssistantAgentProgressTracker } from '../src/agent-progress';
describe('MAX evidence progress control', () => {
  it('closes tool decisions after two rounds without new evidence', () => {
    const tracker = createAssistantAgentProgressTracker(() => 0);
    expect(tracker.next().forceFinal).toBe(false);
    expect(tracker.next().forceFinal).toBe(false);
    expect(tracker.next()).toEqual({ modelCallCount: 3, forceFinal: true, terminationReason: 'NO_NEW_EVIDENCE' });
  });
  it('resets the no-progress count when the evidence revision increases', () => {
    let revision = 0;
    const tracker = createAssistantAgentProgressTracker(() => revision);
    tracker.next(); tracker.next(); revision++;
    expect(tracker.next().forceFinal).toBe(false);
    expect(tracker.next().forceFinal).toBe(false);
    expect(tracker.next().terminationReason).toBe('NO_NEW_EVIDENCE');
  });
  it('forces a final call after eight decision rounds even with progress', () => {
    let revision = 0;
    const tracker = createAssistantAgentProgressTracker(() => revision++);
    for (let index = 0; index < 8; index++) expect(tracker.next().forceFinal).toBe(false);
    expect(tracker.next().terminationReason).toBe('TOOL_DECISION_ROUND_LIMIT');
    expect(() => tracker.next()).toThrow('SAFETY_LIMIT_EXCEEDED');
  });
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid revision %s', (revision) => {
    expect(() => createAssistantAgentProgressTracker(() => revision).next()).toThrow('EVIDENCE_REVISION_INVALID');
  });
  it('keeps finalization sticky even if later evidence arrives', () => {
    let revision = 0;
    const tracker = createAssistantAgentProgressTracker(() => revision);
    tracker.next(); tracker.next(); tracker.next(); revision++;
    expect(tracker.next().forceFinal).toBe(true);
    expect(tracker.count()).toBe(4);
  });
});
