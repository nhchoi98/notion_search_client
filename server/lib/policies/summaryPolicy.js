/**
 * Summary 관련 정책 모듈.
 * - 요약 의도 판별
 * - 요약 도구 선택 우선순위
 */
export const hasSummaryIntent = (prompt) => {
  return typeof prompt === 'string'
    ? /(요약|정리|요약해|정리해|summary|summar)/i.test(prompt)
    : false;
};

export const findSummaryTool = (tools = []) => {
  const candidates = ['rebuild_summary', 'summary', 'summarize', 'rebuild'];
  for (const name of candidates) {
    const direct = tools.find((tool) => tool?.name === name);
    if (direct) {
      return direct;
    }
  }

  return (
    tools.find((tool) => {
      const toolName = String(tool?.name || '').toLowerCase();
      return candidates.some((name) => toolName.includes(name));
    }) || null
  );
};

