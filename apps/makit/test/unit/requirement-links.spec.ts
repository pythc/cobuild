import {
  DEFAULT_REQUIREMENT_PLATFORM_URL,
  iterationPlatformUrl,
  pullRequestPlatformUrl,
  requirementPlatformUrl,
} from '../../server/modules/requirements/requirement-links';

describe('requirement platform links', () => {
  const previousUrl: string | undefined = process.env.REQUIREMENT_PLATFORM_URL;

  afterEach(() => {
    if (previousUrl === undefined) delete process.env.REQUIREMENT_PLATFORM_URL;
    else process.env.REQUIREMENT_PLATFORM_URL = previousUrl;
  });

  it('opens the exact requirement detail in the current platform', () => {
    delete process.env.REQUIREMENT_PLATFORM_URL;
    expect(requirementPlatformUrl('rec test/1')).toBe(
      `${DEFAULT_REQUIREMENT_PLATFORM_URL}/requirements/rec%20test%2F1`,
    );
  });

  it('opens the exact iteration and trims a configured trailing slash', () => {
    process.env.REQUIREMENT_PLATFORM_URL = 'https://example.test/app/demo/';
    expect(iterationPlatformUrl('rec_iteration')).toBe(
      'https://example.test/app/demo/iterations?iteration=rec_iteration',
    );
  });

  it('opens the exact pull request detail in the current platform', () => {
    process.env.REQUIREMENT_PLATFORM_URL = 'https://example.test/app/demo/';
    expect(pullRequestPlatformUrl(34)).toBe(
      'https://example.test/app/demo/pull-requests/34',
    );
  });
});
