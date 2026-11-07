import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.ts";

async function withServer(fn: (url: string) => Promise<void>): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("the page is served", async () => {
  await withServer(async (url) => {
    const res = await fetch(`${url}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Sift/);
  });
});

test("search returns ranked hits", async () => {
  await withServer(async (url) => {
    const res = await fetch(`${url}/search?q=${encodeURIComponent("lazy dog")}`);
    assert.equal(res.status, 200);
    const { hits } = await res.json();
    assert.deepEqual(hits.map((hit: { id: string }) => hit.id), ["1", "2"]);
    assert.ok(hits[0].score > 0);
  });
});

test("phrase search requires adjacency", async () => {
  await withServer(async (url) => {
    const res = await fetch(`${url}/phrase?q=${encodeURIComponent("fox lazy")}`);
    const { hits } = await res.json();
    assert.deepEqual(hits, []);
  });
});

test("prefix search matches word starts", async () => {
  await withServer(async (url) => {
    const res = await fetch(`${url}/search?q=bro&prefix=1`);
    const { hits } = await res.json();
    assert.deepEqual(hits.map((hit: { id: string }) => hit.id).sort(), ["1", "3"]);
  });
});

test("a new document becomes searchable and reset removes it", async () => {
  await withServer(async (url) => {
    const created = await fetch(`${url}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "doc-4", text: "a sleepy cat watches the harbour" }),
    });
    assert.equal(created.status, 201);

    const found = await (await fetch(`${url}/search?q=harbour`)).json();
    assert.deepEqual(found.hits.map((hit: { id: string }) => hit.id), ["doc-4"]);

    await fetch(`${url}/reset`, { method: "POST" });
    const after = await (await fetch(`${url}/search?q=harbour`)).json();
    assert.deepEqual(after.hits, []);
  });
});

test("rejects a document without text", async () => {
  await withServer(async (url) => {
    const res = await fetch(`${url}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "empty", text: "   " }),
    });
    assert.equal(res.status, 400);
  });
});
