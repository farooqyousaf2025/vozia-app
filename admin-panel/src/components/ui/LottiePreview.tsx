import { useEffect, useRef, useState } from 'react';
import lottie, { AnimationItem } from 'lottie-web';
import { assetUrl } from '../../lib/api';

interface LottiePreviewProps {
  /** Lottie JSON URL, root-relative or absolute; resolved against the API origin. */
  src: string | null | undefined;
  size?: number;
  loop?: boolean;
  className?: string;
  /** Rendered when the animation cannot load, so a bad URL is visible, not blank. */
  fallback?: string;
}

/**
 * Plays a generated gift/effect animation in the console. The renderer is 'svg'
 * because the assets are vector-only, and the animation is destroyed on unmount
 * — a leaked lottie keeps a rAF loop alive per mounted preview.
 */
export function LottiePreview({ src, size = 120, loop = true, className = '', fallback = 'no animation' }: LottiePreviewProps) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const url = assetUrl(src);

  useEffect(() => {
    setFailed(false);
    if (!url || !host.current) return undefined;
    let item: AnimationItem | null = null;
    try {
      item = lottie.loadAnimation({
        container: host.current,
        renderer: 'svg',
        loop,
        autoplay: true,
        path: url,
      });
      item.addEventListener('data_failed', () => setFailed(true));
    } catch {
      setFailed(true);
    }
    return () => item?.destroy();
  }, [url, loop]);

  if (!url || failed) {
    return (
      <div
        className={`flex items-center justify-center rounded-lg border border-dashed border-white/10 text-[10px] text-muted ${className}`}
        style={{ width: size, height: size }}
      >
        {failed ? 'load failed' : fallback}
      </div>
    );
  }
  return <div ref={host} className={className} style={{ width: size, height: size }} />;
}
