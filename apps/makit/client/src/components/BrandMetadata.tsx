import { useEffect } from 'react';
import {
  APP_TITLE,
  BRAND_FAVICON_URL,
  BRAND_FAVICON_DARK_URL,
} from '@/lib/brand';

/** Keep the brand after the host SDK updates app metadata asynchronously. */
export function BrandMetadata() {
  useEffect(() => {
    const scheme: MediaQueryList = window.matchMedia(
      '(prefers-color-scheme: dark)',
    );
    const applyBrand = (): void => {
      const faviconUrl: string = new URL(
        scheme.matches ? BRAND_FAVICON_DARK_URL : BRAND_FAVICON_URL,
        document.baseURI,
      ).href;
      if (document.title !== APP_TITLE) document.title = APP_TITLE;
      if (!document.head.querySelector('link[rel~="icon"]')) {
        const icon: HTMLLinkElement = document.createElement('link');
        icon.rel = 'icon';
        document.head.appendChild(icon);
      }
      // Some SDK versions append an icon instead of updating the first one.
      // Keep every active icon consistent so the browser cannot choose an old one.
      document.head
        .querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')
        .forEach((icon: HTMLLinkElement): void => {
          if (icon.href !== faviconUrl) icon.href = faviconUrl;
          icon.type = 'image/svg+xml';
        });
    };
    applyBrand();
    scheme.addEventListener('change', applyBrand);
    const observer: MutationObserver = new MutationObserver(applyBrand);
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['href'],
    });
    return () => {
      observer.disconnect();
      scheme.removeEventListener('change', applyBrand);
    };
  }, []);
  return null;
}
