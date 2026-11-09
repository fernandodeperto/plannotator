import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiEventBus, type PiEventBus } from "../../tests/helpers/pi-event-bus.ts";
import plannotator from "./index.ts";

/**
 * Extension-level coverage for the todo-provider mirror: proves the plan
 * lifecycle actually drives a provider, which the provider's own unit tests
 * (todo-providers/pi-todos.test.ts) cannot show.
 *
 * The Pi host stub mirrors the one in external-execution.test.ts, trimmed to
 * what a `--plan` session needs to boot, auto-approve (hasUI: false), finish a
 * turn, and toggle back to idle.
 */
const tempDirs: string[] = [];
let originalPiTodoPath: string | undefined;
let originalTodoProviderEnv: string | undefined;

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Restore an env var to its pre-test value instead of deleting ambient state. */
function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

beforeEach(() => {
	// The extension resolves a real provider through the real env-sensitive
	// detection code (resolveTodoProvider / detectPiTodos). Snapshot and clear
	// PI_TODO_PATH and PLANNOTATOR_TODO_PROVIDER so an ambient value on the
	// host — or leaked from another test file sharing this process — can
	// never redirect detection or writes outside the temp dirs below.
	originalPiTodoPath = process.env.PI_TODO_PATH;
	originalTodoProviderEnv = process.env.PLANNOTATOR_TODO_PROVIDER;
	delete process.env.PI_TODO_PATH;
	delete process.env.PLANNOTATOR_TODO_PROVIDER;
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	restoreEnv("PI_TODO_PATH", originalPiTodoPath);
	restoreEnv("PLANNOTATOR_TODO_PROVIDER", originalTodoProviderEnv);
});

function createHarness(cwd: string, events: Pick<PiEventBus, "on" | "emit"> = { on: () => () => undefined, emit: () => undefined }) {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const notifications: string[] = [];
	const widgets: Array<string[] | undefined> = [];
	const state = { activeTools: ["read", "bash", "edit", "write"], thinkingLevel: "medium" };

	const pi = {
		events,
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerCommand: (
			name: string,
			command: { handler: (args: string, ctx: unknown) => Promise<void> },
		) => commands.set(name, command),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
			tools.set(tool.name, tool),
		getFlag: () => true,
		getActiveTools: () => [...state.activeTools],
		setActiveTools: (next: string[]) => {
			state.activeTools = [...next];
		},
		getThinkingLevel: () => state.thinkingLevel,
		setThinkingLevel: (level: string) => {
			state.thinkingLevel = level;
		},
		setModel: async () => true,
		appendEntry: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
	};

	const ctx = {
		cwd,
		hasUI: false,
		isProjectTrusted: () => true,
		isIdle: () => true,
		model: { provider: "test", id: "original-model" },
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionId: () => "test-session",
			getSessionFile: () => "session.json",
			getSessionName: () => undefined,
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => undefined,
			setWidget: (_key: string, content: string[] | undefined) => widgets.push(content),
			theme: {
				fg: (_color: string, text: string) => text,
				strikethrough: (text: string) => text,
			},
		},
	};

	return {
		ctx,
		commands,
		notifications,
		widgets,
		async startSession(): Promise<void> {
			plannotator(pi as never);
			for (const handler of handlers.get("session_start") ?? []) {
				await handler({ reason: "startup" }, ctx);
			}
		},
		submitPlan(filePath: string) {
			return tools
				.get("plannotator_submit_plan")!
				.execute("call-1", { filePath }, undefined, undefined, ctx);
		},
		markStepDone(step: number) {
			return tools
				.get("plannotator_mark_done")!
				.execute("call-2", { step }, undefined, undefined, ctx);
		},
		async endTurn(text: string): Promise<void> {
			for (const handler of handlers.get("turn_end") ?? []) {
				await handler({ message: { role: "assistant", content: [{ type: "text", text }] } }, ctx);
			}
		},
		/** The `/plannotator-plan-mode` toggle is the shared exit back to idle. */
		async toggle(): Promise<void> {
			await commands.get("plannotator-plan-mode")?.handler("", ctx);
		},
	};
}

const PLAN_CONTENT = "# Plan\n\n- [ ] First step\n- [ ] Second step\n";

function readTodos(
	todosDir: string,
): Array<{ title: string; status: string; tags: string[]; assigned_to_session?: string }> {
	if (!existsSync(todosDir)) return [];
	return readdirSync(todosDir)
		.filter((entry) => entry.endsWith(".md"))
		.map((entry) => {
			const content = readFileSync(join(todosDir, entry), "utf8");
			const end = content.indexOf("\n}");
			return JSON.parse(content.slice(0, end + 2)) as {
				title: string;
				status: string;
				tags: string[];
				assigned_to_session?: string;
			};
		});
}

describe("plan execution mirrors into a detected todo provider", () => {
	test("approving a plan writes the checklist to .pi/todos", async () => {
		const cwd = makeTempDir("plannotator-todo-sync-");
		const todosDir = join(cwd, ".pi", "todos");
		mkdirSync(todosDir, { recursive: true });
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);

		const harness = createHarness(cwd);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");

		const todos = readTodos(todosDir);
		expect(todos.map((todo) => todo.title).sort()).toEqual(["1. First step", "2. Second step"]);
		for (const todo of todos) {
			expect(todo.status).toBe("open");
			expect(todo.tags).toContain("plannotator:plan:PLAN.md");
			// TodoProviderEnv carries the session id (ctx.sessionManager.getSessionId()),
			// never the session file path — the harness mock returns a different
			// string for each, so this fails if the wiring regresses.
			expect(todo.assigned_to_session).toBe("test-session");
		}
	});

	test("marking a step during execution persists only that step", async () => {
		const cwd = makeTempDir("plannotator-todo-sync-");
		const todosDir = join(cwd, ".pi", "todos");
		mkdirSync(todosDir, { recursive: true });
		const planPath = join(cwd, "PLAN.md");
		writeFileSync(planPath, PLAN_CONTENT);

		const harness = createHarness(cwd);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");
		await harness.markStepDone(1);

		expect(readFileSync(planPath, "utf8")).toBe(
			"# Plan\n\n- [x] First step\n- [ ] Second step\n",
		);
		const byTitle = new Map(readTodos(todosDir).map((todo) => [todo.title, todo]));
		expect(byTitle.get("1. First step")?.status).toBe("done");
		expect(byTitle.get("2. Second step")?.status).toBe("open");
	});

	test("a DONE marker closes the matching todo and persists the plan", async () => {
		const cwd = makeTempDir("plannotator-todo-sync-");
		const todosDir = join(cwd, ".pi", "todos");
		mkdirSync(todosDir, { recursive: true });
		const planPath = join(cwd, "PLAN.md");
		writeFileSync(planPath, PLAN_CONTENT);

		const harness = createHarness(cwd);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");
		await harness.endTurn("Finished the first bit. [DONE:1]");

		const byTitle = new Map(readTodos(todosDir).map((todo) => [todo.title, todo]));
		expect(byTitle.get("1. First step")?.status).toBe("done");
		expect(byTitle.get("2. Second step")?.status).toBe("open");
		expect(readFileSync(planPath, "utf8")).toBe("# Plan\n\n- [x] First step\n- [ ] Second step\n");
	});

	test("keeps the progress widget even while mirroring", async () => {
		const cwd = makeTempDir("plannotator-todo-sync-");
		const todosDir = join(cwd, ".pi", "todos");
		mkdirSync(todosDir, { recursive: true });
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);

		const harness = createHarness(cwd);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");

		// The mirror is additive: the tracker still renders both steps...
		const rendered = harness.widgets.filter((content): content is string[] => Array.isArray(content));
		expect(rendered.at(-1)).toHaveLength(2);

		// ...and the provider actually received the same two steps, not just
		// an empty or partial mirror running alongside an unaffected widget.
		const todos = readTodos(todosDir);
		expect(todos.map((todo) => todo.title).sort()).toEqual(["1. First step", "2. Second step"]);
		for (const todo of todos) expect(todo.status).toBe("open");
	});

	test("stays widget-only when no provider is present", async () => {
		const cwd = makeTempDir("plannotator-todo-sync-");
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);

		const harness = createHarness(cwd);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");
		await harness.endTurn("Done with one. [DONE:1]");

		// No .pi/todos to detect, so nothing is created and nothing warns.
		expect(existsSync(join(cwd, ".pi", "todos"))).toBe(false);
		expect(harness.notifications.filter((note) => note.includes("sync failed"))).toEqual([]);
		const rendered = harness.widgets.filter((content): content is string[] => Array.isArray(content));
		expect(rendered.at(-1)).toHaveLength(2);
	});

	test("re-detects a provider that appears after the first plan", async () => {
		const cwd = makeTempDir("plannotator-todo-sync-");
		const todosDir = join(cwd, ".pi", "todos");
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);
		writeFileSync(join(cwd, "SECOND.md"), "# Plan\n\n- [ ] Later step\n");

		const harness = createHarness(cwd);
		await harness.startSession();
		// First plan runs with no provider installed.
		await harness.submitPlan("PLAN.md");
		expect(readTodos(todosDir)).toEqual([]);

		// Back to idle, provider installed, second plan approved.
		await harness.toggle();
		mkdirSync(todosDir, { recursive: true });
		await harness.toggle();
		await harness.submitPlan("SECOND.md");

		expect(readTodos(todosDir).map((todo) => todo.title)).toEqual(["1. Later step"]);
	});

	test("a sync failure notifies once and latches while the widget keeps updating", async () => {
		const cwd = makeTempDir("plannotator-todo-sync-");
		const todosDir = join(cwd, ".pi", "todos");
		mkdirSync(todosDir, { recursive: true });
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);

		const harness = createHarness(cwd);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");
		// The provider is healthy for the initial sync: a real directory.
		expect(readTodos(todosDir)).toHaveLength(2);

		// Break the provider without chmod: replace the todos directory with a
		// plain file, so the next sync's `fs.mkdir(todosDir, { recursive: true })`
		// throws ENOTDIR/EEXIST instead of silently no-oping or needing
		// permissions this process might not even be able to drop.
		rmSync(todosDir, { recursive: true, force: true });
		writeFileSync(todosDir, "not a directory anymore");

		await harness.endTurn("Finished the first bit. [DONE:1]");
		await harness.endTurn("Finished the second bit. [DONE:2]");

		const failureNotices = harness.notifications.filter((note) => note.includes("sync failed"));
		expect(failureNotices).toHaveLength(1);

		// The widget is wired independently of provider health: execution
		// keeps rendering progress after the provider latches disabled.
		const rendered = harness.widgets.filter((content): content is string[] => Array.isArray(content));
		expect(rendered.at(-1)).toHaveLength(2);
	});
});

/**
 * rpiv-todo's side of `rpiv:todo:sync`, answering inside `emit` like the real
 * extension on Pi's bus. `refuse` makes it reject plan syncs (not the probe).
 */
function fakeRpivTodo(opts: { refuse?: () => boolean; started?: () => boolean } = {}) {
	const bus = createPiEventBus();
	const syncs: Array<{ group: string; items: Array<{ key: string; status: string }> }> = [];
	bus.on("rpiv:todo:sync", (data) => {
		const request = data as { requestId: string; group: string; items: Array<{ key: string; status: string }> };
		// Before its own session_start, rpiv-todo does not answer.
		if (opts.started && !opts.started()) return;
		if (request.group === "plannotator:probe") {
			bus.emit("rpiv:todo:sync-result", { requestId: request.requestId, ok: true, live: true });
			return;
		}
		syncs.push({ group: request.group, items: request.items });
		bus.emit(
			"rpiv:todo:sync-result",
			opts.refuse?.()
				? { requestId: request.requestId, ok: false, code: "invalid_payload", reason: "refused" }
				: { requestId: request.requestId, ok: true, live: true },
		);
	});
	return { bus, syncs };
}

const lastWidget = (widgets: Array<string[] | undefined>) => widgets.at(-1);

describe("plan execution mirrors into rpiv-todo", () => {
	test("hides the progress widget while rpiv-todo shows the steps", async () => {
		const cwd = makeTempDir("plannotator-rpiv-todo-");
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);
		const rpiv = fakeRpivTodo();

		const harness = createHarness(cwd, rpiv.bus);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");
		expect(lastWidget(harness.widgets)).toBeUndefined();
		expect(rpiv.syncs.at(-1)).toEqual({
			group: "PLAN.md",
			items: [
				expect.objectContaining({ key: "step:1", status: "in_progress" }),
				expect.objectContaining({ key: "step:2", status: "pending" }),
			],
		});

		await harness.endTurn("Finished the first bit. [DONE:1]");
		expect(lastWidget(harness.widgets)).toBeUndefined();
		expect(rpiv.syncs.at(-1)?.items.map((item) => item.status)).toEqual(["completed", "in_progress"]);
	});

	test("brings the widget back when rpiv-todo refuses a sync", async () => {
		const cwd = makeTempDir("plannotator-rpiv-todo-");
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);
		let refusing = false;
		const rpiv = fakeRpivTodo({ refuse: () => refusing });

		const harness = createHarness(cwd, rpiv.bus);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");
		refusing = true;
		await harness.endTurn("Finished the first bit. [DONE:1]");

		expect(harness.notifications.filter((note) => note.includes("rpiv-todo sync failed"))).toHaveLength(1);
		expect(lastWidget(harness.widgets)).toHaveLength(2);
	});

	test("finds rpiv-todo at a later sync when it was not answering yet", async () => {
		const cwd = makeTempDir("plannotator-rpiv-todo-");
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);
		let started = false;
		const rpiv = fakeRpivTodo({ started: () => started });

		const harness = createHarness(cwd, rpiv.bus);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");
		expect(lastWidget(harness.widgets)).toHaveLength(2);

		started = true;
		await harness.markStepDone(1);
		expect(lastWidget(harness.widgets)).toBeUndefined();
		expect(rpiv.syncs.at(-1)?.items.map((item) => item.status)).toEqual(["completed", "in_progress"]);
	});

	test("a probe that throws leaves the plan running with the widget", async () => {
		const cwd = makeTempDir("plannotator-rpiv-todo-");
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);
		const bus = createPiEventBus();
		bus.on("rpiv:todo:sync", () => {
			throw new Error("listener blew up");
		});

		const harness = createHarness(cwd, bus);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");
		await harness.markStepDone(1);

		expect(harness.notifications.filter((note) => note.includes("sync failed"))).toHaveLength(1);
		expect(lastWidget(harness.widgets)).toHaveLength(2);
	});

	test("leaving plan mode with open steps clears the plan from rpiv-todo", async () => {
		const cwd = makeTempDir("plannotator-rpiv-todo-");
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);
		const rpiv = fakeRpivTodo();

		const harness = createHarness(cwd, rpiv.bus);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");
		await harness.markStepDone(1);
		await harness.toggle();

		expect(rpiv.syncs.at(-1)).toEqual({ group: "PLAN.md", items: [] });
	});

	test("a finished plan keeps its rows when plan mode ends", async () => {
		const cwd = makeTempDir("plannotator-rpiv-todo-");
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);
		const rpiv = fakeRpivTodo();

		const harness = createHarness(cwd, rpiv.bus);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");
		await harness.markStepDone(1);
		await harness.markStepDone(2);
		await harness.toggle();

		expect(rpiv.syncs.at(-1)?.items.map((item) => item.status)).toEqual(["completed", "completed"]);
	});
});
