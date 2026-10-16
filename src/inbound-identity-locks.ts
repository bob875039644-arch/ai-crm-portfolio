const INBOUND_IDENTITY_LOCK_NAMESPACE = 'crm:whatsapp-inbound';

export function buildInboundIdentityLockKeys(input: {
  waMessageId: string;
  phone: string | null;
  waId: string | null;
}): string[] {
  const keys = [`${INBOUND_IDENTITY_LOCK_NAMESPACE}:wamid:${input.waMessageId}`];
  const phone = normalizeLockIdentifier(input.phone);
  const waId = normalizeLockIdentifier(input.waId);
  if (phone) keys.push(`${INBOUND_IDENTITY_LOCK_NAMESPACE}:phone:${phone}`);
  if (waId) keys.push(`${INBOUND_IDENTITY_LOCK_NAMESPACE}:waId:${waId}`);
  return keys.sort(compareLockKeys);
}

function normalizeLockIdentifier(value: string | null): string | null {
  const normalized = value?.trim() ?? '';
  return normalized || null;
}

function compareLockKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
