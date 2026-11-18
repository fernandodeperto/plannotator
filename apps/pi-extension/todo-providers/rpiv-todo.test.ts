import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPiEventBus, type PiEventBus } from "../../../tests/helpers/pi-event-bus.ts";
import type { ChecklistItem } from "../generated/checklist.ts";
import { resolveTodoProvider } from "./index.ts";

/**
 * A stand-in for rpiv-todo's side of the `rpiv:todo:sync` contract
 * (juicesharp/rpiv-mono `packages/rpiv-todo/events.ts`): it answers each
 * request on `rpiv:todo:sync-result` inside `emit`, the way rpiv-todo does on
 * Pi's bus. `answer` decides the verdict; returning undefined stays silent.
 */
function fakeRpivTodo(bus: PiEventBus, answer: (request: Record<string, unknown>) => object | undefined) {
	const requests: Array<Record<string, unknown>> = [];
	bus.on("rpiv:todo:sync", (data) => {
		const request = data as Record<string, unknown>;
		requests.push(request);
		const verdict = answer(request);
		if (verdict) bus.emit("rpiv:todo:sync-result", { requestId: request.requestId, ...verdict });
	});
	return requests;
}

const checklist = (...completed: boolean[]): ChecklistItem[] =>
	completed.map((done, i) => ({ step: i + 1, text: `Step ${i + 1}`, completed: done }));

let cwd: string;
let bus: PiEventBus;
let originalTodoProviderEnv: string | undefined;
let originalPiTodoPath: string | undefined;

beforeEach(async () => {
	// An inherited PLANNOTATOR_TODO_PROVIDER=off would disable every provider,
	// and an inherited PI_TODO_PATH would redirect pi-todos detection.
	originalTodoProviderEnv = process.env.PLANNOTATOR_TODO_PROVIDER;
	originalPiTodoPath = process.env.PI_TODO_PATH;
	delete process.env.PLANNOTATOR_TODO_PROVIDER;
	delete process.env.PI_TODO_PATH;
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "plannotator-rpiv-todo-"));
	bus = createPiEventBus();
});

afterEach(async () => {
	await fs.rm(cwd, { recursive: true, force: true });
	if (originalTodoProviderEnv === undefined) delete process.env.PLANNOTATOR_TODO_PROVIDER;
	else process.env.PLANNOTATOR_TODO_PROVIDER = originalTodoProviderEnv;
	if (originalPiTodoPath === undefined) delete process.env.PI_TODO_PATH;
	else process.env.PI_TODO_PATH = originalPiTodoPath;
});

const env = () => ({ cwd, sessionId: "session-1", events: bus });

describe("rpiv-todo provider", () => {
	test("is picked when rpiv-todo answers the probe, and reports its live flag", () => {
		const requests = fakeRpivTodo(bus, () => ({ ok: true, live: true }));
		const provider = resolveTodoProvider({}, env());
		expect(provider?.name).toBe("rpiv-todo");
		expect(provider?.live).toBe(true);
		// The probe names a group of its own with no items, so it cannot touch real rows.
		expect(requests).toEqual([
			expect.objectContaining({ owner: "plannotator", group: "plannotator:probe", sessionId: "session-1", items: [] }),
		]);
	});

	test("is not live when rpiv-todo writes a session the overlay is not showing", () => {
		fakeRpivTodo(bus, () => ({ ok: true, live: false }));
		expect(resolveTodoProvider({}, env())?.live).toBe(false);
	});

	test("wins over pi-todos when both are present", async () => {
		await fs.mkdir(path.join(cwd, ".pi", "todos"), { recursive: true });
		fakeRpivTodo(bus, () => ({ ok: true, live: true }));
		const provider = resolveTodoProvider({}, env());
		expect(provider?.name).toBe("rpiv-todo");
		await provider?.sync(checklist(false), "plan.md");
		expect(await fs.readdir(path.join(cwd, ".pi", "todos"))).toEqual([]);
	});

	test("falls back to pi-todos, or to nothing, when rpiv-todo stays silent", async () => {
		fakeRpivTodo(bus, () => undefined);
		expect(resolveTodoProvider({}, env())).toBeUndefined();
		await fs.mkdir(path.join(cwd, ".pi", "todos"), { recursive: true });
		expect(resolveTodoProvider({}, env())?.name).toBe("pi-todos");
	});

	test("is never probed when todoProvider is off", () => {
		const requests = fakeRpivTodo(bus, () => ({ ok: true, live: true }));
		expect(resolveTodoProvider({ todoProvider: "off" }, env())).toBeUndefined();
		expect(requests).toEqual([]);
	});

	test("sends every step, with the first open one in progress", async () => {
		const requests = fakeRpivTodo(bus, () => ({ ok: true, live: true }));
		await resolveTodoProvider({}, env())?.sync(checklist(true, false, false), "plans/feature.md");
		expect(requests.at(-1)).toMatchObject({
			owner: "plannotator",
			group: "plans/feature.md",
			sessionId: "session-1",
			items: [
				{ key: "step:1", subject: "Step 1", status: "completed" },
				{ key: "step:2", subject: "Step 2", status: "in_progress" },
				{ key: "step:3", subject: "Step 3", status: "pending" },
			],
		});
	});

	test("sync fails when rpiv-todo stops answering", async () => {
		let answering = true;
		fakeRpivTodo(bus, () => (answering ? { ok: true, live: true } : undefined));
		const provider = resolveTodoProvider({}, env());
		answering = false;
		await expect(provider!.sync(checklist(false), "plan.md")).rejects.toThrow("did not answer");
	});

	test("sync fails with rpiv-todo's reason when it refuses", async () => {
		fakeRpivTodo(bus, (request) =>
			request.group === "plannotator:probe"
				? { ok: true, live: true }
				: { ok: false, code: "invalid_payload", reason: "items[0].subject must be a non-empty string" },
		);
		const provider = resolveTodoProvider({}, env());
		await expect(provider!.sync(checklist(false), "plan.md")).rejects.toThrow("items[0].subject");
	});
});
