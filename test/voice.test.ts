import assert from "assert";

import { insist } from "../src/voice.js";

/** A call to the voice server that fails with each of [errors] in turn, then goes through. Counts its tries. */
function flaky(...errors: string[]) {
  const call = { tries: 0, send: async () => void 0 as unknown };
  call.send = async () => {
    const error = errors[call.tries++];
    if (error) throw new Error(error);
  };
  return call;
}

describe("a change of voice rights", () => {
  const silent = console.warn;
  before(() => (console.warn = () => {}));
  after(() => (console.warn = silent));

  it("is sent again until the voice server takes it", async () => {
    const call = flaky("fetch failed", "getaddrinfo EAI_AGAIN voice.example");
    await insist(call.send, () => true, 5, 1);
    assert.strictEqual(call.tries, 3);
  });

  it("is given up after its tries, and never thrown at the game", async () => {
    const call = flaky(...Array<string>(20).fill("fetch failed"));
    await insist(call.send, () => true, 4, 1);
    assert.strictEqual(call.tries, 4);
  });

  it("isn't sent again for a player who isn't in the voice room: his next token has his rights", async () => {
    const call = flaky("twirp error unknown: participant does not exist", "fetch failed");
    await insist(call.send, () => true, 5, 1);
    assert.strictEqual(call.tries, 1);
  });

  it("gives way to a newer change", async () => {
    const call = flaky("fetch failed", "fetch failed", "fetch failed");
    let wanted = true;
    await insist(async () => {
      await call.send().finally(() => (wanted = false)); // meanwhile the phase changed again
    }, () => wanted, 5, 1);
    assert.strictEqual(call.tries, 1);
  });
});
