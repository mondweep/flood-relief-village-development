import { describe, expect, it } from "vitest";
import { alertId, signalId, unwrap } from "@afrip/shared-kernel";
import { InMemorySignalRepository } from "../src/adapters/in-memory-signal-repository.js";
import { InMemoryAlertRepository } from "../src/adapters/in-memory-alert-repository.js";
import { Signal } from "../src/domain/signal.js";
import { SmartAlert } from "../src/domain/smart-alert.js";

function makeSignal(rawId: string): Signal {
  return unwrap(
    Signal.create({
      id: unwrap(signalId(rawId)),
      source: "x",
      rawText: "Relief distributed",
      extracted: { needs: [] },
      detectedAt: "2026-07-01T00:00:00.000Z",
    }),
  );
}

function makeAlert(rawId: string): SmartAlert {
  return unwrap(
    SmartAlert.create({
      id: unwrap(alertId(rawId)),
      type: "new_relief_activity",
      signalId: unwrap(signalId("signal-1")),
      details: "New relief activity reported",
      raisedAt: "2026-07-02T00:00:00.000Z",
    }),
  );
}

describe("InMemorySignalRepository", () => {
  it("returns null for an unknown id", async () => {
    const repository = new InMemorySignalRepository();
    expect(await repository.findById(unwrap(signalId("missing")))).toBeNull();
  });

  it("finds a saved signal by id", async () => {
    const repository = new InMemorySignalRepository();
    const signal = makeSignal("signal-1");

    await repository.save(signal);

    expect(await repository.findById(unwrap(signalId("signal-1")))).toBe(signal);
  });

  it("lists all saved signals", async () => {
    const repository = new InMemorySignalRepository();
    await repository.save(makeSignal("signal-1"));
    await repository.save(makeSignal("signal-2"));

    const all = await repository.listAll();
    expect(all.map((s) => s.id)).toEqual(["signal-1", "signal-2"]);
  });

  it("overwrites a signal saved under the same id", async () => {
    const repository = new InMemorySignalRepository();
    await repository.save(makeSignal("signal-1"));
    const replacement = makeSignal("signal-1");
    await repository.save(replacement);

    expect(await repository.listAll()).toHaveLength(1);
    expect(await repository.findById(unwrap(signalId("signal-1")))).toBe(replacement);
  });
});

describe("InMemoryAlertRepository", () => {
  it("starts empty", async () => {
    const repository = new InMemoryAlertRepository();
    expect(await repository.listAll()).toEqual([]);
  });

  it("lists all saved alerts", async () => {
    const repository = new InMemoryAlertRepository();
    await repository.save(makeAlert("alert-1"));
    await repository.save(makeAlert("alert-2"));

    const all = await repository.listAll();
    expect(all.map((a) => a.id)).toEqual(["alert-1", "alert-2"]);
  });

  it("overwrites an alert saved under the same id", async () => {
    const repository = new InMemoryAlertRepository();
    await repository.save(makeAlert("alert-1"));
    const replacement = makeAlert("alert-1");
    await repository.save(replacement);

    const all = await repository.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toBe(replacement);
  });
});
