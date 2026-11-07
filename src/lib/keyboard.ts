/** Support native DOM and React keyboard events during IME composition. */
export function isImeKeyEvent(event: {
  isComposing?: boolean;
  keyCode: number;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  return event.isComposing === true || event.nativeEvent?.isComposing === true || event.keyCode === 229;
}
