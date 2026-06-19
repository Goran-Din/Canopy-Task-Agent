// Single source of truth for the 9-stage hardscape taxonomy + phase colors
// (matches the Stage 1 badge styling used on the Pipeline board).

export const STAGE_STYLES = {
  request_site_visit: { bg: '#FAEEDA', text: '#633806', label: 'Request site visit', phase: 'quote' },
  pending_quote:      { bg: '#FAEEDA', text: '#633806', label: 'Pending quote',      phase: 'quote' },
  quote_sent:         { bg: '#FAEEDA', text: '#633806', label: 'Quote sent',         phase: 'quote' },
  quote_accepted:     { bg: '#E6F1FB', text: '#0C447C', label: 'Quote accepted',     phase: 'production' },
  pending_permits:    { bg: '#E6F1FB', text: '#0C447C', label: 'Pending permits',    phase: 'production' },
  scheduled_for_work: { bg: '#E6F1FB', text: '#0C447C', label: 'Scheduled for work', phase: 'production' },
  work_in_progress:   { bg: '#EEEDFE', text: '#3C3489', label: 'Work in progress',   phase: 'production' },
  completed:          { bg: '#EAF3DE', text: '#27500A', label: 'Completed',          phase: 'done' },
  lost_opportunity:   { bg: '#FCEBEB', text: '#501313', label: 'Lost opportunity',   phase: 'done' },
};

// Pipeline order — also used to sort by Status.
export const STAGE_KEYS = Object.keys(STAGE_STYLES);

// Stages offered for selection in the status dropdown. request_site_visit is
// intentionally excluded (no tab routes it, so a job set to it would vanish) —
// the value stays defined above so existing data/logic remains safe.
export const SELECTABLE_STAGE_KEYS = STAGE_KEYS.filter((k) => k !== 'request_site_visit');

export const QUOTE_STAGES = STAGE_KEYS.filter((k) => STAGE_STYLES[k].phase === 'quote');
export const PRODUCTION_STAGES = STAGE_KEYS.filter((k) => STAGE_STYLES[k].phase === 'production');

export const CREW_OPTIONS = [
  { key: 'hp1', label: 'HP#1' },
  { key: 'hp2', label: 'HP#2' },
];

export function stageLabel(stage) {
  return STAGE_STYLES[stage]?.label || stage;
}
