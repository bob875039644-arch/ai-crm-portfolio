import { addCalendarDays, parseCalendarDate } from '../src/calendar-date';
import { createCustomerGradeLoader } from '../src/customer-grade-loader';
import { buildInboundIdentityLockKeys } from '../src/inbound-identity-locks';
import { semanticObservationV1Schema } from '../src/semantic-observation';

const requests: string[][] = [];
const load = createCustomerGradeLoader(async (ids) => {
  requests.push(ids);
  return { items: ids.map((customerId) => ({ customerId, grade: 'A', status: 'current',
    source: 'assessment', asOf: null, reason: null })) };
});
const summaries = await Promise.all([load('demo-customer-1'), load('demo-customer-2'), load('demo-customer-1')]);
console.log('Batching:', { requestCount: requests.length, uniqueIds: requests[0]?.length, resolved: summaries.length });
console.log('Calendar:', addCalendarDays(parseCalendarDate('2028-02-28'), 2));
console.log('Lock order:', buildInboundIdentityLockKeys({ waMessageId: 'demo-message', phone: 'demo-phone', waId: null }));
console.log('Observation validation:', semanticObservationV1Schema.safeParse({
  summary: '纯演示：采购时间尚未确认。', factors: [], missingInformation: ['采购时间'], contradictions: [],
}).success);


const { createAssistantAgentProgressTracker } = await import('../src/agent-progress');
const tracker = createAssistantAgentProgressTracker(() => 0);
console.log('MAX without new evidence:', [tracker.next(), tracker.next(), tracker.next()]);
const { countRejectedEvidence } = await import('../src/evidence-grounding');
console.log('Invented evidence rejected:', countRejectedEvidence([
  { sourceKind: 'message', sourceId: 'demo-invented' },
], { analysisMode: 'map', semanticImpactObserve: { asOf: '2026-01-02T00:00:00Z' }, messages: [], manualNotes: [], chunkResults: [] }));
