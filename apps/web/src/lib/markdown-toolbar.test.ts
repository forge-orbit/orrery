import { describe, expect, it } from "vitest";
import {
  continueListOnEnter,
  insertCode,
  insertCodeBlock,
  insertLink,
  insertTable,
  pasteUrlOverSelection,
  prefixLines,
  quoteReply,
  wrapSelection,
} from "./markdown-toolbar.ts";

describe("markdown-toolbar helpers", () => {
  it("wraps selected text and inserts placeholder when collapsed", () => {
    expect(wrapSelection("hello world", 6, 11, "**", "**", "bold text")).toEqual({
      value: "hello **world**",
      selectionStart: 8,
      selectionEnd: 13,
    });
    expect(wrapSelection("hello ", 6, 6, "**", "**", "bold text")).toEqual({
      value: "hello **bold text**",
      selectionStart: 8,
      selectionEnd: 17,
    });
  });

  it("uses inline backticks for single-line code and fenced blocks for multi-line", () => {
    expect(insertCode("run foo now", 4, 7)).toEqual({
      value: "run `foo` now",
      selectionStart: 5,
      selectionEnd: 8,
    });
    expect(insertCode("a\nb", 0, 3)).toEqual({
      value: "```\na\nb\n```",
      selectionStart: 4,
      selectionEnd: 7,
    });
    expect(insertCodeBlock("hello", 5, 5)).toEqual({
      value: "hello\n```\ncode\n```",
      selectionStart: 10,
      selectionEnd: 14,
    });
  });

  it("formats links from either label text or a selected URL", () => {
    expect(insertLink("see docs", 4, 8)).toEqual({
      value: "see [docs](https://)",
      selectionStart: 11,
      selectionEnd: 19,
    });
    expect(insertLink("https://example.com", 0, 19)).toEqual({
      value: "[link text](https://example.com)",
      selectionStart: 1,
      selectionEnd: 10,
    });
  });

  it("inserts a GFM table template", () => {
    const result = insertTable("", 0, 0);
    expect(result.value).toBe("| Column 1 | Column 2 |\n| --- | --- |\n| Cell | Cell |");
    expect(result.value.slice(result.selectionStart, result.selectionEnd)).toBe("Column 1");
  });

  it("prefixes every line in the selection for lists and quotes", () => {
    expect(prefixLines("one\ntwo\nthree", 0, 7, "- ")).toEqual({
      value: "- one\n- two\nthree",
      selectionStart: 2,
      selectionEnd: 11,
    });
    expect(prefixLines("first\nsecond", 0, 12, (i) => `${i + 1}. `)).toEqual({
      value: "1. first\n2. second",
      selectionStart: 3,
      selectionEnd: 18,
    });
  });

  it("turns a pasted URL over selected text into a Markdown link", () => {
    expect(pasteUrlOverSelection("read the docs now", 5, 13, "https://orrery.dev")).toEqual({
      value: "read [the docs](https://orrery.dev) now",
      selectionStart: 35,
      selectionEnd: 35,
    });
    expect(pasteUrlOverSelection("read the docs", 5, 5, "https://orrery.dev")).toBeNull();
    expect(pasteUrlOverSelection("read the docs", 5, 13, "not a url")).toBeNull();
  });

  it("continues bullet, numbered, and task lists on Enter and exits empty markers", () => {
    expect(continueListOnEnter("- item one", 10, 10)).toEqual({
      value: "- item one\n- ",
      selectionStart: 13,
      selectionEnd: 13,
    });
    expect(continueListOnEnter("1. first", 8, 8)).toEqual({
      value: "1. first\n2. ",
      selectionStart: 12,
      selectionEnd: 12,
    });
    expect(continueListOnEnter("- [x] done", 10, 10)).toEqual({
      value: "- [x] done\n- [ ] ",
      selectionStart: 17,
      selectionEnd: 17,
    });
    expect(continueListOnEnter("- ", 2, 2)).toEqual({
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
    });
  });
});

describe("quoteReply", () => {
  it("prefixes every line of a comment with a Markdown blockquote marker", () => {
    expect(quoteReply("One line.")).toBe("> One line.\n\n");
    expect(quoteReply("First line.\nSecond line.\n")).toBe("> First line.\n> Second line.\n> \n\n");
  });

  it("appends a quoted comment after an existing draft with separating whitespace", () => {
    expect(quoteReply("Quoted.", "My reply")).toBe("My reply\n\n> Quoted.\n\n");
    expect(quoteReply("Quoted.", "My reply\n")).toBe("My reply\n\n> Quoted.\n\n");
  });
});
