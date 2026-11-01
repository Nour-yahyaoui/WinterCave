import { describe, expect, it } from 'vitest';
import {
  computeNewline,
  decideAutoClose,
  detectIndent,
  reindentBlock,
  smartHomeTarget,
  toggleCommentBlock,
  toggleLineCommentText,
} from '../../src/core/smartEdit';

describe('decideAutoClose', () => {
  it('closes openers', () => {
    expect(decideAutoClose({ char: '(', before: '', after: '', hasSelection: false })).toEqual({
      type: 'insert',
      text: '()',
    });
  });

  it('wraps a selection instead of doubling it', () => {
    expect(decideAutoClose({ char: '[', before: 'x', after: 'y', hasSelection: true })).toEqual({
      type: 'wrap',
      open: '[',
      close: ']',
    });
  });

  it('steps over an existing closer', () => {
    expect(decideAutoClose({ char: ')', before: '(', after: ')', hasSelection: false })).toEqual({
      type: 'skip',
      advance: 1,
    });
  });

  it('does not turn prose apostrophes into pairs', () => {
    expect(decideAutoClose({ char: "'", before: 'n', after: 't', hasSelection: false })).toBeNull();
  });

  it('does not pair quotes when the next character is a word character', () => {
    expect(decideAutoClose({ char: '"', before: ' ', after: 'a', hasSelection: false })).toBeNull();
  });

  it('pairs quotes in an empty context', () => {
    expect(decideAutoClose({ char: '"', before: '', after: '', hasSelection: false })).toEqual({
      type: 'insert',
      text: '""',
    });
  });

  it('does not wrap the next word with a bracket', () => {
    expect(decideAutoClose({ char: '(', before: ' ', after: 'a', hasSelection: false })).toBeNull();
  });

  it('ignores ordinary characters', () => {
    expect(decideAutoClose({ char: 'a', before: '', after: '', hasSelection: false })).toBeNull();
  });
});

describe('computeNewline', () => {
  it('keeps the current indentation', () => {
    expect(computeNewline({ lineText: '    x', column: 5, indentUnit: '  ' })).toEqual({
      text: '\n    ',
      caret: 5,
    });
  });

  it('indents after an opening brace', () => {
    expect(computeNewline({ lineText: '  if (x) {', column: 10, indentUnit: '  ' })).toEqual({
      text: '\n    ',
      caret: 5,
    });
  });

  it('splits an empty block into three lines', () => {
    const result = computeNewline({ lineText: '{}', column: 1, indentUnit: '  ' });
    expect(result.text).toBe('\n  \n');
    expect(result.caret).toBe(3);
  });

  it('dedents when pressing enter before a lone closer', () => {
    expect(computeNewline({ lineText: '    }', column: 4, indentUnit: '  ' })).toEqual({
      text: '\n  ',
      caret: 3,
    });
  });

  it('respects tab indentation', () => {
    expect(computeNewline({ lineText: '\tx', column: 2, indentUnit: '\t' })).toEqual({
      text: '\n\t',
      caret: 2,
    });
  });
});

describe('smartHomeTarget', () => {
  it('goes to the first non-blank character, then to column zero', () => {
    expect(smartHomeTarget('    foo', 7)).toBe(4);
    expect(smartHomeTarget('    foo', 4)).toBe(0);
    expect(smartHomeTarget('foo', 0)).toBe(0);
    expect(smartHomeTarget('   ', 3)).toBe(0);
  });
});

describe('detectIndent', () => {
  it('detects tabs', () => {
    expect(detectIndent('\ta\n\t\tb\nc')).toEqual({ indentUnit: '\t', insertSpaces: false });
  });

  it('detects space width from the smallest run', () => {
    expect(detectIndent('a\n    b\n        c')).toEqual({ indentUnit: '    ', insertSpaces: true });
  });

  it('falls back when there is no indentation to learn from', () => {
    expect(detectIndent('a\nb')).toEqual({ indentUnit: '  ', insertSpaces: true });
  });

  it('caps absurd widths', () => {
    expect(detectIndent(' '.repeat(40) + 'x').indentUnit).toBe(' '.repeat(8));
  });
});

describe('reindentBlock', () => {
  const options = { indentUnit: '  ', insertSpaces: true };

  it('indents every line', () => {
    expect(reindentBlock(['a', 'b'], options, 'indent')).toEqual(['  a', '  b']);
  });

  it('outdents partial indentation safely', () => {
    expect(reindentBlock(['  a', ' a', 'a'], options, 'outdent')).toEqual(['a', 'a', 'a']);
  });

  it('removes a single tab when the file uses tabs', () => {
    expect(reindentBlock(['\ta', '  a'], { indentUnit: '\t', insertSpaces: false }, 'outdent')).toEqual([
      'a',
      'a',
    ]);
  });
});

describe('comment toggling', () => {
  it('comments and uncomments a line', () => {
    expect(toggleLineCommentText('  code', '//')).toBe('  // code');
    expect(toggleLineCommentText('  // code', '//')).toBe('  code');
  });

  it('leaves blank lines alone', () => {
    expect(toggleLineCommentText('   ', '//')).toBe('   ');
    expect(toggleLineCommentText('x', undefined)).toBe('x');
  });

  it('comments a block only if not every line is commented', () => {
    expect(toggleCommentBlock(['a', 'b'], '//')).toEqual(['// a', '// b']);
    expect(toggleCommentBlock(['// a', '// b'], '//')).toEqual(['a', 'b']);
    expect(toggleCommentBlock(['// a', 'b'], '//')).toEqual(['// // a', '// b']);
  });

  it('skips blank lines inside a block', () => {
    expect(toggleCommentBlock(['a', '', 'b'], '--')).toEqual(['-- a', '', '-- b']);
  });
});
