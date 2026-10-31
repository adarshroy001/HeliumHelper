import { describe, expect, it } from 'vitest';
import { autoReplyFor, autoReplyId, type AutoReplyRule } from './auto-reply.js';
import { isOptOut, parseInbound, type ParsedInbound, previewOf } from './inbound-parser.js';

const base = { from: '919876543210', timestamp: '1761904800' };

describe('parseInbound', () => {
  it('reads text, buttons, interactive replies and media, with the sender name and the replied-to message', () => {
    const parsed = parseInbound({
      contacts: [{ wa_id: '919876543210', profile: { name: 'Asha' } }],
      messages: [
        { ...base, id: 'w1', type: 'text', text: { body: 'Hi there' }, context: { id: 'wamid.ours' } },
        { ...base, id: 'w2', type: 'button', button: { text: 'Bedroom', payload: 'BEDROOM' } },
        {
          ...base,
          id: 'w3',
          type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Yes' } },
        },
        { ...base, id: 'w4', type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg' } },
      ],
    });

    expect(parsed).toEqual([
      {
        wamid: 'w1',
        from: '919876543210',
        name: 'Asha',
        type: 'text',
        at: new Date(1761904800_000),
        text: 'Hi there',
        contextWamid: 'wamid.ours',
      },
      expect.objectContaining({ wamid: 'w2', button: { text: 'Bedroom', payload: 'BEDROOM' } }),
      expect.objectContaining({ wamid: 'w3', type: 'interactive', button: { text: 'Yes', payload: 'b1' } }),
      expect.objectContaining({ wamid: 'w4', media: { id: 'media-1', mime: 'image/jpeg' } }),
    ]);
  });

  it('drops malformed messages and numbers that are not Indian mobiles', () => {
    expect(
      parseInbound({
        messages: [
          { id: 'x', type: 'text' },
          { id: 'y', from: '14155550100', timestamp: '1', type: 'text', text: { body: 'hi' } },
        ],
      }),
    ).toEqual([]);
  });

  it('previews text, a button, or the media kind', () => {
    const message = (extra: Partial<ParsedInbound>): ParsedInbound => ({
      wamid: 'w',
      from: '91',
      type: 'image',
      at: new Date(),
      ...extra,
    });
    expect(previewOf(message({ text: 'x'.repeat(100) }))).toHaveLength(80);
    expect(previewOf(message({ button: { text: 'Yes' } }))).toBe('Yes');
    expect(previewOf(message({}))).toBe('[image]');
  });
});

describe('isOptOut', () => {
  const optOut = { keywords: ['STOP', 'UNSUBSCRIBE'], payloads: ['OPT_OUT'] };
  const message = (extra: Partial<ParsedInbound>): ParsedInbound => ({
    wamid: 'w',
    from: '91',
    type: 'text',
    at: new Date(),
    ...extra,
  });

  it.each([
    [{ text: ' stop ' }, true],
    [{ text: 'Unsubscribe' }, true],
    [{ text: 'please stop sending' }, false],
    [{ button: { text: 'Stop promotions', payload: 'OPT_OUT' } }, true],
    [{ button: { text: 'STOP' } }, true],
    [{ button: { text: 'Yes', payload: 'YES' } }, false],
  ])('%j → %s', (extra, expected) => {
    expect(isOptOut(message(extra), optOut)).toBe(expected);
  });
});

describe('auto-reply', () => {
  const button = (text: string): ParsedInbound => ({
    wamid: 'w',
    from: '919876543210',
    type: 'button',
    at: new Date(),
    button: { text },
  });
  const text: ParsedInbound = {
    wamid: 'w',
    from: '919876543210',
    type: 'text',
    at: new Date(),
    text: 'hello',
  };
  const rule: AutoReplyRule = {
    trigger: 'any_button',
    mode: 'text',
    text: 'Thanks {{name}}!',
    choiceReplies: [{ buttonText: 'bedroom', replyText: 'Great choice, {{name}}. We will call {{phone}}.' }],
  };

  it('uses the reply for the tapped button, then the general text, filling in name and phone', () => {
    expect(autoReplyFor(rule, button('Bedroom'), { name: 'Asha', phone: '919876543210' })).toEqual({
      kind: 'text',
      text: 'Great choice, Asha. We will call 919876543210.',
    });
    expect(autoReplyFor(rule, button('Office'), { phone: '919876543210' })).toEqual({
      kind: 'text',
      text: 'Thanks there!',
    });
  });

  it('answers only button taps for any_button, and any message for any_reply', () => {
    expect(autoReplyFor(rule, text, { phone: '91' })).toBeNull();
    expect(autoReplyFor({ ...rule, trigger: 'any_reply' }, text, { phone: '91' })).toEqual({
      kind: 'text',
      text: 'Thanks there!',
    });
  });

  it('sends a template without parameters in template mode', () => {
    expect(
      autoReplyFor(
        { trigger: 'any_reply', mode: 'template', template: { name: 'thank_you', language: 'en' } },
        text,
        { phone: '91' },
      ),
    ).toEqual({ kind: 'template', template: { name: 'thank_you', language: { code: 'en' } } });
  });

  it('derives one stable ID per campaign delivery, without colons', () => {
    expect(autoReplyId('abc')).toBe(autoReplyId('abc'));
    expect(autoReplyId('abc')).not.toBe(autoReplyId('abd'));
    expect(autoReplyId('abc')).toMatch(/^ar-[0-9a-f]{24}$/);
  });
});
