import { describe, expect, it, vi } from 'vitest';

import {
  idenBrandProfile,
  isCloudBrandEnvironment,
  loadRuntimePlatformBranding,
  logtoBrandProfile,
  rebrandProductPhrases,
  rebrandProductText,
  resolveBrandProfile,
  resolveSelfHostedHelpLink,
} from './brand.js';

describe('resolveBrandProfile', () => {
  it('uses iden for self-hosted builds', () => {
    expect(resolveBrandProfile(false)).toBe(idenBrandProfile);
  });

  it('preserves Logto for Cloud builds', () => {
    expect(resolveBrandProfile(true)).toBe(logtoBrandProfile);
  });

  it('does not treat a false environment string as Cloud', () => {
    expect(isCloudBrandEnvironment('true')).toBe(true);
    expect(isCloudBrandEnvironment('1')).toBe(true);
    expect(isCloudBrandEnvironment('false')).toBe(false);
    expect(isCloudBrandEnvironment(null)).toBe(false);
  });
});

describe('loadRuntimePlatformBranding', () => {
  it('applies validated self-hosted branding to an app-local profile', async () => {
    const profile = { ...idenBrandProfile };
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            productName: 'Acme ID',
            slogan: 'One identity.',
            logoUrl: '/api/platform-assets/light-logo.svg',
            darkLogoUrl: '/api/platform-assets/dark-logo.svg',
            hideOpenSourceNotice: true,
          }),
          { status: 200 }
        )
    );

    await loadRuntimePlatformBranding(profile, false, request);

    expect(request).toHaveBeenCalledWith('/api/platform-branding', {
      credentials: 'same-origin',
    });
    expect(profile).toMatchObject({
      productName: 'Acme ID',
      consoleTitle: 'Acme ID',
      darkLogoUrl: '/api/platform-assets/dark-logo.svg',
      hideOpenSourceNotice: true,
    });
  });

  it('does not request local branding for Cloud builds', async () => {
    const profile = { ...logtoBrandProfile };
    const request = vi.fn();

    await loadRuntimePlatformBranding(profile, true, request);

    expect(request).not.toHaveBeenCalled();
    expect(profile).toEqual(logtoBrandProfile);
  });

  it('keeps defaults when the branding response is invalid', async () => {
    const profile = { ...idenBrandProfile };
    const request = vi.fn(async () => new Response(JSON.stringify({ productName: 'Incomplete' })));

    await loadRuntimePlatformBranding(profile, false, request);

    expect(profile).toEqual(idenBrandProfile);
  });
});

describe('rebrandProductText', () => {
  it('rebrands self-hosted product prose', () => {
    expect(rebrandProductText('Welcome to Logto Cloud. Powered by Logto.', false)).toBe(
      'Welcome to iden. Powered by iden.'
    );
  });

  it('preserves compatibility identifiers', () => {
    expect(
      rebrandProductText(
        'Use @logto/react, LogtoClient, urn:logto:scope, and Logto-ID-Token with Logto.',
        false
      )
    ).toBe('Use @logto/react, LogtoClient, urn:logto:scope, and Logto-ID-Token with iden.');
  });

  it('does not alter Cloud phrases', () => {
    expect(rebrandProductPhrases({ title: 'Logto Cloud' }, true)).toEqual({
      title: 'Logto Cloud',
    });
  });

  it('uses the runtime platform name for self-hosted prose', () => {
    expect(rebrandProductText('Welcome to Logto. Powered by iden.', false, 'Acme ID')).toBe(
      'Welcome to Acme ID. Powered by Acme ID.'
    );
  });
});

describe('resolveSelfHostedHelpLink', () => {
  it('maps inherited product sites to local help without rewriting third-party links', () => {
    expect(resolveSelfHostedHelpLink('https://docs.logto.io/logto-oss#setup', 'zh-CN')).toBe(
      '/help/zh-CN/iden-oss#setup'
    );
    expect(resolveSelfHostedHelpLink('https://cloud.logto.io/to/applications')).toBe(
      '/help/en/introduction/'
    );
    expect(resolveSelfHostedHelpLink('https://help.iden.local/quick-starts', 'en-US')).toBe(
      '/help/en/quick-starts'
    );
    expect(resolveSelfHostedHelpLink('https://developer.mozilla.org/')).toBeUndefined();
  });
});
