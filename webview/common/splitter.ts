export interface SplitterOptions {
  axis: 'x' | 'y';
  /** The pane whose size the handle controls. */
  target: HTMLElement;
  /** The target sits after the handle (right/bottom), so dragging towards it shrinks it. */
  after?: boolean;
  min: number;
  max: () => number;
  onResize: (size: number) => void;
  /** Store the size in this CSS custom property of the target instead of setting its width/height. */
  cssVar?: string;
}

/** Makes `handle` resize `target` by dragging. */
export function makeSplitter(handle: HTMLElement, options: SplitterOptions): void {
  handle.addEventListener('pointerdown', (start) => {
    start.preventDefault();
    handle.setPointerCapture(start.pointerId);
    handle.classList.add('dragging');
    const rect = options.target.getBoundingClientRect();
    const startSize = options.axis === 'x' ? rect.width : rect.height;
    const startPos = options.axis === 'x' ? start.clientX : start.clientY;
    const onMove = (e: PointerEvent) => {
      const delta = (options.axis === 'x' ? e.clientX : e.clientY) - startPos;
      const size = Math.round(Math.max(options.min, Math.min(options.max(), startSize + (options.after ? -delta : delta))));
      if (options.cssVar) {
        options.target.style.setProperty(options.cssVar, `${size}px`);
      } else {
        options.target.style[options.axis === 'x' ? 'width' : 'height'] = `${size}px`;
      }
      options.onResize(size);
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}
