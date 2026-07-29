import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { startApiServer, type ApiServerOptions } from './api-server';

const MODULE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UI_ROOT = join(MODULE_ROOT, 'ui', 'src');
const DAEMON_ENTRY = join(MODULE_ROOT, 'src', 'daemon-entry.ts');
const SAMPLE = 'route-coverage';
const MAX_ABSTRACT_VALUES = 256;

interface RouteSource {
  file: string;
  line: number;
}

interface UiRoute {
  pattern: string;
  sources: RouteSource[];
}

interface NetworkBoundary {
  file: string;
  line: number;
  expression: string;
}

interface DynamicBoundaryAllowance {
  file: string;
  expression: RegExp;
  reason: string;
}

/**
 * These are transport adapters whose concrete URLs are supplied at their call
 * sites. Each daemon `/v1` call site is still extracted independently. Keep
 * this list exact: a newly dynamic fetch must fail loudly until it has a
 * specific explanation.
 */
const DYNAMIC_BOUNDARY_ALLOWLIST: DynamicBoundaryAllowance[] = [
  {
    file: 'ui/src/lib/stt/daemon-engine.ts',
    expression: /^fetch\(input, init\)$/,
    reason: 'defaultFetch is a transparent adapter; the STT constants passed to fetchImpl are checked separately',
  },
  {
    file: 'ui/src/lib/stt/local-engine.ts',
    expression: /^(?:fetchImpl\(|fetch\(input, init\)$)/,
    reason: 'the local ONNX engine fetches public model assets, deliberately outside the daemon /v1 surface',
  },
  {
    file: 'ui/src/components/WebTerminals.tsx',
    expression: /^new WebSocket\(dependencies\.streamUrl\(/,
    reason: 'the socket URL is dependency-injected for tests; webTerminalStreamUrl is extracted and checked directly',
  },
  {
    file: 'ui/src/components/RemoteBrowserPane.tsx',
    expression: /^new WebSocket\(streamUrl\(/,
    reason: 'the socket URL is dependency-injected for tests; remoteBrowserStreamUrl is extracted and checked directly',
  },
];

/** Deliberately unavailable daemon routes need an exact pattern and a reason. */
const UNMOUNTED_ROUTE_ALLOWLIST = new Map<string, string>();

function productionUiFiles(directory = UI_ROOT): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...productionUiFiles(path));
    else if (
      /\.(?:ts|tsx)$/.test(entry.name) &&
      !/\.test\.(?:ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    )
      files.push(path);
  }
  return files.sort();
}

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  return symbol;
}

function functionForSymbol(symbol: ts.Symbol): ts.FunctionLikeDeclaration | undefined {
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) return declaration;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isFunctionLike(declaration.initializer))
      return declaration.initializer;
    if (ts.isPropertyAssignment(declaration) && ts.isFunctionLike(declaration.initializer))
      return declaration.initializer;
  }
  return undefined;
}

function symbolForFunction(checker: ts.TypeChecker, node: ts.SignatureDeclaration): ts.Symbol | undefined {
  const name = 'name' in node ? node.name : undefined;
  if (name) return resolvedSymbol(checker, name);
  if (ts.isVariableDeclaration(node.parent)) return resolvedSymbol(checker, node.parent.name);
  if (ts.isPropertyAssignment(node.parent)) return resolvedSymbol(checker, node.parent.name);
  return undefined;
}

function mergeValues(...groups: Iterable<string>[]): Set<string> {
  const merged = new Set<string>();
  for (const group of groups) {
    for (const value of group) {
      merged.add(value);
      if (merged.size >= MAX_ABSTRACT_VALUES) return merged;
    }
  }
  return merged;
}

function concatenate(left: Iterable<string>, right: Iterable<string>): Set<string> {
  const combined = new Set<string>();
  for (const a of left) {
    for (const b of right) {
      combined.add(`${a}${b}`);
      if (combined.size >= MAX_ABSTRACT_VALUES) return combined;
    }
  }
  return combined;
}

class StaticStrings {
  private readonly callsBySymbol = new Map<ts.Symbol, ts.CallExpression[]>();

  constructor(
    private readonly checker: ts.TypeChecker,
    sourceFiles: readonly ts.SourceFile[],
  ) {
    for (const sourceFile of sourceFiles) {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const symbol = resolvedSymbol(this.checker, node.expression);
          if (symbol) {
            const calls = this.callsBySymbol.get(symbol) ?? [];
            calls.push(node);
            this.callsBySymbol.set(symbol, calls);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }

  values(
    node: ts.Expression | undefined,
    environment = new Map<ts.Symbol, Set<string>>(),
    stack = new Set<ts.Symbol>(),
  ): Set<string> {
    if (!node) return new Set(['*']);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return new Set([node.text]);
    if (ts.isNumericLiteral(node)) return new Set([node.text]);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return new Set(['true']);
    if (node.kind === ts.SyntaxKind.FalseKeyword) return new Set(['false']);
    if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.UndefinedKeyword) return new Set(['']);
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isAwaitExpression(node)
    )
      return this.values(node.expression, environment, stack);
    if (ts.isConditionalExpression(node))
      return mergeValues(
        this.values(node.whenTrue, environment, stack),
        this.values(node.whenFalse, environment, stack),
      );
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken)
        return concatenate(this.values(node.left, environment, stack), this.values(node.right, environment, stack));
      if (
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      )
        return mergeValues(this.values(node.left, environment, stack), this.values(node.right, environment, stack));
      return new Set(['*']);
    }
    if (ts.isTemplateExpression(node)) {
      let values = new Set([node.head.text]);
      for (const span of node.templateSpans) {
        values = concatenate(values, this.values(span.expression, environment, stack));
        values = concatenate(values, [span.literal.text]);
      }
      return values;
    }
    if (ts.isIdentifier(node)) {
      const symbol = resolvedSymbol(this.checker, node);
      if (!symbol) return new Set(['*']);
      const bound = environment.get(symbol);
      if (bound) return bound;
      if (stack.has(symbol)) return new Set(['*']);
      const nextStack = new Set(stack).add(symbol);
      for (const declaration of symbol.declarations ?? []) {
        if (ts.isParameter(declaration)) return this.parameterValues(symbol, declaration, environment, nextStack);
        if (ts.isVariableDeclaration(declaration) && declaration.initializer)
          return this.values(declaration.initializer, environment, nextStack);
        if (ts.isPropertyAssignment(declaration)) return this.values(declaration.initializer, environment, nextStack);
        if (ts.isEnumMember(declaration) && declaration.initializer)
          return this.values(declaration.initializer, environment, nextStack);
      }
      return new Set(['*']);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const symbol = resolvedSymbol(this.checker, node);
      if (symbol && !stack.has(symbol)) {
        for (const declaration of symbol.declarations ?? []) {
          if (ts.isPropertyAssignment(declaration))
            return this.values(declaration.initializer, environment, new Set(stack).add(symbol));
        }
      }
      return new Set(['*']);
    }
    if (ts.isNewExpression(node)) {
      if (node.expression.getText() === 'URL') return this.values(node.arguments?.[0], environment, stack);
      return new Set(['*']);
    }
    if (ts.isCallExpression(node)) {
      const callName = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : node.expression.getText();
      if (callName === 'encodeURIComponent') {
        const encoded = new Set<string>();
        for (const value of this.values(node.arguments[0], environment, stack))
          encoded.add(value.includes('*') ? '*' : encodeURIComponent(value));
        return encoded;
      }
      if (callName === 'String') return this.values(node.arguments[0], environment, stack);
      if (callName === 'toString' && ts.isPropertyAccessExpression(node.expression))
        return this.values(node.expression.expression, environment, stack);

      const symbol = resolvedSymbol(this.checker, node.expression);
      if (!symbol || stack.has(symbol)) return new Set(['*']);
      const declaration = functionForSymbol(symbol);
      if (!declaration) return new Set(['*']);
      const callEnvironment = new Map(environment);
      declaration.parameters.forEach((parameter, index) => {
        const parameterSymbol = resolvedSymbol(this.checker, parameter.name);
        if (!parameterSymbol) return;
        const argument = node.arguments[index];
        callEnvironment.set(
          parameterSymbol,
          argument
            ? this.values(argument, environment, stack)
            : parameter.initializer
              ? this.values(parameter.initializer, environment, stack)
              : new Set(['*']),
        );
      });
      const nextStack = new Set(stack).add(symbol);
      if (!declaration.body) return new Set(['*']);
      if (!ts.isBlock(declaration.body)) return this.values(declaration.body, callEnvironment, nextStack);
      const returns: Set<string>[] = [];
      const visit = (child: ts.Node): void => {
        if (child !== declaration.body && ts.isFunctionLike(child)) return;
        if (ts.isReturnStatement(child)) returns.push(this.values(child.expression, callEnvironment, nextStack));
        else ts.forEachChild(child, visit);
      };
      visit(declaration.body);
      return returns.length > 0 ? mergeValues(...returns) : new Set(['*']);
    }
    return new Set(['*']);
  }

  private parameterValues(
    symbol: ts.Symbol,
    parameter: ts.ParameterDeclaration,
    environment: Map<ts.Symbol, Set<string>>,
    stack: Set<ts.Symbol>,
  ): Set<string> {
    const owner = parameter.parent;
    const ownerSymbol = symbolForFunction(this.checker, owner);
    if (!ownerSymbol || stack.has(ownerSymbol)) return this.values(parameter.initializer, environment, stack);
    const index = owner.parameters.indexOf(parameter);
    const values: Set<string>[] = [];
    for (const call of this.callsBySymbol.get(ownerSymbol) ?? []) {
      const argument = call.arguments[index];
      values.push(
        argument
          ? this.values(argument, environment, stack)
          : parameter.initializer
            ? this.values(parameter.initializer, environment, stack)
            : new Set(['*']),
      );
    }
    if (values.length === 0)
      values.push(parameter.initializer ? this.values(parameter.initializer, environment, stack) : new Set(['*']));
    const merged = mergeValues(...values);
    return merged.size > 0 ? merged : new Set(['*']);
  }
}

function routePattern(value: string): string | null {
  const start = value.indexOf('/v1');
  if (start < 0) return null;
  let path = value.slice(start);
  const query = path.search(/[?#\s]/);
  if (query >= 0) path = path.slice(0, query);
  path = path.replace(/\*+/g, '*').replace(/\/$/, '') || '/';
  return /^\/v1(?:\/|$)[A-Za-z0-9%._~*/-]*$/.test(path) ? path : null;
}

function sourceLocation(node: ts.Node): RouteSource {
  const sourceFile = node.getSourceFile();
  return {
    file: relative(MODULE_ROOT, sourceFile.fileName),
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
  };
}

function candidateExpressions(sourceFile: ts.SourceFile): ts.Expression[] {
  const candidates: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
      candidates.push(node);
    if (ts.isReturnStatement(node) && node.expression) candidates.push(node.expression);
    if (ts.isVariableDeclaration(node) && node.initializer && !ts.isFunctionLike(node.initializer))
      candidates.push(node.initializer);
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) candidates.push(node.body);
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments?.[0])
      candidates.push(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return candidates;
}

function isNetworkBoundary(node: ts.Node): node is ts.CallExpression | ts.NewExpression {
  if (ts.isNewExpression(node)) return node.expression.getText() === 'WebSocket';
  if (!ts.isCallExpression(node)) return false;
  const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText();
  return name === 'fetch' || /fetchImpl$/i.test(name);
}

function collectUiRoutes(): { routes: UiRoute[]; unresolved: NetworkBoundary[]; usedAllowances: Set<number> } {
  const fileNames = productionUiFiles();
  const program = ts.createProgram(fileNames, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true,
  });
  const sources = fileNames
    .map(path => program.getSourceFile(path))
    .filter((source): source is ts.SourceFile => !!source);
  const strings = new StaticStrings(program.getTypeChecker(), sources);
  const routes = new Map<string, RouteSource[]>();
  const unresolved: NetworkBoundary[] = [];
  const usedAllowances = new Set<number>();

  for (const sourceFile of sources) {
    for (const expression of candidateExpressions(sourceFile)) {
      for (const value of strings.values(expression)) {
        const pattern = routePattern(value);
        if (!pattern) continue;
        const location = sourceLocation(expression);
        const existing = routes.get(pattern) ?? [];
        if (!existing.some(item => item.file === location.file && item.line === location.line)) existing.push(location);
        routes.set(pattern, existing);
      }
    }

    const visit = (node: ts.Node): void => {
      if (isNetworkBoundary(node)) {
        const argument = node.arguments?.[0];
        const patterns = argument
          ? [...strings.values(argument)].map(routePattern).filter((path): path is string => path !== null)
          : [];
        if (patterns.length === 0) {
          const location = sourceLocation(node);
          const expression = node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 240);
          const allowance = DYNAMIC_BOUNDARY_ALLOWLIST.findIndex(
            item => item.file === location.file && item.expression.test(expression),
          );
          if (allowance >= 0) usedAllowances.add(allowance);
          else unresolved.push({ ...location, expression });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return {
    routes: [...routes.entries()]
      .map(([pattern, sources]) => ({
        pattern,
        sources: sources.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
      }))
      .sort((a, b) => a.pattern.localeCompare(b.pattern)),
    unresolved,
    usedAllowances,
  };
}

function daemonOptionNames(): Set<string> {
  const source = ts.createSourceFile(DAEMON_ENTRY, readFileSync(DAEMON_ENTRY, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'apiOptions') {
      if (!node.initializer || !ts.isObjectLiteralExpression(node.initializer))
        throw new Error('daemon-entry.ts apiOptions must remain a statically enumerable object literal');
      for (const property of node.initializer.properties) {
        if (ts.isShorthandPropertyAssignment(property)) names.add(property.name.text);
        else if (
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        )
          names.add(property.name.text);
        else throw new Error(`daemon-entry.ts apiOptions contains a dynamic property: ${property.getText(source)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (names.size === 0) throw new Error('could not find daemon-entry.ts apiOptions');
  for (const omitted of (process.env['KTEAM_ROUTE_COVERAGE_OMIT'] ?? '').split(',').filter(Boolean))
    names.delete(omitted);
  return names;
}

type Dispatch = (request: Request, server: RouterServer) => Response | undefined | Promise<Response | undefined>;

interface RouterServer {
  stop(closeActiveConnections?: boolean): void;
  requestIP(request: Request): { address: string };
  upgrade(request: Request, options: unknown): boolean;
  port: number;
}

interface CapturedServeOptions {
  fetch: Dispatch;
}

function captureAssembledRouter(): { dispatch: Dispatch; server: RouterServer } {
  const wiredOptions = daemonOptionNames();
  const sentinel = new Error('route-coverage reached a mounted handler');
  const subscription = () => () => undefined;
  const throwingMethod = () => {
    throw sentinel;
  };
  const capability = new Proxy(throwingMethod, {
    get(_target, property) {
      if (property === 'then') return undefined;
      if (property === 'subscribe') return subscription;
      return throwingMethod;
    },
  });
  const service = new Proxy(
    { subscribe: subscription },
    {
      get(target, property) {
        if (property in target) return Reflect.get(target, property);
        return throwingMethod;
      },
    },
  );
  const core = { host: '127.0.0.1', port: 0, token: 'route-coverage-token', service };
  const options = new Proxy(core, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      return typeof property === 'string' && wiredOptions.has(property) ? capability : undefined;
    },
  }) as unknown as ApiServerOptions;

  let captured: CapturedServeOptions | undefined;
  const server: RouterServer = {
    stop() {},
    requestIP: () => ({ address: '127.0.0.1' }),
    upgrade: () => true,
    port: 0,
  };
  const bun = Bun as unknown as { serve: (options: unknown) => unknown };
  const originalServe = bun.serve;
  bun.serve = ((serveOptions: unknown) => {
    captured = serveOptions as CapturedServeOptions;
    return server;
  }) as typeof bun.serve;
  try {
    startApiServer(options);
  } finally {
    bun.serve = originalServe;
  }
  if (!captured) throw new Error('startApiServer did not assemble a Bun fetch handler');
  return { dispatch: captured.fetch, server };
}

function representatives(pattern: string): string[] {
  let values = [''];
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character !== '*') {
      values = values.map(value => value + character);
      continue;
    }
    const previous = pattern[index - 1];
    const next = pattern[index + 1];
    const replacements =
      previous === '/' && (next === '/' || next === undefined) ? [SAMPLE] : ['', `/${SAMPLE}`, SAMPLE];
    values = values.flatMap(value => replacements.map(replacement => value + replacement)).slice(0, 24);
  }
  return [...new Set(values.filter(value => value.startsWith('/v1')))];
}

async function isUnknownRoute(response: Response | undefined): Promise<boolean> {
  if (!response) return false;
  if (response.status !== 404) return false;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { code?: unknown } | null;
  return body?.code === 'unknown_route';
}

async function routeIsReachable(pattern: string, dispatch: Dispatch, server: RouterServer): Promise<boolean> {
  const attempts = [
    { method: 'GET', headers: {} },
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' },
    { method: 'DELETE', headers: {} },
    { method: 'GET', headers: { upgrade: 'websocket' } },
  ] as const;
  for (const path of representatives(pattern)) {
    for (const attempt of attempts) {
      const headers = new Headers(attempt.headers);
      headers.set('authorization', 'Bearer route-coverage-token');
      const response = await dispatch(
        new Request(`http://route-coverage.invalid${path}`, {
          method: attempt.method,
          headers,
          ...('body' in attempt ? { body: attempt.body } : {}),
        }),
        server,
      );
      if (!(await isUnknownRoute(response))) return true;
    }
  }
  return false;
}

const collected = collectUiRoutes();

describe('UI to daemon route coverage', () => {
  test('all daemon request paths are statically resolved or explicitly documented', () => {
    const staleAllowances = DYNAMIC_BOUNDARY_ALLOWLIST.filter((_, index) => !collected.usedAllowances.has(index));
    const details = [
      ...collected.unresolved.map(item => `${item.file}:${item.line} could not resolve ${item.expression}`),
      ...staleAllowances.map(item => `${item.file} has a stale dynamic-boundary allowance: ${item.reason}`),
    ];
    expect(details, details.join('\n')).toEqual([]);
    expect(collected.routes.length).toBeGreaterThan(0);
  });

  test('extractor canaries include the route families that previously shipped unmounted', () => {
    const patterns = collected.routes.map(route => route.pattern);
    expect(patterns.some(path => path.includes('/terminals'))).toBe(true);
    expect(patterns.some(path => path.includes('/browser'))).toBe(true);
    expect(patterns).toContain('/v1/sessions/*/skills');
    expect(patterns).toContain('/v1/sessions/*/runtime-models');
  });

  test('the CLI-only direct-notify route is mounted (&F140)', async () => {
    // `kteam attention notify` has no UI caller, so the static extractor never
    // sees it; assert its reachability against the assembled router directly.
    const { dispatch, server } = captureAssembledRouter();
    expect(await routeIsReachable('/v1/sessions/*/notify', dispatch, server)).toBe(true);
  });

  test('the CLI PWA identity route is mounted by daemon-entry (&F159)', async () => {
    const { dispatch, server } = captureAssembledRouter();
    expect(await routeIsReachable('/v1/pwa/config', dispatch, server)).toBe(true);
  });

  test('every UI /v1 path reaches the router assembled by daemon-entry', async () => {
    const { dispatch, server } = captureAssembledRouter();
    const unmatched: UiRoute[] = [];
    for (const route of collected.routes) {
      if (UNMOUNTED_ROUTE_ALLOWLIST.has(route.pattern)) continue;
      if (!(await routeIsReachable(route.pattern, dispatch, server))) unmatched.push(route);
    }
    const failures = unmatched.map(route => {
      const locations = route.sources.map(source => `${source.file}:${source.line}`).join(', ');
      return `${route.pattern} requested at ${locations}`;
    });
    expect(failures, `UI paths with no reachable daemon route:\n${failures.join('\n')}`).toEqual([]);
    for (const [pattern, reason] of UNMOUNTED_ROUTE_ALLOWLIST) {
      expect(reason.trim(), `${pattern} needs a documented allowlist reason`).not.toBe('');
      expect(
        collected.routes.some(route => route.pattern === pattern),
        `${pattern} is a stale route allowlist entry`,
      ).toBe(true);
    }
  });
});
