// The registry is now explicit, which means it can be WRONG in a way the
// all-languages bundle could not: a language that `langFromPath` returns but
// nobody registered would silently downgrade to plain text. That is exactly the
// regression this file exists to catch.

import { describe, expect, test } from 'bun:test';
import { escapeHtml, fenceLanguage, highlightToHtml, isKnownLanguage } from './highlight';
import { langFromPath } from './tool-extract';

/** Every extension the tool-result path can hand us. Kept here rather than
 *  exported from tool-extract so the test asserts the OBSERVABLE contract
 *  (`langFromPath(file)` is highlightable) instead of an internal table. */
const FILES = [
  'a.ts',
  'a.tsx',
  'a.js',
  'a.jsx',
  'a.mjs',
  'a.cjs',
  'a.json',
  'a.md',
  'a.mdx',
  'a.css',
  'a.scss',
  'a.html',
  'a.xml',
  'a.svg',
  'a.sh',
  'a.bash',
  'a.zsh',
  'a.fish',
  'a.py',
  'a.rb',
  'a.go',
  'a.rs',
  'a.java',
  'a.kt',
  'a.c',
  'a.h',
  'a.cpp',
  'a.cc',
  'a.hpp',
  'a.cs',
  'a.php',
  'a.yml',
  'a.yaml',
  'a.toml',
  'a.ini',
  'a.sql',
  'a.lua',
  'a.nix',
  'Dockerfile',
  'a.swift',
  'a.scala',
  'a.pl',
  'a.r',
  'a.diff',
  'a.patch',
];

describe('highlight registry', () => {
  test('covers every language langFromPath can return', () => {
    const missing: string[] = [];
    for (const file of FILES) {
      const lang = langFromPath(file);
      expect(lang, `${file} should map to a language`).toBeTruthy();
      if (!isKnownLanguage(lang)) missing.push(`${file} → ${lang}`);
    }
    expect(missing).toEqual([]);
  });

  test('highlights a known language', () => {
    const html = highlightToHtml('const x: number = 1;', 'typescript');
    expect(html).toContain('hljs-');
  });

  test('resolves the aliases markdown fences use', () => {
    for (const alias of ['ts', 'js', 'sh', 'yml', 'py', 'rb', 'html', 'shell', 'toml', 'patch']) {
      expect(highlightToHtml('x = 1', alias), `alias ${alias}`).not.toBeNull();
    }
  });

  test('returns null for an unknown language (caller escapes)', () => {
    expect(highlightToHtml('whatever', 'brainfuck')).toBeNull();
    expect(highlightToHtml('whatever', undefined)).toBeNull();
  });

  test('refuses to tokenize a huge blob', () => {
    expect(highlightToHtml('x'.repeat(60_001), 'javascript')).toBeNull();
  });

  test('never emits unescaped angle brackets from source text', () => {
    const html = highlightToHtml('const a = "<script>alert(1)</script>";', 'javascript') ?? '';
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('escapeHtml escapes the three that matter', () => {
    expect(escapeHtml('<a & b>')).toBe('&lt;a &amp; b&gt;');
  });

  test('reads the fence language off react-markdown class names', () => {
    expect(fenceLanguage('language-ts')).toBe('ts');
    expect(fenceLanguage('foo language-c++ bar')).toBe('c++');
    // The `language-` prefix must be its own class, not a substring of one:
    // `no-language-here` is a class name, not a fence declaring "here".
    expect(fenceLanguage('no-language-here')).toBeUndefined();
    expect(fenceLanguage(undefined)).toBeUndefined();
    expect(fenceLanguage('inline-code')).toBeUndefined();
  });
});
