import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

type Restore = () => void;

export async function withNetworkBlockedForTests<T>(task: () => Promise<T>): Promise<T> {
  const restores: Restore[] = [];
  const fail = () => {
    throw new Error("Outbound network access is blocked during document processing tests.");
  };

  restores.push(patch(net, "connect", fail));
  restores.push(patch(net, "createConnection", fail));
  restores.push(patch(tls, "connect", fail));
  restores.push(patch(http, "request", fail));
  restores.push(patch(http, "get", fail));
  restores.push(patch(https, "request", fail));
  restores.push(patch(https, "get", fail));

  const previousFetch = globalThis.fetch;
  if (previousFetch) {
    globalThis.fetch = (async () => fail()) as typeof fetch;
    restores.push(() => {
      globalThis.fetch = previousFetch;
    });
  }

  try {
    return await task();
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

function patch<T extends object, K extends keyof T>(target: T, key: K, replacement: T[K]): Restore {
  const previous = target[key];
  target[key] = replacement;
  return () => {
    target[key] = previous;
  };
}
