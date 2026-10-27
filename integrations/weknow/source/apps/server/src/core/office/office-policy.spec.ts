import {
  engineUrl,
  extension,
  fileName,
  modernExtension,
  officeType,
} from './office-policy';
import { BadRequestException } from '@nestjs/common';
describe('Office boundary policy', () => {
  it.each(['../report.docx', 'C:\\secret\\report.docx', 'report\u0000.docx'])(
    'normalizes a submitted filename without retaining a path: %s',
    (input) => expect(fileName(input)).toBe('report.docx'),
  );
  it.each(['', '..', '.'])('rejects empty or special names: %s', (input) =>
    expect(() => fileName(input)).toThrow(BadRequestException),
  );
  it.each([
    ['DOCX', 'word', 'docx'],
    ['xls', 'cell', 'xlsx'],
    ['ppt', 'slide', 'pptx'],
  ])('maps legacy Office formats', (ext, type, modern) => {
    const normalized = extension('sample.' + ext);
    expect(officeType(normalized)).toBe(type);
    expect(modernExtension(normalized)).toBe(modern);
  });
  it('accepts arbitrary file names without overflowing extension metadata', () =>
    expect(extension('file.' + 'x'.repeat(40))).toBe(''));
  it('does not claim to edit PDFs as text documents', () =>
    expect(officeType('pdf')).toBeNull());
  it.each([
    'http://169.254.169.254/secret',
    'http://office.local.evil.test/file',
    'http://user:secret@office.local/file',
    'file:///etc/passwd',
    'https://other.test/file',
  ])(
    'rejects callback download outside the configured editing service: %s',
    (url) =>
      expect(() => engineUrl(url, ['http://office.local'])).toThrow(
        BadRequestException,
      ),
  );
  it('accepts a configured editing service URL', () =>
    expect(
      engineUrl('http://office.local/cache/a.docx', ['http://office.local']),
    ).toBe('http://office.local/cache/a.docx'));
});
