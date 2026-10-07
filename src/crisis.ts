// First-layer crisis pre-check. It runs on every user message before the model
// sees it. It is deliberately broad: a false positive only shows the help banner
// and reminds the coach of its Safety section; a miss is caught (we hope) by the
// model following the Safety section on its own. It is not the only safeguard.
const PATTERNS: RegExp[] = [
  /\bsuicid/i,
  /\bkill(ing)?\s+(my\s*self|myself)\b/i,
  /\bend(ing)?\s+(my|it)\s+(life|all)\b/i,
  /\bend\s+it\s+all\b/i,
  /\b(want|wanna|going|ready)\s+to\s+die\b/i,
  /\bwish\s+i\s+(was|were)\s+dead\b/i,
  /\bbetter\s+off\s+(dead|without\s+me)\b/i,
  /\bno\s+(reason|point)\s+(to|in)\s+(live|living|going\s+on)\b/i,
  /\bdon'?t\s+want\s+to\s+(be\s+alive|live|exist|be\s+here\s+anymore)\b/i,
  /\bself[-\s]?harm/i,
  /\b(hurt|cut|cutting|harm|harming)\s+(my\s*self|myself)\b/i,
  /\boverdos/i,
  /\b(going|gonna|want|threaten(ed|ing)?)\s+to\s+(kill|hurt)\s+(me|him|her|them|someone|somebody|people)\b/i,
  /\b(i'?m|i\s+am)\s+(not\s+safe|in\s+danger)\b/i,
];

export function crisisCheck(text: string): boolean {
  return PATTERNS.some((p) => p.test(text));
}

export const CRISIS_SYSTEM_NOTE =
  "Safety pre-check: the user's latest message matched crisis language (self-harm, suicide, or danger). " +
  "Before anything else, follow the Safety section of your instructions. Step out of any role-play. " +
  "If it is clearly a false positive (for example, an idiom like \"this meeting is killing me\" or a role-play line), " +
  "briefly check in once in plain words and then continue helping.";
