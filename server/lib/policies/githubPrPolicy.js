/**
 * GitHub PR 워크플로우 정책 모듈.
 * - 의도 판별
 * - sync_status 결과 판독
 * - workflow.steps 스키마 생성
 */
export const hasGitHubPRIntent = (prompt) => {
  if (typeof prompt !== 'string') {
    return false;
  }
  return /(pr|pull request|깃허브|github|동기화|sync|커밋|푸시|배포)/i.test(prompt);
};

export const parseSyncStatusPayload = (response) => {
  const candidate =
    response && typeof response.result === 'object' && !Array.isArray(response.result)
      ? response.result
      : null;
  if (candidate) {
    return candidate;
  }

  if (typeof response?.answer === 'string') {
    try {
      const parsed = JSON.parse(response.answer);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // noop
    }
  }

  return null;
};

export const evaluateGitHubPRReadiness = (syncResponse) => {
  const payload = parseSyncStatusPayload(syncResponse);
  if (!payload) {
    return {
      canProceed: false,
      reason: 'sync_status 결과 구조를 파싱하지 못했습니다.',
      payload: null,
    };
  }

  const isClean = payload.is_clean === true;
  const readyForPr = payload.ready_for_pr === true;

  if (!isClean || !readyForPr) {
    return {
      canProceed: false,
      reason:
        'PR 생성 전 작업공간 상태를 충족하지 못했습니다. staged/unstaged/untracked/ready_for_pr 상태를 확인해 주세요.',
      payload,
    };
  }

  return {
    canProceed: true,
    reason: '',
    payload,
  };
};

export const buildGitHubPRWorkflowSteps = ({
  syncStatusToolName,
  pullToolName,
  createPRToolName,
  createPRToolArguments,
}) => {
  const steps = [];
  if (pullToolName) {
    steps.push({
      id: 'pull_if_needed',
      tool: pullToolName,
      toolArguments: {},
      when: {
        type: 'sync_field_equals',
        field: 'ready_for_pull',
        equals: true,
      },
    });
    steps.push({
      id: 'sync_refresh_after_pull',
      tool: syncStatusToolName,
      toolArguments: {},
      when: {
        type: 'step_executed',
        stepId: 'pull_if_needed',
      },
    });
  }

  steps.push({
    id: 'create_pr_if_ready',
    tool: createPRToolName,
    toolArguments: createPRToolArguments || {},
    when: {
      type: 'sync_field_equals',
      field: 'ready_for_pr',
      equals: true,
    },
  });

  return {
    type: 'github_pr',
    schema: 'workflow.steps.v1',
    mode: 'sequential',
    steps,
  };
};

