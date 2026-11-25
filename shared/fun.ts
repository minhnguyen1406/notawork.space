/** Reactions that float up over your head. Keys 1 to 6. */
export const EMOJI = ['👋', '😂', '❤️', '🔥', '👏', '💀'];
/** Everything a client may send as an emote. */
export const EMOTES = [...EMOJI, 'dance', 'zzz'];

/**
 * This is not a workspace. Saying any of these in chat sets off the alarm and resets the
 * "minutes since anyone mentioned work" sign. English and Vietnamese.
 */
const WORK_WORDS = [
  'meeting', 'deadline', 'kpi', 'okr', 'standup', 'stand-up', 'jira', 'sprint', 'synergy', 'circle back',
  'action item', 'quarterly', 'timesheet', 'overtime', 'performance review', 'stakeholder', 'deliverable',
  'per my last email', 'touch base', 'low-hanging fruit', 'bandwidth', 'họp', 'tăng ca', 'sếp', 'báo cáo', 'chạy deadline',
];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORK_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${WORK_WORDS.map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'iu');

/** The work word in a chat message, or null if it is clean. */
export const workWord = (text: string): string | null => WORK_RE.exec(text)?.[1].toLowerCase() ?? null;

/** The id of the built-in Claude character. Real players get random ids, so it can't clash. */
export const NPC_ID = 'claude';
