/**
 * Regular-expression matching rules.
 *
 * A budget-item or merchant rule with method `regex` runs a pattern any member of the
 * ledger typed: in Node for budget rules (BudgetItemMatcher, on every imported
 * transaction) and in Postgres for a merchant rule's preview (`~*`). A pattern that
 * backtracks catastrophically, such as `(a+)+$`, can take minutes on one description.
 * Saving a rule therefore refuses a pattern that is:
 * - longer than {@link MAX_REGEX_RULE_LENGTH} characters;
 * - not a valid JavaScript regular expression;
 * - a repeat inside a repeat (`(a+)+`, `(a*)*`, `(\w+\s?)*`, `(.*){2,}`): the shape of
 *   nearly every catastrophic pattern;
 * - more than {@link MAX_REGEX_RULE_REPEATS} repeats, or a `{n,m}` count above
 *   {@link MAX_REGEX_RULE_COUNT} (Postgres refuses counts above 255).
 *
 * The check can't recognise every slow pattern (overlapping alternatives such as
 * `(a|a)*` aren't caught), and rules saved before it existed weren't checked, so the
 * server also bounds the time a pattern may run: backend/src/utils/userRegex.ts for
 * Node and a statement timeout for the preview in Postgres.
 */

export const MAX_REGEX_RULE_LENGTH = 200;
export const MAX_REGEX_RULE_REPEATS = 25;
export const MAX_REGEX_RULE_COUNT = 255;

interface Shape {
  /** A repeat applies to something that already contains one. */
  nestedRepeat: boolean;
  /** Repeating quantifiers (`*`, `+`, `{n,}`, `{n,m}` with m > 1). */
  repeats: number;
  /** The largest number in a `{n}` / `{n,m}` count. */
  largestCount: number;
}

const COUNT = /^\{(\d+)(?:(,)(\d*))?\}/;

/**
 * The repeat structure of a pattern that already compiles as a JavaScript regular
 * expression (no `u` or `v` flag). Each atom (a character, a class, an escape, a group)
 * gets a depth: how many repeats it contains. A repeat on an atom of depth 1 or more is
 * a nested repeat.
 */
function shapeOf(pattern: string): Shape {
  const shape: Shape = { nestedRepeat: false, repeats: 0, largestCount: 0 };
  // One entry per open group: the deepest atom in it so far.
  const groups: number[] = [0];
  // The depth of the atom a quantifier would apply to; null after `(`, `|` or a quantifier.
  let atom: number | null = null;

  const commit = (depth: number) => {
    // `groups` always holds at least the outermost entry (a `)` never pops the last one).
    groups[groups.length - 1] = Math.max(groups[groups.length - 1] ?? 0, depth);
  };
  const quantify = (repeating: boolean) => {
    if (atom === null) return;
    const depth = repeating ? atom + 1 : atom;
    if (repeating) {
      shape.repeats += 1;
      if (atom > 0) shape.nestedRepeat = true;
    }
    commit(depth);
    atom = null;
  };

  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '\\') {
      atom = 0;
      commit(0);
      i += 2;
    } else if (c === '[') {
      // A class: to the first unescaped `]` after any leading `^` (`[]` is an empty class).
      i += 1;
      if (pattern[i] === '^') i += 1;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      i += 1;
      atom = 0;
      commit(0);
    } else if (c === '(') {
      groups.push(0);
      atom = null;
      i += 1;
      if (pattern[i] === '?') {
        // (?: (?= (?! (?<= (?<! (?<name>
        i += 1;
        if (pattern[i] === '<' && pattern[i + 1] !== '=' && pattern[i + 1] !== '!') {
          const close = pattern.indexOf('>', i);
          i = close === -1 ? pattern.length : close + 1;
        } else {
          i += pattern[i] === '<' ? 2 : 1;
        }
      }
    } else if (c === ')') {
      const depth = groups.length > 1 ? (groups.pop() as number) : 0;
      atom = depth;
      commit(depth);
      i += 1;
    } else if (c === '|') {
      atom = null;
      i += 1;
    } else if (c === '*' || c === '+') {
      quantify(true);
      i += pattern[i + 1] === '?' ? 2 : 1;
    } else if (c === '?') {
      quantify(false);
      i += pattern[i + 1] === '?' ? 2 : 1;
    } else if (c === '{' && COUNT.test(pattern.slice(i))) {
      const [whole, low, comma, high] = COUNT.exec(pattern.slice(i)) as RegExpExecArray;
      const min = Number(low);
      const max = comma ? (high === '' ? Infinity : Number(high)) : min;
      shape.largestCount = Math.max(shape.largestCount, min, Number.isFinite(max) ? max : 0);
      quantify(max > 1);
      i += whole.length + (pattern[i + whole.length] === '?' ? 1 : 0);
    } else {
      // A character, `.`, an anchor, or a `{` that isn't a count.
      atom = 0;
      commit(0);
      i += 1;
    }
  }
  return shape;
}

/**
 * Why `pattern` can't be saved as a regex rule, in words for the person who typed it,
 * or null when it can.
 */
export function regexRuleProblem(pattern: string): string | null {
  if (pattern.length > MAX_REGEX_RULE_LENGTH) {
    return `A regular expression can be up to ${MAX_REGEX_RULE_LENGTH} characters.`;
  }
  try {
    new RegExp(pattern, 'i');
  } catch {
    return 'This isn’t a valid regular expression.';
  }
  const shape = shapeOf(pattern);
  if (shape.nestedRepeat) {
    return 'A repeated part can’t contain another repeat, as in (a+)+ or (\\w+\\s?)*: a pattern like that can take minutes to check one transaction. Repeat the characters once, as in a+ or [\\w\\s]+.';
  }
  if (shape.repeats > MAX_REGEX_RULE_REPEATS) {
    return `A regular expression can have up to ${MAX_REGEX_RULE_REPEATS} repeats (*, + or {n,m}).`;
  }
  if (shape.largestCount > MAX_REGEX_RULE_COUNT) {
    return `A count in {n,m} can be up to ${MAX_REGEX_RULE_COUNT}.`;
  }
  return null;
}
