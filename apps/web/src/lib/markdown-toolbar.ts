export interface TextSelectionEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export function wrapSelection(
  value: string,
  start: number,
  end: number,
  prefix: string,
  suffix: string,
  placeholder: string,
): TextSelectionEdit {
  const selected = value.slice(start, end);
  const inner = selected.length > 0 ? selected : placeholder;
  const nextValue = `${value.slice(0, start)}${prefix}${inner}${suffix}${value.slice(end)}`;
  const nextStart = start + prefix.length;
  return {
    value: nextValue,
    selectionStart: nextStart,
    selectionEnd: nextStart + inner.length,
  };
}

export function insertCode(value: string, start: number, end: number): TextSelectionEdit {
  const selected = value.slice(start, end);
  if (selected.includes("\n")) {
    return insertCodeBlock(value, start, end);
  }
  return wrapSelection(value, start, end, "`", "`", "code");
}

export function insertCodeBlock(value: string, start: number, end: number): TextSelectionEdit {
  const before = start > 0 && value[start - 1] !== "\n" ? "\n" : "";
  const after = end < value.length && value[end] !== "\n" ? "\n" : "";
  const prefix = `${before}\`\`\`\n`;
  const suffix = `\n\`\`\`${after}`;
  return wrapSelection(value, start, end, prefix, suffix, "code");
}

export function insertLink(value: string, start: number, end: number): TextSelectionEdit {
  const selected = value.slice(start, end);
  if (/^https?:\/\/\S+$/i.test(selected)) {
    const label = "link text";
    const nextValue = `${value.slice(0, start)}[${label}](${selected})${value.slice(end)}`;
    return {
      value: nextValue,
      selectionStart: start + 1,
      selectionEnd: start + 1 + label.length,
    };
  }
  const label = selected.length > 0 ? selected : "link text";
  const url = "https://";
  const nextValue = `${value.slice(0, start)}[${label}](${url})${value.slice(end)}`;
  const urlStart = start + 1 + label.length + 2;
  return {
    value: nextValue,
    selectionStart: urlStart,
    selectionEnd: urlStart + url.length,
  };
}

export function insertTable(value: string, start: number, end: number): TextSelectionEdit {
  const before = start > 0 && value[start - 1] !== "\n" ? "\n\n" : "";
  const after = end < value.length && value[end] !== "\n" ? "\n\n" : "";
  const header = "Column 1";
  const table = `${before}| ${header} | Column 2 |\n| --- | --- |\n| Cell | Cell |${after}`;
  const nextValue = `${value.slice(0, start)}${table}${value.slice(end)}`;
  const headerStart = start + before.length + 2;
  return {
    value: nextValue,
    selectionStart: headerStart,
    selectionEnd: headerStart + header.length,
  };
}

export function insertMentionTrigger(value: string, start: number, end: number): TextSelectionEdit {
  const needsSpace = start > 0 && !/[\s(]/.test(value[start - 1] ?? "");
  const insert = needsSpace ? " #" : "#";
  const nextValue = `${value.slice(0, start)}${insert}${value.slice(end)}`;
  const cursor = start + insert.length;
  return {
    value: nextValue,
    selectionStart: cursor,
    selectionEnd: cursor,
  };
}

export function prefixLines(
  value: string,
  start: number,
  end: number,
  prefix: string | ((lineIndex: number) => string),
): TextSelectionEdit {
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const lineEndIndex = value.indexOf("\n", end);
  const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;

  const block = value.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const prefixed = lines
    .map((line, index) => `${typeof prefix === "function" ? prefix(index) : prefix}${line}`)
    .join("\n");

  const nextValue = `${value.slice(0, lineStart)}${prefixed}${value.slice(lineEnd)}`;
  const firstPrefixLen = (typeof prefix === "function" ? prefix(0) : prefix).length;
  const delta = prefixed.length - block.length;

  return {
    value: nextValue,
    selectionStart: start + firstPrefixLen,
    selectionEnd: end + delta,
  };
}

export function pasteUrlOverSelection(
  value: string,
  start: number,
  end: number,
  pastedText: string,
): TextSelectionEdit | null {
  if (start === end) return null;
  const url = pastedText.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  const selected = value.slice(start, end);
  if (/^https?:\/\/\S+$/i.test(selected.trim())) return null;
  const nextValue = `${value.slice(0, start)}[${selected}](${url})${value.slice(end)}`;
  const cursor = start + selected.length + url.length + 4;
  return {
    value: nextValue,
    selectionStart: cursor,
    selectionEnd: cursor,
  };
}

export function continueListOnEnter(
  value: string,
  start: number,
  end: number,
): TextSelectionEdit | null {
  if (start !== end) return null;
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const currentLine = value.slice(lineStart, start);

  const taskMatch = /^(\s*[-*+]\s+\[[ xX]\]\s+)(.*)$/.exec(currentLine);
  if (taskMatch !== null) {
    const [, prefix, rest] = taskMatch;
    if (prefix === undefined || rest === undefined) return null;
    if (rest.trim() === "") {
      const nextValue = `${value.slice(0, lineStart)}${value.slice(start)}`;
      return { value: nextValue, selectionStart: lineStart, selectionEnd: lineStart };
    }
    const nextPrefix = prefix.replace(/\[[xX]\]/, "[ ]");
    const insert = `\n${nextPrefix}`;
    const nextValue = `${value.slice(0, start)}${insert}${value.slice(end)}`;
    const cursor = start + insert.length;
    return { value: nextValue, selectionStart: cursor, selectionEnd: cursor };
  }

  const orderedMatch = /^(\s*)(\d+)\.\s+(.*)$/.exec(currentLine);
  if (orderedMatch !== null) {
    const [, indent, numStr, rest] = orderedMatch;
    if (indent === undefined || numStr === undefined || rest === undefined) return null;
    if (rest.trim() === "") {
      const nextValue = `${value.slice(0, lineStart)}${value.slice(start)}`;
      return { value: nextValue, selectionStart: lineStart, selectionEnd: lineStart };
    }
    const insert = `\n${indent}${Number(numStr) + 1}. `;
    const nextValue = `${value.slice(0, start)}${insert}${value.slice(end)}`;
    const cursor = start + insert.length;
    return { value: nextValue, selectionStart: cursor, selectionEnd: cursor };
  }

  const bulletMatch = /^(\s*[-*+]\s+)(.*)$/.exec(currentLine);
  if (bulletMatch !== null) {
    const [, prefix, rest] = bulletMatch;
    if (prefix === undefined || rest === undefined) return null;
    if (rest.trim() === "") {
      const nextValue = `${value.slice(0, lineStart)}${value.slice(start)}`;
      return { value: nextValue, selectionStart: lineStart, selectionEnd: lineStart };
    }
    const insert = `\n${prefix}`;
    const nextValue = `${value.slice(0, start)}${insert}${value.slice(end)}`;
    const cursor = start + insert.length;
    return { value: nextValue, selectionStart: cursor, selectionEnd: cursor };
  }

  return null;
}
