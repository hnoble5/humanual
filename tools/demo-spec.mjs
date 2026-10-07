// What the public demo (/demo) shows. tools/record-demo.mjs sends these to the
// real coach and saves its replies to public/demo/samples.json, so the demo
// replays genuine output without visitors ever calling the API.
//
// Each sample is a short conversation: the visitor taps the first message, and
// after each reply the next user message is offered as a tap-to-send chip.

export const PROFILE = {
  name: "Alex",
  about: "I'm autistic. Phone calls and small talk with strangers are the hardest for me. I'd rather text when I can. I over-explain when I'm nervous.",
  work: "QA engineer at a mid-size software company. Hybrid: in the office Tuesdays and Thursdays. I'm also starting to take on QA consulting clients on the side.",
  people: "Jordan (developer on my team): friendly 1:1 but takes credit in standup.\nPriya (my manager): fair, busy, prefers short updates.",
};

export const SAMPLES = [
  {
    id: "dentist",
    label: "I keep putting off a call to the dentist",
    mode: "everyday",
    coach: "junie",
    style: "gentle",
    turns: [
      "I need to call my dentist to move my cleaning and I've put it off for two weeks. Every time I pick up the phone I freeze.",
      "What if they ask why I'm rescheduling?",
    ],
  },
  {
    id: "credit",
    label: "A coworker took credit for my bug find",
    mode: "workplace",
    coach: "otis",
    style: "direct",
    turns: [
      "In standup today Jordan said he \"tracked down\" the login bug. I found it, wrote the repro steps, and sent them to him yesterday. Nobody said anything and I didn't either.",
      "Should I bring it up with Priya?",
    ],
  },
  {
    id: "slack",
    label: "Answer a snippy Slack message",
    mode: "reply",
    coach: "otis",
    style: "direct",
    turns: [
      "A developer replied to my bug report on Slack: \"Per my last message, this isn't a bug, it's working as designed. Please read the ticket before filing.\" I did read the ticket. The design doc says the opposite. Help me answer without starting a war.",
      "Can you make it shorter?",
    ],
  },
  {
    id: "meetup",
    label: "Meet potential clients at a meetup",
    mode: "networking",
    coach: "junie",
    style: "direct",
    turns: [
      "I'm going to a local software testing meetup on Thursday. I'd like to meet one or two people who might need QA consulting, but I hate walking up to strangers.",
      "What do I say if someone asks what I do and I go blank?",
    ],
  },
  {
    id: "gym",
    label: "Rehearse cancelling a gym membership",
    mode: "practice",
    coach: "otis",
    style: "direct",
    turns: [
      "Get me ready for this. It happens on a phone call.\nSituation: Cancel a membership when they push upsells\n\nLet's role-play it. Set the scene in one or two lines (who you're playing and what my goal is), then start in character.",
      "Hi, I'd like to cancel my membership, please.",
      "No thanks. I'd just like to cancel it today.",
      "stop",
    ],
  },
  {
    id: "k",
    label: "My friend replied \"k\". Is she mad?",
    mode: null,
    coach: "junie",
    style: "gentle",
    turns: [
      "I told my friend I can't make it to her birthday dinner and she texted back \"k\". Is she mad at me?",
      "Should I say something or leave it alone?",
    ],
  },
];

// Script cards for the example chips in the Scripts tool (public/app.js CHANNELS.examples).
export const SCRIPTS = [
  { channel: "inperson", coach: "junie", task: "Return shoes without a receipt" },
  { channel: "inperson", coach: "junie", task: "Ask a pharmacist about a side effect" },
  { channel: "inperson", coach: "otis", task: "Order at a busy coffee counter" },
  { channel: "inperson", coach: "otis", task: "Get out of a long chat with a neighbor" },
  { channel: "phone", coach: "junie", task: "Reschedule a doctor's appointment" },
  { channel: "phone", coach: "otis", task: "Dispute a charge on my internet bill" },
  { channel: "phone", coach: "otis", task: "Cancel a subscription that only cancels by phone" },
  { channel: "phone", coach: "junie", task: "Answer a call from an unknown number" },
  { channel: "written", coach: "junie", task: "Decline an invitation without over-explaining" },
  { channel: "written", coach: "otis", task: "Follow up on an email nobody answered" },
  { channel: "written", coach: "junie", task: "Ask my landlord to fix something" },
  { channel: "written", coach: "otis", task: "Reply to a passive-aggressive Slack message" },
];
