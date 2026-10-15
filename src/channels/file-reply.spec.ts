import { describe, expect, it } from 'vitest';
import { fileReply } from './file-reply.js';

describe('result files in an answer', () => {
  it('takes explicit files and local Markdown previews, deduplicating paths', () => {
    expect(
      fileReply(
        'Ready.\n<file>output/Песня.mp3</file>\n![Preview](</work/my design.png>)\n<file>output/Песня.mp3</file>',
      ),
    ).toEqual({
      text: 'Ready.',
      paths: ['output/Песня.mp3', '/work/my design.png'],
    });
  });
  it('does not deliver quoted/code directives or fetch remote URLs', () => {
    const text =
      '```xml\n<file>/etc/passwd</file>\n```\n> <file>quoted</file>\n![Remote](https://example.com/a.png)\n<file>file:///etc/passwd</file>';
    expect(fileReply(text)).toEqual({ text, paths: [] });
  });
  it('bounds the number of attachments', () => {
    const text = Array.from(
      { length: 12 },
      (_, i) => `<file>${i}.txt</file>`,
    ).join('\n');
    expect(fileReply(text).paths).toHaveLength(10);
    expect(fileReply(text).text).toContain('<file>11.txt</file>');
  });
});
