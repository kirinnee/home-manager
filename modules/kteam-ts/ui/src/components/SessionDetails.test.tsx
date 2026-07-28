import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionView } from '../types';
import { ApiError } from '../lib/api';
import {
  BottomSheet,
  CLAUDE_EFFORT_LEVELS,
  ClaudeEffortChoices,
  RuntimeEffortControls,
  RuntimeModelControls,
  RuntimeModelChoices,
  RuntimeReasoningChoices,
  RuntimeReasoningStep,
  SessionDetails,
  codexPickerFallbackNeeded,
  isEffortActionUnsupported,
  isRuntimeEndpointUnavailable,
  modelObservationChanged,
  observedModelPresentation,
} from './SessionDetails';
import { primeDetailsTab, resetDetailsTabMemory, type DetailsTab } from '../hooks/useDetailsTab';

function view(harness: SessionView['config']['harness'] = 'codex'): SessionView {
  return {
    config: {
      id: 'runtime-probe',
      name: 'Runtime Probe',
      binary: `${harness}-auto-probe`,
      harness,
      modelHint: 'configured-model',
      model: 'configured-model',
      mode: 'auto',
      cwd: '/tmp/probe',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
      turn: 1,
      harnessSessionId: 'harness',
      tmuxSession: 'kteam-runtime-probe',
      watcherSession: 'watcher',
      intervalSeconds: 2,
      stallSeconds: 300,
      timeoutSeconds: 3600,
      maxSnapshots: 8,
      systemPromptFile: '/tmp/system.md',
      originalPromptFile: '/tmp/prompt.md',
    },
    state: {
      id: 'runtime-probe',
      status: 'awaiting_user',
      turn: 1,
      observedModel: 'actual-runtime-model',
      observedReasoningEffort: 'high',
    },
    directory: '/tmp/session',
  };
}

describe('shared BottomSheet contract', () => {
  test('keeps the original modal, swipe, focus and keyboard-safe geometry in one shell', () => {
    const html = renderToStaticMarkup(
      <BottomSheet id="test-sheet" open onClose={() => undefined} ariaLabel="Test sheet" closeLabel="Close test sheet">
        <p>Sheet content</p>
      </BottomSheet>,
    );

    expect(html).toContain('data-bottom-sheet="test-sheet"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Test sheet"');
    expect(html.match(/aria-label="Close test sheet"/g)?.length).toBe(2);
    expect(html).toContain('data-sheet-swipe="supported"');
    expect(html).toContain('min-h-[44px]');
    expect(html).toContain('var(--app-h, 100dvh)');
  });

  test('shrink-to-fit callers stay content-sized: no height style without the height prop', () => {
    const html = renderToStaticMarkup(
      <BottomSheet id="fit-sheet" open onClose={() => undefined} ariaLabel="Fit sheet" closeLabel="Close fit sheet">
        <p>Short content</p>
      </BottomSheet>,
    );
    // `max-height:` also ends in "height:", so anchor on the separator.
    expect(html).not.toContain(';height:min(');
  });

  test('a fixed-height caller pins the panel and keeps the keyboard-safe ceiling', () => {
    const html = renderToStaticMarkup(
      <BottomSheet
        id="tall-sheet"
        open
        onClose={() => undefined}
        ariaLabel="Tall sheet"
        closeLabel="Close tall sheet"
        height="min(90dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))"
      >
        <p>Sheet content</p>
      </BottomSheet>,
    );
    expect(html).toContain('height:min(90dvh');
    // maxHeight still present: an open keyboard shrinks the sheet.
    expect(html).toContain('max-height:min(');
  });

  test('does not leave a focusable closed sheet in the initial DOM', () => {
    expect(
      renderToStaticMarkup(
        <BottomSheet id="test-sheet" open={false} onClose={() => undefined} closeLabel="Close test sheet">
          <p>Sheet content</p>
        </BottomSheet>,
      ),
    ).toBe('');
  });
});

describe('in-session runtime model controls', () => {
  test('treats only an unknown runtime route as a daemon-restart requirement', () => {
    expect(
      isRuntimeEndpointUnavailable(new ApiError(404, 'no route POST /v1/sessions/s1/runtime', 'unknown_route')),
    ).toBe(true);
    expect(isRuntimeEndpointUnavailable(new ApiError(404, 'unknown kteam session s1'))).toBe(false);
    expect(isRuntimeEndpointUnavailable(new ApiError(409, 'runtime controls require an idle prompt'))).toBe(false);
  });

  test('shows a catalog failure instead of leaving the choices loader visible', () => {
    const html = renderToStaticMarkup(
      <RuntimeModelChoices
        harness="claude"
        choices={null}
        error="model catalog failed"
        currentModel={undefined}
        submittingModel={undefined}
        disabled={false}
        onChoose={() => undefined}
      />,
    );

    expect(html).toContain('Account-aware model choices are unavailable: model catalog failed');
    expect(html).not.toContain('Loading account-aware model choices');
  });

  test('renders one shared 44px model list with observed-current and requested-row-only pending semantics', () => {
    const html = renderToStaticMarkup(
      <RuntimeModelChoices
        harness="codex"
        choices={[
          {
            value: 'gpt-5.6-sol',
            label: 'GPT-5.6 Sol',
            reasoningEfforts: [{ value: 'high' }],
          },
          {
            value: 'gpt-5.5',
            label: 'GPT-5.5',
            reasoningEfforts: [{ value: 'medium' }],
          },
        ]}
        error={null}
        currentModel="gpt-5.6-sol"
        submittingModel="gpt-5.5"
        disabled={false}
        onChoose={() => undefined}
      />,
    );
    const rows = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    const current = rows.find(row => row.includes('GPT-5.6 Sol'))!;
    const pending = rows.find(row => row.includes('GPT-5.5'))!;

    expect(current).toContain('Current');
    expect(current).toContain('aria-current="true"');
    expect(current).not.toContain('aria-busy="true"');
    expect(pending).toContain('aria-busy="true"');
    expect(pending).not.toContain('aria-current="true"');
    for (const row of rows) {
      expect(row).toContain('min-h-[44px]');
      expect(row).toContain('min-w-[44px]');
    }
  });

  test('keeps Codex reasoning in authoritative catalog order with current and pending rows distinguished', () => {
    const html = renderToStaticMarkup(
      <RuntimeReasoningChoices
        model={{
          value: 'gpt-5.6-sol',
          label: 'GPT-5.6 Sol',
          defaultReasoningEffort: 'medium',
          reasoningEfforts: [
            { value: 'low', description: 'Fast' },
            { value: 'medium', description: 'Balanced' },
            { value: 'ultra', description: 'Delegates' },
          ],
        }}
        currentEffort="medium"
        submittingEffort="ultra"
        disabled={false}
        onChoose={() => undefined}
      />,
    );
    const rows = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(rows.map(row => row.match(/font-semibold[^>]*>([^<]+)/)?.[1])).toEqual(['Low', 'Medium', 'Ultra']);
    const current = rows[1]!;
    const pending = rows[2]!;
    expect(current).toContain('Current');
    expect(current).toContain('aria-current="true"');
    expect(current).not.toContain('aria-busy="true"');
    expect(pending).toContain('aria-busy="true"');
    expect(pending).not.toContain('aria-current="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    for (const row of rows) {
      expect(row).toContain('min-h-[44px]');
      expect(row).toContain('min-w-[44px]');
    }
  });

  test('moves focus into the newly rendered reasoning step and keeps a 44px way back', () => {
    const html = renderToStaticMarkup(
      <RuntimeReasoningStep
        model={{ value: 'gpt-5.5', label: 'GPT-5.5', reasoningEfforts: [{ value: 'high' }] }}
        currentEffort="high"
        disabled={false}
        backDisabled={false}
        onBack={() => undefined}
        onChoose={() => undefined}
      />,
    );
    const back = (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [])[0]!;
    expect(back).toContain('autofocus=""');
    expect(back).toContain('min-h-[44px]');
    expect(back).toContain('min-w-[44px]');
  });

  test('keeps the manual picker fallback for legacy errors and successful catalogs missing the observed choice', () => {
    const loaded = {
      harness: 'codex' as const,
      source: 'codex-app-server' as const,
      choices: [{ value: 'gpt-5.5', label: 'GPT-5.5', reasoningEfforts: [{ value: 'high' }] }],
    };
    expect(codexPickerFallbackNeeded(null, new ApiError(404, 'unknown route', 'unknown_route'))).toBe(true);
    expect(codexPickerFallbackNeeded(loaded, null, undefined, true)).toBe(true);
    expect(codexPickerFallbackNeeded(loaded, null, loaded.choices[0], true)).toBe(false);
    expect(codexPickerFallbackNeeded(null, null, undefined, true)).toBe(false); // still loading
  });

  test('uses the harness-observed fact and calls stale data last observed rather than falling back to config', () => {
    expect(observedModelPresentation('actual-runtime-model')).toEqual({
      label: 'Model (observed)',
      value: 'actual-runtime-model',
    });
    expect(observedModelPresentation('actual-runtime-model', true)).toEqual({
      label: 'Last observed model',
      value: 'actual-runtime-model',
    });
    expect(observedModelPresentation(undefined)).toEqual({ label: 'Model (observed)', value: undefined });
  });

  test('clears stale model copy only for fresh model evidence, including a same-model confirmation', () => {
    const before = { model: 'claude-sonnet-5', observedAt: '2026-07-27T00:37:00.000Z' };

    expect(modelObservationChanged(before, before)).toBe(false);
    expect(
      modelObservationChanged(before, {
        model: 'claude-sonnet-5',
        observedAt: '2026-07-27T00:38:00.000Z',
      }),
    ).toBe(true);
    expect(
      modelObservationChanged(before, {
        model: 'claude-opus-5',
        observedAt: before.observedAt,
      }),
    ).toBe(true);
  });

  test('loads Codex’s session-scoped catalog instead of handing every choice to Terminal', () => {
    const html = renderToStaticMarkup(
      <RuntimeModelControls
        view={view('codex')}
        open
        canControl
        onModelSwitch={() => undefined}
        onOpenTerminal={() => true}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('Switch model in place');
    expect(html).toContain('Loading account-aware model choices');
    expect(html).toContain('min-h-[44px]');
    expect(html).not.toContain('Use native picker in Terminal');
    expect(html).not.toContain('autofocus');
  });

  test('leaves unsupported harnesses with explanatory copy and no dead control', () => {
    const unsupported = view('claude');
    (unsupported.config as { harness: string }).harness = 'unsupported';
    const html = renderToStaticMarkup(
      <RuntimeModelControls
        view={unsupported}
        open
        canControl
        onModelSwitch={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('not available for this harness');
    expect(html).not.toContain('<button');
  });

  test('keeps terminal sessions honest and refuses to render a model control', () => {
    const terminal = view('codex');
    terminal.state.status = 'completed';
    const html = renderToStaticMarkup(
      <RuntimeModelControls
        view={terminal}
        open
        canControl
        onModelSwitch={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('requires a running session');
    expect(html).not.toContain('<button');
  });

  test('explains the idle-prompt requirement before allowing a runtime command', () => {
    const busy = view('codex');
    busy.state.promptReady = false;
    const html = renderToStaticMarkup(
      <RuntimeModelControls view={busy} open canControl onModelSwitch={() => undefined} onClose={() => undefined} />,
    );

    expect(html).toContain('Wait for an idle prompt before switching model');
    expect(html).not.toContain('<button');
  });

  test('shows Codex’s reported reasoning as an observation, never as a Claude effort control', () => {
    const details = (harness: SessionView['config']['harness']) => {
      // The reasoning row lives on the Runtime tab; force it so the static
      // render (which cannot click a tab) exercises that panel.
      resetDetailsTabMemory();
      primeDetailsTab('runtime-probe', 'runtime');
      return renderToStaticMarkup(
        <SessionDetails
          id={`details-${harness}`}
          view={view(harness)}
          quota={null}
          liveStatus="open"
          open
          onClose={() => undefined}
          canControlRuntime
        />,
      );
    };

    expect(details('codex')).toContain('Last observed reasoning');
    expect(details('codex')).toContain('high');
    expect(details('claude')).not.toContain('Last observed reasoning');
  });
});

describe('reasoning effort controls', () => {
  function idle(harness: SessionView['config']['harness']): SessionView {
    const v = view(harness);
    v.state.promptReady = true;
    return v;
  }

  test('Claude gets four persistable 44px effort levels and no others', () => {
    const html = renderToStaticMarkup(
      <RuntimeEffortControls view={idle('claude')} canControl onClose={() => undefined} />,
    );
    expect(html).toContain('Reasoning effort');
    for (const level of CLAUDE_EFFORT_LEVELS) expect(html).toContain(`Set reasoning effort to ${level}`);
    // `auto`, `max` and `ultracode` are session-only or resets — never offered.
    expect(html).not.toContain('Set reasoning effort to auto');
    expect(html).not.toContain('ultracode');
    expect(html).toContain('min-h-[44px]');
    expect(html).toContain('saved as the default for new sessions');
  });

  test('Codex reasoning loads the active model’s advertised levels, never a fabricated /reasoning verb', () => {
    const html = renderToStaticMarkup(
      <RuntimeEffortControls view={idle('codex')} canControl onOpenTerminal={() => true} onClose={() => undefined} />,
    );
    expect(html).toContain('Loading account-aware reasoning choices');
    expect(html).not.toContain('Use native picker in Terminal');
    // No Claude-style level grid on a Codex session.
    expect(html).not.toContain('Set reasoning effort to low');
  });

  test('a terminal session refuses the effort control instead of showing a dead one', () => {
    const terminal = idle('claude');
    terminal.state.status = 'completed';
    const html = renderToStaticMarkup(<RuntimeEffortControls view={terminal} canControl onClose={() => undefined} />);
    expect(html).toContain('requires a running session');
    expect(html).not.toContain('<button');
  });

  test('a read-only origin explains why effort cannot be changed and shows no control', () => {
    const html = renderToStaticMarkup(
      <RuntimeEffortControls view={idle('claude')} canControl={false} onClose={() => undefined} />,
    );
    expect(html).toContain('read-only');
    expect(html).not.toContain('<button');
  });

  test('a busy pane blocks the effort command until an idle prompt', () => {
    const busy = view('claude'); // promptReady left unset ⇒ not ready
    const html = renderToStaticMarkup(<RuntimeEffortControls view={busy} canControl onClose={() => undefined} />);
    expect(html).toContain('Wait for an idle prompt before changing the reasoning level');
    expect(html).toContain('disabled=""');
  });

  test('ClaudeEffortChoices is a presentational grid the parent can disable', () => {
    const enabled = renderToStaticMarkup(<ClaudeEffortChoices disabled={false} onChoose={() => undefined} />);
    expect(enabled.match(/<button/g)?.length).toBe(CLAUDE_EFFORT_LEVELS.length);
    expect(enabled).not.toContain('disabled=""');

    const disabled = renderToStaticMarkup(<ClaudeEffortChoices disabled onChoose={() => undefined} />);
    expect(disabled.match(/disabled=""/g)?.length).toBe(CLAUDE_EFFORT_LEVELS.length);
  });

  test('an old daemon rejecting the effort verb reads as restart-required, not a red error', () => {
    expect(isEffortActionUnsupported(new ApiError(400, 'runtime action must be "model"'))).toBe(true);
    // A genuine 404 keeps the existing runtime-endpoint treatment; an unrelated
    // 400 stays an ordinary failure the reader should see verbatim.
    expect(isEffortActionUnsupported(new ApiError(404, 'unknown_route'))).toBe(false);
    expect(isEffortActionUnsupported(new ApiError(400, 'model is required'))).toBe(false);
  });

  test('the details Runtime tab gives Claude an effort control and Codex none of its own', () => {
    const details = (harness: SessionView['config']['harness']) => {
      resetDetailsTabMemory();
      primeDetailsTab('runtime-probe', 'runtime');
      const v = idle(harness);
      return renderToStaticMarkup(
        <SessionDetails
          id={`details-effort-${harness}`}
          view={v}
          quota={null}
          liveStatus="open"
          open
          onClose={() => undefined}
          canControlRuntime
        />,
      );
    };

    expect(details('claude')).toContain('Set Claude reasoning effort');
    // Codex tunes reasoning inside the model picker already on this tab, so it
    // must NOT grow a second, redundant effort control.
    expect(details('codex')).not.toContain('Set Claude reasoning effort');
  });
});

describe('details sheet tabs', () => {
  test('renders one tablist, four tabs, and only the selected panel', () => {
    resetDetailsTabMemory();
    const html = renderToStaticMarkup(
      <SessionDetails
        id="details-tabs"
        view={view('codex')}
        quota={null}
        liveStatus="open"
        open
        onClose={() => undefined}
        canControlRuntime
      />,
    );

    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)?.length).toBe(4);
    // Exactly one tabpanel is in the DOM; unselected panels never render.
    expect(html.match(/role="tabpanel"/g)?.length).toBe(1);
    // Default is Identity: its rows are present, Budget's are not.
    expect(html).toContain('Session id');
    expect(html).not.toContain('5-hour window');
    // The selected tab points at the rendered panel by id.
    expect(html).toContain('id="details-tabs-tab-identity"');
    expect(html).toContain('id="details-tabs-tabpanel-identity"');
    expect(html).toContain('aria-controls="details-tabs-tabpanel-identity"');
  });

  test('the tabbed sheet is FIXED-height so a tab switch cannot move the tab bar', () => {
    resetDetailsTabMemory();
    const render = (tab: DetailsTab) => {
      resetDetailsTabMemory();
      primeDetailsTab('runtime-probe', tab);
      return renderToStaticMarkup(
        <SessionDetails
          id="details-fixed"
          view={view('codex')}
          quota={null}
          liveStatus="open"
          open
          onClose={() => undefined}
          canControlRuntime
        />,
      );
    };
    const heightOf = (html: string) => html.match(/style="[^"]*height:min\(90dvh[^)]*\)[^"]*"/)?.[0];
    const identity = heightOf(render('identity'));
    // The pinned height renders, and it is byte-identical on every tab — the
    // sheet's box cannot depend on which panel is selected.
    expect(identity).toBeTruthy();
    for (const tab of ['runtime', 'progress', 'budget'] as const) expect(heightOf(render(tab))).toBe(identity);
  });

  test('two retained instances never collide on tab or panel ids', () => {
    resetDetailsTabMemory();
    const render = (id: string) =>
      renderToStaticMarkup(
        <SessionDetails
          id={id}
          view={view('codex')}
          quota={null}
          liveStatus="open"
          open
          onClose={() => undefined}
          canControlRuntime
        />,
      );
    const combined = render('paneA') + render('paneB');
    const ids = [...combined.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('pins the view switch and controls above the tablist so Stop needs no tab', () => {
    resetDetailsTabMemory();
    const html = renderToStaticMarkup(
      <SessionDetails
        id="details-pinned"
        view={view('codex')}
        quota={null}
        liveStatus="open"
        open
        onClose={() => undefined}
        canControlRuntime
        actions={<button type="button">Stop</button>}
        viewSwitcher={<div>view-switch</div>}
      />,
    );
    // Both pinned sections appear before the tablist in source order.
    expect(html.indexOf('view-switch')).toBeGreaterThan(-1);
    expect(html.indexOf('>Stop<')).toBeGreaterThan(-1);
    expect(html.indexOf('view-switch')).toBeLessThan(html.indexOf('role="tablist"'));
    expect(html.indexOf('>Stop<')).toBeLessThan(html.indexOf('role="tablist"'));
  });
});
