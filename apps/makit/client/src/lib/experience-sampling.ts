type Experience =
  | 'first_usable'
  | 'interaction_feedback'
  | 'transition_validation'
  | 'error_recovery';
/** Monitoring retired: business interactions no longer schedule or send samples. */
export function sampleExperience(
  _operation: Experience,
  _startedAt: number,
): void {}
export function sampleAfterPaint(
  _operation: Experience,
  _startedAt: number,
): void {}
