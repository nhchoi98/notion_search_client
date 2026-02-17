/**
 * A2A 기반 오케스트레이션 런타임.
 * - Plan Agent: 실행 계획 수립
 * - MCP/Chat Agent: 실행 전담
 * - Output Agent: 스트림 출력 전담
 *
 * 모든 세부 의존성은 팩토리 인자로 주입받아 index.js 라우터를 얇게 유지한다.
 */
export const createOrchestrationRuntime = ({
  localMcpEndpoint,
  buildRouteDecisionPrompt,
  chatOnlyPrompt,
  callOpenAI,
  callLocalMCP,
  resolveConversation,
  proxyResponse,
  planExecutionFromManifest,
  shouldRetryForPathIssue,
  buildRetryExecutionPlan,
  evaluateGitHubPRReadiness,
  parseRoutePlan,
  streamText,
  writeSSE,
}) => {
  const A2A_PROTOCOL_VERSION = 'a2a.v1';

  const AGENT_IDS = {
    orchestrator: 'orchestrator',
    plan: 'plan-agent',
    mcp: 'mcp-agent',
    summary: 'summary-agent',
    writer: 'writer-agent',
    evaluator: 'evaluator-agent',
    output: 'output-agent',
    chat: 'chat-agent',
  };

  const WRITER_PERSONA_PROMPT =
    '너는 최종 응답 작성 에이전트다. 정확하고 간결하게 핵심만 전달한다. 내부 도구명, 디버그 로그, 경로/인자 원문은 숨기고 사용자 관점으로 작성한다.';
  const EVALUATOR_PERSONA_PROMPT =
    '너는 응답 품질 평가 에이전트다. 정확성, 요구 충족, 명확성, 불필요한 내부정보 노출 여부를 평가하고 JSON으로 반환한다.';

  const createA2AMessage = ({ from, to, type, requestId, payload = {} }) => ({
    protocol: A2A_PROTOCOL_VERSION,
    requestId,
    from,
    to,
    type,
    timestamp: Date.now(),
    payload,
  });

  const createRequestId = () => `req_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;

  const normalizePathCandidate = (value) => {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed;
  };

  const collectMdPathsFromValue = (value, acc) => {
    if (!value) {
      return;
    }
    if (typeof value === 'string') {
      const normalized = normalizePathCandidate(value);
      if (normalized && /\.md$/i.test(normalized)) {
        acc.push(normalized);
      }
      const matches = value.match(/[^\s"'`]+\.md\b/gi) || [];
      for (const item of matches) {
        const matched = normalizePathCandidate(item);
        if (matched) {
          acc.push(matched);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        collectMdPathsFromValue(item, acc);
      }
      return;
    }
    if (typeof value === 'object') {
      for (const child of Object.values(value)) {
        collectMdPathsFromValue(child, acc);
      }
    }
  };

  const extractMdPathsFromResponse = (response) => {
    const acc = [];
    collectMdPathsFromValue(response?.result, acc);
    collectMdPathsFromValue(response?.answer, acc);
    return [...new Set(acc)];
  };

  const buildListDocsArguments = (toolSpec, candidatePaths = []) => {
    const args = {};
    const props = toolSpec?.inputSchema?.properties || {};
    const required = Array.isArray(toolSpec?.inputSchema?.required) ? toolSpec.inputSchema.required : [];
    const keys = Object.keys(props);
    const normalizedCandidates = Array.isArray(candidatePaths)
      ? [...new Set(candidatePaths.map((item) => String(item || '').trim()).filter(Boolean))]
      : [];

    if (keys.includes('paths') || required.includes('paths')) {
      if (normalizedCandidates.length > 0) {
        args.paths = normalizedCandidates;
      }
    }
    if (keys.includes('extensions')) {
      args.extensions = ['.md'];
    }
    if (keys.includes('extension')) {
      args.extension = '.md';
    }
    if (keys.includes('glob')) {
      args.glob = '**/*.md';
    }
    if (keys.includes('pattern')) {
      args.pattern = '*.md';
    }

    return args;
  };

  const shouldRunWorkflowStep = (when, context) => {
    if (!when || typeof when !== 'object') {
      return { run: true, reason: '' };
    }

    if (when.type === 'sync_field_equals') {
      const field = typeof when.field === 'string' ? when.field : '';
      const expected = when.equals;
      const actual = field ? context.syncPayload?.[field] : undefined;
      if (actual === expected) {
        return { run: true, reason: '' };
      }
      return {
        run: false,
        reason: `조건 불일치: sync_status.${field} === ${JSON.stringify(expected)} 필요`,
      };
    }

    if (when.type === 'step_executed') {
      const stepId = typeof when.stepId === 'string' ? when.stepId : '';
      const executed = stepId ? context.stepResults.get(stepId)?.executed === true : false;
      if (executed) {
        return { run: true, reason: '' };
      }
      return {
        run: false,
        reason: `선행 step 미실행: ${stepId}`,
      };
    }

    return { run: true, reason: '' };
  };

  /**
   * workflow.steps.v1 실행기
   * - 순차 step 실행
   * - when 조건 평가
   * - 각 step 결과를 컨텍스트(stepResults/syncPayload)에 누적
   */
  const runWorkflowSteps = async ({
    workflow,
    initialResponse,
    execute,
    requestId,
    routedPrompt,
    localEndpoint,
    conversation,
    explanation,
    emit,
  }) => {
    const workflowState = {
      type: workflow?.type || 'workflow',
      schema: workflow?.schema || null,
      proceeded: false,
      reason: '',
      steps: [],
    };

    if (!workflow || !Array.isArray(workflow.steps) || workflow.steps.length === 0) {
      return { response: initialResponse, workflowState };
    }

    let activeResponse = initialResponse;
    let readiness = evaluateGitHubPRReadiness(activeResponse);
    let syncPayload = readiness?.payload || null;
    const stepResults = new Map();

    for (const step of workflow.steps) {
      const stepId = typeof step?.id === 'string' ? step.id : `step_${workflowState.steps.length + 1}`;
      const tool = typeof step?.tool === 'string' ? step.tool : '';
      const decision = shouldRunWorkflowStep(step?.when, { syncPayload, stepResults });

      if (!tool) {
        workflowState.steps.push({
          id: stepId,
          tool: null,
          executed: false,
          skipped: true,
          reason: '도구명이 비어 있음',
        });
        continue;
      }

      if (!decision.run) {
        workflowState.steps.push({
          id: stepId,
          tool,
          executed: false,
          skipped: true,
          reason: decision.reason,
        });
        continue;
      }

      emit?.(
        'a2a',
        createA2AMessage({
          from: AGENT_IDS.orchestrator,
          to: AGENT_IDS.plan,
          type: 'plan.workflow_continue',
          requestId,
          payload: {
            workflow: workflow.type || 'workflow',
            step: stepId,
            tool,
          },
        }),
      );

      const stepPlan = {
        tool,
        toolArguments:
          step?.toolArguments && typeof step.toolArguments === 'object' && !Array.isArray(step.toolArguments)
            ? step.toolArguments
            : {},
        routedQuery: routedPrompt,
        explanation: `workflow_step:${stepId}`,
      };

      activeResponse = await execute({
        requestId,
        prompt: routedPrompt,
        localEndpoint,
        conversation,
        explanation,
        executionPlan: stepPlan,
        emit,
      });

      const status = activeResponse?.mcpStatus || 200;
      stepResults.set(stepId, { executed: true, status, response: activeResponse });
      workflowState.steps.push({
        id: stepId,
        tool,
        executed: true,
        skipped: false,
        status,
      });

      const evaluated = evaluateGitHubPRReadiness(activeResponse);
      if (evaluated?.payload) {
        syncPayload = evaluated.payload;
      }
      readiness = evaluated;
    }

    // github_pr 워크플로우에서는 create_pr step이 실행되지 않았으면 보완 필요 상태로 반환.
    if (workflow.type === 'github_pr') {
      const createStep = workflow.steps.find(
        (step) => typeof step?.id === 'string' && step.id.toLowerCase().includes('create_pr'),
      );
      const created = createStep ? stepResults.get(createStep.id)?.executed === true : false;
      workflowState.proceeded = created;
      if (!created) {
        const reason = readiness?.reason || 'PR 생성 조건을 충족하지 못해 create_pr를 실행하지 않았습니다.';
        workflowState.reason = reason;
        activeResponse = {
          ...activeResponse,
          answer: `${reason}\n\n${activeResponse?.answer || ''}`.trim(),
          requiresInput: true,
          missing: 'workspace_state',
        };
      }
    } else {
      workflowState.proceeded = true;
    }

    return {
      response: activeResponse,
      workflowState,
    };
  };

  const runPlanAgent = async ({ prompt, localEndpoint, emit }) => {
    const requestId = createRequestId();
    emit?.(
      'a2a',
      createA2AMessage({
        from: AGENT_IDS.orchestrator,
        to: AGENT_IDS.plan,
        type: 'plan.request',
        requestId,
        payload: { prompt },
      }),
    );

    const planning = await callOpenAI({
      responseFormat: 'json',
      messages: [
        { role: 'system', content: buildRouteDecisionPrompt() },
        { role: 'user', content: `사용자 요청: ${prompt}` },
      ],
    });

    const plan = parseRoutePlan(planning) || {
      route: 'local_mcp',
      query: prompt,
      explanation: '',
    };
    const executionAgent = plan.route === 'local_mcp' ? AGENT_IDS.mcp : AGENT_IDS.chat;
    let executionPlan = null;
    let manifestContext = null;
    if (plan.route === 'local_mcp') {
      const manifestPlanning = await planExecutionFromManifest({
        prompt,
        routedQuery: plan.query || prompt,
        localEndpoint,
      });
      executionPlan = manifestPlanning.executionPlan;
      manifestContext = manifestPlanning.context;
    }

    emit?.(
      'a2a',
      createA2AMessage({
        from: AGENT_IDS.plan,
        to: AGENT_IDS.orchestrator,
        type: 'plan.response',
        requestId,
        payload: {
          ...plan,
          executionAgent,
          hasExecutionPlan: !!executionPlan,
          workflow: executionPlan?.workflow?.type || null,
          manifestOk: manifestContext?.ok === true,
          manifestStatus: manifestContext?.manifestAttempt?.status || manifestContext?.status || 0,
        },
      }),
    );

    return {
      requestId,
      plan,
      executionAgent,
      executionPlan,
      manifestContext,
    };
  };

  const runMCPAgent = async ({
    requestId,
    prompt,
    localEndpoint,
    conversation,
    explanation,
    executionPlan,
    emit,
  }) => {
    emit?.(
      'a2a',
      createA2AMessage({
        from: AGENT_IDS.orchestrator,
        to: AGENT_IDS.mcp,
        type: 'execution.request',
        requestId,
        payload: {
          prompt,
          localEndpoint: localEndpoint || localMcpEndpoint,
          tool: executionPlan?.tool || null,
        },
      }),
    );

    const localResult = await callLocalMCP({
      prompt,
      localEndpoint,
      conversation: resolveConversation(conversation),
      useLLMPlanner: false,
      preplannedToolPlan: executionPlan,
      eventEmitter: (type, payload) => {
        emit?.(
          'a2a',
          createA2AMessage({
            from: AGENT_IDS.mcp,
            to: AGENT_IDS.orchestrator,
            type: 'execution.progress',
            requestId,
            payload: { type, ...payload },
          }),
        );
      },
    });

    const response = proxyResponse(localResult, {
      route: 'local_mcp',
      routedQuery: prompt,
      explanation,
    });

    emit?.(
      'a2a',
      createA2AMessage({
        from: AGENT_IDS.mcp,
        to: AGENT_IDS.orchestrator,
        type: 'execution.response',
        requestId,
        payload: {
          status: response.mcpStatus || 200,
          tool: response.tool || null,
        },
      }),
    );

    return response;
  };

  const runChatAgent = async ({ requestId, prompt, explanation, emit }) => {
    emit?.(
      'a2a',
      createA2AMessage({
        from: AGENT_IDS.orchestrator,
        to: AGENT_IDS.chat,
        type: 'execution.request',
        requestId,
        payload: { prompt },
      }),
    );

    const answer = await callOpenAI({
      responseFormat: 'text',
      messages: [
        { role: 'system', content: chatOnlyPrompt },
        { role: 'user', content: prompt },
      ],
    });

    const response = {
      action: 'chat-only',
      answer,
      route: 'chat_only',
      routedQuery: prompt,
      explanation,
      mcpStatus: 200,
    };

    emit?.(
      'a2a',
      createA2AMessage({
        from: AGENT_IDS.chat,
        to: AGENT_IDS.orchestrator,
        type: 'execution.response',
        requestId,
        payload: { status: 200 },
      }),
    );

    return response;
  };

  const shouldHandoffToSummaryAgent = (response, executionAgent) => {
    if (executionAgent !== AGENT_IDS.mcp) {
      return false;
    }
    if (!response || typeof response !== 'object') {
      return false;
    }
    if (response.requiresInput) {
      return false;
    }
    if ((response.mcpStatus || 200) >= 400) {
      return false;
    }

    const toolName = String(response.tool || '').toLowerCase();
    if (!toolName) {
      return false;
    }

    return ['list_docs', 'search', 'query', 'find', 'lookup'].some((keyword) =>
      toolName.includes(keyword),
    );
  };

  const runSummaryAgent = async ({ requestId, prompt, mcpResponse, emit }) => {
    emit?.(
      'a2a',
      createA2AMessage({
        from: AGENT_IDS.orchestrator,
        to: AGENT_IDS.summary,
        type: 'summary.request',
        requestId,
        payload: {
          tool: mcpResponse?.tool || null,
        },
      }),
    );

    const rawResult =
      mcpResponse?.result && typeof mcpResponse.result === 'object'
        ? JSON.stringify(mcpResponse.result, null, 2)
        : String(mcpResponse?.answer || '');

    const summarized = await callOpenAI({
      responseFormat: 'text',
      messages: [
        {
          role: 'system',
          content:
            '너는 결과 요약 에이전트다. 중간 도구 결과를 사용자 최종 응답으로 요약한다. 경로/도구 내부 로그는 숨기고, 핵심만 간결하게 한국어로 정리한다.',
        },
        {
          role: 'user',
          content: `사용자 요청:\n${prompt}\n\nMCP 중간 결과:\n${rawResult}`,
        },
      ],
    });

    emit?.(
      'a2a',
      createA2AMessage({
        from: AGENT_IDS.summary,
        to: AGENT_IDS.orchestrator,
        type: 'summary.response',
        requestId,
        payload: {
          summarized: true,
          tool: mcpResponse?.tool || null,
        },
      }),
    );

    return {
      ...mcpResponse,
      answer: summarized || mcpResponse?.answer || '',
    };
  };

  const runWriterAgent = async ({ requestId, prompt, baseResponse, feedback, emit }) => {
    emit?.(
      'a2a',
      createA2AMessage({
        from: AGENT_IDS.orchestrator,
        to: AGENT_IDS.writer,
        type: 'writer.request',
        requestId,
        payload: { hasFeedback: !!feedback },
      }),
    );

    const drafted = await callOpenAI({
      responseFormat: 'text',
      messages: [
        { role: 'system', content: WRITER_PERSONA_PROMPT },
        {
          role: 'user',
          content: `사용자 요청:\n${prompt}\n\n초안:\n${baseResponse?.answer || ''}${
            feedback ? `\n\n수정 피드백:\n${feedback}` : ''
          }`,
        },
      ],
    });

    emit?.(
      'a2a',
      createA2AMessage({
        from: AGENT_IDS.writer,
        to: AGENT_IDS.orchestrator,
        type: 'writer.response',
        requestId,
        payload: { revised: true },
      }),
    );

    return {
      ...baseResponse,
      answer: drafted || baseResponse?.answer || '',
    };
  };

  const runEvaluatorAgent = async ({ requestId, prompt, candidateAnswer, emit }) => {
    emit?.(
      'a2a',
      createA2AMessage({
        from: AGENT_IDS.orchestrator,
        to: AGENT_IDS.evaluator,
        type: 'evaluator.request',
        requestId,
        payload: {},
      }),
    );

    const evaluatedText = await callOpenAI({
      responseFormat: 'json',
      messages: [
        { role: 'system', content: EVALUATOR_PERSONA_PROMPT },
        {
          role: 'user',
          content:
            `다음 응답을 평가하고 JSON만 반환:\n` +
            `{"pass": boolean, "score": number(0~100), "feedback": "개선점 한두 문장"}\n\n` +
            `요청:\n${prompt}\n\n응답:\n${candidateAnswer || ''}`,
        },
      ],
    });

    let parsed = { pass: true, score: 80, feedback: '' };
    try {
      const value = JSON.parse(evaluatedText);
      if (value && typeof value === 'object') {
        parsed = {
          pass: value.pass !== false,
          score: typeof value.score === 'number' ? value.score : 80,
          feedback: typeof value.feedback === 'string' ? value.feedback : '',
        };
      }
    } catch {
      // noop
    }

    emit?.(
      'a2a',
      createA2AMessage({
        from: AGENT_IDS.evaluator,
        to: AGENT_IDS.orchestrator,
        type: 'evaluator.response',
        requestId,
        payload: parsed,
      }),
    );

    return parsed;
  };

  const runWriterEvaluationPipeline = async ({ requestId, prompt, response, emit }) => {
    let drafted = await runWriterAgent({
      requestId,
      prompt,
      baseResponse: response,
      emit,
    });

    const firstEval = await runEvaluatorAgent({
      requestId,
      prompt,
      candidateAnswer: drafted?.answer || '',
      emit,
    });

    if (firstEval.pass) {
      return {
        response: drafted,
        evaluation: firstEval,
      };
    }

    drafted = await runWriterAgent({
      requestId,
      prompt,
      baseResponse: drafted,
      feedback: firstEval.feedback,
      emit,
    });

    const secondEval = await runEvaluatorAgent({
      requestId,
      prompt,
      candidateAnswer: drafted?.answer || '',
      emit,
    });

    return {
      response: drafted,
      evaluation: secondEval,
    };
  };

  const EXECUTION_AGENT_REGISTRY = {
    [AGENT_IDS.mcp]: runMCPAgent,
    [AGENT_IDS.chat]: runChatAgent,
  };

  const runOrchestration = async ({ prompt, localEndpoint, conversation, emit }) => {
    const { requestId, plan, executionAgent, executionPlan, manifestContext } = await runPlanAgent({
      prompt,
      localEndpoint,
      emit,
    });
    const execute = EXECUTION_AGENT_REGISTRY[executionAgent] || runMCPAgent;
    const routedPrompt = plan.query || prompt;
    if (executionAgent === AGENT_IDS.mcp && !executionPlan) {
      return {
        requestId,
        executionAgent,
        plan,
        executionPlan: null,
        retried: false,
        manifestContext,
        response: {
          action: 'local-mcp',
          answer:
            'Plan Agent가 manifest/tools 정보를 기반으로 실행 계획을 만들지 못했습니다. 로컬 MCP manifest/tools/list 상태를 확인해 주세요.',
          route: 'local_mcp',
          routedQuery: routedPrompt,
          explanation: plan.explanation,
          requiresInput: true,
          missing: 'execution_plan',
          mcpStatus: 200,
        },
      };
    }

    let response = await execute({
      requestId,
      prompt: routedPrompt,
      localEndpoint,
      conversation,
      explanation: plan.explanation,
      executionPlan,
      emit,
    });
    let retried = false;
    let workflowState = null;

    // workflow.steps 스키마가 있으면 공통 실행기로 후속 step을 순차 실행한다.
    if (
      executionAgent === AGENT_IDS.mcp &&
      executionPlan?.workflow?.schema === 'workflow.steps.v1' &&
      Array.isArray(executionPlan.workflow.steps) &&
      executionPlan.workflow.steps.length > 0 &&
      (response?.mcpStatus || 200) < 400
    ) {
      const workflowResult = await runWorkflowSteps({
        workflow: executionPlan.workflow,
        initialResponse: response,
        execute,
        requestId,
        routedPrompt,
        localEndpoint,
        conversation,
        explanation: plan.explanation,
        emit,
      });
      response = workflowResult.response;
      workflowState = workflowResult.workflowState;
    }

    if (executionAgent === AGENT_IDS.mcp && shouldRetryForPathIssue(response)) {
      let retryPlan = null;
      let usedListDocsDiscovery = false;
      const listDocsTool =
        manifestContext?.tools?.find((tool) => String(tool?.name || '').toLowerCase() === 'list_docs') || null;

      // 경로 오류 시 1차 재시도 전략:
      // list_docs를 통해 실제 .md 파일 경로를 수집하고, 원래 요약 도구를 그 경로로 재실행한다.
      if (listDocsTool && executionPlan?.tool) {
        usedListDocsDiscovery = true;
        const seededPaths = Array.isArray(executionPlan?.toolArguments?.paths)
          ? executionPlan.toolArguments.paths
          : [];
        emit?.(
          'a2a',
          createA2AMessage({
            from: AGENT_IDS.orchestrator,
            to: AGENT_IDS.plan,
            type: 'plan.retry_discovery',
            requestId,
            payload: {
              reason: 'paths_not_found',
              discoveryTool: listDocsTool.name,
            },
          }),
        );

        const discoveryPlan = {
          tool: listDocsTool.name,
          toolArguments: buildListDocsArguments(listDocsTool, seededPaths),
          routedQuery: `${routedPrompt} (.md only)`,
          explanation: 'retry_discovery_md_files',
        };

        const discoveryResponse = await execute({
          requestId,
          prompt: routedPrompt,
          localEndpoint,
          conversation,
          explanation: plan.explanation,
          executionPlan: discoveryPlan,
          emit,
        });

        const discoveredMdPaths = extractMdPathsFromResponse(discoveryResponse);
        if (discoveredMdPaths.length > 0) {
          const nextArgs =
            executionPlan.toolArguments &&
            typeof executionPlan.toolArguments === 'object' &&
            !Array.isArray(executionPlan.toolArguments)
              ? { ...executionPlan.toolArguments }
              : {};
          nextArgs.paths = discoveredMdPaths;
          retryPlan = {
            ...executionPlan,
            toolArguments: nextArgs,
          };
        } else {
          response = {
            ...response,
            answer:
              '요약 가능한 .md/.txt 문서를 찾지 못했습니다. MCP 서버의 실제 workspace 경로에 저장소가 clone되어 있는지 확인하고, LOCAL_MCP_DEFAULT_PATHS를 해당 경로로 설정해 주세요.',
            requiresInput: true,
            missing: 'paths',
          };
        }
      }

      if (!retryPlan && !usedListDocsDiscovery) {
        retryPlan = buildRetryExecutionPlan(executionPlan);
      }
      if (retryPlan) {
        retried = true;
        emit?.(
          'a2a',
          createA2AMessage({
            from: AGENT_IDS.orchestrator,
            to: AGENT_IDS.plan,
            type: 'plan.retry',
            requestId,
            payload: {
              reason: 'paths_not_found',
              retryPaths: retryPlan?.toolArguments?.paths || [],
            },
          }),
        );

        response = await execute({
          requestId,
          prompt: routedPrompt,
          localEndpoint,
          conversation,
          explanation: plan.explanation,
          executionPlan: retryPlan,
          emit,
        });
      }
    }

    if (shouldHandoffToSummaryAgent(response, executionAgent)) {
      response = await runSummaryAgent({
        requestId,
        prompt: routedPrompt,
        mcpResponse: response,
        emit,
      });
    }

    // 모든 요청의 최종 응답은 writer/evaluator 검증 파이프라인을 통과시킨다.
    const written = await runWriterEvaluationPipeline({
      requestId,
      prompt: routedPrompt,
      response,
      emit,
    });
    response = {
      ...written.response,
      qualityCheck: written.evaluation,
    };

    return {
      requestId,
      executionAgent,
      plan,
      executionPlan,
      retried,
      workflowState,
      manifestContext,
      response,
    };
  };

  /**
   * Output Agent: 응답 텍스트 스트리밍 + final/done 이벤트를 책임진다.
   */
  const runOutputAgentStream = ({ res, response, requestId, emit }) => {
    emit?.(
      'a2a',
      createA2AMessage({
        from: AGENT_IDS.orchestrator,
        to: AGENT_IDS.output,
        type: 'output.request',
        requestId,
        payload: {
          mode: 'stream',
        },
      }),
    );

    streamText(res, String(response?.answer || ''));
    writeSSE(res, 'final', response);
    writeSSE(res, 'done', { ok: true });

    emit?.(
      'a2a',
      createA2AMessage({
        from: AGENT_IDS.output,
        to: AGENT_IDS.orchestrator,
        type: 'output.done',
        requestId,
        payload: {
          delivered: true,
        },
      }),
    );
  };

  return {
    A2A_PROTOCOL_VERSION,
    runOrchestration,
    runOutputAgentStream,
  };
};
