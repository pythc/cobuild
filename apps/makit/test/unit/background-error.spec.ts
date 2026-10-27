import { backgroundErrorDiagnostic } from '../../server/common/utils/background-error';

describe('background failure diagnostics', () => {
  it('keeps nested database error codes and call sites without query parameters or credentials', () => {
    const driver = Object.assign(new Error('secret document sk-private'), {
      code: '42501',
    });
    const error = new Error('Failed query: INSERT secret material', {
      cause: driver,
    });
    error.stack +=
      '\nrequest Authorization=Bearer secret\n    at https://host/?token=secret';
    const diagnostic = backgroundErrorDiagnostic(error);
    expect(diagnostic).toContain('42501');
    expect(diagnostic).toContain('background-error.spec.ts');
    expect(diagnostic).not.toMatch(
      /secret|sk-private|INSERT|Authorization|https:/u,
    );
  });

  it('handles circular causes and non-error throws', () => {
    const error = new Error('circular');
    Object.assign(error, { cause: error });
    expect(JSON.parse(backgroundErrorDiagnostic(error)).causes).toHaveLength(1);
    expect(backgroundErrorDiagnostic('untrusted secret')).toBe('{"causes":[]}');
  });
});
