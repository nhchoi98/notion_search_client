const formatHitsAsMarkdown = (payload, heading = '검색 결과') => {
  const source = payload?.hits;
  if (!Array.isArray(source) || source.length === 0) {
    return null;
  }

  const groups = new Map();
  for (const item of source) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const path = String(item.path || 'unknown');
    if (!groups.has(path)) {
      groups.set(path, []);
    }

    const line = typeof item.line === 'number' && Number.isFinite(item.line) ? item.line : null;
    const snippet = typeof item.snippet === 'string' ? item.snippet.trim() : '';
    const entry = { line, snippet };
    groups.get(path).push(entry);
  }

  const lines = [`## ${heading}`, `총 ${source.length}개 항목을 찾았습니다.`, ''];
  for (const [path, hits] of groups.entries()) {
    lines.push(`### ${path}`);
    for (const hit of hits) {
      const lineLabel = hit.line ? ` (line ${hit.line})` : '';
      const snippet = hit.snippet ? ` - ${hit.snippet}` : '';
      lines.push(`- ${path}${lineLabel}${snippet}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
};

const formatStructuredToolResult = (structuredPayload) => {
  if (!structuredPayload || typeof structuredPayload !== 'object') {
    return null;
  }

  if (typeof structuredPayload.summary === 'string') {
    const outputPath = structuredPayload.output_path || structuredPayload.path || structuredPayload.outputPath;
    const header = outputPath ? `## 실행 결과\n- output_path: ${outputPath}` : '## 실행 결과';
    return `${header}\n\n${structuredPayload.summary.trim()}`;
  }

  if (structuredPayload.ok === true) {
    const outputPath = structuredPayload.output_path || structuredPayload.path || structuredPayload.outputPath;
    if (outputPath || structuredPayload.summary) {
      const header = outputPath ? `## 실행 결과\n- output_path: ${outputPath}` : '## 실행 결과';
      if (typeof structuredPayload.summary === 'string' && structuredPayload.summary.trim()) {
        return `${header}\n\n${structuredPayload.summary.trim()}`;
      }
      return `${header}\n`;
    }
  }

  if (Array.isArray(structuredPayload.results)) {
    const source = structuredPayload.results;
    const grouped = new Map();
    for (const item of source) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const path = String(item.path || item.file || 'unknown');
      if (!grouped.has(path)) {
        grouped.set(path, []);
      }
      grouped.get(path).push(item);
    }

    const lines = ['## 실행 결과'];
    for (const [path, items] of grouped.entries()) {
      lines.push(`### ${path}`);
      for (const item of items) {
        const title = item.title ? `- ${item.title}` : '- 항목';
        const lineInfo = item.line ? ` (line ${item.line})` : '';
        const snippet = item.snippet ? `\n  - ${item.snippet}` : '';
        lines.push(`${title}${lineInfo}${snippet}`);
      }
      lines.push('');
    }
    return lines.join('\n').trim();
  }

  if (Array.isArray(structuredPayload.docs)) {
    if (structuredPayload.docs.length === 0) {
      return '## 실행 결과\n- 검색 가능한 .md/.txt 문서를 찾지 못했습니다.';
    }

    const lines = ['## 문서 목록', `총 ${structuredPayload.docs.length}개 문서를 찾았습니다.`, ''];
    for (const doc of structuredPayload.docs) {
      if (typeof doc === 'string' && doc.trim()) {
        lines.push(`- ${doc.trim()}`);
        continue;
      }

      if (doc && typeof doc === 'object') {
        const path = typeof doc.path === 'string' ? doc.path : typeof doc.file === 'string' ? doc.file : '';
        if (path) {
          lines.push(`- ${path}`);
        }
      }
    }

    return lines.join('\n').trim();
  }

  if (Array.isArray(structuredPayload.hits)) {
    return formatHitsAsMarkdown(structuredPayload, '검색 결과');
  }

  return null;
};

export const summarizeStructuredForDisplay = (structuredPayload, toolName) => {
  const formatted = formatStructuredToolResult(structuredPayload);
  if (formatted) {
    return formatted;
  }

  const body =
    Object.keys(structuredPayload || {}).length > 0
      ? `\n\n\`\`\`json\n${JSON.stringify(structuredPayload, null, 2)}\n\`\`\``
      : '';
  return `## 실행 결과\n- 도구: ${toolName || 'unknown'}${body}`;
};

export const formatContentArrayAsMarkdown = (contentArrayPayload) => {
  if (!Array.isArray(contentArrayPayload) || contentArrayPayload.length === 0) {
    return null;
  }

  const lines = [];
  for (const item of contentArrayPayload) {
    if (item && typeof item.text === 'string' && item.text.trim()) {
      lines.push(`- ${item.text.trim()}`);
    }
  }

  if (lines.length === 0) {
    return null;
  }

  return ['## MCP 응답', ...lines].join('\n');
};
