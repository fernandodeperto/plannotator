/**
 * rpiv-todo provider.
 *
 * rpiv-todo (juicesharp/rpiv-mono `packages/rpiv-todo`) draws the model's todo
 * list as a live overlay and accepts task lists from other extensions over
 * `pi.events`. The channel names and payload shapes below mirror its
 * `events.ts` (`rpiv:todo:sync` / `rpiv:todo:sync-result`); Plannotator does
 * not depend on the package, so they are restated here. That contract is
 * append-only by rpiv's stability policy, so these never need to change.
 *
 * Pi's event bus runs listeners inside `emit`, so the verdict is in hand as
 * soon as `emit` returns. No verdict means rpiv-todo is not loaded for this
 * session.
 */
import crypto from "node:crypto";
import type { ChecklistItem } from "../generated/checklist.ts";
import type { TodoProvider, TodoProviderEnv } from "./types.ts";

const SYNC_EVENT = "rpiv:todo:sync";
const SYNC_RESULT_EVENT = "rpiv:todo:sync-result";
const OWNER = "plannotator";
/** Group for the detection probe. An empty list for it never writes anything. */
const PROBE_GROUP = "plannotator:probe";

type SyncStatus = "pending" | "in_progress" | "completed";

interface SyncItem {
	key: string;
	subject: string;
	status: SyncStatus;
}

interface SyncResult {
	ok: boolean;
	requestId?: string;
	live?: boolean;
	reason?: string;
}

/** Emit one sync and return rpiv-todo's verdict, or undefined when nothing answered. */
function requestSync(env: TodoProviderEnv, group: string, items: SyncItem[]): SyncResult | undefined {
	const requestId = crypto.randomUUID();
	let result: SyncResult | undefined;
	const off = env.events.on(SYNC_RESULT_EVENT, (data) => {
		const verdict = data as SyncResult | null;
		if (verdict?.requestId === requestId) result = verdict;
	});
	try {
		env.events.emit(SYNC_EVENT, {
			requestId,
			owner: OWNER,
			group,
			...(env.sessionId ? { sessionId: env.sessionId } : {}),
			items,
		});
	} finally {
		off();
	}
	return result;
}

/** One item per step; the first open step is the one in progress. */
function toSyncItems(items: ChecklistItem[]): SyncItem[] {
	const active = items.find((item) => !item.completed);
	return items.map((item) => ({
		key: `step:${item.step}`,
		subject: item.text,
		status: item.completed ? "completed" : item === active ? "in_progress" : "pending",
	}));
}

/** Build the provider when rpiv-todo answers for this session, else undefined. */
export function detectRpivTodo(env: TodoProviderEnv): TodoProvider | undefined {
	const probe = requestSync(env, PROBE_GROUP, []);
	if (!probe?.ok) return undefined;
	return {
		name: "rpiv-todo",
		live: probe.live === true,
		async sync(items: ChecklistItem[], planId: string): Promise<void> {
			const result = requestSync(env, planId, toSyncItems(items));
			if (!result) throw new Error("rpiv-todo did not answer.");
			if (!result.ok) throw new Error(`rpiv-todo refused the sync: ${result.reason ?? "no reason given"}.`);
		},
	};
}
