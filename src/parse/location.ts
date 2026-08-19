import type { SourceRange } from '../api/model.js';

export const lineStarts = (source: string): readonly number[] => {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
};

export const positionAt = (starts: readonly number[], offset: number): SourceRange['start'] => {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = starts[middle] ?? 0;
    if (value <= offset) low = middle + 1;
    else high = middle - 1;
  }
  const lineIndex = Math.max(0, high);
  const start = starts[lineIndex] ?? 0;
  return { offset, line: lineIndex + 1, column: offset - start + 1 };
};

export const rangeAt = (
  source: string,
  startOffset: number,
  endOffset = startOffset
): SourceRange => {
  const starts = lineStarts(source);
  return {
    start: positionAt(starts, Math.max(0, startOffset)),
    end: positionAt(starts, Math.max(startOffset, endOffset))
  };
};

export const zeroRange = (): SourceRange => ({
  start: { offset: 0, line: 1, column: 1 },
  end: { offset: 0, line: 1, column: 1 }
});
