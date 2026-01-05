// Azerbaijani profanity moderation helpers.
//
// Requirement: vulgar words should be "blurred" in chat.
// We implement this by obfuscating matched words with bullet characters (•).
//
// NOTE: This should also be enforced on the server; client-side checks can be bypassed.

const VULGAR_WORDS: string[] = [
  // AZ/TR common (non-exhaustive)
  "siktir",
  "sikdir",
  "sik",
  "qehbe",
  "qəhbə",
  "qehbə",
  "pox",
  "gijdillaq",
  "gicdillaq",

  // RU/EN transliterations that appear frequently
  "blyat",
  "suka",
  "xuy",
  "huy",
  "pizda",
  "pizd",
  "ebat",
  "yob",
];

// Map latin chars to loose matching groups to handle Azerbaijani diacritics.
const CHAR_GROUP: Record<string, string> = {
  a: "a",
  b: "b",
  c: "[cç]",
  ç: "[cç]",
  d: "d",
  e: "[eə]",
  ə: "[eə]",
  f: "f",
  g: "[gğ]",
  ğ: "[gğ]",
  h: "h",
  i: "[iı]",
  ı: "[iı]",
  j: "j",
  k: "k",
  l: "l",
  m: "m",
  n: "n",
  o: "[oö]",
  ö: "[oö]",
  p: "p",
  q: "q",
  r: "r",
  s: "[sş]",
  ş: "[sş]",
  t: "t",
  u: "[uü]",
  ü: "[uü]",
  v: "v",
  x: "x",
  y: "y",
  z: "z",
};

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looseWordPattern(word: string) {
  const w = word.trim().toLowerCase();
  let out = "";
  for (const ch of w) {
    const grp = CHAR_GROUP[ch];
    out += grp ? grp : escapeRegex(ch);
  }
  return out;
}

const WORD_REGEXES: RegExp[] = VULGAR_WORDS.map((w) => {
  const p = looseWordPattern(w);
  // Match whole-token-ish words, to avoid censoring inside normal words.
  // (^|non-letter/number) (word) (?=non-letter/number|$)
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${p})(?=[^\\p{L}\\p{N}]|$)`, "giu");
});

export function hasAzVulgar(text: string) {
  const t = String(text || "");
  for (const r of WORD_REGEXES) {
    r.lastIndex = 0;
    if (r.test(t)) return true;
  }
  return false;
}

export function censorAzVulgar(text: string) {
  let t = String(text || "");
  for (const r of WORD_REGEXES) {
    r.lastIndex = 0;
    t = t.replace(r, (_m, p1: string, p2: string) => {
      const mask = "•".repeat(Math.max(3, p2.length));
      return `${p1}${mask}`;
    });
  }
  return t;
}
