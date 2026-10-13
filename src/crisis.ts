// First-layer crisis pre-check. It runs on every user message before the model
// sees it. It is deliberately broad: a false positive in chat only shows the
// help banner and asks the coach to check in once; a miss is caught (we hope)
// by the model following the Safety section on its own, or by the cards'
// safety_concern flag. It is not the only safeguard.
//
// In the Journal and Scripts a match replaces the card with the help banner, so
// common idioms ("my boss is going to kill me") are kept out on purpose.
// tests/unit/safety.test.ts lists what must and mustn't match: add to it when
// changing these.
const PATTERNS: RegExp[] = [
  // Suicide and wanting to die
  /\bsuicid/i,
  /\bkill(ing)?\s+(my\s*self|myself)\b/i,
  /\bkms\b/i,
  /\bun-?aliv(e|ing)\b/i,
  /\bend(ing)?\s+(my|it)\s+(life|all)\b/i,
  /\bend\s+it\s+all\b/i,
  /\b(think|thinking|thought|thoughts)\s+(about|of)\s+ending\s+(it|things|everything)\b/i,
  /\b(want|wanna|going|ready)\s+to\s+die\b/i,
  /\bwish\s+i\s+(was|were)\s+dead\b/i,
  /\bwish\s+i\s+(wasn'?t|weren'?t|was\s+never|had\s+never\s+been)\s+(alive|born|here)\b/i,
  /\bbetter\s+off\s+(dead|without\s+me)\b/i,
  /\b(no\s*one|nobody)\s+would\s+miss\s+me\b/i,
  /\b(no\s*one|nobody)\s+would\s+(care|notice)\s*([.!]|$|if\s+i\s+((was|were)\s+(gone|dead|not\s+(here|around))|died|disappeared))/im,
  /\b(disappear|be\s+gone)\s+forever\b/i,
  /\bno\s+(reason|point)\s+(to|in)\s+(live|living|going\s+on|being\s+alive)\b/i,
  /\b(don'?t|do\s+not)\s+want\s+to\s+(be\s+alive|live|exist|be\s+here\s+anymore|wake\s+up)\b/i,
  /\bcan'?t\s+(do\s+this|go\s+on|keep\s+going)\s+anymore\b/i,

  // Self-harm and overdose
  /\bself[-\s]?harm/i,
  /\b(hurt|cut|cutting|harm|harming|burn|burning)\s+(my\s*self|myself)\b/i,
  /\boverdos/i,
  /\b(take|taking|took|swallow|swallowing|swallowed)\s+(all|a\s+bunch|a\s+handful|the\s+whole\s+bottle)\s+(of\s+)?(my\s+|the\s+|those\s+)?(pills|meds|medication|tablets)\b/i,

  // Danger from or to someone else (threats, abuse)
  /\bthreaten(s|ed|ing)?\s+(to\s+)?(kill|hurt|harm)\b/i,
  /\b(said|says|told\s+me)\s+(he|she|they)('?d|'?ll|\s+would|\s+will|'?s\s+going\s+to|\s+is\s+going\s+to|\s+was\s+going\s+to|'?s\s+gonna|\s+gonna)\s+(kill|hurt)\b/i,
  /\b(going|gonna|want|wants)\s+to\s+hurt\s+(me|him|her|them|someone|somebody|people)\b/i,
  /\b(want|wants|going|gonna)\s+to\s+kill\s+(someone|somebody|people)\b/i,
  /\b(he|she|they|my\s+\w+)\s+(hit|hits|hitting|beat|beats|beating|choked|chokes|choking|strangled|punched|kicked)\s+me\b(?!\s+(up|with|back))/i,
  /\b(scared|afraid|terrified)\s+(to\s+go\s+home|for\s+my\s+life)\b/i,
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
