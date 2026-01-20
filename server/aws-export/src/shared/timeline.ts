/**
 * Minimal runtime validation for the timeline payload.
 */
export function assertValidTimeline(timeline: unknown): asserts timeline is { editorData: unknown[] } {
  const editorData = (timeline as { editorData?: unknown })?.editorData;
  if (!Array.isArray(editorData)) {
    throw new Error('`timeline.editorData` must be an array.');
  }
}

/**
 * Extracts editorData (array) or throws.
 */
export function getEditorData(timeline: unknown): unknown[] {
  assertValidTimeline(timeline);
  return (timeline as { editorData: unknown[] }).editorData;
}
