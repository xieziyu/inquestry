import { useEffect, useRef } from 'react';

/**
 * Esc 只落到**最后打开的那一层**。
 *
 * 各层自己 `addEventListener('keydown')` 是不行的：window 上的监听按注册先后收事件，
 * 而先注册的恰恰是先打开的那一层——详情抽屉开着再从里面点开原文浮层，Esc 会先关掉底下的抽屉，
 * 连带把上面那层一起卸掉。谁该收这一下只取决于谁在最上面，所以统一记一摞、只叫栈顶。
 */
const layers: Array<{ current: () => void }> = [];

let bound = false;
function bind() {
  if (bound) return;
  bound = true;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    layers[layers.length - 1]?.current();
  });
}

/** `active` 为真的这段时间里，这一层压在栈顶，Esc 归它。 */
export function useEscape(active: boolean, onEsc: () => void) {
  const cb = useRef(onEsc);
  cb.current = onEsc;
  useEffect(() => {
    if (!active) return;
    bind();
    layers.push(cb);
    return () => {
      const i = layers.lastIndexOf(cb);
      if (i >= 0) layers.splice(i, 1);
    };
  }, [active]);
}
