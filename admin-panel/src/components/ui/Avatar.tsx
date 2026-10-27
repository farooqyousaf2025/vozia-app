import { useState, type ReactNode } from 'react';
import { assetUrl } from '../../lib/api';
import { initials } from '../../lib/format';

type Size = 'xs' | 'sm' | 'md' | 'lg';

const sizeClasses: Record<Size, string> = {
  xs: 'h-6 w-6 text-[10px]',
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-14 w-14 text-base',
};

interface AvatarProps {
  name: string;
  src?: string | null;
  size?: Size;
  className?: string;
}

/** Circular avatar with graceful image fallback to gradient initials. */
export function Avatar({ name, src, size = 'md', className = '' }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const resolved = assetUrl(src);

  if (resolved && !failed) {
    return (
      <img
        src={resolved}
        alt={name}
        loading="lazy"
        onError={() => setFailed(true)}
        className={`shrink-0 rounded-full border border-edge object-cover ${sizeClasses[size]} ${className}`}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-full bg-brand-gradient font-bold text-white ${sizeClasses[size]} ${className}`}
    >
      {initials(name)}
    </span>
  );
}
