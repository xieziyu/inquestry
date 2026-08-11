/**
 * 待办栏要能全程用键盘处置（ui.md §4），代价是全局按键会撞上正在打字的输入框。
 * 判断只看焦点落在哪里，不看具体是哪张卡——加一个新控件时不该还要回来改这里。
 */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable === true
  );
}

/** 单字母快捷键只在「没按修饰键」时算数，否则会抢掉 ⌘A 之类的系统组合。 */
export function isPlainKey(e: KeyboardEvent): boolean {
  return !e.metaKey && !e.ctrlKey && !e.altKey;
}
