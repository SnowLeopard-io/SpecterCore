import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchIcoAsPng } from './ico';

/** True if the icon is a resource path (e.g. /icons/foo.ico) — otherwise emoji. */
function isIconPath(icon: string): boolean {
  return /^(https?:)?\//.test(icon) || /\.(ico|png|svg|jpg|jpeg|webp|gif|bmp)$/i.test(icon);
}

interface AppIconProps {
  icon: string;
  /** Fallback shown while the icon loads (or if the .ico has no PNG payload). */
  fallback?: string;
  className?: string;
  alt?: string;
}

/**
 * Render an app icon: resource paths (PNG/SVG/...) become <img>; .ico paths
 * are decoded asynchronously (Chromium/Edge can't render raw .ico in <img>);
 * anything else is passed through as an emoji/character in a <span>.
 */
export function AppIcon({ icon, fallback, className, alt }: AppIconProps): ReactNode {
  // Decode .ico asynchronously; for other resource types the browser can
  // render the path directly so no decode step is needed.
  const icoUrl = isIcoPath(icon) ? icon : null;
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(icoUrl ? null : icon);

  useEffect(() => {
    if (!icoUrl) return;
    let cancelled = false;
    void fetchIcoAsPng(icoUrl).then((res) => {
      if (cancelled) return;
      setResolvedUrl(res.pngUrl ?? `__fallback__:${icon}`);
    });
    return () => {
      cancelled = true;
    };
  }, [icoUrl, icon]);

  if (resolvedUrl === null) {
    // Loading: render a transparent placeholder so layout doesn't jump.
    return <span className={className} aria-hidden style={{ visibility: 'hidden' }}>{fallback ?? ''}</span>;
  }
  if (resolvedUrl.startsWith('__fallback__:')) {
    // .ico had no PNG entry — fall back to the supplied character.
    return <span className={className}>{fallback ?? icon}</span>;
  }
  return (
    <img
      className={className}
      src={resolvedUrl}
      alt={alt ?? ''}
      draggable={false}
    />
  );
}

function isIcoPath(icon: string): boolean {
  return /\.ico(\?|$)/i.test(icon);
}
