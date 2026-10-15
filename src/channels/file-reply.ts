/** Explicit file directives and standalone local Markdown links, outside fences. */
export function fileReply(answer: string): { text: string; paths: string[] } {
  const paths: string[] = [];
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of answer.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      lines.push(line);
      continue;
    }
    const directive =
      fence === null
        ? /^<file>([^\r\n]+)<\/file>\s*$/.exec(line)?.[1]
        : undefined;
    const link =
      fence === null
        ? /^!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))\)\s*$/.exec(line)
        : null;
    const path = directive?.trim() ?? link?.[1] ?? link?.[2];
    if (
      path !== undefined &&
      !/^[a-z]+:/i.test(path) &&
      !path.startsWith('//') &&
      paths.length < 10
    ) {
      if (!paths.includes(path)) paths.push(path);
    } else lines.push(line);
  }
  return { text: lines.join('\n').trim(), paths };
}
