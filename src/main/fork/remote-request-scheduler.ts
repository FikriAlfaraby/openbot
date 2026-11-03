// Fork: the order in which requests go to a remote server over WebRTC. Every request and every answer of a
// server share one ordered data channel, so a switch to the server that sends forty reads at once makes the
// conversation wait behind the answers of the queue, routines, tasks and settings. Measured on 2026-11-03:
// the first conversation page of a switch took 7 to 15 s and timed out at 15 s, while the network had a
// 25 ms round trip. Here the reads that draw the screen go first, background reads wait for them (up to a
// limit) and run a few at a time, and two identical reads in flight share one answer. A write is never held
// back and never shared.
import { Deferred, Effect } from "effect";

export type RemoteRequestPriority = "screen" | "background" | "write";

/** Reads that draw the screen of a server: the agents, their status, and the open conversation. */
const SCREEN_READS = [
  /^\/v1\/compatibility$/u,
  /^\/v1\/agents$/u,
  /^\/v1\/agents\/status$/u,
  /^\/v1\/sidebar-layout$/u,
  /^\/v1\/agents\/[^/]+\/conversation(?:-page)?$/u,
  /^\/v1\/direct\/conversations\/[^/]+(?:\/page)?$/u,
];
/** POST routes that only read, so they may wait and be shared like a GET. */
const POSTED_READS = [/^\/v1\/agent-tasks\/list$/u, /^\/v1\/agent-threads\/branches$/u];
/** Background reads of one server in flight at once. */
const BACKGROUND_CONCURRENCY = 4;
/** The longest a background read waits for the screen reads, so a slow page cannot hold it forever. */
const BACKGROUND_WAIT_MS = 4_000;

function remoteRequestPriority(method: string, path: string): RemoteRequestPriority {
  const route = path.split("?", 1)[0] ?? path;
  if (method === "GET") return SCREEN_READS.some((pattern) => pattern.test(route)) ? "screen" : "background";
  return POSTED_READS.some((pattern) => pattern.test(route)) ? "background" : "write";
}

interface ServerLane {
  screen: number;
  background: number;
  waiters: Set<() => void>;
}

export class RemoteRequestScheduler<E> {
  readonly #lanes = new Map<string, ServerLane>();
  readonly #shared = new Map<string, Deferred.Deferred<unknown, E>>();

  #lane(serverId: string): ServerLane {
    let lane = this.#lanes.get(serverId);
    if (!lane) {
      lane = { screen: 0, background: 0, waiters: new Set() };
      this.#lanes.set(serverId, lane);
    }
    return lane;
  }

  #wake(lane: ServerLane): void {
    for (const waiter of [...lane.waiters]) waiter();
  }

  /** Waits until no screen read is out and a background slot is free, or the wait limit passes. */
  #backgroundSlot(lane: ServerLane): Effect.Effect<void> {
    return Effect.callback<void>((resume) => {
      const deadline = Date.now() + BACKGROUND_WAIT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const attempt = () => {
        const free = lane.background < BACKGROUND_CONCURRENCY;
        if (!free || (lane.screen > 0 && Date.now() < deadline)) return;
        lane.waiters.delete(attempt);
        if (timer !== undefined) clearTimeout(timer);
        lane.background += 1;
        resume(Effect.void);
      };
      lane.waiters.add(attempt);
      timer = setTimeout(attempt, BACKGROUND_WAIT_MS);
      attempt();
      return Effect.sync(() => {
        lane.waiters.delete(attempt);
        if (timer !== undefined) clearTimeout(timer);
      });
    });
  }

  #scheduled(serverId: string, priority: RemoteRequestPriority, request: Effect.Effect<unknown, E>) {
    const lane = this.#lane(serverId);
    if (priority === "write") return request;
    if (priority === "screen") {
      return Effect.sync(() => {
        lane.screen += 1;
      }).pipe(
        Effect.andThen(request),
        Effect.ensuring(
          Effect.sync(() => {
            lane.screen -= 1;
            this.#wake(lane);
          }),
        ),
      );
    }
    return this.#backgroundSlot(lane).pipe(
      Effect.andThen(request),
      Effect.ensuring(
        Effect.sync(() => {
          lane.background -= 1;
          this.#wake(lane);
        }),
      ),
    );
  }

  /** Runs `request` in its place in the server's order. An identical read in flight answers it instead. */
  run(
    serverId: string,
    method: string,
    path: string,
    body: unknown,
    request: Effect.Effect<unknown, E>,
  ): Effect.Effect<unknown, E> {
    const priority = remoteRequestPriority(method, path);
    if (priority === "write") return request;
    const key = `${serverId}\n${method}\n${path}\n${body === undefined ? "" : JSON.stringify(body)}`;
    return Effect.suspend(() => {
      const pending = this.#shared.get(key);
      if (pending) return Deferred.await(pending);
      const shared = Deferred.makeUnsafe<unknown, E>();
      this.#shared.set(key, shared);
      return this.#scheduled(serverId, priority, request).pipe(
        Effect.onExit((exit) => Deferred.done(shared, exit)),
        Effect.ensuring(
          Effect.sync(() => {
            if (this.#shared.get(key) === shared) this.#shared.delete(key);
          }),
        ),
      );
    });
  }
}
