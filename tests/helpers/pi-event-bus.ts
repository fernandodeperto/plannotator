/**
 * Stand-in for Pi's extension event bus (`pi.events`). Pi's own bus is a plain
 * EventEmitter whose listeners run inside `emit`, which is what extensions that
 * talk over it rely on; this keeps the same behavior without importing Pi.
 */
import { EventEmitter } from "node:events";

export interface PiEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export function createPiEventBus(): PiEventBus {
	const emitter = new EventEmitter();
	return {
		emit: (channel, data) => {
			emitter.emit(channel, data);
		},
		on: (channel, handler) => {
			emitter.on(channel, handler);
			return () => emitter.off(channel, handler);
		},
	};
}
