import { describe, expect, it } from 'vitest';
import { buildInboundIdentityLockKeys } from '../src/inbound-identity-locks';

describe('buildInboundIdentityLockKeys', () => {
  it('locks the wamid and sorted non-empty identifiers only', () => {
    expect(
      buildInboundIdentityLockKeys({
        waMessageId: 'wamid.123',
        phone: ' demo-phone ',
        waId: ' wa.123 ',
      }),
    ).toEqual([
      'crm:whatsapp-inbound:phone:demo-phone',
      'crm:whatsapp-inbound:waId:wa.123',
      'crm:whatsapp-inbound:wamid:wamid.123',
    ]);
    expect(
      buildInboundIdentityLockKeys({
        waMessageId: 'wamid.empty-identifiers',
        phone: '   ',
        waId: null,
      }),
    ).toEqual(['crm:whatsapp-inbound:wamid:wamid.empty-identifiers']);
  });
});
