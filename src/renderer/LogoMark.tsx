/**
 * 应用标记。几何、降档、调色都在 `logo.ts`——那一份不带 React，官网也读它。
 * 这里只把它包成一个组件。
 */
import { markInner, tierFor, type Tier } from './logo.js';
import { useId } from 'react';

export function LogoMark({
  size = 24,
  tier,
  className,
}: {
  size?: number;
  /** 强制某一档；不给就按 size 自动降。 */
  tier?: Tier;
  className?: string;
}) {
  const t = tier ?? tierFor(size);
  const instance = useId();
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 96 96"
      role="img"
      aria-label="Inquestry"
      dangerouslySetInnerHTML={{ __html: markInner(t, instance) }}
    />
  );
}
